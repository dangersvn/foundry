import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { stringify } from "smol-toml";
import { Ledger, type LedgerEvent } from "../../src/kernel/ledger.js";
import { fakeAgentCommand } from "../../test/helpers.js";
import type { FoundryWorld } from "../support/world.js";

// The three-step test pack and the fake agent's script, built up by the
// Given steps and written to disk when the run starts.
interface PackSpec {
  steps: Record<string, unknown>[];
  plan: Record<string, Record<string, unknown>[]>;
  workers: number;
}
type W = FoundryWorld & { pack?: PackSpec; packDir?: string; runId?: string };

const designSubmit = (units: string[], extra: Record<string, unknown> = {}) => ({
  status: "done",
  summary: "design ready",
  outputs: { units },
  artifacts: [{ path: "docs/design.md", summary: "the design" }],
  decisions: [],
  ...extra,
});

// One ledger connection at a time: several connections in one process can
// deadlock each other in SQLite (see test/ledger.test.ts).
let chain: Promise<unknown> = Promise.resolve();
function ledger<T>(w: W, fn: (l: Ledger) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const l = await Ledger.open(path.join(w.repo, ".foundry/foundry.db"));
    try {
      return await fn(l);
    } finally {
      await l.close();
    }
  });
  chain = run.catch(() => {});
  return run;
}
const itemsOf = (w: W, step?: string) => ledger(w, async (l) => (await l.listItems()).filter((i) => !step || i.step_id === step));
const firstItem = async (w: W, step: string) => (await itemsOf(w, step))[0]!;
const eventsOf = (w: W, id: string) => ledger(w, (l) => l.events(id));
const envelope = (w: W, id: string, attempt: number) => fs.readFileSync(path.join(w.repo, ".foundry/envelopes", `${id}-a${attempt}.md`), "utf8");
const ts = (events: LedgerEvent[], type: string) => events.find((e) => e.type === type)?.ts;

Given("the test pack {string} with steps {string}, {string} and {string}", function (this: W, _name: string, a: string, b: string, c: string) {
  this.pack = {
    workers: 3,
    steps: [
      { id: a, role: "architect", goal: "Design the change and list the units to build." },
      { id: b, role: "developer", goal: "Build one unit.", needs: [a], per: "units", verify: "npm test" },
      { id: c, role: "qa", goal: "Check the built units.", needs: [b], verify: "npm test" },
    ],
    plan: {
      [a]: [{ writes: [{ path: "docs/design.md", content: "# Design\n" }], submit: designSubmit(["main"]) }],
      [b]: [{ writes: [{ path: "units/{unit}.txt", content: "{unit}\n" }] }],
      [c]: [{}],
    },
  };
});

const step = (w: W, id: string) => w.pack!.steps.find((s) => s.id === id)!;

Given("the {string} step produces {int} units", function (this: W, id: string, n: number) {
  this.pack!.plan[id] = [{ writes: [{ path: "docs/design.md", content: "# Design\n" }], submit: designSubmit(Array.from({ length: n }, (_, i) => `u${i + 1}`)) }];
});

Given("the fake agent asks {string} with options {string} and {string}", function (this: W, question: string, a: string, b: string) {
  const design = this.pack!.plan.design!;
  this.pack!.plan.design = [{ ask: { question, options: [a, b] } }, ...design];
});

Given("the {string} step has a human gate", function (this: W, id: string) {
  step(this, id).gate = "human";
});

Given("the fake agent submits a decision with alternatives, rationale and evidence", function (this: W) {
  this.pack!.plan.design = [
    {
      writes: [{ path: "docs/design.md", content: "# Design\n" }],
      submit: designSubmit(["main"], {
        decisions: [
          {
            kind: "decision",
            question: "Where do units live?",
            choice: "One file per unit under units/",
            alternatives: ["one shared file", "a database table"],
            rationale: "Separate files let units be built in parallel without conflicts",
            evidence: ["docs/design.md"],
            affects: ["units/"],
          },
        ],
      }),
    },
  ];
});

