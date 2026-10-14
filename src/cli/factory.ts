// `foundry factory`: a live ASCII board of the factory (main, one lane per
// worker and its worktree, queue, activity) with a line at the bottom where
// each message you type becomes a new work item. The board is drawn from
// the ledger and git; the workers run in this process.
import { execFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { workQueue, type Workspace } from "../kernel/dispatcher.js";
import * as git from "../kernel/git.js";
import type { Item, LedgerEvent } from "../kernel/ledger.js";
import { pickAgent } from "../schemas/config.js";
import { summarize } from "./format.js";

const exec = promisify(execFile);

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};
const STATUS: Record<string, (s: string) => string> = {
  ready: c.cyan,
  merging: c.magenta,
  merge_ready: c.magenta,
  waiting_input: c.yellow,
  at_gate: c.yellow,
  skipped: c.dim,
  running: c.yellow,
  verifying: c.magenta,
  done: c.green,
  failed: c.red,
};

export interface BoardState {
  repo: string;
  agent: string;
  target: string;
  workers: { id: string; stopped?: string }[];
  items: Item[];
  latest: Map<string, LedgerEvent[]>; // last events of active items
  mainLog: string[]; // `git log --oneline` of the target
  activity: string[];
  input: string;
  notice: string;
  width: number;
}

// Pure: state in, screen out (no trailing cursor handling).
export function renderBoard(s: BoardState): string {
  const w = Math.max(60, s.width);
  const lines: string[] = [];
  const rule = (label = "") => c.dim(`── ${label}`.padEnd(w, "─"));
  const active = (i: Item) => i.status === "running" || i.status === "verifying" || i.status === "merging";

  lines.push(
    c.bold(c.cyan(" ▟▙ FOUNDRY ")) + c.dim("software factory") + `   repo ${c.bold(path.basename(s.repo))}   agent ${c.bold(s.agent)}   workers ${s.workers.length}`,
  );
  lines.push(rule(`${s.target} (merged work lands here)`));
  const log = s.mainLog.slice(0, 5);
  log.forEach((l, i) => lines.push(`  ${i === 0 ? c.green("●") : c.dim("●")} ${i === 0 ? c.bold(l) : l}`));
  lines.push(`  ${c.dim("│")}`);

  s.workers.forEach((wk, wi) => {
    const last = wi === s.workers.length - 1;
    const branch = last ? "└─▶" : "├─▶";
    const pipe = last ? " " : c.dim("│");
    const item = s.items.find((i) => active(i) && i.lease_owner === wk.id);
    const label = c.bold(`worker ${wi + 1}`);
    if (!item) {
      lines.push(`  ${c.dim(branch)} ${label}  ${wk.stopped ? c.red(`stopped: ${wk.stopped}`) : c.dim("idle, waiting for work")}`);
      lines.push(`  ${pipe}`);
      return;
    }
    lines.push(`  ${c.dim(branch)} ${label}  ${c.bold(item.id)} ${STATUS[item.status]!(`[${item.status}]`)}  ${item.title}`);
    lines.push(`  ${pipe}     worktree ${c.cyan(item.worktree ? path.relative(s.repo, item.worktree) : "(creating)")}  branch ${c.cyan(item.branch ?? "-")}`);
    for (const e of (s.latest.get(item.id) ?? []).slice(-3)) {
      lines.push(`  ${pipe}     ${c.dim("▸")} ${e.type.padEnd(15)} ${summarize(e)}`);
    }
    lines.push(`  ${pipe}`);
  });

  const queue = s.items.filter((i) => i.status === "ready");
  const done = s.items.filter((i) => i.status === "done");
  const failed = s.items.filter((i) => i.status === "failed");
  const waiting = s.items.filter((i) => i.status === "waiting_input" || i.status === "at_gate");
  const merging = s.items.filter((i) => i.status === "merge_ready");
  lines.push(rule("work items"));
  lines.push(`  ${c.cyan("queued ")} ${queue.length ? queue.map((i) => `${i.id} ${i.title}`).join(c.dim("  ·  ")) : c.dim("(empty)")}`);
  if (merging.length) lines.push(`  ${c.magenta("merge q")} ${merging.map((i) => i.id).join("  ")}  ${c.dim("(the refinery merges one at a time)")}`);
  if (waiting.length) lines.push(`  ${c.yellow("for you")} ${waiting.map((i) => `${i.id} ${i.status === "at_gate" ? "at gate" : "has a question"}`).join("  ·  ")}  ${c.dim("(foundry status <id>)")}`);
  lines.push(`  ${c.green("done   ")} ${done.length ? done.map((i) => `${i.id} ✔`).join("  ") : c.dim("(none yet)")}`);
  if (failed.length) lines.push(`  ${c.red("failed ")} ${failed.map((i) => `${i.id} ✘`).join("  ")}  ${c.dim("(foundry status <id> to see why)")}`);

  lines.push(rule("activity"));
  for (const a of s.activity.slice(-8)) lines.push(`  ${a}`);

  lines.push(rule());
  lines.push(c.dim(s.notice || " Tell the factory what to build. Enter adds a work item; /quit exits."));
  lines.push(`${c.bold(c.green(" factory ›"))} ${s.input}`);
  return lines.map((l) => truncate(l, w)).join("\n");
}

