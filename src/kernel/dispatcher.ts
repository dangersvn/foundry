// The dispatcher works claimed items: worktree, agent session (or script),
// submission, verifier, review, then a gate or the merge queue. The refinery
// merges one item at a time. Every step is in the ledger before the next one
// starts, so a crash anywhere is recovered by patrol.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../schemas/config.js";
import { pickAgent } from "../schemas/config.js";
import type { AgentEvent } from "../schemas/agent.js";
import type { Step } from "../schemas/formula.js";
import { DEFAULT_ROLE, loadPack, type Pack } from "../schemas/pack.js";
import type { Result } from "../schemas/result.js";
import { AgentStartError, runAgent } from "../runtime/acp.js";
import { RENDERED_PATHS, renderRole } from "../runtime/render.js";
import { buildEnvelope } from "./envelope.js";
import { FoundryError } from "./errors.js";
import * as git from "./git.js";
import type { InputRef, Item, Ledger, Run } from "./ledger.js";
import { runVerify } from "./verifier.js";

export interface Workspace {
  repo: string;
  stateDir: string;
  config: Config;
  ledger: Ledger;
  owner: string;
  out: (line: string) => void;
  // How an agent runs `foundry` from inside a worktree (this very CLI).
  selfCommand: string[];
}

export type Outcome =
  | { status: "done" | "skipped" | "merge_ready" | "at_gate" | "waiting_input"; itemId: string; commit?: string }
  | { status: "retry" | "failed" | "unavailable"; itemId: string; error: FoundryError };

export const workerId = () => `${os.hostname()}:${process.pid}`;

// What an agent command (`foundry submit`, `ask`, ...) reads to know its item.
export interface ItemHandle {
  item: string;
  attempt: number;
  ledger: string;
  review: boolean;
}

// One git-mutating section at a time within this process.
let gitChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitChain.then(fn, fn);
  gitChain = run.catch(() => {});
  return run;
}

const packCache = new Map<string, Pack>();
function packOf(run: Run): Pack | null {
  if (!run.pack_dir) return null;
  if (!packCache.has(run.pack_dir)) packCache.set(run.pack_dir, loadPack(run.pack_dir));
  return packCache.get(run.pack_dir)!;
}

const tail = (s: string, n = 4000) => (s.length > n ? "…" + s.slice(-n) : s);
const errorPayload = (e: FoundryError) => ({ layer: e.layer, message: e.message, next: e.next });

