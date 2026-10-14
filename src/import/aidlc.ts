// `foundry import aidlc`: reads AI-DLC's own source (stages, agents and
// knowledge, scopes, sensors) and writes packs/aidlc/. Deterministic: the
// same source gives a byte-identical pack (sorted, no timestamps).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { FoundryError } from "../kernel/errors.js";
import { findCalls } from "./calls.js";
import { parseRules, rewrite, UnmatchedCall, type Applied, type Rule } from "./rewrites.js";

const PHASES = ["initialization", "ideation", "inception", "construction", "operation"];
const INIT = "initialization";
// v1 runs every profile with AI-DLC's simplest settings (brief, 1b).
const V1_SETTINGS = {
  collaborators: false,
  review: "advisory",
  learnings: false,
  summary_confirmation: false,
  skeleton: false,
  plan_approval: true,
};

interface Stage {
  slug: string;
  phase: string;
  file: string;
  fm: {
    name?: string;
    execution?: string;
    condition?: string;
    lead_agent?: string;
    support_agents?: string[];
    reviewer?: string;
    for_each?: string;
    produces?: string[];
    optional_produces?: string[];
    consumes?: { artifact: string; required?: boolean; conditional_on?: string }[];
    requires_stage?: string[];
    sensors?: string[];
    scopes?: string[];
    summary_confirmation?: string;
  };
  body: string;
}

