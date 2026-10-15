// Autopilot: a role resolves a decision point instead of a person. The
// path is the same as in manual mode (Waiting for input, At gate); only the
// resolver differs. The kernel guards the resolution: a role never resolves
// its own question or work, evidence must resolve to something real, the
// resolver runs on another agent where one is configured, and locked paths
// and environment changes wait for a person.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { otherAgent } from "../schemas/config.js";
import type { Step } from "../schemas/formula.js";
import type { AnswerResolution, Citation, GateResolution, Result } from "../schemas/result.js";
import { activeDecisions, copyContext, launchSession, layeredRules, packOf, type Outcome, type Workspace } from "./dispatcher.js";
import { buildResolverEnvelope } from "./envelope.js";
import { FoundryError } from "./errors.js";
import * as git from "./git.js";
import type { InputRef, Item, Run } from "./ledger.js";

// "payments/**" matches everything under payments/; "*" stays within one
// path segment.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function lockedFiles(files: string[], globs: string[]): string[] {
  const res = globs.map(globToRegExp);
  return files.filter((f) => res.some((r) => r.test(f)));
}

const inTree = (repo: string, ref: string, file: string) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Each citation must resolve: the run's request (and a quote from it, if
// given), an artifact of a finished item of this run, a file in the
// workspace, or a decision record that nothing rejected.
export async function checkEvidence(ws: Workspace, run: Run, item: Item, citations: Citation[]): Promise<{ valid: boolean; resolved: string[]; problems: string[] }> {
  const resolved: string[] = [];
  const problems: string[] = [];
  const target = await git.targetBranch(ws.repo);
  const items = await ws.ledger.listItems(run.id);
  const approved = new Set(
    items
      .filter((i) => i.status === "done" && i.result_json)
      .flatMap((i) => ((JSON.parse(i.result_json!) as Result).artifacts ?? []).map((a) => path.normalize(a.path))),
  );
  const status = await ws.ledger.decisionStatus();
  const inWorkspace = (ref: string) => {
    const rel = path.normalize(ref);
    if (path.isAbsolute(rel) || rel.startsWith("..")) return false;
    return (item.worktree !== null && fs.existsSync(path.join(item.worktree, rel))) || inTree(ws.repo, target, rel);
  };
  for (const c of citations) {
    const label = `${c.kind}${c.ref ? `:${c.ref}` : ""}`;
    if (c.kind === "request") {
      if (!run.input.trim()) problems.push("the run has no request to cite");
      else if (c.quote && !run.input.toLowerCase().includes(c.quote.toLowerCase())) problems.push(`the request does not say "${c.quote}"`);
      else resolved.push(label);
    } else if (!c.ref) {
      problems.push(`a ${c.kind} citation needs a ref`);
    } else if (c.kind === "artifact") {
      if (!approved.has(path.normalize(c.ref))) problems.push(`${c.ref} is not an artifact of a finished item in ${run.id}`);
      else if (!inWorkspace(c.ref)) problems.push(`${c.ref} does not exist`);
      else resolved.push(label);
    } else if (c.kind === "context") {
      if (!inWorkspace(c.ref)) problems.push(`${c.ref} is not a file in the workspace`);
      else resolved.push(label);
    } else {
      const d = (await ws.ledger.decisions({})).find((x) => x.id === c.ref);
      if (!d) problems.push(`no decision ${c.ref}`);
      else if (status.get(d.id)?.status === "rejected") problems.push(`${c.ref} was rejected`);
      else resolved.push(label);
    }
  }
  if (citations.length === 0) problems.push("no evidence cited");
  return { valid: problems.length === 0, resolved, problems };
}

// Why a decision point of an autopilot run must wait for a person, if it must.
export async function holdReason(ws: Workspace, step: Step, locked: string[]): Promise<string | null> {
  if (locked.length) return `the change touches locked paths: ${locked.join(", ")}`;
  if (step.environment_change) return "this step would change a real environment";
  if (!(await ws.ledger.autopilotOn())) return "autopilot is off";
  return null;
}

const MAX_RESOLVER_TRIES = 2;

