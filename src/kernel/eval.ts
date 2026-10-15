// Evals: approved items frozen as benchmark cases, replayed in fresh
// worktrees from their base commit, graded by the engine (verify command for
// code; sensors plus a judge's rubric for documents), and compared between
// pack versions or agents. Replays use their own ledger (.foundry/evals.db),
// so the factory's stats stay about real work.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { otherAgent } from "../schemas/config.js";
import type { Formula, Step } from "../schemas/formula.js";
import type { Pack, VerifierDef } from "../schemas/pack.js";
import type { JudgeResult, Result } from "../schemas/result.js";
import { BUILTIN_CHECKS } from "./checks.js";
import { activeDecisions, copyContext, launchSession, layeredRules, packOf, type Workspace } from "./dispatcher.js";
import { buildEnvelope, buildJudgeEnvelope } from "./envelope.js";
import { FoundryError } from "./errors.js";
import * as git from "./git.js";
import { Ledger, type DecisionRecord, type InputRef, type Item, type Note, type Question, type Run } from "./ledger.js";
import { runVerify } from "./verifier.js";

const exec = promisify(execFile);
export const BENCH_DIR = "benchmarks";
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+\.py$/;
export type Split = "dev" | "held-out";

export interface BenchCase {
  id: string;
  split: Split;
  source: { item: string; run: string; step: string; unit: string | null; role: string; review: string | null; agent: string | null; formula: string; pack: { name: string; version: string; dir: string | null } };
  base_commit: string;
  accepted_commit: string;
  // The envelope as data: what the accepted attempt was given. The role
  // prompt, step instructions and rules come from the pack being evaluated.
  envelope: {
    item: Pick<Item, "title" | "goal" | "inputs" | "unit" | "attempt" | "max_attempts" | "role">;
    run: Pick<Run, "id" | "title" | "goal" | "input">;
    inputs: InputRef[];
    inputDecisions: DecisionRecord[];
    notes: Note[];
    questions: Question[];
    params: Record<string, string>;
    fullVerify?: string;
  };
  // `tests`: test files the accepted change added or changed, kept in
  // benchmarks/<case>/tests/ and put into each trial before its verify, so
  // a trial that does nothing cannot pass a suite that was green before.
  verify: { command: string | null; checks: VerifierDef[]; docs_only: boolean; tests: string[] };
  accepted: { summary: string; result: Result | null; files: string[] };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// From the item's content, so the same item gets the same id in any setup.
export function caseId(formula: string, step: string, unit: string | null, request: string, title: string): string {
  const slug = unit ? `-${unit.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 24)}` : "";
  return `${step}${slug}-${sha([formula, step, unit ?? "", request, title].join("\u0000")).slice(0, 8)}`;
}

// About 70/30 by a hash of the id.
export function splitOf(id: string): Split {
  return parseInt(sha(id).slice(0, 8), 16) % 100 < 70 ? "dev" : "held-out";
}

const gitOut = async (cwd: string, args: string[]) => (await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

// `foundry bench add`: freeze an approved item as a case.
export async function benchAdd(ws: Workspace, itemId: string): Promise<BenchCase> {
  const { ledger } = ws;
  const item = await ledger.getItem(itemId);
  if (!item) throw new FoundryError("ledger", `no item ${itemId}`, "foundry status");
  if (item.status !== "done") throw new FoundryError("ledger", `${itemId} is ${item.status.replace("_", " ")}; only approved, finished items become benchmark cases`, `foundry status ${itemId}`);
  const target = await git.targetBranch(ws.repo);
  const accepted = await git.findItemCommit(ws.repo, target, itemId);
  if (!accepted) throw new FoundryError("git", `${itemId} has no merged commit on ${target} (it changed no files, or its lane has not merged yet)`, `foundry status ${itemId}`);
  const base = await gitOut(ws.repo, ["rev-parse", `${accepted}^`]);
  const run = (await ledger.getRun(item.run_id))!;
  const formula = JSON.parse(run.formula_json!) as Formula;
  const step = JSON.parse(item.spec_json!) as Step;
  const pack = packOf(run);
  const id = caseId(run.formula, step.id, item.unit, run.input, item.title);
  const dir = path.join(ws.repo, BENCH_DIR, id);
  if (fs.existsSync(dir)) throw new FoundryError("config", `${itemId} is already in the benchmark as ${id}`, `ls ${path.relative(ws.repo, dir)}`);
  const inputs = JSON.parse(item.inputs_json ?? "[]") as InputRef[];
  const command = step.verify ?? formula.verify ?? ws.config.project.test_command ?? null;
  const files = await git.changedFiles(ws.repo, base, accepted);
  const docsOnly = step.docs_only || !command;
  const present = new Set((await gitOut(ws.repo, ["ls-tree", "-r", "--name-only", accepted])).split("\n"));
  const tests = docsOnly ? [] : files.filter((f) => TEST_FILE.test(f) && present.has(f));
  const c: BenchCase = {
    id,
    split: splitOf(id),
    source: {
      item: itemId,
      run: run.id,
      step: step.id,
      unit: item.unit,
      role: step.role,
      review: step.review ?? null,
      agent: item.agent,
      formula: run.formula,
      pack: { name: pack?.name ?? run.formula, version: pack?.version ?? String(run.formula_version), dir: run.pack_dir },
    },
    base_commit: base,
    accepted_commit: accepted,
    envelope: {
      item: { title: item.title, goal: item.goal, inputs: item.inputs, unit: item.unit, attempt: item.attempt, max_attempts: item.max_attempts, role: item.role },
      run: { id: run.id, title: run.title, goal: run.goal, input: run.input },
      inputs,
      inputDecisions: await activeDecisions(ledger, inputs.map((i) => i.item)),
      // What the accepted attempt saw: everything from the attempts before it.
      notes: (await ledger.notes(itemId)).filter((n) => n.attempt < item.attempt),
      questions: (await ledger.questions(itemId)).filter((q) => q.attempt < item.attempt),
      params: JSON.parse(run.params_json ?? "{}"),
      fullVerify: formula.verify,
    },
    verify: {
      command,
      checks: step.verifiers.map((v) => pack?.verifiers.get(v)).filter((v): v is VerifierDef => !!v),
      docs_only: docsOnly,
      tests,
    },
    accepted: { summary: item.result_json ? (JSON.parse(item.result_json) as Result).summary : item.title, result: item.result_json ? JSON.parse(item.result_json) : null, files },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify(c, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "accepted.patch"), await gitOut(ws.repo, ["diff", "--binary", base, accepted]) + "\n");
  const original = path.join(ws.stateDir, "envelopes", `${itemId}-a${item.attempt}.md`);
  if (fs.existsSync(original)) fs.copyFileSync(original, path.join(dir, "envelope.md"));
  for (const t of tests) {
    const dest = path.join(dir, "tests", t);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, (await exec("git", ["show", `${accepted}:${t}`], { cwd: ws.repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout);
  }
  // The base commit must outlive branch clean-ups.
  await gitOut(ws.repo, ["update-ref", `refs/foundry/bench/${id}`, base]);
  return c;
}

export function loadCases(repo: string, set: Split | "all" = "all"): BenchCase[] {
  const dir = path.join(repo, BENCH_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .filter((d) => fs.existsSync(path.join(dir, d, "case.json")))
    .map((d) => JSON.parse(fs.readFileSync(path.join(dir, d, "case.json"), "utf8")) as BenchCase)
    .filter((c) => set === "all" || c.split === set);
}

export function loadCase(repo: string, id: string): BenchCase {
  const f = path.join(repo, BENCH_DIR, id, "case.json");
  if (!fs.existsSync(f)) throw new FoundryError("config", `no benchmark case ${id}`, "foundry bench list");
  return JSON.parse(fs.readFileSync(f, "utf8")) as BenchCase;
}

// Agent sessions one trial starts: the role, plus a judge for documents.
export const sessionsPerTrial = (c: BenchCase) => (c.verify.docs_only ? 2 : 1);

export interface Trial {
  trial: number;
  item: string; // in the eval ledger
  worktree: string;
  base: string;
  agent: string;
  passed: boolean;
  reason: string;
}

export interface EvalContext {
  ws: Workspace;
  ledger: Ledger; // .foundry/evals.db
  dir: string; // .foundry/evals
}

export async function openEvals(ws: Workspace): Promise<EvalContext> {
  const dir = path.join(ws.stateDir, "evals");
  fs.mkdirSync(dir, { recursive: true });
  return { ws, ledger: await Ledger.open(path.join(dir, "evals.db")), dir };
}

// `foundry replay`: N trials of one case with one pack version and agent.
export async function replayCase(ev: EvalContext, c: BenchCase, pack: Pack, agent: string, trials: number): Promise<Trial[]> {
  const out: Trial[] = [];
  for (let t = 1; t <= trials; t++) out.push(await runTrial(ev, c, pack, agent, t, trials));
  return out;
}

async function runTrial(ev: EvalContext, c: BenchCase, pack: Pack, agent: string, t: number, n: number): Promise<Trial> {
  const { ws, ledger } = ev;
  const packStep = pack.formula.steps.find((s) => s.id === c.source.step);
  if (!packStep) throw new FoundryError("config", `pack ${pack.name} ${pack.version} has no step "${c.source.step}" for case ${c.id}`, "eval a version of the pack the case came from");
  // One step, nothing around it: no needs, fan-out, gate or review.
  const step: Step = { ...packStep, needs: [], per: undefined, gate: undefined, review: undefined, inputs: [], max_attempts: 1, environment_change: false };
  const formula: Formula = { formula: `replay:${c.id}`, version: 1, title: `replay ${c.id}`, verify: undefined, oneStep: false, steps: [step] };
  const label = `${c.id} trial ${t} of ${n} (pack ${pack.name} ${pack.version})`;
  const { runId, itemIds } = await ledger.startRun({ formula, title: `replay ${label}`, input: c.envelope.run.input, packDir: pack.dir });
  const itemId = itemIds[0]!;
  const ttl = ws.config.leases.ttl_seconds;
  if (!(await ledger.claim(itemId, ws.owner, ttl))) throw new FoundryError("ledger", `could not claim the replay item ${itemId}`, "foundry replay again");
  const renew = setInterval(() => void ledger.renewLease(itemId, ws.owner, ttl).catch(() => {}), Math.max(250, (ttl * 1000) / 3));
  const wt = path.join(ev.dir, "worktrees", itemId);
  const finish = async (passed: boolean, reason: string): Promise<Trial> => {
    await ledger.transition(itemId, ws.owner, ["running", "verifying"], passed ? "done" : "failed", "graded", { passed, reason, case: c.id, trial: t });
    ws.out(`${c.id} trial ${t}/${n} on ${agent}: ${passed ? "pass" : "fail"} (${reason})`);
    return { trial: t, item: itemId, worktree: wt, base: c.base_commit, agent, passed, reason };
  };
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await gitOut(ws.repo, ["worktree", "add", "-q", "--detach", wt, c.base_commit]);
    // The benchmark itself is never visible to the role under test.
    fs.rmSync(path.join(wt, BENCH_DIR), { recursive: true, force: true });
    await ledger.enterLane(itemId, ws.owner, { path: wt, base: c.base_commit, case: c.id, trial: t, replay: true }, { worktree: wt, branch: "(detached)", lane_start: c.base_commit, agent });
    const run = (await ledger.getRun(runId))!;
    const role = pack.roles.get(step.role);
    const context = copyContext(pack, [...(role?.knowledge ?? []), ...step.context], wt);
    const e = c.envelope;
    const item = { ...(await ledger.getItem(itemId))!, ...e.item, id: itemId } as Item;
    const envelope = buildEnvelope({
      item,
      run: { ...run, id: e.run.id, title: e.run.title, goal: e.run.goal, input: e.run.input },
      step,
      rolePrompt: role?.promptText ?? "",
      instructions: step.instructions && pack.dir ? fs.readFileSync(path.join(pack.dir, step.instructions), "utf8") : "",
      worktree: wt,
      branch: "(replay)",
      inputs: e.inputs,
      inputDecisions: e.inputDecisions,
      notes: e.notes,
      questions: e.questions,
      runItems: [],
      context,
      rules: layeredRules(ws, pack),
      params: e.params,
      fullVerify: e.fullVerify,
      replay: label,
    });
    await launchSession(ws, {
      item: { ...item, attempt: 1 },
      run,
      roleName: step.role,
      wt: { path: wt, branch: "(replay)" },
      agent,
      envelope,
      tag: itemId,
      handle: { item: itemId, attempt: 1, ledger: path.join(ev.dir, "evals.db"), review: false },
      eventPrefix: "",
      context,
      ledger,
      stateDir: ev.dir,
    });

    if ((await ledger.questions(itemId)).some((q) => q.answer === null)) return await finish(false, "asked a question; a replay has no one to answer");
    const result = await ledger.latestSubmission(itemId, 1);
    if (step.submit && !result) return await finish(false, "no valid submission");
    if (result?.status === "skipped") return await finish(false, `skipped: ${result.reason}`);
    await ledger.transition(itemId, ws.owner, "running", "verifying", "verifying", { command: c.verify.command });
    const commit = await git.squashCommit(wt, c.base_commit, `${itemId}: replay ${c.id}`, itemId);
    const files = commit ? await git.changedFiles(wt, c.base_commit, commit) : [];
    if (!c.verify.docs_only) {
      for (const t of c.verify.tests ?? []) {
        fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true });
        fs.copyFileSync(path.join(ws.repo, BENCH_DIR, c.id, "tests", t), path.join(wt, t));
      }
      const r = await runVerify(wt, c.verify.command!);
      await ledger.record(itemId, ws.owner, r.passed ? "verified" : "verify_failed", { command: c.verify.command, exitCode: r.exitCode, output: r.output.slice(-1000) });
      return await finish(r.passed, r.passed ? `\`${c.verify.command}\` passed` : `\`${c.verify.command}\` failed (exit ${r.exitCode})`);
    }
    // Documents: every sensor must pass, then the judge's rubric.
    const findings: string[] = [];
    for (const def of c.verify.checks) {
      const check = BUILTIN_CHECKS.get(def.builtin);
      if (!check) continue;
      const r = await check({ worktree: wt, step, result, changedFiles: files, inputs: e.inputs });
      await ledger.record(itemId, ws.owner, "checked", { verifier: def.id, pass: r.pass, findings: r.findings });
      if (!r.pass) findings.push(...r.findings.map((f) => `${def.id}: ${f}`));
    }
    if (findings.length) return await finish(false, `sensors: ${findings.slice(0, 3).join("; ")}`);
    const verdict = await judge(ev, c, pack, run, item, wt, agent, result, files, findings);
    return await finish(verdict.passed, verdict.reason);
  } catch (err) {
    const error = err instanceof FoundryError ? err : new FoundryError("agent", (err as Error).message, `foundry log ${itemId} (in .foundry/evals/evals.db)`);
    return await finish(false, `${error.layer}: ${error.message.split("\n")[0]}`).catch(() => ({ trial: t, item: itemId, worktree: wt, base: c.base_commit, agent, passed: false, reason: error.message }));
  } finally {
    clearInterval(renew);
    await git.removeLane(ws.repo, wt, null).catch(() => {});
  }
}

// A judge on another agent where one is configured scores a document output
// against the rubric, with the accepted output as the reference.
async function judge(ev: EvalContext, c: BenchCase, pack: Pack, run: Run, item: Item, wt: string, author: string, result: Result | null, files: string[], findings: string[]) {
  const { ws, ledger } = ev;
  const roleName = c.source.review ?? pack.autopilot.reviewer;
  const role = pack.roles.get(roleName);
  const agent = otherAgent(ws.config, author);
  fs.writeFileSync(path.join(wt, ".foundry", "accepted.patch"), fs.readFileSync(path.join(ws.repo, BENCH_DIR, c.id, "accepted.patch")));
  const envelope = buildJudgeEnvelope({
    caseId: c.id,
    step: pack.formula.steps.find((s) => s.id === c.source.step)!,
    request: c.envelope.run.input,
    goal: c.envelope.item.goal,
    inputs: c.envelope.inputs,
    roleName,
    rolePrompt: role?.promptText ?? "",
    worktree: wt,
    accepted: { summary: c.accepted.summary, artifacts: c.accepted.result?.artifacts ?? [], files: c.accepted.files },
    trial: { summary: result?.summary ?? "(no result)", artifacts: result?.artifacts ?? [], files },
    findings,
  });
  await launchSession(ws, {
    item: { ...item, attempt: 1 },
    run,
    roleName,
    wt: { path: wt, branch: "(replay)" },
    agent,
    envelope,
    tag: `${item.id}-judge`,
    handle: { item: item.id, attempt: 1, ledger: path.join(ev.dir, "evals.db"), review: false, resolve: "judge" },
    tools: ["read", "shell"],
    eventPrefix: "judge_",
    context: copyContext(pack, role?.knowledge ?? [], wt),
    ledger,
    stateDir: ev.dir,
  });
  const j = (await ledger.latestResolution(item.id, 1, "judge")) as JudgeResult | null;
  if (!j) return { passed: false, reason: `the judge (${roleName}@${agent}) submitted no verdict` };
  const failed = Object.entries(j.criteria).filter(([, v]) => !v).map(([k]) => k);
  return { passed: failed.length === 0, reason: failed.length ? `judge ${roleName}@${agent}: not ${failed.join(", ")}: ${j.comment}` : `judge ${roleName}@${agent}: meets the rubric` };
}

export interface CaseScore {
  case: string;
  step: string;
  role: string;
  passes: Record<string, number>; // by version or agent label
  trials: number;
}

// B is better when its total passes are higher and no case loses passes.
export function verdict(scores: CaseScore[], a: string, b: string): { better: boolean; totalA: number; totalB: number; losses: string[] } {
  const totalA = scores.reduce((n, s) => n + (s.passes[a] ?? 0), 0);
  const totalB = scores.reduce((n, s) => n + (s.passes[b] ?? 0), 0);
  const losses = scores.filter((s) => (s.passes[b] ?? 0) < (s.passes[a] ?? 0)).map((s) => s.case);
  return { better: totalB > totalA && losses.length === 0, totalA, totalB, losses };
}

// Every case under each variant (a pack version, or an agent with one pack).
export async function compare(ev: EvalContext, cases: BenchCase[], variants: { label: string; pack: Pack; agent: string }[], trials: number): Promise<CaseScore[]> {
  const scores: CaseScore[] = [];
  for (const c of cases) {
    const s: CaseScore = { case: c.id, step: c.source.step, role: c.source.role, passes: {}, trials };
    for (const v of variants) s.passes[v.label] = (await replayCase(ev, c, v.pack, v.agent, trials)).filter((t) => t.passed).length;
    scores.push(s);
  }
  return scores;
}