function splitFrontmatter(text: string, file: string): { fm: Record<string, unknown>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new FoundryError("config", `${file} has no frontmatter`, "check the AI-DLC source version");
  // Sensor files carry unquoted `command: {{INVOKE}} ...` values, which YAML
  // would read as a flow mapping; quote them first.
  const yaml = m[1]!.replace(/^(\s*[A-Za-z_]+): (\{\{.*)$/gm, (_, k: string, v: string) => `${k}: ${JSON.stringify(v)}`);
  return { fm: (parseYaml(yaml) ?? {}) as Record<string, unknown>, body: m[2]! };
}

export interface ImportReport {
  source: string;
  tag: string;
  commit: string;
  stages: number;
  steps: number;
  roles: number;
  profiles: number;
  verifiers: number;
  reviewSteps: number;
  rewrites: (Applied & { file: string })[];
  dropped: { stage: string; calls: number }[];
}

export function importAidlc(opts: { source: string; out: string; rules: string }): ImportReport {
  const core = path.join(opts.source, "core");
  if (!fs.existsSync(path.join(core, "aidlc-common", "stages"))) {
    throw new FoundryError("config", `no AI-DLC source at ${opts.source} (core/aidlc-common/stages is missing)`, "clone it: git clone --depth 1 --branch v2.11.0 https://github.com/awslabs/aidlc-workflows vendor/aidlc-workflows");
  }
  const gitOut = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: opts.source, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unknown";
    }
  };
  const tag = gitOut(["describe", "--tags", "--exact-match"]);
  const commit = gitOut(["rev-parse", "HEAD"]);
  const rules: Rule[] = parseRules(opts.rules);
  const rewrites: ImportReport["rewrites"] = [];
  const applyRules = (text: string, file: string) => {
    try {
      const r = rewrite(text, rules, file);
      rewrites.push(...r.applied.map((a) => ({ ...a, file })));
      return r.text;
    } catch (e) {
      if (e instanceof UnmatchedCall) {
        throw new FoundryError("config", `import failed: ${e.message}`, `add a rule for this call to docs/aidlc-rewrites.md, then run foundry import aidlc again`);
      }
      throw e;
    }
  };

  // ---- read
  const stageFiles = PHASES.flatMap((ph) => {
    const d = path.join(core, "aidlc-common", "stages", ph);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(d, f)) : [];
  });
  const stages: Stage[] = stageFiles.map((file) => {
    const { fm, body } = splitFrontmatter(fs.readFileSync(file, "utf8"), file);
    return { slug: String(fm.slug), phase: String(fm.phase), file: path.relative(opts.source, file), fm: fm as Stage["fm"], body };
  });
  const init = stages.filter((s) => s.phase === INIT);
  const work = topoSort(stages.filter((s) => s.phase !== INIT));
  const slugs = new Set(work.map((s) => s.slug));

  // artifact -> the stages that produce it
  const producers = new Map<string, string[]>();
  for (const s of work) for (const a of [...(s.fm.produces ?? []), ...(s.fm.optional_produces ?? [])]) producers.set(a, [...(producers.get(a) ?? []), s.slug]);

  const out = opts.out;
  fs.rmSync(out, { recursive: true, force: true });
  for (const d of ["steps", "roles", "profiles", "verifiers", "knowledge"]) fs.mkdirSync(path.join(out, d), { recursive: true });
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), content);
  };

  // ---- knowledge (copied as reference)
  const knowledgeRoot = path.join(core, "knowledge");
  const knowledgeFiles = new Map<string, string[]>();
  for (const dir of fs.readdirSync(knowledgeRoot).sort()) {
    const abs = path.join(knowledgeRoot, dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    const files = listFiles(abs).map((f) => path.join("knowledge", dir, f));
    for (const f of files) write(f, fs.readFileSync(path.join(core, f), "utf8"));
    knowledgeFiles.set(dir, files);
  }

  // ---- roles from the 14 agents
  const envStages = environmentStages(opts.rules);
  const agentFiles = fs.readdirSync(path.join(core, "agents")).filter((f) => f.endsWith(".md")).sort();
  for (const f of agentFiles) {
    const file = path.join("core", "agents", f);
    const { fm, body } = splitFrontmatter(fs.readFileSync(path.join(opts.source, file), "utf8"), file);
    const name = String(fm.name);
    const disallowed = String(fm.disallowedTools ?? "").split(/[,\s]+/);
    const tools = (["read", "write", "shell"] as const).filter(
      (t) => !(t === "write" && disallowed.some((d) => /^(Write|Edit)$/.test(d))) && !(t === "shell" && disallowed.includes("Bash")),
    );
    write(`roles/${name}.md`, applyRules(body, file).trim() + "\n");
    write(
      `roles/${name}.toml`,
      stringify({
        role: name,
        description: String(fm.description ?? "").replace(/\s+/g, " ").trim(),
        prompt: `roles/${name}.md`,
        knowledge: [...(knowledgeFiles.get(name) ?? []), ...(knowledgeFiles.get("aidlc-shared") ?? [])],
        tools_allowed: tools,
      }),
    );
  }

  // ---- steps from the 30 non-initialization stages
  const steps = work.map((s) => {
    const instructions = applyRules(s.body, s.file);
    const context = [...new Set([...instructions.matchAll(/\.foundry\/pack\/(knowledge\/[^\s`)'"]+)/g)].map((m) => m[1]!.replace(/[.,;:]+$/, "")))].sort();
    write(`steps/${s.slug}.md`, stepHeader(s, envStages.has(s.slug)) + instructions.trim() + "\n");
    const produces = s.fm.produces ?? [];
    const inputs = (s.fm.consumes ?? []).flatMap((c) =>
      (producers.get(c.artifact) ?? [])
        .filter((p) => p !== s.slug)
        .map((p) => ({ from: p, name: c.artifact, required: c.required === true, ...(c.conditional_on ? { conditional_on: c.conditional_on } : {}) })),
    );
    const conditional = s.fm.execution === "CONDITIONAL";
    const goal = [
      `Run the AI-DLC stage "${s.fm.name ?? s.slug}" (${s.phase}) at the run's depth. It produces: ${[...produces, ...(s.fm.optional_produces ?? []).map((p) => `${p} (optional)`)].join(", ") || "nothing named"}.`,
      ...(s.fm.for_each ? [`When the plan lists units, it runs once per ${s.fm.for_each} and your unit is in the envelope; otherwise it runs once for the whole change.`] : []),
      ...(s.slug === "units-generation" ? ['List the units in your result as outputs."unit-of-work" (one name per unit).'] : []),
      ...(conditional ? [`It runs only when it applies: ${String(s.fm.condition ?? "").trim()} If it does not apply, submit "skipped" with the reason.`] : []),
    ].join(" ");
    return {
      id: s.slug,
      phase: s.phase,
      role: String(s.fm.lead_agent),
      instructions: `steps/${s.slug}.md`,
      goal,
      needs: (s.fm.requires_stage ?? []).filter((n) => slugs.has(n)),
      ...(s.fm.for_each ? { per: s.fm.for_each } : {}),
      gate: "human",
      ...(/checkpoint plan-approval/.test(s.body) ? { gate_note: "plan approval" } : {}),
      ...(s.fm.reviewer ? { review: s.fm.reviewer } : {}),
      max_attempts: 3,
      conditional,
      environment_change: envStages.has(s.slug),
      outputs: [...produces, ...(s.fm.optional_produces ?? [])],
      inputs,
      verifiers: (s.fm.sensors ?? []).slice().sort(),
      context,
      support_roles: s.fm.support_agents ?? [],
    };
  });
  write("formula.toml", stringify({ formula: "aidlc", version: 1, title: "AI-DLC", steps }));

  // ---- profiles from the 11 scopes
  const scopeFiles = fs.readdirSync(path.join(core, "scopes")).filter((f) => f.endsWith(".md")).sort();
  for (const f of scopeFiles) {
    const { fm, body } = splitFrontmatter(fs.readFileSync(path.join(core, "scopes", f), "utf8"), f);
    const name = String(fm.name);
    const source: Record<string, string | boolean> = {};
    for (const k of ["depth", "skeleton", "review_cap", "guard_policy", "sensors", "learnings", "summary_confirmation", "plan_approval", "collaborators", "existing_code", "testStrategy"]) {
      if (fm[k] !== undefined) source[k] = typeof fm[k] === "boolean" ? (fm[k] as boolean) : String(fm[k]);
    }
    write(
      `profiles/${name}.toml`,
      stringify({
        profile: name,
        description: String(fm.description ?? "").trim(),
        steps: work.filter((s) => (s.fm.scopes ?? []).includes(name)).map((s) => s.slug),
        params: {
          depth: String(fm.depth ?? "Standard"),
          test_strategy: String(fm.testStrategy ?? fm.depth ?? "Standard"),
          project_type: fm.existing_code === true ? "brownfield" : "auto",
        },
        settings: V1_SETTINGS,
        source_settings: source,
      }),
    );
    void body;
  }

  // ---- verifiers from the 6 sensors
  const sensorFiles = fs.readdirSync(path.join(core, "sensors")).filter((f) => f.endsWith(".md")).sort();
  for (const f of sensorFiles) {
    const { fm } = splitFrontmatter(fs.readFileSync(path.join(core, "sensors", f), "utf8"), f);
    const id = String(fm.id);
    write(
      `verifiers/${id}.toml`,
      stringify({
        id,
        builtin: `aidlc.${id}`,
        severity: fm.default_severity === "blocking" ? "blocking" : "advisory",
        description: String(fm.description ?? "").trim(),
        ...(fm.matches ? { matches: String(fm.matches) } : {}),
        ...(fm.fire_on ? { fire_on: String(fm.fire_on) } : {}),
      }),
    );
  }

  // ---- layered rules: AI-DLC's org, team and project memory as defaults
  for (const layer of ["org", "team", "project"]) {
    const f = path.join(core, "memory", `${layer}.md`);
    if (fs.existsSync(f)) write(`rules/${layer}.md`, fs.readFileSync(f, "utf8"));
  }

  // ---- run setup from the 3 initialization stages
  const dropped = init.map((s) => ({ stage: s.slug, calls: findCalls(s.body).length }));
  write(
    "setup.toml",
    stringify({
      detect_project_type: true,
      dropped: init.map((s) => s.slug),
      notes:
        "AI-DLC's initialization stages become run setup: workspace-detection's existing-code check sets the project_type parameter (brownfield when the repository has source files, else greenfield); state-init and workspace-scaffold are dropped because the ledger holds run state and the worktree is the workspace.",
    }),
  );

  write(
    "pack.toml",
    stringify({ name: "aidlc", version: tag.replace(/^v/, ""), formula: "formula.toml", source: "https://github.com/awslabs/aidlc-workflows", tag, commit, imported_by: "foundry import aidlc" }),
  );

  const report: ImportReport = {
    source: "https://github.com/awslabs/aidlc-workflows",
    tag,
    commit,
    stages: stages.length,
    steps: steps.length,
    roles: agentFiles.length,
    profiles: scopeFiles.length,
    verifiers: sensorFiles.length,
    reviewSteps: steps.filter((s) => s.review).length,
    rewrites,
    dropped,
  };

  // Nothing of AI-DLC's engine may survive in what agents are told.
  for (const dir of ["steps", "roles"]) {
    for (const f of fs.readdirSync(path.join(out, dir)).filter((f) => f.endsWith(".md")).sort()) {
      const left = findCalls(fs.readFileSync(path.join(out, dir, f), "utf8"));
      if (left.length) throw new FoundryError("config", `import failed: ${dir}/${f} still calls AI-DLC's engine: \`${left[0]!.text}\``, "add a rule to docs/aidlc-rewrites.md");
    }
  }
  write("import-report.json", JSON.stringify(report, null, 2) + "\n");
  write("import-report.md", renderReport(report));
  return report;
}

// The person-facing header on every imported step's instructions.
function stepHeader(s: Stage, environmentChange: boolean): string {
  return [
    `<!-- Imported by \`foundry import aidlc\` from AI-DLC ${s.file}. Engine calls are rewritten; see packs/aidlc/import-report.md. -->`,
    "",
    "## Reading this stage in Foundry",
    "",
    "- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.",
    "- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.",
    "- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.",
    '- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.',
    "- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's \"How to work with Foundry\" replaces them.",
    "- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.",
    ...(environmentChange
      ? ["- **This stage would change a real environment.** Do not run anything that changes it (deploy, apply, provision). Write the exact plan and commands into your artifacts and submit; the person carries them out at the gate."]
      : []),
    "",
    "---",
    "",
    "",
  ].join("\n");
}

function renderReport(r: ImportReport): string {
  const byRule = new Map<string, number>();
  for (const w of r.rewrites) byRule.set(w.rule, (byRule.get(w.rule) ?? 0) + 1);
  return [
    "# AI-DLC import report",
    "",
    `Source: ${r.source} at ${r.tag} (${r.commit}).`,
    "",
    `- ${r.stages} stages: ${r.steps} steps plus run setup (${r.dropped.map((d) => d.stage).join(", ")})`,
    `- ${r.roles} roles, ${r.profiles} profiles, ${r.verifiers} verifiers, ${r.reviewSteps} steps with a review step`,
    `- ${r.rewrites.length} engine calls rewritten; ${r.dropped.reduce((n, d) => n + d.calls, 0)} calls dropped with the initialization stages`,
    "",
    "## Rewrites by rule",
    "",
    "| Rule | Count |",
    "| --- | --- |",
    ...[...byRule].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Every rewrite",
    "",
    "| File | Line | Rule | Original | Foundry |",
    "| --- | --- | --- | --- | --- |",
    ...r.rewrites.map((w) => `| ${w.file} | ${w.line} | ${w.rule} | \`${esc(w.from)}\` | \`${esc(w.to)}\` |`),
    "",
  ].join("\n");
}

const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("`", "'");

function listFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir)
    .sort()
    .flatMap((f) => (fs.statSync(path.join(dir, f)).isDirectory() ? listFiles(path.join(dir, f), path.join(prefix, f)) : [path.join(prefix, f)]));
}

// Stages listed under "Steps that change a real environment" in the rewrites doc.
function environmentStages(rulesFile: string): Set<string> {
  const section = fs.readFileSync(rulesFile, "utf8").split(/^## Steps that change a real environment\s*$/m)[1] ?? "";
  return new Set([...section.matchAll(/^\| ([a-z][a-z-]+) \|/gm)].map((m) => m[1]!));
}

// Dependency order, with phase order and then slug as tie-breaks.
function topoSort(stages: Stage[]): Stage[] {
  const rank = (s: Stage) => PHASES.indexOf(s.phase);
  const bySlug = new Map(stages.map((s) => [s.slug, s]));
  const done = new Set<string>();
  const order: Stage[] = [];
  const pending = stages.slice().sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
  while (order.length < stages.length) {
    const next = pending.find((s) => !done.has(s.slug) && (s.fm.requires_stage ?? []).every((n) => done.has(n) || !bySlug.has(n)));
    if (!next) throw new FoundryError("config", "AI-DLC stages depend on each other in a cycle", "check requires_stage in the source");
    done.add(next.slug);
    order.push(next);
  }
  return order;
}
