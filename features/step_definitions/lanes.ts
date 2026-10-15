import assert from "node:assert/strict";
import fs from "node:fs";
import { Given, Then, When } from "@cucumber/cucumber";
import { eventsOf, firstItem, itemsOf, ledger, startRun, type W } from "./multi_step.js";

const failing = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unit works", () => assert.equal(1, 2));\n';
const passing = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unit works", () => assert.equal(2, 2));\n';
const units = (n: number) => Array.from({ length: n }, (_, i) => `u${i + 1}`);
const design = (n: number) => [
  {
    writes: [{ path: "docs/design.md", content: "# Design\n" }],
    submit: { status: "done", summary: "design ready", outputs: { units: units(n) }, artifacts: [{ path: "docs/design.md", summary: "the design" }], decisions: [] },
  },
];

// design lists the units; per unit, plan writes plans/<unit>.md and build
// can only pass its verify when it sees that file in its worktree.
Given("the test pack {string} where each unit has a {string} step then a {string} step", function (this: W, _name: string, plan: string, build: string) {
  this.pack = {
    workers: 3,
    steps: [
      { id: "design", role: "architect", goal: "Design the change and list the units." },
      { id: plan, role: "architect", goal: "Plan one unit.", needs: ["design"], per: "units" },
      { id: build, role: "developer", goal: "Build one unit.", needs: [plan], per: "units", verify: "npm test && test -f plans/$(ls plans | head -1)" },
    ],
    plan: {
      design: design(1),
      [plan]: [{ writes: [{ path: "plans/{unit}.md", content: "# Plan for {unit}\n" }] }],
      [build]: [{ writes: [{ path: "units/{unit}.txt", content: "{unit}\n" }] }],
    },
  };
});

Given("the run produces {int} unit(s)", function (this: W, n: number) {
  this.pack!.plan.design = design(n);
});

Given("the fake agent fails verification once on {string}", function (this: W, id: string) {
  this.pack!.plan[id] = [{ writes: [{ path: "test/unit.test.js", content: failing }] }, { writes: [{ path: "test/unit.test.js", content: passing }] }];
});

Given("the pack has two document-only steps", function (this: W) {
  for (const id of ["brief", "notes"]) {
    this.pack!.steps.push({ id, role: "architect", goal: `Write the ${id}.`, needs: ["design"], docs_only: true });
    this.pack!.plan[id] = [{ writes: [{ path: `docs/${id}.md`, content: `# ${id}\n` }] }];
  }
});

Given("one unit merges and another fails", function (this: W) {
  this.pack!.plan.design = design(2);
  this.pack!.plan["build(u2)"] = [{ writes: [{ path: "test/unit.test.js", content: failing }] }];
});

When("the run ends", { timeout: 180_000 }, async function (this: W) {
  await startRun(this);
});

const byUnit = async (w: W, step: string, unit: string) => (await itemsOf(w, step)).find((i) => i.unit === unit)!;

Then("{string} and {string} for that unit use the same worktree and branch", async function (this: W, a: string, b: string) {
  const [x, y] = [await byUnit(this, a, "u1"), await byUnit(this, b, "u1")];
  assert.ok(x.worktree && x.branch, this.result!.stdout);
  assert.equal(x.worktree, y.worktree);
  assert.equal(x.branch, y.branch);
  assert.equal(x.lane_id, y.lane_id);
});

Then("{string} sees the files {string} wrote", async function (this: W, b: string, _a: string) {
  const build = await byUnit(this, b, "u1");
  assert.equal(build.status, "done", this.result!.stdout + this.result!.stderr);
  assert.ok((await eventsOf(this, build.id)).some((e) => e.type === "verified"), "build passed its verify, which needs plans/u1.md");
});

Then("the refinery merges the unit once", async function (this: W) {
  const lane = (await byUnit(this, "plan", "u1")).lane_id;
  const items = (await itemsOf(this)).filter((i) => i.lane_id === lane);
  const merges = (await Promise.all(items.map((i) => eventsOf(this, i.id)))).flat().filter((e) => e.type === "merged");
  assert.equal(merges.length, 1, "one merge for the unit's lane");
  assert.equal(merges[0]!.item_id, (await byUnit(this, "build", "u1")).id);
  assert.ok((await eventsOf(this, (await byUnit(this, "plan", "u1")).id)).some((e) => e.type === "lane_committed"));
  assert.equal(this.git("show", "main:plans/u1.md"), "# Plan for u1");
  assert.equal(this.git("show", "main:units/u1.txt"), "u1");
});

Then("each unit has its own worktree and branch", async function (this: W) {
  const builds = await itemsOf(this, "build");
  assert.equal(builds.length, 2);
  assert.notEqual(builds[0]!.worktree, builds[1]!.worktree);
  assert.notEqual(builds[0]!.branch, builds[1]!.branch);
  for (const b of builds) assert.equal(b.worktree, (await byUnit(this, "plan", b.unit!)).worktree);
});

Then("the second {string} attempt runs in the same worktree as the first", async function (this: W, id: string) {
  const item = await firstItem(this, id);
  const wts = (await eventsOf(this, item.id)).filter((e) => e.type === "worktree_created").map((e) => e.payload.path);
  assert.equal(wts.length, 2, `attempts: ${wts.join(", ")}`);
  assert.equal(wts[0], wts[1]);
  assert.equal(item.status, "done");
});

Then("both document-only steps use one docs worktree for the run", async function (this: W) {
  const [brief, notes, d] = [await firstItem(this, "brief"), await firstItem(this, "notes"), await firstItem(this, "design")];
  assert.ok(brief.worktree, this.result!.stdout);
  assert.equal(brief.worktree, notes.worktree);
  assert.notEqual(brief.worktree, d.worktree);
  const lane = await ledger(this, (l) => l.getLane(brief.lane_id!));
  assert.equal(lane?.kind, "docs");
  assert.equal(lane?.status, "merged", "the docs lane merges at the end of the run");
  const run = await ledger(this, (l) => l.getRun(this.runId!));
  assert.equal(run?.status, "done", this.result!.stdout + this.result!.stderr);
  for (const f of ["brief", "notes"]) assert.equal(this.git("show", `main:docs/${f}.md`), `# ${f}`);
});

Then("the merged unit's worktree is removed", async function (this: W) {
  const u1 = await byUnit(this, "build", "u1");
  assert.equal(u1.status, "done");
  assert.ok(!fs.existsSync(u1.worktree!), `${u1.worktree} should be removed`);
  assert.ok(!this.git("branch", "--list", u1.branch!), `${u1.branch} should be deleted`);
});

Then("the failed unit's worktree is kept until {string}", async function (this: W, command: string) {
  const u2 = await byUnit(this, "build", "u2");
  assert.equal(u2.status, "failed");
  assert.ok(fs.existsSync(u2.worktree!), `${u2.worktree} should be kept for diagnosis`);
  const r = await this.foundry(...command.replace(/^foundry /, "").split(" "));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(u2.worktree!), `${command} should remove ${u2.worktree}`);
});