// One resolver session on a decision point this worker holds.
export async function resolveItem(ws: Workspace, itemId: string): Promise<Outcome> {
  const { ledger, owner, out } = ws;
  const item = (await ledger.getItem(itemId))!;
  const run = (await ledger.getRun(item.run_id))!;
  const step = JSON.parse(item.spec_json!) as Step;
  const pack = packOf(run);
  const kind = item.status === "waiting_input" ? "answer" : "gate";
  const names = pack?.autopilot ?? { answerer: "answerer", reviewer: "reviewer" };
  const roleName = kind === "answer" ? names.answerer : (step.review ?? names.reviewer);
  const hold = async (reason: string): Promise<Outcome> => {
    await ledger.hold(itemId, reason, "kernel");
    out(`${itemId} waits for a person: ${reason}`);
    return { status: "held", itemId };
  };
  if (roleName === item.role) return hold(`the ${roleName} role ${kind === "answer" ? "asked this question" : "did this work"}, and a role never resolves its own decision point`);
  if (!item.worktree || !fs.existsSync(item.worktree)) return hold("the item's worktree is gone, so no role can look at its work");
  const tries = (await ledger.events(itemId)).filter((e) => e.type === "resolver_failed" && e.payload.attempt === item.attempt).length;
  if (tries >= MAX_RESOLVER_TRIES) return hold(`the ${roleName} role did not resolve it in ${tries} sessions`);

  const ttl = ws.config.leases.ttl_seconds;
  const lost = new AbortController();
  const renew = setInterval(
    () => void ledger.renewLease(itemId, owner, ttl).then((held) => held || lost.abort(), () => lost.abort()),
    Math.max(250, (ttl * 1000) / 3),
  );
  const agent = otherAgent(ws.config, item.agent);
  const actor = `${roleName}@${agent}`;
  try {
    out(`${itemId} ${kind === "answer" ? "question" : "gate"} goes to ${actor}`);
    await ledger.record(itemId, owner, "resolver_started", { kind, role: roleName, agent, author: item.agent, attempt: item.attempt });
    const role = pack?.roles.get(roleName);
    const wt = { path: item.worktree, branch: item.branch ?? "" };
    const context = copyContext(pack, role?.knowledge ?? [], wt.path);
    const inputs = JSON.parse(item.inputs_json ?? "[]") as InputRef[];
    const runItems = await ledger.listItems(run.id);
    const result = item.result_json ? (JSON.parse(item.result_json) as Result) : null;
    const changed = kind === "gate" && item.commit_sha && item.lane_start ? await git.changedFiles(wt.path, item.lane_start, item.commit_sha) : [];
    const envelope = buildResolverEnvelope({
      kind,
      item,
      run,
      step,
      roleName,
      rolePrompt: role?.promptText ?? "",
      worktree: wt.path,
      inputs,
      questions: (await ledger.questions(itemId)).filter((q) => q.answer === null),
      notes: await ledger.notes(itemId),
      decisions: await activeDecisions(ledger, runItems.map((i) => i.id)),
      approved: runItems
        .filter((i) => i.status === "done" && i.result_json)
        .flatMap((i) => ((JSON.parse(i.result_json!) as Result).artifacts ?? []).map((a) => ({ ...a, item: i.id, step: i.step_id }))),
      result,
      changed,
      checks: (await ledger.events(itemId)).filter((e) => e.type === "verified" || e.type === "checked").map((e) => e.payload),
      rules: layeredRules(ws, pack),
      context,
    });
    await launchSession(ws, {
      item,
      run,
      roleName,
      wt,
      agent,
      envelope,
      tag: `${itemId}-a${item.attempt}-${kind}`,
      handle: { item: itemId, attempt: item.attempt, ledger: path.join(ws.stateDir, "foundry.db"), review: false, resolve: kind },
      tools: ["read", "shell"],
      eventPrefix: "resolver_",
      context,
      signal: lost.signal,
    });
    await git.resetWorktree(wt.path);
    const resolution = await ledger.latestResolution(itemId, item.attempt, kind);
    if (!resolution) {
      await ledger.releaseDecision(itemId, owner, `the ${roleName} role ended without a valid resolution`, item.attempt);
      return { status: "retry", itemId, error: new FoundryError("agent", "no valid resolution was submitted", `foundry log ${itemId}`) };
    }
    if (kind === "answer") {
      const { answers } = resolution as AnswerResolution;
      const open = (await ledger.questions(itemId)).filter((q) => q.answer === null);
      for (const q of open) {
        const a = answers.find((x) => x.question === q.id) ?? (open.length === 1 && answers.length === 1 ? answers[0] : undefined);
        if (!a) {
          await ledger.releaseDecision(itemId, owner, `no answer to ${q.id}`, item.attempt);
          return { status: "retry", itemId, error: new FoundryError("agent", `the resolution has no answer to ${q.id}`, `foundry log ${itemId}`) };
        }
        const ev = await checkEvidence(ws, run, item, a.evidence);
        const rationale = ev.valid ? a.rationale : `${a.rationale} [assumption: ${ev.problems.join("; ")}]`;
        await ledger.answer(q.id, a.answer, actor, { owner, kind: ev.valid ? "decision" : "assumption", rationale, evidence: ev.resolved });
        out(`${itemId} ${q.id} answered by ${actor}: ${JSON.stringify(a.answer)}${ev.valid ? "" : " (logged as an assumption)"}`);
      }
    } else {
      const g = resolution as GateResolution;
      for (const f of g.findings) await ledger.addNote(itemId, item.attempt, "review", actor, f);
      const ev = await checkEvidence(ws, run, item, g.evidence);
      await ledger.gate(itemId, actor, g.verdict === "approve", g.comment, { owner, kind: "decision", rationale: g.comment, evidence: ev.resolved });
      out(`${itemId} gate ${g.verdict === "approve" ? "approved" : "rejected"} by ${actor}: ${g.comment.split("\n")[0]}`);
    }
    return { status: "resolved", itemId };
  } catch (e) {
    const error = e instanceof FoundryError ? e : new FoundryError("agent", `the resolver failed: ${(e as Error).message}`, `foundry log ${itemId}`);
    // A person, the kill switch or a lost lease took the decision point over.
    if (error.layer === "ledger") return { status: "held", itemId };
    await ledger.releaseDecision(itemId, owner, error.message, item.attempt).catch(() => {});
    return { status: "retry", itemId, error };
  } finally {
    clearInterval(renew);
  }
}