export async function processItem(ws: Workspace, itemId: string): Promise<Outcome> {
  const { ledger, owner, out } = ws;
  const ttl = ws.config.leases.ttl_seconds;
  const lost = new AbortController();
  const renew = setInterval(
    () => void ledger.renewLease(itemId, owner, ttl).then((held) => held || lost.abort(), () => lost.abort()),
    Math.max(250, (ttl * 1000) / 3),
  );
  const checkLease = () => {
    if (lost.signal.aborted) throw new FoundryError("ledger", `lost the lease on ${itemId}`, `foundry status ${itemId}`);
  };

  const item = (await ledger.getItem(itemId))!;
  const run = (await ledger.getRun(item.run_id))!;
  const step = JSON.parse(item.spec_json!) as Step;

  // Send the item back for another attempt, with the reason in its history.
  const sendBack = async (noteKind: string, error: FoundryError, extra: Record<string, unknown> = {}): Promise<Outcome> => {
    await ledger.addNote(itemId, item.attempt, noteKind, "foundry", `${error.message}${extra.output ? `\n${tail(String(extra.output), 2000)}` : ""}`);
    const next = await ledger.retry(itemId, owner, owner, ["running", "verifying"], error.message, { ...errorPayload(error), ...extra });
    out(next === "failed" ? `${itemId} failed: ${error.message}` : `${itemId} sent back for attempt ${item.attempt + 1}: ${error.message.split("\n")[0]}`);
    return { status: next === "failed" ? "failed" : "retry", itemId, error };
  };

  try {
    const wt = await serialized(async () => {
      await git.excludeStateDir(ws.repo, RENDERED_PATHS);
      return git.createWorktree(ws.repo, itemId, item.attempt);
    });
    const agent = pickAgent(ws.config);
    await ledger.record(itemId, owner, "worktree_created", { path: wt.path, branch: wt.branch, base: wt.base }, {
      worktree: wt.path,
      branch: wt.branch,
      agent: step.type === "agent" ? agent : "script",
    });
    out(`${itemId} worktree ${path.relative(ws.repo, wt.path)} on ${wt.branch}`);

    let result: Result | null = null;
    if (step.type === "script") {
      out(`${itemId} running script: ${step.run}`);
      const r = await runVerify(wt.path, step.run!);
      if (!r.passed) return await sendBack("verifier", new FoundryError("verifier", `script \`${step.run}\` failed (exit ${r.exitCode})`, `foundry status ${itemId}`), { output: tail(r.output) });
      result = { status: "done", summary: `script \`${step.run}\` passed`, outputs: {}, artifacts: [], findings: [], decisions: [] };
    } else {
      try {
        await runSession(ws, item, run, step, wt, agent, false, lost.signal);
      } catch (e) {
        if (e instanceof AgentStartError) {
          await ledger.transition(itemId, owner, "running", "ready", "agent_unavailable", errorPayload(e));
          return { status: "unavailable", itemId, error: e };
        }
        if (e instanceof FoundryError && e.layer === "agent") return await sendBack("note", e);
        throw e;
      }
      checkLease();

      // A question ends the session; the item waits for a person.
      const open = (await ledger.questions(itemId)).filter((q) => q.attempt === item.attempt && q.answer === null);
      if (open.length) {
        await ledger.transition(itemId, owner, "running", "waiting_input", "waiting_for_input", { questions: open.map((q) => q.id) });
        out(`${itemId} waiting for input: ${open.map((q) => `${q.id} "${q.question}"`).join(", ")}`);
        return { status: "waiting_input", itemId };
      }

      if (step.submit) {
        result = await ledger.latestSubmission(itemId, item.attempt);
        if (!result) {
          return await sendBack("note", new FoundryError("agent", "the agent ended its turn without a valid `foundry submit`", `foundry log ${itemId}`));
        }
        await ledger.addAgentDecisions(itemId, item.attempt, `${step.role}@${agent}`, result.decisions);
        if (result.status === "skipped") {
          await ledger.addAgentDecisions(itemId, item.attempt, `${step.role}@${agent}`, [
            { kind: "decision", question: `Does step "${step.id}" apply?`, choice: "skipped", alternatives: ["run it"], rationale: result.reason!, evidence: [], affects: [], reversible: true },
          ]);
          await ledger.transition(itemId, owner, "running", "skipped", "skipped", { reason: result.reason }, { result_json: JSON.stringify(result) });
          out(`${itemId} skipped: ${result.reason}`);
          return { status: "skipped", itemId };
        }
      }
    }

    await ledger.transition(itemId, owner, "running", "verifying", "verifying", { command: step.verify ?? null });
    const commit = await git.squashCommit(wt.path, wt.base, `${itemId}: ${item.title}`, itemId);
    if (!commit && !step.submit) {
      return await sendBack("note", new FoundryError("agent", `the agent ended its turn without changing any files in ${wt.path}`, `foundry log ${itemId}`));
    }

    if (step.verify) {
      out(`${itemId} verifying: ${step.verify}`);
      const r = await runVerify(wt.path, step.verify);
      const logPath = path.join(ws.stateDir, "logs", `${itemId}-a${item.attempt}-verify.log`);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, r.output);
      await ledger.addArtifact(itemId, "verify_log", logPath);
      checkLease();
      if (!r.passed) {
        const err = new FoundryError(
          "verifier",
          `\`${step.verify}\` failed (exit ${r.exitCode}) in ${wt.path}`,
          `read the output with \`foundry status ${itemId}\` (full log: ${path.relative(ws.repo, logPath)}); the worktree is kept for you to inspect`,
        );
        return await sendBack("verifier", err, { exitCode: r.exitCode, output: tail(r.output), log: logPath });
      }
      await ledger.record(itemId, owner, "verified", {
        command: step.verify,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        sha: commit,
        output: tail(r.output, 1000),
      });
    }

    if (step.review && step.type === "agent") {
      out(`${itemId} review by ${step.review}`);
      try {
        await runSession(ws, item, run, step, wt, agent, true, lost.signal);
      } catch (e) {
        if (!(e instanceof FoundryError)) throw e;
        await ledger.addNote(itemId, item.attempt, "review", "foundry", `the reviewer could not finish: ${e.message}`);
      }
      await git.resetWorktree(wt.path);
      const findings = (await ledger.notes(itemId)).filter((n) => n.kind === "review" && n.attempt === item.attempt);
      await ledger.record(itemId, owner, "reviewed", { reviewer: step.review, findings: findings.map((f) => f.body), advisory: true });
    }
    checkLease();

    const fields = { result_json: result ? JSON.stringify(result) : null, commit_sha: commit };
    if (step.gate || step.environment_change) {
      await ledger.transition(itemId, owner, "verifying", "at_gate", "at_gate", { commit, environmentChange: step.environment_change }, fields);
      out(`${itemId} at gate: approve with \`foundry approve ${itemId}\` or reject with \`foundry reject ${itemId} --comment "..."\``);
      return { status: "at_gate", itemId };
    }
    if (!commit) {
      await ledger.transition(itemId, owner, "verifying", "done", "completed", { commit: null }, fields);
      out(`${itemId} done (no file changes)`);
      return { status: "done", itemId };
    }
    await ledger.transition(itemId, owner, "verifying", "merge_ready", "merge_queued", { commit }, fields);
    out(`${itemId} queued for merge`);
    return { status: "merge_ready", itemId, commit };
  } catch (e) {
    const error = e instanceof FoundryError ? e : new FoundryError("ledger", `unexpected error: ${(e as Error).message}`, `foundry log ${itemId}, then report it`);
    if (lost.signal.aborted || error.layer === "ledger") return { status: "failed", itemId, error };
    await ledger.transition(itemId, owner, ["running", "verifying"], "failed", "failed", errorPayload(error)).catch(() => {});
    return { status: "failed", itemId, error };
  } finally {
    clearInterval(renew);
  }
}

