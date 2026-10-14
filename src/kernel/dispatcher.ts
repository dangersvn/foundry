// The dispatcher works one claimed item: worktree, agent, commit, verifier,
// merge. Every step is recorded in the ledger before the next one starts, so
// a crash at any point is recovered by returning the item to ready.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../schemas/config.js";
import { pickAgent } from "../schemas/config.js";
import type { AgentEvent } from "../schemas/agent.js";
import { AgentStartError, runAgent } from "../runtime/acp.js";
import { FoundryError } from "./errors.js";
import * as git from "./git.js";
import type { Item, Ledger } from "./ledger.js";
import { runVerify } from "./verifier.js";

export interface Workspace {
  repo: string;
  stateDir: string;
  config: Config;
  ledger: Ledger;
  owner: string;
  out: (line: string) => void;
}

export type Outcome = { status: "done"; commit: string } | { status: "failed" | "ready"; error: FoundryError };

// One git-mutating section at a time within this process.
let gitChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitChain.then(fn, fn);
  gitChain = run.catch(() => {});
  return run;
}

export const workerId = () => `${os.hostname()}:${process.pid}`;

export function buildPrompt(item: Item, wt: git.Worktree): string {
  return [
    `Foundry work item ${item.id} (step "${item.step_id}", attempt ${item.attempt}).`,
    "",
    "Goal:",
    item.goal.trim(),
    ...(item.inputs.trim() ? ["", "Request:", item.inputs.trim()] : []),
    "",
    "Rules:",
    `- Work only inside this directory: ${wt.path}. It is a git worktree on branch ${wt.branch}.`,
    "- Do not run git push and do not merge. Commits are optional; Foundry squashes your changes into one commit.",
    `- When you are finished, end your turn. Foundry then runs \`${item.verify}\` in this directory, and the item is done only if it passes, so run it yourself first.`,
  ].join("\n");
}

// Works an item this worker has already claimed.
export async function processItem(ws: Workspace, itemId: string): Promise<Outcome> {
  const { ledger, owner, out } = ws;
  const ttl = ws.config.leases.ttl_seconds;
  const lost = new AbortController();
  const renew = setInterval(
    () => {
      ledger
        .renewLease(itemId, owner, ttl)
        .then((held) => held || lost.abort())
        .catch(() => lost.abort());
    },
    Math.max(250, (ttl * 1000) / 3),
  );
  const checkLease = () => {
    if (lost.signal.aborted) throw new FoundryError("ledger", `lost the lease on ${itemId}`, `foundry status ${itemId}`);
  };

  const item = (await ledger.getItem(itemId))!;
  try {
    const target = await git.targetBranch(ws.repo);

    // A crash after the merge but before "done" was written: finish the bookkeeping.
    const merged = await git.findItemCommit(ws.repo, target, itemId);
    if (merged) {
      await ledger.transition(itemId, owner, ["running", "verifying"], "done", "merged", { commit: merged, target, recovered: true });
      out(`${itemId} done: already merged as ${merged.slice(0, 7)}`);
      return { status: "done", commit: merged };
    }

    const agent = pickAgent(ws.config);
    const wt = await serialized(() => git.createWorktree(ws.repo, itemId, item.attempt));
    await ledger.record(itemId, owner, "worktree_created", { path: wt.path, branch: wt.branch, base: wt.base }, {
      worktree: wt.path,
      branch: wt.branch,
      agent,
    });
    out(`${itemId} worktree ${path.relative(ws.repo, wt.path)} on ${wt.branch}`);

    const transcriptPath = path.join(ws.stateDir, "transcripts", `${itemId}-a${item.attempt}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    await ledger.addArtifact(itemId, "transcript", transcriptPath);
    try {
      await runAgent({
        agent,
        command: ws.config.agents[agent]!.command,
        cwd: wt.path,
        prompt: buildPrompt(item, wt),
        transcriptPath,
        signal: lost.signal,
        onEvent: async (e) => {
          const { type, ...payload } = e;
          await ledger.record(itemId, owner, type, payload);
          out(describeEvent(itemId, e));
        },
      });
    } catch (e) {
      if (e instanceof AgentStartError) {
        await ledger.transition(itemId, owner, "running", "ready", "agent_unavailable", errorPayload(e));
        return { status: "ready", error: e };
      }
      throw e;
    }
    checkLease();

    await ledger.transition(itemId, owner, "running", "verifying", "verifying", { command: item.verify });
    const commit = await git.squashCommit(wt.path, wt.base, `${itemId}: ${item.title}`, itemId);
    if (!commit) {
      throw new FoundryError("agent", `the agent ended its turn without changing any files in ${wt.path}`, `foundry log ${itemId}`);
    }
    // Rebase, verify and fast-forward one item at a time, so parallel
    // workers never race to move the target branch.
    const head = await serialized(async () => {
      const head = await git.rebaseOnto(wt.path, target);
      out(`${itemId} verifying: ${item.verify}`);
      const result = await runVerify(wt.path, item.verify);
      const logPath = path.join(ws.stateDir, "logs", `${itemId}-a${item.attempt}-verify.log`);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, result.output);
      await ledger.addArtifact(itemId, "verify_log", logPath);
      checkLease();
      if (!result.passed) {
        throw Object.assign(
          new FoundryError(
            "verifier",
            `\`${item.verify}\` failed (exit ${result.exitCode}) in ${wt.path}`,
            `read the output with \`foundry status ${itemId}\` (full log: ${path.relative(ws.repo, logPath)}); the worktree is kept for you to inspect`,
          ),
          { detail: { exitCode: result.exitCode, output: tail(result.output), log: logPath } },
        );
      }
      await ledger.record(itemId, owner, "verified", {
        command: item.verify,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: tail(result.output, 1000),
      });

      await git.fastForward(ws.repo, target, head);
      return head;
    });
    await ledger.transition(itemId, owner, "verifying", "done", "merged", { commit: head, target, branch: wt.branch });
    out(`${itemId} done: merged ${head.slice(0, 7)} into ${target}`);
    return { status: "done", commit: head };
  } catch (e) {
    const error =
      e instanceof FoundryError
        ? e
        : new FoundryError("ledger", `unexpected error: ${(e as Error).message}`, `foundry log ${itemId}, then report it`);
    if (lost.signal.aborted || error.layer === "ledger") return { status: "failed", error };
    await ledger
      .transition(itemId, owner, ["running", "verifying"], "failed", "failed", {
        ...errorPayload(error),
        ...((e as { detail?: object }).detail ?? {}),
      })
      .catch(() => {});
    return { status: "failed", error };
  } finally {
    clearInterval(renew);
  }
}

