#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { processItem, workerId, workQueue, type Outcome, type Workspace } from "../kernel/dispatcher.js";
import { FoundryError } from "../kernel/errors.js";
import * as git from "../kernel/git.js";
import { Ledger } from "../kernel/ledger.js";
import { parseConfig } from "../schemas/config.js";
import { parseFormula, type Formula } from "../schemas/formula.js";
import { runFactory } from "./factory.js";
import { summarize } from "./format.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `usage:
  foundry run <formula> [--input <text>]   create an item from a formula and work it
  foundry add <formula> --input <text>      queue an item for workers to pick up
  foundry work [--workers N]                work ready items (N in parallel); resume after a crash
  foundry factory <formula> [--workers N]   live board of workers and worktrees; type to add work
  foundry status [item]                     list items, or show one in detail
  foundry log <item>                        show the item's audit log

<formula> is a path to a .toml file or a built-in name (${builtinFormulas().join(", ")}).`;

function builtinFormulas(): string[] {
  const dir = path.join(pkgRoot, "formulas");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)) : [];
}

async function openWorkspace(): Promise<Workspace> {
  const repo = await git.repoRoot(process.cwd());
  const configPath = path.join(repo, "foundry.toml");
  if (!fs.existsSync(configPath)) {
    throw new FoundryError("config", `no foundry.toml in ${repo}`, "create foundry.toml listing your agents (see README.md, \"Configure\")");
  }
  const config = parseConfig(fs.readFileSync(configPath, "utf8"), configPath);
  const stateDir = path.join(repo, ".foundry");
  fs.mkdirSync(stateDir, { recursive: true });
  await git.excludeStateDir(repo);
  const ledger = await Ledger.open(path.join(stateDir, "foundry.db"));
  return { repo, stateDir, config, ledger, owner: workerId(), out: (l) => console.log(l) };
}

function loadFormula(arg: string) {
  const file = fs.existsSync(arg) ? arg : path.join(pkgRoot, "formulas", `${arg}.toml`);
  if (!fs.existsSync(file)) {
    throw new FoundryError(
      "config",
      `no formula "${arg}" (not a file, and not a built-in: ${builtinFormulas().join(", ")})`,
      "pass a path to a formula .toml file, or `foundry run health-endpoint`",
    );
  }
  return parseFormula(fs.readFileSync(file, "utf8"), file);
}

// Formulas without a title (like a general "feature" formula) take the
// request as the item's title.
async function createItem(ws: Workspace, formula: Formula, input: string) {
  const title = formula.title ?? (input ? (input.length > 60 ? input.slice(0, 57) + "..." : input) : formula.formula);
  const ids = await ws.ledger.createRun({
    formula: formula.formula,
    formulaVersion: formula.version,
    stepId: formula.step.id,
    title,
    goal: formula.step.goal,
    input,
    verify: formula.step.verify,
  });
  return { ...ids, title };
}

function report(o: Outcome): number {
  if (o.status === "done") return 0;
  console.error(o.error.format());
  return 1;
}

async function cmdRun(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { input: { type: "string" } } });
  if (positionals.length !== 1) throw new FoundryError("config", "foundry run takes one formula", "foundry run health-endpoint --input \"...\"");
  const formula = loadFormula(positionals[0]!);
  const ws = await openWorkspace();
  try {
    const { itemId, runId, title } = await createItem(ws, formula, values.input ?? "");
    ws.out(`${runId} created ${itemId}: ${title}`);
    if (!(await ws.ledger.claim(itemId, ws.owner, ws.config.leases.ttl_seconds))) {
      ws.out(`${itemId} was claimed by another worker; follow it with \`foundry status ${itemId}\``);
      return 0;
    }
    ws.out(`${itemId} claimed by ${ws.owner}`);
    return report(await processItem(ws, itemId));
  } finally {
    await ws.ledger.close();
  }
}

function workersArg(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { workers: { type: "string", default: "1" } } });
  const n = Number(values.workers);
  if (!Number.isInteger(n) || n < 1) throw new FoundryError("config", `--workers must be a whole number, got "${values.workers}"`, "foundry work --workers 2");
  return { positionals, workers: n };
}