Given("the fake agent submits a result with no decisions list", function (this: W) {
  this.pack!.plan.design = [{ submit: "no-decisions" }];
});

Given("the fake agent submits {string} for {string} with reason {string}", function (this: W, status: string, id: string, reason: string) {
  this.pack!.plan[id] = [{ submit: { status, summary: `${id} not needed`, reason, decisions: [] } }];
});

Given("the fake agent writes a handoff and then fails verification", function (this: W) {
  const failing = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unit works", () => assert.equal(1, 2));\n';
  const passing = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unit works", () => assert.equal(2, 2));\n';
  this.pack!.plan.build = [
    { writes: [{ path: "test/unit.test.js", content: failing }], handoff: "unit.test.js compares the wrong numbers; compare 2 with 2" },
    { writes: [{ path: "test/unit.test.js", content: passing }] },
  ];
});

Given("the {string} step has an advisory reviewer", function (this: W, id: string) {
  Object.assign(step(this, id), { review: "reviewer", gate: "human" });
  this.pack!.plan[`${id}:review`] = [{ submit: { status: "done", summary: "reviewed", findings: ["The design does not cover error cases"], decisions: [] } }];
});

Given("Foundry runs {int} workers", function (this: W, n: number) {
  this.pack!.workers = n;
});

Given("two {string} items change the same lines of the same file", function (this: W, id: string) {
  this.pack!.plan.design = [{ writes: [{ path: "docs/design.md", content: "# Design\n" }], submit: designSubmit(["a", "b"]) }];
  this.pack!.plan[id] = [{ writes: [{ path: "shared.txt", content: "written by {unit}\n" }] }];
});

// ---- running

async function startRun(w: W) {
  const dir = path.join(w.dir, "three-step");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.toml"), stringify({ name: "three-step", version: "1" }));
  fs.writeFileSync(path.join(dir, "formula.toml"), stringify({ formula: "three-step", version: 1, title: "three steps", verify: "npm test", steps: w.pack!.steps }));
  for (const role of ["architect", "developer", "qa", "reviewer"]) {
    fs.writeFileSync(path.join(dir, "roles", `${role}.md`), `You are the ${role}.\n`);
    fs.writeFileSync(path.join(dir, "roles", `${role}.toml`), stringify({ role, prompt: `roles/${role}.md` }));
  }
  const plan = path.join(w.dir, "plan.json");
  fs.writeFileSync(plan, JSON.stringify({ steps: w.pack!.plan }));
  w.writeConfig({ fake: fakeAgentCommand("--plan", plan, "--delay-ms", "200") }, `\n[leases]\nttl_seconds = 5\n[workers]\ncount = ${w.pack!.workers}\n`);
  w.packDir = dir;
  w.mainBefore = w.git("rev-parse", "main");
  w.result = await w.foundry("run", dir);
  w.runId = w.result.stdout.match(/(RUN-\d+) created/)?.[1];
  assert.ok(w.runId, w.result.stdout + w.result.stderr);
}

When("I start a run of {string}", { timeout: 180_000 }, async function (this: W, _name: string) {
  await startRun(this);
});

When("both pass verification", { timeout: 180_000 }, async function (this: W) {
  await startRun(this);
});

When("a run of {string} completes", { timeout: 180_000 }, async function (this: W, _name: string) {
  await startRun(this);
  const run = await ledger(this, async (l) => l.getRun(this.runId!));
  assert.equal(run?.status, "done", this.result!.stdout + this.result!.stderr);
});

When("I answer {string}", { timeout: 120_000 }, async function (this: W, answer: string) {
  const design = await firstItem(this, "design");
  const r = await this.foundry("answer", design.id, answer);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  this.result = await this.foundry("work");
});

When("I reject the {string} gate with comment {string}", { timeout: 120_000 }, async function (this: W, id: string, comment: string) {
  const item = await firstItem(this, id);
  assert.equal(item.status, "at_gate", this.result!.stdout + this.result!.stderr);
  const r = await this.foundry("reject", item.id, "--comment", comment);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  this.result = await this.foundry("work");
});

// ---- checks

