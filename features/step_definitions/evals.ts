import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { stringify } from "smol-toml";
import { Ledger } from "../../src/kernel/ledger.js";
import { splitOf } from "../../src/kernel/eval.js";
import { eventsOf, firstItem, itemsOf, ledger, startRun, threeStep, writePack, type W } from "./multi_step.js";

const REQUEST = "Add a units feature";
// Units whose build cases split two held-out (u1, u3) and two dev (u2, u4).
const UNITS = ["u1", "u2", "u3", "u4"];
const failing = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unit works", () => assert.equal(1, 2));\n';
const pass = { writes: [{ path: "units/{unit}.txt", content: "{unit}\n" }] };
const fail = { writes: [{ path: "test/unit.test.js", content: failing }] };
type E = W & { cases?: Record<string, string>; versions?: Set<string>; caseId?: string; splits?: { id: string; split: string }[] };

const design = (units: string[]) => [
  { writes: [{ path: "docs/design.md", content: "# Design\n" }], submit: { status: "done", summary: "design ready", outputs: { units }, artifacts: [{ path: "docs/design.md", summary: "the design" }], decisions: [] } },
];

async function completedRun(w: E) {
  threeStep(w);
  w.pack!.plan.design = design(UNITS);
  await startRun(w, "--input", REQUEST);
  assert.equal((await ledger(w, (l) => l.getRun(w.runId!)))?.status, "done", w.result!.stdout + w.result!.stderr);
}

Given("a completed run of {string} with approved items", { timeout: 180_000 }, async function (this: E, _name: string) {
  await completedRun(this);
});

// Every build item as a case, by unit.
async function ensureCases(w: E) {
  if (w.cases) return w.cases;
  w.cases = {};
  for (const b of await itemsOf(w, "build")) {
    const r = await w.foundry("bench", "add", b.id);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    w.cases[b.unit!] = r.stdout.match(/as case (\S+)/)![1]!;
  }
  return w.cases;
}

const caseFile = (w: E, id: string) => JSON.parse(fs.readFileSync(path.join(w.repo, "benchmarks", id, "case.json"), "utf8"));

When("I add an approved {string} item to the benchmark", async function (this: E, step: string) {
  const item = await firstItem(this, step);
  this.result = await this.foundry("bench", "add", item.id);
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
  this.caseId = this.result.stdout.match(/as case (\S+)/)![1];
});

Then("a case is written to benchmarks\\/ with its envelope, base commit, accepted output and verifier setup", async function (this: E) {
  const c = caseFile(this, this.caseId!);
  const item = await firstItem(this, "build");
  assert.equal(c.source.item, item.id);
  const accepted = this.git("log", "main", "--format=%H", `--grep=^Foundry-Item: ${item.id}$`);
  assert.equal(c.accepted_commit, accepted);
  assert.equal(c.base_commit, this.git("rev-parse", `${accepted}^`));
  assert.equal(this.git("rev-parse", `refs/foundry/bench/${c.id}`), c.base_commit, "a ref keeps the base commit");
  assert.equal(c.envelope.run.input, REQUEST);
  assert.equal(c.envelope.inputs[0].step, "design");
  assert.ok(fs.existsSync(path.join(this.repo, "benchmarks", c.id, "envelope.md")));
  assert.match(fs.readFileSync(path.join(this.repo, "benchmarks", c.id, "accepted.patch"), "utf8"), /units\/u1\.txt/);
  assert.deepEqual(c.accepted.files, ["units/u1.txt"]);
  assert.deepEqual(c.verify, { command: "npm test", checks: [], docs_only: false, tests: [] });
});

Then("the case is assigned to {string} or {string}", function (this: E, a: string, b: string) {
  const c = caseFile(this, this.caseId!);
  assert.ok([a, b].includes(c.split), c.split);
  assert.equal(c.split, splitOf(c.id));
});