async function cmdAdd(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { input: { type: "string" } } });
  if (positionals.length !== 1) throw new FoundryError("config", "foundry add takes one formula", "foundry add ./formulas/feature.toml --input \"...\"");
  const formula = loadFormula(positionals[0]!);
  const ws = await openWorkspace();
  try {
    const { itemId, title } = await createItem(ws, formula, values.input ?? "");
    ws.out(`${itemId} queued: ${title}  (start workers with \`foundry work\` or \`foundry factory\`)`);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdWork(args: string[]): Promise<number> {
  const { workers } = workersArg(args);
  const ws = await openWorkspace();
  try {
    const owners = workers === 1 ? [ws.owner] : Array.from({ length: workers }, (_, i) => `${ws.owner}:w${i + 1}`);
    const results = await Promise.all(owners.map((owner) => workQueue({ ...ws, owner })));
    const fatal = results.find((r) => r.fatal)?.fatal;
    if (fatal) {
      console.error(fatal.format());
      return 1;
    }
    const worked = results.flatMap((r) => r.worked);
    if (worked.length === 0) ws.out("nothing to do: no ready items");
    return worked.map(report).some((c) => c !== 0) ? 1 : 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdFactory(args: string[]): Promise<number> {
  const { positionals, workers } = workersArg(args);
  if (positionals.length !== 1) throw new FoundryError("config", "foundry factory takes one formula for the work you add", "foundry factory ./formulas/feature.toml --workers 2");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new FoundryError("config", "foundry factory needs an interactive terminal", "run it in a terminal, or use `foundry add` and `foundry work`");
  const formula = loadFormula(positionals[0]!);
  const ws = await openWorkspace();
  return runFactory(ws, workers, async (input) => (await createItem(ws, formula, input)).itemId);
}

const time = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 23);

async function cmdStatus(args: string[]): Promise<number> {
  const ws = await openWorkspace();
  try {
    if (args.length === 0) {
      const items = await ws.ledger.listItems();
      if (items.length === 0) ws.out("no items yet; start one with `foundry run health-endpoint`");
      for (const i of items) {
        const stale = (i.status === "running" || i.status === "verifying") && (i.lease_expires_at ?? 0) < Date.now();
        ws.out(`${i.id.padEnd(6)} ${i.status.padEnd(9)} attempt ${i.attempt}  ${i.agent ?? "-"}  ${i.title}${stale ? "  (lease expired: run `foundry work` to resume)" : ""}`);
      }
      return 0;
    }
    const item = await ws.ledger.getItem(args[0]!);
    if (!item) throw new FoundryError("ledger", `no item ${args[0]}`, "foundry status");
    const events = await ws.ledger.events(item.id);
    const of = (t: string) => events.filter((e) => e.type === t);
    const claimed = of("claimed")[0];
    const end = [...of("merged"), ...of("failed")].at(-1);
    const perms = of("permission");
    const lines = [
      `${item.id}: ${item.title}`,
      `  status:    ${item.status} (attempt ${item.attempt} of ${item.max_attempts})`,
      `  run:       ${item.run_id}, step ${item.step_id}`,
      `  agent:     ${item.agent ?? "-"}`,
      `  worktree:  ${item.worktree ?? "-"}${item.branch ? ` (${item.branch})` : ""}`,
      `  verify:    ${item.verify}`,
    ];
    if (item.lease_owner) lines.push(`  lease:     ${item.lease_owner} until ${time(item.lease_expires_at!)}`);
    lines.push(`  activity:  ${of("tool_call").length} tool calls, ${perms.length} permission requests (${perms.filter((p) => !p.payload.allow).length} denied)`);
    if (claimed && end) lines.push(`  duration:  ${((end.ts - claimed.ts) / 1000).toFixed(1)}s from claim to ${end.type}`);
    const merged = of("merged").at(-1);
    if (merged) lines.push(`  merged:    ${String(merged.payload.commit).slice(0, 12)} into ${merged.payload.target}`);
    const failed = of("failed").at(-1);
    if (item.status === "failed" && failed) {
      const p = failed.payload as { layer: string; message: string; next?: string; output?: string };
      lines.push(`  failure:   [${p.layer}] ${p.message}`);
      if (p.next) lines.push(`  next:      ${p.next}`);
      if (p.output) lines.push("  output:", ...p.output.trimEnd().split("\n").slice(-30).map((l) => `    | ${l}`));
    }
    ws.out(lines.join("\n"));
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdLog(args: string[]): Promise<number> {
  if (args.length !== 1) throw new FoundryError("config", "foundry log takes one item id", "foundry log WI-1");
  const ws = await openWorkspace();
  try {
    const events = await ws.ledger.events(args[0]!);
    if (events.length === 0) throw new FoundryError("ledger", `no events for ${args[0]}`, "foundry status");
    for (const e of events) ws.out(`${time(e.ts)}  ${e.type.padEnd(16)} ${summarize(e)}`);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "add": return cmdAdd(rest);
    case "work": return cmdWork(rest);
    case "factory": return cmdFactory(rest);
    case "status": return cmdStatus(rest);
    case "log": return cmdLog(rest);
    case undefined: case "help": case "--help": case "-h":
      console.log(USAGE);
      return cmd ? 0 : 2;
    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof FoundryError) console.error(e.format());
    else {
      console.error(`error [internal]: ${(e as Error).message}\n  next: rerun with FOUNDRY_DEBUG=1 for details`);
      if (process.env.FOUNDRY_DEBUG) console.error(e);
    }
    process.exit(1);
  },
);