Then("{string} starts only after {string} is done", async function (this: W, later: string, earlier: string) {
  const before = await itemsOf(this, earlier);
  const after = await itemsOf(this, later);
  assert.ok(before.length && after.length, `items: ${before.length} ${earlier}, ${after.length} ${later}`);
  const doneAt = Math.max(...(await Promise.all(before.map(async (i) => ts(await eventsOf(this, i.id), i.status === "skipped" ? "skipped" : "merged") ?? Infinity))));
  for (const i of after) {
    const claimed = ts(await eventsOf(this, i.id), "claimed")!;
    assert.ok(claimed >= doneAt, `${i.id} (${later}) was claimed before ${earlier} was done`);
  }
});

Then("{int} {string} items are created, one per unit", async function (this: W, n: number, id: string) {
  const items = await itemsOf(this, id);
  assert.equal(items.length, n);
  assert.deepEqual(items.map((i) => i.unit).sort(), Array.from({ length: n }, (_, i) => `u${i + 1}`));
});

Then("the item is {string}", async function (this: W, status: string) {
  const design = await firstItem(this, "design");
  assert.equal(design.status, status.replaceAll(" ", "_").replace("waiting_for_input", "waiting_input"), this.result!.stdout + this.result!.stderr);
});

Then("no agent session is running for it", async function (this: W) {
  const design = await firstItem(this, "design");
  assert.equal(design.lease_owner, null);
  const ps = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
  assert.ok(!ps.split("\n").some((l) => l.includes("fake-agent.ts") && l.includes(this.dir)), "a fake agent is still running");
  const events = await eventsOf(this, design.id);
  assert.ok(events.findIndex((e) => e.type === "agent_finished") < events.findIndex((e) => e.type === "waiting_for_input"));
});

Then("the next attempt receives the question and the answer in its envelope", async function (this: W) {
  const design = await firstItem(this, "design");
  const text = envelope(this, design.id, 2);
  assert.match(text, /question Q-1: "Which database\?"/);
  assert.match(text, /answer: "SQLite"/);
});

Then("the decision log records the answer with me as the actor", async function (this: W) {
  const me = `person:${this.git("config", "user.name")}`;
  const decisions = await ledger(this, (l) => l.decisions({ runId: this.runId }));
  const d = decisions.find((d) => d.question === "Which database?");
  assert.ok(d, JSON.stringify(decisions));
  assert.equal(d.choice, "SQLite");
  assert.equal(d.actor, me);
});

Then("the next {string} attempt receives {string} in its envelope", async function (this: W, id: string, comment: string) {
  const item = await firstItem(this, id);
  const text = envelope(this, item.id, 2);
  assert.ok(text.includes("rejected at the gate") && text.includes(comment), text);
});

Then("the decision log holds that decision linked to its item and step", async function (this: W) {
  const design = await firstItem(this, "design");
  const d = (await ledger(this, (l) => l.decisions({ itemId: design.id }))).find((d) => d.question === "Where do units live?");
  assert.ok(d);
  assert.equal(d.step_id, "design");
  assert.equal(d.kind, "decision");
  assert.match(d.rationale, /in parallel/);
  assert.deepEqual(JSON.parse(d.alternatives_json), ["one shared file", "a database table"]);
  assert.deepEqual(JSON.parse(d.evidence_json), ["docs/design.md"]);
});

Then("the submission fails schema validation", async function (this: W) {
  const design = await firstItem(this, "design");
  const rejected = (await eventsOf(this, design.id)).filter((e) => e.type === "submission_rejected");
  assert.ok(rejected.length >= 1);
  assert.match(String(rejected[0]!.payload.errors), /decisions/);
});

Then("the item is not done", async function (this: W) {
  const design = await firstItem(this, "design");
  assert.notEqual(design.status, "done");
  assert.equal((await itemsOf(this, "build")).length, 0, "no later step may start");
});

Then("{string} is {string} and the reason is in the decision log", async function (this: W, id: string, status: string) {
  const item = await firstItem(this, id);
  assert.equal(item.status, status);
  const d = (await ledger(this, (l) => l.decisions({ itemId: item.id }))).find((d) => d.choice === "skipped");
  assert.equal(d?.rationale, "no checks apply");
});