// One agent session in the item's worktree: render the role, write the
// envelope and the item handle, run the turn.
async function runSession(ws: Workspace, item: Item, run: Run, step: Step, wt: git.Worktree, agent: string, review: boolean, signal: AbortSignal) {
  const { ledger, owner, out } = ws;
  const pack = packOf(run);
  const roleName = review ? step.review! : step.role;
  const role = pack?.roles.get(roleName);
  const params = JSON.parse(run.params_json ?? "{}") as Record<string, string>;

  // Knowledge is copied under the worktree's excluded .foundry/, so reading it
  // never leaves the worktree.
  const context: string[] = [];
  for (const k of role?.knowledge ?? []) {
    const dest = path.join(wt.path, ".foundry", "pack", k);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(pack!.dir!, k), dest);
    context.push(path.join(".foundry", "pack", k));
  }
  if (fs.existsSync(path.join(wt.path, "AGENTS.md"))) context.push("AGENTS.md");

  const rules: { layer: string; text: string }[] = [];
  for (const layer of ["org", "team", "project"] as const) {
    const file = ws.config.rules[layer];
    if (file && fs.existsSync(path.resolve(ws.repo, file))) rules.push({ layer, text: fs.readFileSync(path.resolve(ws.repo, file), "utf8") });
  }

  const inputs = JSON.parse(item.inputs_json ?? "[]") as InputRef[];
  const inputDecisions = (await Promise.all(inputs.map((i) => ledger.decisions({ itemId: i.item })))).flat().filter((d) => d.kind !== "control");
  const envelope = buildEnvelope({
    item,
    run,
    step,
    rolePrompt: role?.promptText ?? "",
    instructions: step.instructions && pack?.dir && !review ? fs.readFileSync(path.join(pack.dir, step.instructions), "utf8") : "",
    worktree: wt.path,
    branch: wt.branch,
    inputs,
    inputDecisions,
    notes: await ledger.notes(item.id),
    questions: await ledger.questions(item.id),
    runItems: await ledger.listItems(run.id),
    context,
    rules,
    params,
    fullVerify: (JSON.parse(run.formula_json!) as { verify?: string }).verify,
    review,
  });

  const fdir = path.join(wt.path, ".foundry");
  fs.mkdirSync(path.join(fdir, "bin"), { recursive: true });
  const handle: ItemHandle = { item: item.id, attempt: item.attempt, ledger: path.join(ws.stateDir, "foundry.db"), review };
  fs.writeFileSync(path.join(fdir, "item.json"), JSON.stringify(handle, null, 2) + "\n");
  const wrapper = path.join(fdir, "bin", "foundry");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${ws.selfCommand.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  fs.rmSync(path.join(fdir, "result.json"), { force: true });

  const tag = `${item.id}-a${item.attempt}${review ? "-review" : ""}`;
  const envelopePath = path.join(ws.stateDir, "envelopes", `${tag}.md`);
  fs.mkdirSync(path.dirname(envelopePath), { recursive: true });
  fs.writeFileSync(envelopePath, envelope);
  await ledger.addArtifact(item.id, "envelope", envelopePath);

  const cfg = ws.config.agents[agent]!;
  const rendered =
    role || roleName !== DEFAULT_ROLE
      ? renderRole(cfg.render, wt.path, {
          name: roleName,
          description: role?.description ?? "",
          prompt: role?.promptText ?? "",
          knowledge: context,
          tools: review ? ["read", "shell"] : (role?.tools_allowed ?? ["read", "write", "shell"]),
        })
      : { args: [], files: [] };

  const transcriptPath = path.join(ws.stateDir, "transcripts", `${tag}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  await ledger.addArtifact(item.id, "transcript", transcriptPath);
  await runAgent({
    agent,
    command: [...cfg.command, ...rendered.args],
    cwd: wt.path,
    prompt: envelope,
    transcriptPath,
    signal,
    onEvent: async (e) => {
      const { type, ...payload } = e;
      await ledger.record(item.id, owner, review ? `review_${type}` : type, { ...payload, ...(type === "agent_started" ? { role: roleName, envelope: envelopePath } : {}) });
      out(describeEvent(item.id, e));
    },
  });
}

// The refinery: rebase onto the target, run the full verify, fast-forward.
// A conflict or failure goes back to its item with the error attached.
export async function mergeItem(ws: Workspace, itemId: string): Promise<Outcome> {
  const { ledger, owner, out } = ws;
  const ttl = ws.config.leases.ttl_seconds;
  const renew = setInterval(() => void ledger.renewLease(itemId, owner, ttl).catch(() => {}), Math.max(250, (ttl * 1000) / 3));
  const item = (await ledger.getItem(itemId))!;
  const run = (await ledger.getRun(item.run_id))!;
  const step = JSON.parse(item.spec_json!) as Step;
  const fullVerify = (JSON.parse(run.formula_json!) as { verify?: string }).verify ?? step.verify;
  const sendBack = async (error: FoundryError, extra: Record<string, unknown> = {}): Promise<Outcome> => {
    await ledger.addNote(itemId, item.attempt, "refinery", "foundry", `${error.message}${extra.output ? `\n${tail(String(extra.output), 2000)}` : ""}`);
    const next = await ledger.retry(itemId, owner, owner, "merging", error.message, { ...errorPayload(error), ...extra });
    out(`${itemId} ${next === "failed" ? "failed" : "sent back"} by the merge queue: ${error.message.split("\n")[0]}`);
    return { status: next === "failed" ? "failed" : "retry", itemId, error };
  };
  try {
    const target = await git.targetBranch(ws.repo);
    // A crash after the merge but before "done" was written: finish the bookkeeping.
    const merged = await git.findItemCommit(ws.repo, target, itemId);
    if (merged) {
      await ledger.transition(itemId, owner, "merging", "done", "merged", { commit: merged, target, recovered: true }, { commit_sha: merged });
      out(`${itemId} done: already merged as ${merged.slice(0, 7)}`);
      return { status: "done", itemId, commit: merged };
    }
    if (!item.commit_sha || !item.worktree) {
      await ledger.transition(itemId, owner, "merging", "done", "completed", { commit: null });
      return { status: "done", itemId };
    }
    let head: string;
    try {
      head = await git.rebaseOnto(item.worktree, target);
    } catch (e) {
      if (e instanceof FoundryError) return await sendBack(e);
      throw e;
    }
    const verified = (await ledger.events(itemId)).filter((e) => e.type === "verified").at(-1);
    const alreadyVerified = verified?.payload.sha === head && verified?.payload.command === fullVerify;
    if (fullVerify && !alreadyVerified) {
      out(`${itemId} merge verify: ${fullVerify}`);
      const r = await runVerify(item.worktree, fullVerify);
      if (!r.passed) {
        return await sendBack(new FoundryError("verifier", `\`${fullVerify}\` failed on top of ${target} (exit ${r.exitCode})`, `foundry status ${itemId}`), { output: tail(r.output) });
      }
      await ledger.record(itemId, owner, "merge_verified", { command: fullVerify, sha: head });
    }
    await git.fastForward(ws.repo, target, head);
    await ledger.transition(itemId, owner, "merging", "done", "merged", { commit: head, target, branch: item.branch }, { commit_sha: head });
    out(`${itemId} done: merged ${head.slice(0, 7)} into ${target}`);
    return { status: "done", itemId, commit: head };
  } catch (e) {
    const error = e instanceof FoundryError ? e : new FoundryError("git", `merge failed: ${(e as Error).message}`, `foundry status ${itemId}`);
    if (error.layer === "ledger") return { status: "failed", itemId, error };
    return await sendBack(error).catch(() => ({ status: "failed" as const, itemId, error }));
  } finally {
    clearInterval(renew);
  }
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

