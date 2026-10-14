import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { findCalls } from "../../src/import/calls.js";
import { compile } from "../../src/kernel/compile.js";
import { Ledger, type InputRef } from "../../src/kernel/ledger.js";
import { loadPack } from "../../src/schemas/pack.js";
import { root, type FoundryWorld } from "../support/world.js";

type W = FoundryWorld & { source?: string; packOut?: string; packOut2?: string; plan?: Record<string, any>; runId?: string };
const PINNED = "v2.11.0";
const vendor = path.join(root, "vendor/aidlc-workflows");

function tmp(w: W): string {
  if (!w.dir) w.dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-feature-"));
  return w.dir;
}

async function importTo(w: W, out: string, source = w.source!) {
  w.result = await w.foundryAt(root, "import", "aidlc", "--source", source, "--out", out);
  return w.result;
}

Given("the AI-DLC source at the pinned version", function (this: W) {
  assert.ok(fs.existsSync(vendor), `AI-DLC is not in ${vendor}; clone it: git clone --depth 1 --branch ${PINNED} https://github.com/awslabs/aidlc-workflows vendor/aidlc-workflows`);
  assert.equal(execFileSync("git", ["describe", "--tags", "--exact-match"], { cwd: vendor, encoding: "utf8" }).trim(), PINNED);
  this.source = vendor;
});

When("I import AI-DLC", async function (this: W) {
  this.packOut = path.join(tmp(this), "packs/aidlc");
  await importTo(this, this.packOut);
});

When("I import AI-DLC twice", async function (this: W) {
  this.packOut = path.join(tmp(this), "first/aidlc");
  this.packOut2 = path.join(tmp(this), "second/aidlc");
  for (const out of [this.packOut, this.packOut2]) assert.equal((await importTo(this, out)).code, 0, this.result!.stderr);
});

Given("the aidlc pack is imported", async function (this: W) {
  this.source ??= vendor;
  this.packOut = path.join(tmp(this), "packs/aidlc");
  assert.equal((await importTo(this, this.packOut)).code, 0, this.result!.stderr);
});

Given("a stage text with an engine call missing from the rewrite table", function (this: W) {
  const copy = path.join(tmp(this), "aidlc-source");
  fs.cpSync(path.join(vendor, "core"), path.join(copy, "core"), { recursive: true });
  const stage = path.join(copy, "core/aidlc-common/stages/construction/build-and-test.md");
  fs.appendFileSync(stage, "\nBefore you finish, run `{{INVOKE}} engine frobnicate --everything`.\n");
  this.source = copy;
});

const pack = (w: W) => loadPack(w.packOut!);

Then("the aidlc pack covers all {int} stages as {int} steps plus run setup", function (this: W, stages: number, steps: number) {
  assert.equal(this.result!.code, 0, this.result!.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(this.packOut!, "import-report.json"), "utf8"));
  assert.equal(report.stages, stages);
  const p = pack(this);
  assert.equal(p.formula.steps.length, steps);
  assert.equal(p.formula.steps.length + p.setup.dropped.length, stages);
  assert.ok(p.setup.detect_project_type, "run setup detects project_type");
});

Then("it has {int} roles, {int} profiles and {int} verifiers", function (this: W, roles: number, profiles: number, verifiers: number) {
  const p = pack(this);
  assert.equal(p.roles.size, roles);
  assert.equal(p.profiles.size, profiles);
  assert.equal(p.verifiers.size, verifiers);
});

Then("{int} steps have a review step", function (this: W, n: number) {
  assert.equal(pack(this).formula.steps.filter((s) => s.review).length, n);
});

Then('"foundry validate" passes on the aidlc pack', async function (this: W) {
  const r = await this.foundryAt(root, "validate", this.packOut!);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

Then("no step instruction calls AI-DLC's own engine", function (this: W) {
  assert.equal(this.result!.code, 0, this.result!.stderr);
  for (const dir of ["steps", "roles"]) {
    for (const f of fs.readdirSync(path.join(this.packOut!, dir)).filter((f) => f.endsWith(".md"))) {
      const text = fs.readFileSync(path.join(this.packOut!, dir, f), "utf8");
      assert.deepEqual(findCalls(text).map((c) => c.text), [], `${dir}/${f}`);
      assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `${dir}/${f} keeps an AI-DLC placeholder`);
    }
  }
});

Then("every rewrite applied is listed in the import report", function (this: W) {
  const core = path.join(this.source!, "core");
  const bodies = [
    ...["ideation", "inception", "construction", "operation"].flatMap((ph) =>
      fs.readdirSync(path.join(core, "aidlc-common/stages", ph)).map((f) => path.join(core, "aidlc-common/stages", ph, f)),
    ),
    ...fs.readdirSync(path.join(core, "agents")).map((f) => path.join(core, "agents", f)),
  ].map((f) => fs.readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, ""));
  const calls = bodies.reduce((n, b) => n + findCalls(b).length, 0);
  const report = JSON.parse(fs.readFileSync(path.join(this.packOut!, "import-report.json"), "utf8"));
  assert.equal(report.rewrites.length, calls);
  const md = fs.readFileSync(path.join(this.packOut!, "import-report.md"), "utf8");
  const rows = md.split("## Every rewrite")[1]!.split("\n").filter((l) => l.startsWith("| core/"));
  assert.equal(rows.length, calls);
});

