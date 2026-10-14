#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { workerId, workers, type Workspace } from "../kernel/dispatcher.js";
import { FoundryError } from "../kernel/errors.js";
import * as git from "../kernel/git.js";
import { Ledger, type InputRef, type Item } from "../kernel/ledger.js";
import { compile, describePlan } from "../kernel/compile.js";
import { importAidlc } from "../import/aidlc.js";
import { parseConfig, type Config } from "../schemas/config.js";
import { loadPack, validatePack, type Pack } from "../schemas/pack.js";
import { cmdAsk, cmdNote, cmdSubmit } from "./agent.js";
import { runFactory } from "./factory.js";
import { summarize } from "./format.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `usage:
  foundry run <pack|formula> [--input <text>] [--workers N]   start a run and work it
  foundry add <pack|formula> --input <text>     start a run for workers to pick up
  foundry work [--workers N]                    work ready items; resume after a crash
  foundry factory <formula> [--workers N]       live board of workers and worktrees; type to add work
  foundry status [RUN-n|WI-n]                   list items, or show a run or item in detail
  foundry log <item>                            show the item's audit log
  foundry answer <WI-n|Q-n> <answer>            answer an item's question
  foundry approve <WI-n> [--comment <text>]     approve an item at its gate
  foundry reject <WI-n> --comment <text>        send an item at its gate back with a comment
  foundry decisions [RUN-n]                     the decision log
  foundry why <file>:<line>                     commit, item, decisions, inputs and run behind a line
  foundry validate <pack>                       check a pack
  foundry import aidlc [--source <dir>] [--out <dir>]   import AI-DLC into packs/aidlc
  foundry plan <pack> [--profile <p>] [--param k=v] --dry-run [--json]   show the compiled plan

run and add also take --profile <p> and --param k=v (repeatable) for packs with profiles.

Inside an item's worktree, agents use ./.foundry/bin/foundry submit | note | ask | handoff.