function errorPayload(e: FoundryError) {
  return { layer: e.layer, message: e.message, next: e.next };
}

function tail(s: string, n = 4000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

function describeEvent(itemId: string, e: AgentEvent): string {
  switch (e.type) {
    case "agent_started":
      return `${itemId} agent ${e.agent} started (${e.agentInfo?.name ?? "?"} ${e.agentInfo?.version ?? ""})`.trimEnd();
    case "tool_call":
      return `${itemId}   tool ${e.kind}: ${e.title} [${e.status}]`;
    case "permission":
      return `${itemId}   ${e.allow ? "allowed" : "denied"} ${e.kind}: ${e.command ?? e.title} (${e.reason})`;
    case "agent_finished":
      return `${itemId} agent finished (${e.stopReason})`;
  }
}

// Claims and works ready items until none are left. Waits while other
// workers hold live leases, and recovers items whose leases expired.
// With `watch`, keeps polling for new ready items instead of exiting.
export async function workQueue(ws: Workspace, opts: { watch?: boolean } = {}): Promise<{ worked: Outcome[]; fatal?: FoundryError }> {
  const worked: Outcome[] = [];
  for (;;) {
    for (const id of await ws.ledger.recoverExpired()) ws.out(`${id} lease expired; back to ready`);
    const itemId = await ws.ledger.claimNext(ws.owner, ws.config.leases.ttl_seconds);
    if (itemId) {
      const item = (await ws.ledger.getItem(itemId))!;
      ws.out(`${itemId} claimed by ${ws.owner} (attempt ${item.attempt}): ${item.title}`);
      const outcome = await processItem(ws, itemId);
      worked.push(outcome);
      // The agent could not start; retrying now would fail the same way.
      if (outcome.status === "ready") return { worked, fatal: outcome.error };
      continue;
    }
    if (!opts.watch && !(await ws.ledger.hasActiveItems())) return { worked };
    await new Promise((r) => setTimeout(r, opts.watch ? 1000 : 500));
  }
}