// A worker loop: patrol, then merge-queue work, then ready items. Without
// `watch` it exits once nothing is left that a worker could do; items waiting
// for a person do not keep it alive.
export async function workQueue(
  ws: Workspace,
  opts: { watch?: boolean; runId?: string } = {},
): Promise<{ worked: Outcome[]; fatal?: FoundryError }> {
  const worked: Outcome[] = [];
  const ttl = ws.config.leases.ttl_seconds;
  for (;;) {
    for (const id of await ws.ledger.recoverExpired()) ws.out(`${id} lease expired; recovered`);
    for (const id of await ws.ledger.flagStalls(ws.config.workers.stall_seconds * 1000)) ws.out(`${id} has been quiet for a while (stalled?)`);
    const mergeId = await ws.ledger.claimMerge(ws.owner, ttl, opts.runId);
    if (mergeId) {
      worked.push(await mergeItem(ws, mergeId));
      continue;
    }
    const itemId = await ws.ledger.claimNext(ws.owner, ttl, opts.runId);
    if (itemId) {
      const item = (await ws.ledger.getItem(itemId))!;
      ws.out(`${itemId} claimed by ${ws.owner} (attempt ${item.attempt}): ${item.title}`);
      const outcome = await processItem(ws, itemId);
      worked.push(outcome);
      // The agent could not start; retrying now would fail the same way.
      if (outcome.status === "unavailable") return { worked, fatal: outcome.error };
      continue;
    }
    if (!opts.watch && !(await ws.ledger.hasActiveItems(opts.runId))) return { worked };
    await new Promise((r) => setTimeout(r, opts.watch ? 1000 : 300));
  }
}

// N worker loops in this process, each with its own lease owner.
export async function workers(ws: Workspace, count: number, opts: { watch?: boolean; runId?: string } = {}) {
  const owners = count === 1 ? [ws.owner] : Array.from({ length: count }, (_, i) => `${ws.owner}:w${i + 1}`);
  const results = await Promise.all(owners.map((owner) => workQueue({ ...ws, owner }, opts)));
  return { worked: results.flatMap((r) => r.worked), fatal: results.find((r) => r.fatal)?.fatal };
}