<pack|formula> is a pack folder, a formula .toml file, or a built-in name (${builtinFormulas().join(", ")}).`;

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
  const selfCommand = [process.execPath, ...process.execArgv, path.resolve(process.argv[1]!)];
  return { repo, stateDir, config, ledger, owner: workerId(), out: (l) => console.log(l), selfCommand };
}

function resolvePack(arg: string): Pack {
  const candidates = [arg, path.join(pkgRoot, "formulas", `${arg}.toml`), path.join(process.cwd(), "packs", arg)];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new FoundryError(
      "config",
      `no pack or formula "${arg}" (not a folder or file, and not a built-in: ${builtinFormulas().join(", ")})`,
      "pass a pack folder or a formula .toml file, or `foundry run health-endpoint`",
    );
  }
  const pack = loadPack(found);
  return pack.dir ? { ...pack, dir: path.resolve(pack.dir) } : pack;
}

function parseParams(list: string[] | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new FoundryError("config", `--param takes key=value, got "${kv}"`, "foundry run packs/aidlc --profile bugfix --param depth=Minimal");
    params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return params;
}

// Compiles the pack (and profile) into the formula the run pins. Formulas
// without a title take the request as the run's title.
async function startRun(ws: Workspace, pack: Pack, input: string, profile?: string, paramList?: string[]) {
  const c = compile(pack, { profile, params: parseParams(paramList), repo: ws.repo, testCommand: ws.config.project.test_command });
  const f = c.formula;
  const title = (input ? (input.length > 60 ? input.slice(0, 57) + "..." : input) : undefined) ?? f.title ?? f.formula;
  const named = f.title && !input ? f.title : title;
  const ids = await ws.ledger.startRun({ formula: f, title: pack.formula.oneStep ? (f.title ?? title) : named, input, packDir: pack.dir, params: c.params });
  if (c.profile || Object.keys(c.params).length) await ws.ledger.runNote(ids.runId, "run_setup", { profile: c.profile, params: c.params, settings: c.settings, setup: c.setup });
  return { ...ids, title };
}

function workersArg(args: string[], extra: Record<string, { type: "string"; multiple?: boolean }> = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { workers: { type: "string" }, ...extra } });
  const n = values.workers === undefined ? undefined : Number(values.workers);
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    throw new FoundryError("config", `--workers must be a whole number, got "${values.workers}"`, "foundry work --workers 2");
  }
  return { positionals, values: values as Record<string, string | undefined> & { param?: string[] }, workers: n };
}

const failureOf = async (ws: Workspace, itemId: string) => {
  const failed = (await ws.ledger.events(itemId)).filter((e) => e.type === "failed").at(-1);
  const p = (failed?.payload ?? {}) as { layer?: string; message?: string; next?: string };
  return new FoundryError((p.layer as never) ?? "ledger", `${itemId}: ${p.message ?? "failed"}`, p.next ?? `foundry status ${itemId}`);
};

// What a run is waiting on, with the command for each.
async function reportRun(ws: Workspace, runId: string): Promise<number> {
  const run = (await ws.ledger.getRun(runId))!;
  const items = await ws.ledger.listItems(runId);
  for (const i of items.filter((i) => i.status === "waiting_input")) {
    for (const q of (await ws.ledger.questions(i.id)).filter((q) => q.answer === null)) {
      ws.out(`${i.id} asks ${q.id}: ${q.question}  [${JSON.parse(q.options_json).join(" / ")}]  ->  foundry answer ${i.id} "<answer>"`);
    }
  }
  for (const i of items.filter((i) => i.status === "at_gate")) ws.out(`${i.id} is at its gate  ->  foundry status ${i.id}, then foundry approve ${i.id} or foundry reject ${i.id} --comment "..."`);
  const failed = items.filter((i) => i.status === "failed");
  for (const i of failed) console.error((await failureOf(ws, i.id)).format());
  if (run.status === "done") ws.out(`${runId} done: ${items.filter((i) => i.status === "done").length} items done, ${items.filter((i) => i.status === "skipped").length} skipped`);
  return failed.length ? 1 : 0;
}

async function cmdRun(args: string[]): Promise<number> {
  const { positionals, values, workers: n } = workersArg(args, { input: { type: "string" }, profile: { type: "string" }, param: { type: "string", multiple: true } as never });
  if (positionals.length !== 1) throw new FoundryError("config", "foundry run takes one pack or formula", "foundry run health-endpoint --input \"...\"");
  const pack = resolvePack(positionals[0]!);
  const ws = await openWorkspace();
  try {
    const { runId, itemIds, title } = await startRun(ws, pack, values.input ?? "", values.profile, values.param as unknown as string[]);
    for (const id of itemIds) ws.out(`${runId} created ${id}: ${title}`);
    const { fatal } = await workers(ws, n ?? ws.config.workers.count, { runId });
    if (fatal) {
      console.error(fatal.format());
      return 1;
    }
    return await reportRun(ws, runId);
  } finally {
    await ws.ledger.close();
  }
}

async function cmdAdd(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { input: { type: "string" }, profile: { type: "string" }, param: { type: "string", multiple: true } },
  });
  if (positionals.length !== 1) throw new FoundryError("config", "foundry add takes one pack or formula", "foundry add ./formulas/feature.toml --input \"...\"");
  const pack = resolvePack(positionals[0]!);
  const ws = await openWorkspace();
  try {
    const { itemIds, title } = await startRun(ws, pack, values.input ?? "", values.profile, values.param);
    ws.out(`${itemIds.join(", ")} queued: ${title}  (start workers with \`foundry work\` or \`foundry factory\`)`);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdWork(args: string[]): Promise<number> {
  const { workers: n } = workersArg(args);
  const ws = await openWorkspace();
  try {
    const { worked, fatal } = await workers(ws, n ?? ws.config.workers.count);
    if (fatal) {
      console.error(fatal.format());
      return 1;
    }
    if (worked.length === 0) ws.out("nothing to do: no ready items");
    const failed = worked.filter((o) => o.status === "failed");
    for (const o of failed) if ("error" in o) console.error(o.error.format());
    return failed.length ? 1 : 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdFactory(args: string[]): Promise<number> {
  const { positionals, workers: n } = workersArg(args);
  if (positionals.length !== 1) throw new FoundryError("config", "foundry factory takes one formula for the work you add", "foundry factory ./formulas/feature.toml --workers 2");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new FoundryError("config", "foundry factory needs an interactive terminal", "run it in a terminal, or use `foundry add` and `foundry work`");
  const pack = resolvePack(positionals[0]!);
  const ws = await openWorkspace();
  return runFactory(ws, n ?? ws.config.workers.count, async (input) => (await startRun(ws, pack, input)).itemIds.join(", "));
}

const time = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 23);
const isLeased = (i: Item) => i.status === "running" || i.status === "verifying" || i.status === "merging";

async function cmdStatus(args: string[]): Promise<number> {
  const ws = await openWorkspace();
  try {
    if (args.length === 0) {
      const items = await ws.ledger.listItems();
      if (items.length === 0) ws.out("no items yet; start one with `foundry run health-endpoint`");
      for (const i of items) {
        const stale = isLeased(i) && (i.lease_expires_at ?? 0) < Date.now();
        ws.out(`${i.id.padEnd(6)} ${i.status.padEnd(13)} attempt ${i.attempt}  ${i.agent ?? "-"}  ${i.run_id}  ${i.title}${stale ? "  (lease expired: run `foundry work` to resume)" : ""}`);
      }
      return 0;
    }
    if (args[0]!.startsWith("RUN-")) return await statusRun(ws, args[0]!);
    const item = await ws.ledger.getItem(args[0]!);
    if (!item) throw new FoundryError("ledger", `no item ${args[0]}`, "foundry status");
    const events = await ws.ledger.events(item.id);
    const of = (t: string) => events.filter((e) => e.type === t);
    const claimed = of("claimed")[0];
    const end = [...of("merged"), ...of("completed"), ...of("failed"), ...of("skipped")].at(-1);
    const perms = of("permission");
    const lines = [
      `${item.id}: ${item.title}`,
      `  status:    ${item.status.replace("_", " ")} (attempt ${item.attempt} of ${item.max_attempts})`,
      `  run:       ${item.run_id}, step ${item.step_id}${item.unit ? `, unit ${item.unit}` : ""}, role ${item.role ?? "worker"}`,
      `  agent:     ${item.agent ?? "-"}`,
      `  worktree:  ${item.worktree ?? "-"}${item.branch ? ` (${item.branch})` : ""}`,
      `  verify:    ${item.verify || "-"}`,
    ];
    if (item.lease_owner) lines.push(`  lease:     ${item.lease_owner} until ${time(item.lease_expires_at!)}`);
    lines.push(`  activity:  ${of("tool_call").length} tool calls, ${perms.length} permission requests (${perms.filter((p) => !p.payload.allow).length} denied)`);
    if (claimed && end) lines.push(`  duration:  ${((end.ts - claimed.ts) / 1000).toFixed(1)}s from claim to ${end.type}`);
    const merged = of("merged").at(-1);
    if (merged) lines.push(`  merged:    ${String(merged.payload.commit).slice(0, 12)} into ${merged.payload.target}`);
    if (item.status === "skipped") lines.push(`  skipped:   ${String(of("skipped").at(-1)?.payload.reason ?? "")}`);
    const questions = await ws.ledger.questions(item.id);
    for (const q of questions) {
      lines.push(`  question:  ${q.id} (attempt ${q.attempt}) ${q.question}  [${JSON.parse(q.options_json).join(" / ")}${q.allow_other ? " / other" : ""}]`);
      lines.push(q.answer === null ? `             not answered: foundry answer ${item.id} "<answer>"` : `             answered "${q.answer}" by ${q.answered_by}`);
    }
    if (item.status === "at_gate") {
      lines.push("  gate:      waiting for a person");
      const reviewed = of("reviewed").at(-1);
      if (reviewed) {
        const findings = reviewed.payload.findings as string[];
        lines.push(`  review:    ${reviewed.payload.reviewer} (advisory), ${findings.length} findings`, ...findings.map((f) => `    - ${f}`));
      }
      const r = item.result_json ? JSON.parse(item.result_json) : null;
      if (r) lines.push(`  result:    ${r.summary}`);
      lines.push(`  next:      foundry approve ${item.id}   or   foundry reject ${item.id} --comment "..."`);
    }
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

async function statusRun(ws: Workspace, runId: string): Promise<number> {
  const run = await ws.ledger.getRun(runId);
  if (!run) throw new FoundryError("ledger", `no run ${runId}`, "foundry status");
  ws.out(`${run.id}: ${run.title ?? run.goal}  [${run.status}]  formula ${run.formula} v${run.formula_version}`);
  const items = await ws.ledger.listItems(runId);
  const order = (JSON.parse(run.formula_json ?? '{"steps":[]}') as { steps: { id: string }[] }).steps.map((s) => s.id);
  const steps = (await ws.ledger.runSteps(runId)).sort((a, b) => order.indexOf(a.step_id) - order.indexOf(b.step_id));
  for (const s of steps) {
    ws.out(`  step ${s.step_id.padEnd(24)} ${s.status}`);
    for (const i of items.filter((i) => i.step_id === s.step_id)) ws.out(`    ${i.id.padEnd(6)} ${i.status.replace("_", " ").padEnd(14)} attempt ${i.attempt}  ${i.title}`);
  }
  return 0;
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

// People act as `person:<git user.name or $USER>`.
function person(repo: string): string {
  let name = "";
  try {
    name = execFileSync("git", ["config", "user.name"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {}
  return `person:${name || process.env.USER || "unknown"}`;
}

async function cmdAnswer(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { question: { type: "string" } } });
  const [target, ...words] = positionals;
  const answer = words.join(" ").trim();
  if (!target || !answer) throw new FoundryError("config", "foundry answer takes an item or question id and the answer", 'foundry answer WI-3 "SQLite"');
  const ws = await openWorkspace();
  try {
    let qid = values.question ?? (target.startsWith("Q-") ? target : undefined);
    if (!qid) {
      const open = (await ws.ledger.questions(target)).filter((q) => q.answer === null);
      if (open.length === 0) throw new FoundryError("ledger", `${target} has no open question`, `foundry status ${target}`);
      if (open.length > 1) throw new FoundryError("config", `${target} has ${open.length} open questions (${open.map((q) => q.id).join(", ")})`, `foundry answer ${target} --question ${open[0]!.id} "<answer>"`);
      qid = open[0]!.id;
    }
    const { itemId, resumed } = await ws.ledger.answer(qid, answer, person(ws.repo));
    ws.out(resumed ? `${itemId} is ready again with your answer; continue with \`foundry work\`` : `recorded; ${itemId} still has open questions (foundry status ${itemId})`);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdGate(args: string[], approve: boolean): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { comment: { type: "string" } } });
  const itemId = positionals[0];
  if (!itemId) throw new FoundryError("config", `foundry ${approve ? "approve" : "reject"} takes an item id`, `foundry ${approve ? "approve WI-1" : 'reject WI-1 --comment "..."'}`);
  if (!approve && !values.comment) throw new FoundryError("config", "a rejection needs --comment, so the next attempt knows what to change", `foundry reject ${itemId} --comment "..."`);
  const ws = await openWorkspace();
  try {
    await ws.ledger.gate(itemId, person(ws.repo), approve, values.comment ?? "");
    ws.out(approve ? `${itemId} approved; it merges on the next \`foundry work\`` : `${itemId} sent back with your comment; continue with \`foundry work\``);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdDecisions(args: string[]): Promise<number> {
  const ws = await openWorkspace();
  try {
    const records = await ws.ledger.decisions(args[0] ? { runId: args[0] } : {});
    if (records.length === 0) ws.out("no decisions recorded yet");
    for (const d of records) {
      ws.out(`${d.id.padEnd(7)} ${d.kind.padEnd(10)} ${(d.item_id ?? d.run_id).padEnd(6)} ${d.step_id ?? "-"}  ${d.actor}`);
      ws.out(`        ${d.question}  ->  ${d.choice}${d.supersedes ? `  (supersedes ${d.supersedes})` : ""}`);
      if (d.rationale) ws.out(`        why: ${d.rationale}`);
    }
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdWhy(args: string[]): Promise<number> {
  const m = args[0]?.match(/^(.+):(\d+)$/);
  if (!m) throw new FoundryError("config", "foundry why takes <file>:<line>", "foundry why src/app.js:12");
  const ws = await openWorkspace();
  try {
    const target = await git.targetBranch(ws.repo);
    const { sha, message } = await git.blameLine(ws.repo, target, m[1]!, Number(m[2]));
    ws.out(`${m[1]}:${m[2]}`);
    ws.out(`  commit:    ${sha.slice(0, 12)} ${message.split("\n")[0]}`);
    const itemId = message.match(/^Foundry-Item: (WI-\d+)$/m)?.[1];
    if (!itemId) {
      ws.out("  item:      none (this line was not written through Foundry)");
      return 0;
    }
    const item = (await ws.ledger.getItem(itemId))!;
    const run = (await ws.ledger.getRun(item.run_id))!;
    ws.out(`  item:      ${item.id} ${item.title} (step ${item.step_id}, role ${item.role ?? "worker"}, attempt ${item.attempt})`);
    ws.out(`  run:       ${run.id} ${run.title ?? run.goal} (formula ${run.formula} v${run.formula_version})`);
    if (run.input) ws.out(`  request:   ${run.input}`);
    const inputs = JSON.parse(item.inputs_json ?? "[]") as InputRef[];
    ws.out(`  inputs:    ${inputs.length ? "" : "none"}`);
    for (const i of inputs) ws.out(`    - ${i.step} ${i.item} [${i.status}]: ${i.summary}`);
    const decisions = [...(await ws.ledger.decisions({ itemId })), ...(await Promise.all(inputs.map((i) => ws.ledger.decisions({ itemId: i.item })))).flat()];
    ws.out(`  decisions: ${decisions.length ? "" : "none"}`);
    for (const d of decisions) ws.out(`    - ${d.id} ${d.kind} by ${d.actor} (${d.item_id}): ${d.question} -> ${d.choice}`);
    return 0;
  } finally {
    await ws.ledger.close();
  }
}

async function cmdValidate(args: string[]): Promise<number> {
  if (!args[0]) throw new FoundryError("config", "foundry validate takes a pack folder", "foundry validate packs/aidlc");
  const pack = loadPack(args[0]);
  const problems = validatePack(pack);
  if (problems.length) {
    for (const p of problems) console.error(`  ${p}`);
    throw new FoundryError("config", `${args[0]} has ${problems.length} problems (listed above)`, `fix them in ${args[0]}, then run foundry validate ${args[0]}`);
  }
  console.log(`${pack.name} ${pack.version}: valid (${pack.formula.steps.length} steps, ${pack.roles.size} roles)`);
  return 0;
}

// The AI-DLC source and the rewrite table, wherever foundry is run from.
function aidlcSource(arg?: string): string {
  if (arg) return path.resolve(arg);
  const cfgPath = path.join(process.cwd(), "foundry.toml");
  let config: Config | undefined;
  if (fs.existsSync(cfgPath)) config = parseConfig(fs.readFileSync(cfgPath, "utf8"), cfgPath);
  return path.resolve(config?.aidlc.source ?? "vendor/aidlc-workflows");
}

async function cmdImport(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { source: { type: "string" }, out: { type: "string" } } });
  if (positionals[0] !== "aidlc") throw new FoundryError("config", "foundry import supports one source: aidlc", "foundry import aidlc");
  const report = importAidlc({
    source: aidlcSource(values.source),
    out: path.resolve(values.out ?? "packs/aidlc"),
    rules: path.join(pkgRoot, "docs", "aidlc-rewrites.md"),
  });
  console.log(`imported AI-DLC ${report.tag} into ${values.out ?? "packs/aidlc"}:`);
  console.log(`  ${report.stages} stages as ${report.steps} steps plus run setup; ${report.roles} roles, ${report.profiles} profiles, ${report.verifiers} verifiers; ${report.reviewSteps} steps with a review step`);
  console.log(`  ${report.rewrites.length} engine calls rewritten (see ${values.out ?? "packs/aidlc"}/import-report.md)`);
  return 0;
}

async function cmdPlan(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { profile: { type: "string" }, param: { type: "string", multiple: true }, "dry-run": { type: "boolean" }, json: { type: "boolean" } },
  });
  if (positionals.length !== 1) throw new FoundryError("config", "foundry plan takes one pack", "foundry plan packs/aidlc --profile bugfix --dry-run");
  const pack = resolvePack(positionals[0]!);
  let repo: string | undefined;
  let testCommand: string | undefined;
  try {
    repo = await git.repoRoot(process.cwd());
    const cfg = path.join(repo, "foundry.toml");
    if (fs.existsSync(cfg)) testCommand = parseConfig(fs.readFileSync(cfg, "utf8"), cfg).project.test_command;
  } catch {}
  const c = compile(pack, { profile: values.profile, params: parseParams(values.param), repo, testCommand });
  const plan = describePlan(c, pack);
  if (values.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(`Plan: ${pack.name} ${pack.version}${c.profile ? `, profile ${c.profile}` : ""} (dry run, nothing started)`);
  const pt = c.setup.project_type;
  console.log(`run setup: ${pt ? `project_type=${pt.value}${pt.detected ? " (detected)" : ""}` : "nothing to detect"}${c.setup.dropped.length ? `; dropped: ${c.setup.dropped.join(", ")}` : ""}`);
  console.log(`params: ${Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  if (Object.keys(c.settings).length) console.log(`settings: ${Object.entries(c.settings).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`merge verify: ${plan.merge_verify ?? "none (set [project] test_command in foundry.toml)"}`);
  console.log(`${plan.steps.length} stage steps after run setup:`);
  for (const s of plan.steps) {
    const tags = [
      s.per ? `per ${s.per}` : "",
      s.gate ? `gate ${s.gate}${s.gate_note ? ` (${s.gate_note})` : ""}` : "",
      s.review ? `review ${s.review.role}${s.review.advisory ? " (advisory)" : ""}` : "",
      s.conditional ? "conditional" : "",
      s.environment_change ? "changes an environment" : "",
    ].filter(Boolean);
    console.log(`  ${String(s.n).padStart(2)}. ${s.id.padEnd(26)} ${s.roles.join(" + ").padEnd(36)} needs ${s.needs.join(", ") || "-"}`);
    if (tags.length) console.log(`      ${tags.join(" · ")}`);
  }
  return 0;
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
    case "answer": return cmdAnswer(rest);
    case "approve": return cmdGate(rest, true);
    case "reject": return cmdGate(rest, false);
    case "decisions": return cmdDecisions(rest);
    case "why": return cmdWhy(rest);
    case "validate": return cmdValidate(rest);
    case "import": return cmdImport(rest);
    case "plan": return cmdPlan(rest);
    case "submit": return cmdSubmit(rest);
    case "note": return cmdNote(rest, "note");
    case "handoff": return cmdNote(rest, "handoff");
    case "ask": return cmdAsk(rest);
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