Then("the run completes", async function (this: W) {
  const run = await ledger(this, (l) => l.getRun(this.runId!));
  assert.equal(run?.status, "done", this.result!.stdout + this.result!.stderr);
});

Then("the next attempt receives the handoff in its envelope", async function (this: W) {
  const build = await firstItem(this, "build");
  const text = envelope(this, build.id, 2);
  assert.match(text, /handoff \(agent\):\n\s+unit\.test\.js compares the wrong numbers/);
  assert.match(text, /verifier failure/);
  assert.equal(build.status, "done");
});

Then("the {string} gate shows the reviewer's findings", async function (this: W, id: string) {
  const item = await firstItem(this, id);
  const r = await this.foundry("status", item.id);
  assert.match(r.stdout, /gate:\s+waiting for a person/, r.stdout);
  assert.match(r.stdout, /review:\s+reviewer \(advisory\), 1 findings/, r.stdout);
  assert.match(r.stdout, /- The design does not cover error cases/, r.stdout);
});

Then("no item is claimed twice", async function (this: W) {
  for (const i of await itemsOf(this)) {
    const claims = (await eventsOf(this, i.id)).filter((e) => e.type === "claimed").map((e) => e.payload.attempt);
    assert.equal(new Set(claims).size, claims.length, `${i.id} was claimed twice for one attempt`);
  }
  const owners = new Set((await Promise.all((await itemsOf(this, "build")).map(async (i) => (await eventsOf(this, i.id)).find((e) => e.type === "claimed")!.actor))));
  assert.ok(owners.size > 1, "the build items should have been spread over several workers");
});

Then("all {string} items finish", async function (this: W, id: string) {
  const items = await itemsOf(this, id);
  assert.equal(items.length, 6);
  for (const i of items) assert.equal(i.status, "done", `${i.id} is ${i.status}`);
});

Then("the refinery merges one and sends the other back with the conflict", async function (this: W) {
  const builds = await itemsOf(this, "build");
  const sentBack: string[] = [];
  for (const b of builds) {
    const retries = (await eventsOf(this, b.id)).filter((e) => e.type === "retry" && e.actor.includes(":") && String(e.payload.reason).includes("conflict"));
    if (retries.length) sentBack.push(b.id);
  }
  assert.equal(sentBack.length, 1, `items sent back with a conflict: ${sentBack.join(", ")}`);
  const notes = await ledger(this, (l) => l.notes(sentBack[0]!));
  assert.ok(notes.some((n) => n.kind === "refinery" && n.body.includes("conflict")));
  for (const b of builds) assert.equal(b.status, "done");
});

Then("main passes the test suite after every merge", function (this: W) {
  const commits = this.git("rev-list", "--reverse", `${this.mainBefore}..main`).split("\n").filter(Boolean);
  assert.ok(commits.length >= 2);
  const wt = path.join(this.dir, "check");
  for (const sha of commits) {
    this.git("worktree", "add", "-q", "--detach", wt, sha);
    try {
      execFileSync("npm", ["test"], { cwd: wt, stdio: "pipe" });
    } catch (e) {
      assert.fail(`npm test fails at ${sha}: ${(e as { stdout: string }).stdout}`);
    } finally {
      this.git("worktree", "remove", "--force", wt);
    }
  }
});

Then('"foundry why" on a changed line shows its commit, item, decisions and run', async function (this: W) {
  const r = await this.foundry("why", "units/main.txt:1");
  assert.equal(r.code, 0, r.stderr);
  const build = await firstItem(this, "build");
  assert.match(r.stdout, /commit:\s+[0-9a-f]{12}/);
  assert.match(r.stdout, new RegExp(`item:\\s+${build.id} build \\(main\\)`));
  assert.match(r.stdout, /run:\s+RUN-1 three steps/);
  assert.match(r.stdout, /decisions:/);
  assert.match(r.stdout, /inputs:\s*\n\s+- design WI-1 \[done\]: design ready/);
});
