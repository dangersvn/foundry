import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import type { CliResult } from "../support/world.js";
import { envelope, eventsOf, firstItem, itemsOf, ledger, startRun, writePack, type W } from "./multi_step.js";

const REQUEST = "Add a units feature backed by a database";
type A = W & { decisionId?: string; background?: ChildProcess[]; running?: Promise<CliResult>; buildAttempt?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decisionsOf = (w: W) => ledger(w, (l) => l.decisions({}));

When("I start a run of {string} in {string} mode", { timeout: 180_000 }, async function (this: A, _name: string, mode: string) {
  await startRun(this, "--mode", mode, "--input", REQUEST);
});

Given("the answerer will answer {string} citing the run's request", function (this: A, answer: string) {
  this.pack!.plan["design:answer"] = [{ resolve: { answer, rationale: "the request asks for a database", evidence: [{ kind: "request", quote: "database" }] } }];
});

Given("the answerer will answer {string} citing an artifact that does not exist", function (this: A, answer: string) {
  this.pack!.plan["design:answer"] = [{ resolve: { answer, rationale: "the design says so", evidence: [{ kind: "artifact", ref: "docs/missing.md" }] } }];
});

Then("the question is answered without a person", async function (this: A) {
  const design = await firstItem(this, "design");
  const [q] = await ledger(this, (l) => l.questions(design.id));
  assert.equal(q?.answer, "SQLite", this.result!.stdout + this.result!.stderr);
  assert.match(q!.answered_by!, /^answerer@/);
});

Then("the decision log records the answer as a {string} by the answerer role", async function (this: A, kind: string) {
  const d = (await decisionsOf(this)).find((d) => d.question === "Which database?");
  assert.ok(d, "no decision for the question");
  assert.equal(d.kind, kind);
  assert.equal(d.choice, "SQLite");
  assert.match(d.actor, /^answerer@fake$/);
  assert.ok((JSON.parse(d.evidence_json) as string[]).includes("request"), d.evidence_json);
});

Then("the decision log records the answer as an {string}", async function (this: A, kind: string) {
  const d = (await decisionsOf(this)).find((d) => d.question === "Which database?");
  assert.equal(d?.kind, kind, JSON.stringify(d));
  assert.match(d!.rationale, /docs\/missing\.md is not an artifact/);
});

Given("the answerer role asks a question during its own step", function (this: A) {
  this.pack!.steps.find((s) => s.id === "design")!.role = "answerer";
  this.pack!.plan.design = [{ ask: { question: "Which database?", options: ["SQLite", "Postgres"] } }, ...this.pack!.plan.design!];
});

Then("the question is not resolved by the answerer role", async function (this: A) {
  const design = await firstItem(this, "design");
  const [q] = await ledger(this, (l) => l.questions(design.id));
  assert.equal(q?.answer, null, `answered by ${q?.answered_by}`);
  assert.equal(design.status, "waiting_input");
  assert.match(design.hold ?? "", /never resolves its own/);
  assert.ok(!(await decisionsOf(this)).some((d) => d.actor.startsWith("answerer@")));
  assert.ok(!(await eventsOf(this, design.id)).some((e) => e.type === "resolver_agent_started"), "no resolver session ran");
});

Given("the {string} step has a gate", function (this: A, id: string) {
  this.pack!.steps.find((s) => s.id === id)!.gate = "human";
});

Given("the reviewer will approve", function (this: A) {
  this.pack!.plan["design:gate"] = [{ resolve: { verdict: "approve", comment: "the design covers the request", evidence: [{ kind: "request" }] } }];
});

Given("the reviewer will reject once with comment {string}", function (this: A, comment: string) {
  this.pack!.plan["design:gate"] = [{ resolve: { verdict: "reject", comment } }, { resolve: { verdict: "approve", comment: "fixed" } }];
});

Then("the {string} gate passes without a person", async function (this: A, id: string) {
  const item = await firstItem(this, id);
  assert.equal(item.status, "done", this.result!.stdout + this.result!.stderr);
  const approved = (await eventsOf(this, item.id)).find((e) => e.type === "approved");
  assert.match(approved?.actor ?? "", /^reviewer@/);
});

Then("the decision log records a {string} by the reviewer role", async function (this: A, kind: string) {
  const design = await firstItem(this, "design");
  const d = (await decisionsOf(this)).find((d) => d.item_id === design.id && d.question.startsWith("Approve"));
  assert.equal(d?.kind, kind);
  assert.equal(d?.choice, "approved");
  assert.match(d!.actor, /^reviewer@/);
});

Given("Foundry is configured with fake agents {string} and {string}", function (this: A, a: string, b: string) {
  this.pack!.agents = [a, b];
});

Then("the agent that resolves the {string} gate differs from the agent that did {string}", async function (this: A, gate: string, _work: string) {
  const item = await firstItem(this, gate);
  const resolver = (await eventsOf(this, item.id)).find((e) => e.type === "resolver_started");
  assert.ok(resolver, this.result!.stdout + this.result!.stderr);
  assert.ok(item.agent, "the item records the agent that did it");
  assert.notEqual(resolver.payload.agent, item.agent);
  const d = (await decisionsOf(this)).find((d) => d.item_id === item.id && d.question.startsWith("Approve"));
  assert.equal(d?.actor, `reviewer@${resolver.payload.agent}`);
});

Given("{string} is a locked path", function (this: A, glob: string) {
  this.pack!.config = `${this.pack!.config ?? ""}[autopilot]\nlocked_paths = [${JSON.stringify(glob)}]\n`;
});

Given("the {string} step changes {string}", function (this: A, id: string, file: string) {
  this.pack!.plan[id] = [{ writes: [{ path: file, content: "export const charge = () => 0;\n" }] }];
});

Then("the {string} gate waits for a person", async function (this: A, id: string) {
  const item = await firstItem(this, id);
  assert.equal(item.status, "at_gate", this.result!.stdout + this.result!.stderr);
  assert.match(item.hold ?? "", /locked paths: payments\/charge\.ts/);
  assert.ok(!(await eventsOf(this, item.id)).some((e) => e.type === "resolver_started"));
  const r = await this.foundry("status", item.id);
  assert.match(r.stdout, /gate:\s+waiting for a person/);
});

// build asks, the answerer answers without valid evidence (an assumption),
// and the run completes.
Given("an autopilot run that completed with an assumption used by {string}", { timeout: 180_000 }, async function (this: A, id: string) {
  this.pack!.plan[id] = [{ ask: { question: "Which database?", options: ["SQLite", "Postgres"] } }, { writes: [{ path: "units/{unit}.txt", content: "{unit}\n" }] }];
  this.pack!.plan[`${id}:answer`] = [{ resolve: { answer: "SQLite", rationale: "smallest to set up", evidence: [] } }];
  await startRun(this, "--mode", "autopilot", "--input", REQUEST);
  assert.equal((await ledger(this, (l) => l.getRun(this.runId!)))?.status, "done", this.result!.stdout + this.result!.stderr);
  const item = await firstItem(this, id);
  const d = (await decisionsOf(this)).find((d) => d.item_id === item.id && d.kind === "assumption");
  assert.ok(d, "the answer should be logged as an assumption");
  this.decisionId = d.id;
  this.buildAttempt = item.attempt;
});

When("I reject that assumption with comment {string}", async function (this: A, comment: string) {
  this.result = await this.foundry("reject-decision", this.decisionId!, "--comment", comment);
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

Then("{string} is ready again", async function (this: A, id: string) {
  const item = await firstItem(this, id);
  assert.equal(item.status, "ready");
  assert.equal(item.attempt, this.buildAttempt! + 1);
  assert.equal((await ledger(this, (l) => l.getRun(this.runId!)))?.status, "open");
  const check = await firstItem(this, "check");
  assert.equal(check.status, "ready", "work downstream of it is re-queued too");
});

Then("its next attempt receives {string} in its envelope", { timeout: 180_000 }, async function (this: A, comment: string) {
  this.result = await this.foundry("work");
  const build = await firstItem(this, "build");
  const text = envelope(this, build.id, this.buildAttempt! + 1);
  assert.ok(text.includes("decision rejected") && text.includes(comment), text);
  assert.equal((await ledger(this, (l) => l.getRun(this.runId!)))?.status, "done", this.result.stdout + this.result.stderr);
  const check = await firstItem(this, "check");
  const claims = (await eventsOf(this, check.id)).filter((e) => e.type === "claimed");
  const buildDone = (await eventsOf(this, build.id)).filter((e) => e.type === "merged").at(-1)!.ts;
  assert.ok(claims.at(-1)!.ts >= buildDone, "check re-runs only after build is done again");
});

// The design gate's reviewer is slow, so the gate is still open when
// autopilot is turned off.
Given("an autopilot run with an item at a gate", { timeout: 60_000 }, async function (this: A) {
  for (const id of ["design", "check"]) this.pack!.steps.find((s) => s.id === id)!.gate = "human";
  this.pack!.plan["design:gate"] = [{ delay_ms: 5000, resolve: { verdict: "approve", comment: "ok" } }];
  const dir = writePack(this);
  const { done } = this.startFoundry(["run", dir, "--mode", "autopilot", "--input", REQUEST]);
  this.running = done;
  for (let i = 0; i < 300; i++, await sleep(100)) {
    if (!fs.existsSync(path.join(this.repo, ".foundry/foundry.db"))) continue;
    const design = (await itemsOf(this, "design"))[0];
    if (design && design.status === "at_gate" && (await eventsOf(this, design.id)).some((e) => e.type === "resolver_agent_started")) return;
  }
  throw new Error("design never reached its gate with a resolver running");
});

When("I turn autopilot off", { timeout: 60_000 }, async function (this: A) {
  const r = await this.foundry("autopilot", "off");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  this.result = await this.running!;
});

Then("that gate waits for a person", async function (this: A) {
  const design = await firstItem(this, "design");
  assert.equal(design.status, "at_gate", this.result!.stdout + this.result!.stderr);
  assert.match(design.hold ?? "", /autopilot was turned off/);
  assert.ok(!(await decisionsOf(this)).some((d) => d.item_id === design.id && d.actor.startsWith("reviewer@")), "the reviewer's late verdict is not applied");
});

Then("later decision points wait for a person", { timeout: 120_000 }, async function (this: A) {
  const design = await firstItem(this, "design");
  assert.equal((await this.foundry("approve", design.id)).code, 0);
  this.result = await this.foundry("work");
  const check = await firstItem(this, "check");
  assert.equal(check?.status, "at_gate", this.result.stdout + this.result.stderr);
  assert.equal(check.hold, "autopilot is off");
  assert.ok(!(await eventsOf(this, check.id)).some((e) => e.type === "resolver_started"));
});
