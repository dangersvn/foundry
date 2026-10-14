import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { excludeStateDir } from "../../src/kernel/git.js";
import { Ledger } from "../../src/kernel/ledger.js";
import { parseFormula } from "../../src/schemas/formula.js";
import { root, type FoundryWorld } from "../support/world.js";

const REAL_AGENTS: Record<string, string[]> = {
  kiro: ["kiro-cli", "acp"],
  claude: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
};
const REAL_TIMEOUT = 20 * 60_000;

async function withLedger<T>(w: FoundryWorld, fn: (l: Ledger) => Promise<T>): Promise<T> {
  fs.mkdirSync(path.join(w.repo, ".foundry"), { recursive: true });
  await excludeStateDir(w.repo);
  const ledger = await Ledger.open(path.join(w.repo, ".foundry/foundry.db"));
  try {
    return await fn(ledger);
  } finally {
    await ledger.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const commitsFor = (w: FoundryWorld, itemId: string) =>
  w.git("log", "main", "--format=%H", `--grep=^Foundry-Item: ${itemId}$`).split("\n").filter(Boolean);

// ---- setup

Given("a sample git repo with a passing test suite", function (this: FoundryWorld) {
  this.createSampleRepo();
  const r = this.npmTest();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

Given("Foundry is configured with the fake agent", function (this: FoundryWorld) {
  // A short delay keeps the agent busy long enough to observe main during the run.
  this.configureFake("--delay-ms", "300");
});

Given("Foundry is configured with the {string} agent", function (this: FoundryWorld, agent: string) {
  const command = REAL_AGENTS[agent];
  assert.ok(command, `no real agent called ${agent}`);
  this.writeConfig({ [agent]: command });
});

Given("the fake agent reports success without making the test pass", function (this: FoundryWorld) {
  fs.writeFileSync(
    path.join(this.repo, "src/math.js"),
    "export const add = (a, b) => a - b;\n",
  );
  fs.writeFileSync(
    path.join(this.repo, "test/math.test.js"),
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.js";\n\ntest("add adds", () => assert.equal(add(2, 2), 4));\n',
  );
  this.git("add", "-A");
  this.git("commit", "-qm", "add a failing test");
  this.configureFake("--mode", "fake-success");
});

Given("the configured agent command does not exist", function (this: FoundryWorld) {
  this.writeConfig({ fake: ["foundry-no-such-agent", "acp"] });
});

Given("an item is running", async function (this: FoundryWorld) {
  this.configureFake("--delay-ms", "4000");
  this.mainBefore = this.git("rev-parse", "main");
  const { child, done } = this.startFoundry(["run", "health-endpoint"]);
  (this as FoundryWorld & { running: unknown }).running = { child, done };
  for (let i = 0; i < 200; i++) {
    const started = await withLedger(this, async (l) => {
      const item = (await l.listItems())[0];
      if (!item) return false;
      this.itemId = item.id;
      return (await l.events(item.id)).some((e) => e.type === "agent_started");
    });
    if (started) return;
    await sleep(100);
  }
  throw new Error("the item never reached agent_started");
});

Given("one ready item", async function (this: FoundryWorld) {
  const f = parseFormula(fs.readFileSync(path.join(root, "formulas/health-endpoint.toml"), "utf8"));
  this.mainBefore = this.git("rev-parse", "main");
  this.itemId = await withLedger(this, async (l) => {
    const { itemId } = await l.createRun({
      formula: f.formula,
      formulaVersion: f.version,
      stepId: f.step.id,
      title: f.title!,
      goal: f.step.goal,
      input: "",
      verify: f.step.verify,
    });
    return itemId;
  });
});

// ---- actions

const FORMULAS: Record<string, string> = {
  "add a health endpoint with a test": "health-endpoint",
};

When(
  "I run the one-step formula {string}",
  { timeout: REAL_TIMEOUT },
  async function (this: FoundryWorld, title: string) {
    let formula = FORMULAS[title];
    if (!formula) {
      // Not shipped: written next to the repo for this scenario.
      formula = path.join(this.dir, "formula.toml");
      fs.writeFileSync(
        formula,
        `formula = "fix-failing-test"\nversion = 1\ntitle = ${JSON.stringify(title)}\n\n[step]\nid = "code"\ngoal = ${JSON.stringify(title)}\nverify = "npm test"\n`,
      );
    }
    this.mainBefore = this.git("rev-parse", "main");
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const clean = this.git("status", "--porcelain") === "";
        this.mainObservations.push({ t: Date.now(), sha: this.git("rev-parse", "main"), clean });
        await sleep(20);
      }
    })();
    this.result = await this.foundry("run", formula, "--input", title);
    watching = false;
    await watch;
    this.itemId = this.result.stdout.match(/created (WI-\d+)/)?.[1] ?? "";
  },
);

When("Foundry is killed and restarted", async function (this: FoundryWorld) {
  const { child, done } = (this as FoundryWorld & { running: { child: import("node:child_process").ChildProcess; done: Promise<unknown> } }).running;
  child.kill("SIGKILL");
  await done;
  this.result = await this.foundry("work");
  assert.equal(this.result.code, 0, this.result.stdout + this.result.stderr);
});

When("two Foundry processes start at the same time", async function (this: FoundryWorld) {
  this.results = await Promise.all([this.foundry("work"), this.foundry("work")]);
});

// ---- checks

Then("the item status is {string}", async function (this: FoundryWorld, status: string) {
  assert.ok(this.itemId, `no item was created:\n${this.result?.stdout}\n${this.result?.stderr}`);
  const r = await this.foundry("status", this.itemId);
  assert.match(r.stdout, new RegExp(`status:\\s+${status}\\b`), `${r.stdout}\n--- run output:\n${this.result?.stdout}\n${this.result?.stderr}`);
});

Then("the item finishes as {string}", async function (this: FoundryWorld, status: string) {
  const r = await this.foundry("status", this.itemId);
  assert.match(r.stdout, new RegExp(`status:\\s+${status}\\b`), r.stdout);
  const log = await this.foundry("log", this.itemId);
  assert.match(log.stdout, /lease_expired/, "the restart should have recovered the expired lease");
});

Then("main has exactly one new commit for the item", function (this: FoundryWorld) {
  assert.equal(this.git("rev-list", "--count", `${this.mainBefore}..main`), "1");
  assert.deepEqual(commitsFor(this, this.itemId), [this.git("rev-parse", "main")]);
});

Then("main has exactly one commit for the item", function (this: FoundryWorld) {
  assert.equal(commitsFor(this, this.itemId).length, 1);
  assert.equal(this.git("rev-list", "--count", `${this.mainBefore}..main`), "1");
});

Then("the test suite passes on main", function (this: FoundryWorld) {
  assert.equal(this.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(this.git("status", "--porcelain"), "");
  const r = this.npmTest();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

Then("the item is not merged", async function (this: FoundryWorld) {
  assert.equal(this.git("rev-parse", "main"), this.mainBefore);
  assert.deepEqual(commitsFor(this, this.itemId), []);
  assert.notEqual(this.result?.code, 0);
  const r = await this.foundry("status", this.itemId);
  assert.match(r.stdout, /status:\s+failed/, r.stdout);
});

Then("the item shows the verifier failure", async function (this: FoundryWorld) {
  const r = await this.foundry("status", this.itemId);
  assert.match(r.stdout, /failure:\s+\[verifier\] `npm test` failed/, r.stdout);
  assert.match(r.stdout, /add adds/, "the failing test's output should be shown");
  assert.match(this.result!.stderr, /error \[verifier\]/, this.result!.stderr);
});

Then("main does not change before the merge step", async function (this: FoundryWorld) {
  const events = await withLedger(this, (l) => l.events(this.itemId));
  const at = (type: string) => events.find((e) => e.type === type)?.ts;
  const started = at("agent_started")!;
  const verified = at("verified")!;
  assert.ok(started && verified && at("merged"), events.map((e) => e.type).join(","));
  const before = this.mainObservations.filter((o) => o.t < verified);
  const duringAgent = before.filter((o) => o.t > started);
  assert.ok(duringAgent.length > 3, `only ${duringAgent.length} observations while the agent ran`);
  for (const o of before) {
    assert.equal(o.sha, this.mainBefore, "main moved before the merge");
    assert.ok(o.clean, "main's working tree changed before the merge");
  }
  assert.notEqual(this.git("rev-parse", "main"), this.mainBefore);
});

Then("exactly one of them claims the item", async function (this: FoundryWorld) {
  const claims = this.results.filter((r) => r.stdout.includes(`${this.itemId} claimed by`));
  assert.equal(claims.length, 1, this.results.map((r) => r.stdout + r.stderr).join("\n---\n"));
  for (const r of this.results) assert.equal(r.code, 0, r.stdout + r.stderr);
  const events = await withLedger(this, (l) => l.events(this.itemId));
  assert.equal(events.filter((e) => e.type === "claimed").length, 1);
  assert.deepEqual(commitsFor(this, this.itemId).length, 1);
});

Then(
  "the log for the item lists claimed, agent started, tool call, verified and merged in that order",
  async function (this: FoundryWorld) {
    const r = await this.foundry("log", this.itemId);
    const types = r.stdout.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[2]);
    const want = ["claimed", "agent_started", "tool_call", "verified", "merged"];
    let i = 0;
    for (const t of types) if (t === want[i]) i++;
    assert.equal(i, want.length, `log order was: ${types.join(", ")}`);
  },
);

Then("the error names the ACP runtime layer", function (this: FoundryWorld) {
  assert.notEqual(this.result!.code, 0);
  assert.match(this.result!.stderr, /error \[ACP runtime\]/, this.result!.stderr);
  assert.doesNotMatch(this.result!.stderr, /\n\s+at /, "no stack trace");
});

Then("the error suggests a command to run next", function (this: FoundryWorld) {
  assert.match(this.result!.stderr, /next: .*`foundry [a-z]+`/, this.result!.stderr);
});