Then("the import fails and names the stage and the call", function (this: W) {
  assert.notEqual(this.result!.code, 0);
  assert.match(this.result!.stderr, /build-and-test\.md line \d+/, this.result!.stderr);
  assert.match(this.result!.stderr, /\{\{INVOKE\}\} engine frobnicate --everything/, this.result!.stderr);
  assert.match(this.result!.stderr, /next: add a rule/, this.result!.stderr);
});

Then("both packs are identical", function (this: W) {
  const list = (d: string): string[] =>
    fs.readdirSync(d, { recursive: true, encoding: "utf8" }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
  const a = list(this.packOut!);
  assert.deepEqual(a, list(this.packOut2!));
  for (const f of a) assert.ok(fs.readFileSync(path.join(this.packOut!, f)).equals(fs.readFileSync(path.join(this.packOut2!, f))), `${f} differs`);
});

When("I dry-run the {string} profile", async function (this: W, profile: string) {
  const r = await this.foundryAt(root, "plan", this.packOut!, "--profile", profile, "--dry-run", "--json");
  assert.equal(r.code, 0, r.stderr);
  this.plan = JSON.parse(r.stdout);
});

Then("the plan has {int} stage steps after run setup", function (this: W, n: number) {
  assert.equal(this.plan!.steps.length, n);
  assert.ok(this.plan!.setup.project_type, "run setup sets project_type");
});

Then("every step runs with its lead role only", function (this: W) {
  const p = pack(this);
  for (const s of this.plan!.steps) assert.deepEqual(s.roles, [p.formula.steps.find((x) => x.id === s.id)!.role], s.id);
  assert.equal(this.plan!.settings.collaborators, false);
});

Then("reviews are advisory", function (this: W) {
  const reviewed = this.plan!.steps.filter((s: { review: unknown }) => s.review);
  assert.equal(reviewed.length, 13);
  for (const s of reviewed) assert.equal(s.review.advisory, true, s.id);
});

Then("code plans wait at an approval gate", function (this: W) {
  const cg = this.plan!.steps.find((s: { id: string }) => s.id === "code-generation");
  assert.equal(cg.gate, "human");
  assert.equal(cg.plan_approval, true);
  assert.equal(this.plan!.settings.plan_approval, true);
});

// Drives a compiled feature run through the kernel with no agents: every
// item finishes with outputs and artifacts named after what its step
// produces, except the skipped step.
Given("a {string} run where {string} is skipped", async function (this: W, profile: string, skipped: string) {
  this.createSampleRepo();
  fs.mkdirSync(path.join(this.repo, ".foundry"), { recursive: true });
  const p = pack(this);
  const c = compile(p, { profile, repo: this.repo });
  const ledger = await Ledger.open(path.join(this.repo, ".foundry/foundry.db"));
  try {
    const { runId } = await ledger.startRun({ formula: c.formula, title: "feature run", input: "add a feature", packDir: this.packOut!, params: c.params });
    this.runId = runId;
    for (let guard = 0; guard < 200; guard++) {
      const id = await ledger.claimNext("w", 60, runId);
      if (!id) break;
      const item = (await ledger.getItem(id))!;
      const step = c.formula.steps.find((s) => s.id === item.step_id)!;
      const result =
        step.id === skipped
          ? { status: "skipped", summary: "not needed", reason: "no infrastructure changes", outputs: {}, artifacts: [], decisions: [] }
          : {
              status: "done",
              summary: `${step.id} done`,
              outputs: step.id === "units-generation" ? { "unit-of-work": ["u1"] } : {},
              artifacts: step.outputs.map((o) => ({ path: `aidlc-docs/${runId}/${step.id}/${o}.md`, summary: o })),
              decisions: [],
            };
      const to = step.id === skipped ? "skipped" : "done";
      await ledger.transition(id, "w", "running", to, to, {}, { result_json: JSON.stringify(result) });
    }
    assert.equal((await ledger.getRun(runId))?.status, "done", "the run should complete");
  } finally {
    await ledger.close();
  }
});

Then("the steps that read its outputs start without them", async function (this: W) {
  const ledger = await Ledger.open(path.join(this.repo, ".foundry/foundry.db"));
  try {
    const items = await ledger.listItems(this.runId);
    const readers = items.filter((i) => (JSON.parse(i.inputs_json!) as InputRef[]).some((x) => x.step === "infrastructure-design"));
    assert.ok(readers.length > 0, "some steps read infrastructure-design's outputs");
    for (const r of readers) {
      assert.equal(r.status, "done", `${r.step_id} should have started and finished`);
      const ref = (JSON.parse(r.inputs_json!) as InputRef[]).find((x) => x.step === "infrastructure-design")!;
      assert.equal(ref.status, "skipped");
      assert.deepEqual(ref.artifacts, []);
      assert.deepEqual(ref.outputs, {});
    }
  } finally {
    await ledger.close();
  }
});

Then("no step reports a missing required input", async function (this: W) {
  const ledger = await Ledger.open(path.join(this.repo, ".foundry/foundry.db"));
  try {
    const missing = (await ledger.runEvents(this.runId!)).filter((e) => e.type === "input_missing");
    assert.deepEqual(missing.map((e) => e.payload), []);
  } finally {
    await ledger.close();
  }
});