// Cut a line to `w` visible columns without breaking ANSI codes.
function truncate(line: string, w: number): string {
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      out += line.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= w) continue;
    out += line[i];
    visible++;
  }
  return out + "\x1b[0m";
}

export async function runFactory(
  ws: Workspace,
  workerCount: number,
  addItem: (input: string) => Promise<string>,
): Promise<number> {
  const target = await git.targetBranch(ws.repo);
  const activity: string[] = [];
  const time = () => new Date().toTimeString().slice(0, 8);
  const workers = Array.from({ length: workerCount }, (_, i) => ({ id: `${ws.owner}:w${i + 1}`, stopped: undefined as string | undefined }));
  const state: BoardState = {
    repo: ws.repo,
    agent: pickAgent(ws.config),
    target,
    workers,
    items: [],
    latest: new Map(),
    mainLog: [],
    activity,
    input: "",
    notice: "",
    width: process.stdout.columns ?? 100,
  };
  const out = (line: string) => {
    activity.push(`${c.dim(time())} ${line}`);
    if (activity.length > 200) activity.splice(0, 100);
  };

  // Workers: same loop as `foundry work`, but they keep waiting for new items.
  for (const wk of workers) {
    void workQueue({ ...ws, owner: wk.id, out }, { watch: true }).then(
      (r) => (wk.stopped = r.fatal ? `${r.fatal.layer}: ${r.fatal.message.split("\n")[0]}` : "finished"),
      (e) => (wk.stopped = String(e)),
    );
  }

  let closing = false;
  const refresh = async () => {
    state.items = await ws.ledger.listItems();
    state.latest = new Map();
    for (const i of state.items.filter((i) => i.status === "running" || i.status === "verifying" || i.status === "merging")) {
      state.latest.set(i.id, (await ws.ledger.events(i.id)).filter((e) => e.type !== "created"));
    }
    const { stdout } = await exec("git", ["log", "--oneline", "-5", target], { cwd: ws.repo }).catch(() => ({ stdout: "" }));
    state.mainLog = stdout.trim().split("\n").filter(Boolean);
    state.width = process.stdout.columns ?? 100;
  };
  const draw = () => {
    if (closing) return;
    process.stdout.write("\x1b[H\x1b[2J" + renderBoard(state));
  };

  process.stdout.write("\x1b[?1049h"); // alternate screen
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  return new Promise<number>((resolve) => {
    const quit = () => {
      closing = true;
      clearInterval(timer);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write("\x1b[?1049l");
      console.log("factory stopped. Running items resume with `foundry work` or `foundry factory`.");
      resolve(0);
    };
    const timer = setInterval(() => void refresh().then(draw, () => {}), 700);
    void refresh().then(draw);

    process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key?.ctrl && key.name === "c") return quit();
      if (key?.name === "return") {
        const text = state.input.trim();
        state.input = "";
        if (text === "/quit" || text === "/exit") return quit();
        if (text) {
          void addItem(text).then(
            (id) => {
              state.notice = ` Added ${id}: "${text}". A free worker picks it up in its own worktree.`;
              out(`${id} queued: ${text}`);
            },
            (e) => (state.notice = ` Could not add the item: ${(e as Error).message}`),
          );
        }
      } else if (key?.name === "backspace") {
        state.input = state.input.slice(0, -1);
      } else if (str && !key?.ctrl && str >= " ") {
        state.input += str;
      }
      draw();
    });
  });
}