When("I add the same item to the benchmark in two fresh setups", { timeout: 300_000 }, async function (this: E) {
  this.splits = [];
  for (let i = 0; i < 2; i++) {
    // A fresh repo each time; the one before is not needed any more.
    const old = this.dir;
    this.createSampleRepo();
    fs.rmSync(old, { recursive: true, force: true });
    this.configureFake();
    this.cases = undefined;
    await completedRun(this);
    const id = (await ensureCases(this))["u1"]!;
    this.splits.push({ id, split: caseFile(this, id).split });
  }
});

Then("it lands in the same split both times", function (this: E) {
  const [a, b] = this.splits!;
  assert.equal(a!.id, b!.id);
  assert.equal(a!.split, b!.split);
});

Given("an item whose change edits a file in benchmarks\\/", function (this: E) {
  this.pack!.plan.design = [{ writes: [{ path: "benchmarks/cheat/case.json", content: "{}\n" }], submit: design(["u1"])[0]!.submit }];
});

When("it reaches the refinery", { timeout: 180_000 }, async function (this: E) {
  await startRun(this, "--input", "another change");
});

Then("the refinery rejects it and names the protected path", async function (this: E) {
  const items = (await itemsOf(this, "design")).filter((i) => i.run_id === this.runId);
  const events = await eventsOf(this, items[0]!.id);
  const sentBack = events.filter((e) => (e.type === "retry" || e.type === "failed") && String(e.payload.message ?? e.payload.reason).includes("protected path benchmarks/"));
  assert.ok(sentBack.length > 0, events.map((e) => `${e.type} ${JSON.stringify(e.payload)}`).join("\n"));
  assert.match(String(sentBack[0]!.payload.message), /benchmarks\/cheat\/case\.json/);
  assert.equal(this.git("ls-tree", "-r", "--name-only", "main", "benchmarks"), "", "nothing under benchmarks/ reached main");
});

Given("a benchmark case for a {string} item", async function (this: E, _step: string) {
  this.caseId = (await ensureCases(this))["u1"];
});

When("I replay the case with {int} trials", { timeout: 180_000 }, async function (this: E, n: number) {
  this.result = await this.foundry("replay", this.caseId!, "--trials", String(n), "--yes");
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

const evalsLedger = async <T>(w: E, fn: (l: Ledger) => Promise<T>) => {
  const l = await Ledger.open(path.join(w.repo, ".foundry/evals/evals.db"));
  try {
    return await fn(l);
  } finally {
    await l.close();
  }
};

Then("each trial runs in a fresh lane from the case's base commit", async function (this: E) {
  const base = caseFile(this, this.caseId!).base_commit;
  const lanes = await evalsLedger(this, async (l) => (await Promise.all((await l.listItems()).map((i) => l.events(i.id)))).flat().filter((e) => e.type === "worktree_created"));
  assert.equal(lanes.length, 3);
  assert.equal(new Set(lanes.map((e) => e.payload.path)).size, 3, "a new worktree for every trial");
  for (const e of lanes) {
    assert.equal(e.payload.base, base);
    assert.ok(!fs.existsSync(String(e.payload.path)), "trial worktrees are removed after grading");
  }
});

Then("the report shows passes out of {int}", function (this: E, n: number) {
  assert.match(this.result!.stdout, new RegExp(`${this.caseId}: ${n}/${n} passes`), this.result!.stdout);
});

// Pack versions are copies of the test pack with their own version; the
// fake agent's plan scripts each version trial by trial.
function versions(w: E, ...vs: string[]) {
  w.versions ??= new Set();
  for (const v of vs) w.versions.add(v);
  w.pack!.plan["build@a"] ??= [pass, fail, fail];
  const dir = writePack(w);
  const out: string[] = [];
  for (const v of [...w.versions].sort()) {
    const copy = `${dir}-${v}`;
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(dir, copy, { recursive: true });
    fs.writeFileSync(path.join(copy, "pack.toml"), stringify({ name: "three-step", version: v }));
    out.push(copy);
  }
  return dir;
}

Given("pack version {string} where the fake agent passes {int} of {int} trials", async function (this: E, v: string, passes: number, n: number) {
  await ensureCases(this);
  this.pack!.plan[`build@${v}`] = Array.from({ length: n }, (_, i) => (i < passes ? pass : fail));
  versions(this, v);
});

Given("pack version {string} gains passes on one case and loses passes on another", async function (this: E, v: string) {
  await ensureCases(this);
  this.pack!.plan[`build(u1)@${v}`] = [pass, pass, pass];
  this.pack!.plan[`build(u3)@${v}`] = [fail, fail, fail];
  versions(this, "a", v);
});

When("I eval {string} against {string} on the held-out set", { timeout: 300_000 }, async function (this: E, a: string, b: string) {
  const dir = versions(this, a, b);
  this.result = await this.foundry("eval", `${dir}-${a}`, `${dir}-${b}`, "--set", "held-out", "--trials", "3", "--yes");
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

Then("the report shows pass counts per case for both versions", function (this: E) {
  for (const u of ["u1", "u3"]) assert.match(this.result!.stdout, new RegExp(`${this.cases![u]}\\s+build\\s+1/3\\s+3/3`), this.result!.stdout);
  assert.doesNotMatch(this.result!.stdout, new RegExp(this.cases!["u2"]!), "dev cases are not in a held-out eval");
});

Then("the verdict is that {string} is better", function (this: E, b: string) {
  assert.match(this.result!.stdout, new RegExp(`verdict: ${b} is better`), this.result!.stdout);
});

Then("the verdict is that {string} is not better", function (this: E, b: string) {
  assert.match(this.result!.stdout, new RegExp(`verdict: ${b} is not better \\(cases that lost passes: ${this.cases!["u3"]}\\)`), this.result!.stdout);
});

When("I eval {string} against {string} without confirming", { timeout: 60_000 }, async function (this: E, a: string, b: string) {
  await ensureCases(this);
  const dir = versions(this, a, b);
  this.result = await this.foundry("eval", `${dir}-${a}`, `${dir}-${b}`);
});

Then("the number of agent sessions it would start is shown", function (this: E) {
  // Two dev cases (the default set), 3 trials, 2 versions.
  assert.match(this.result!.stdout, /: 12 agent sessions/, this.result!.stdout);
  assert.notEqual(this.result!.code, 0);
  assert.match(this.result!.stderr, /nothing started[\s\S]*next: .*--yes/, this.result!.stderr);
});

Then("no agent session starts", async function (this: E) {
  const db = path.join(this.repo, ".foundry/evals/evals.db");
  if (!fs.existsSync(db)) return;
  const started = await evalsLedger(this, async (l) => (await Promise.all((await l.listItems()).map((i) => l.events(i.id)))).flat().filter((e) => e.type === "agent_started"));
  assert.equal(started.length, 0);
});

When("I eval agents {string} and {string} on the held-out set", { timeout: 300_000 }, async function (this: E, a: string, b: string) {
  await ensureCases(this);
  const dir = writePack(this);
  this.result = await this.foundry("eval", dir, "--agents", `${a},${b}`, "--set", "held-out", "--trials", "2", "--yes");
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

Then("the report shows pass counts per role for each agent", function (this: E) {
  assert.match(this.result!.stdout, /^role\s+cases\s+kiro\s+claude/m, this.result!.stdout);
  assert.match(this.result!.stdout, /^developer\s+2\s+4\/4\s+4\/4/m, this.result!.stdout);
});

When("I ask for stats by role", async function (this: E) {
  this.result = await this.foundry("stats", "--by", "role");
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

Then("I see first-pass yield, attempts per item, human rejection rate, agent requests per merged item, escalation rate and assumption count for each role", function (this: E) {
  const lines = this.result!.stdout.trim().split("\n");
  for (const h of ["first-pass yield", "attempts/item", "human rejection rate", "agent requests/merged item", "escalation rate", "assumptions"]) assert.ok(lines[0]!.includes(h), lines[0]);
  for (const role of ["architect", "developer", "qa"]) {
    const row = lines.find((l) => l.startsWith(role));
    assert.ok(row, `no row for ${role}:\n${this.result!.stdout}`);
  }
  assert.match(lines.find((l) => l.startsWith("developer"))!, /^developer\s+4\s+100%\s+1\.00\s+- \(0\/0\)\s+\d+\.\d\d\s+0%\s+0$/);
});
