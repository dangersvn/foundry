import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "../src/kernel/dispatcher.js";
import { workQueue } from "../src/kernel/dispatcher.js";
import { benchAdd, caseId, openEvals, replayCase, splitOf, verdict, type BenchCase } from "../src/kernel/eval.js";
import { Ledger } from "../src/kernel/ledger.js";
import { parseConfig } from "../src/schemas/config.js";
import { loadPack } from "../src/schemas/pack.js";
import { fakeAgentCommand, foundryCommand } from "./helpers.js";

describe("benchmark split", () => {
  it("gives the same item the same case id and split anywhere, about 70/30", () => {
    expect(caseId("f", "build", "u1", "req", "build (u1)")).toBe(caseId("f", "build", "u1", "req", "build (u1)"));
    expect(caseId("f", "build", "u1", "req", "build (u1)")).not.toBe(caseId("f", "build", "u2", "req", "build (u2)"));
    const ids = Array.from({ length: 1000 }, (_, i) => caseId("f", "s", `u${i}`, "r", "t"));
    const dev = ids.filter((id) => splitOf(id) === "dev").length;
    expect(dev).toBeGreaterThan(650);
    expect(dev).toBeLessThan(750);
  });
});

describe("eval verdict", () => {
  const s = (a: number, b: number, id = "c") => ({ case: id, step: "x", role: "r", passes: { a, b }, trials: 3 });
  it("needs more passes in total and no case losing passes", () => {
    expect(verdict([s(1, 3, "c1"), s(1, 3, "c2")], "a", "b")).toMatchObject({ better: true, totalA: 2, totalB: 6 });
    expect(verdict([s(1, 3, "c1"), s(1, 0, "c2")], "a", "b")).toMatchObject({ better: false, losses: ["c2"] });
    expect(verdict([s(2, 2)], "a", "b").better).toBe(false);
  });
});

describe("document grading", () => {
  // A docs-only case replayed with the fake agent: sensors, then a judge on
  // the other configured agent.
  it("passes only when the judge's rubric is met, and the judge runs on another agent", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evaldocs-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "x\n");
    git("add", "-A");
    git("-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "init");
    const base = git("rev-parse", "HEAD");
    const packDir = path.join(repo, "..", `${path.basename(repo)}-pack`);
    fs.mkdirSync(path.join(packDir, "roles"), { recursive: true });
    fs.writeFileSync(path.join(packDir, "pack.toml"), 'name = "docs"\nversion = "1"\n');
    fs.writeFileSync(path.join(packDir, "formula.toml"), 'formula = "docs"\nversion = 1\n[[steps]]\nid = "notes"\nrole = "writer"\ngoal = "Write the notes."\ndocs_only = true\n');
    for (const r of ["writer", "reviewer"]) {
      fs.writeFileSync(path.join(packDir, "roles", `${r}.md`), `You are the ${r}.\n`);
      fs.writeFileSync(path.join(packDir, "roles", `${r}.toml`), `role = "${r}"\nprompt = "roles/${r}.md"\n`);
    }
    const id = "notes-0000";
    fs.mkdirSync(path.join(repo, "benchmarks", id), { recursive: true });
    fs.writeFileSync(path.join(repo, "benchmarks", id, "accepted.patch"), "diff\n");
    const c: BenchCase = {
      id,
      split: "held-out",
      source: { item: "WI-1", run: "RUN-1", step: "notes", unit: null, role: "writer", review: null, agent: "one", formula: "docs", pack: { name: "docs", version: "1", dir: packDir } },
      base_commit: base,
      accepted_commit: base,
      envelope: { item: { title: "notes", goal: "Write the notes.", inputs: "write notes", unit: null, attempt: 1, max_attempts: 3, role: "writer" }, run: { id: "RUN-1", title: "t", goal: "t", input: "write notes" }, inputs: [], inputDecisions: [], notes: [], questions: [], params: {} },
      verify: { command: null, checks: [], docs_only: true, tests: [] },
      accepted: { summary: "notes", result: null, files: ["docs/notes.md"] },
    };
    const planFile = path.join(packDir, "plan.json");
    const run = async (judge: object) => {
      fs.writeFileSync(planFile, JSON.stringify({ steps: { notes: [{ writes: [{ path: "docs/notes.md", content: "# notes\n" }] }], "notes:judge": [judge] } }));
      const config = parseConfig(
        ["one", "two"].map((n) => `[agents.${n}]\ncommand = ${JSON.stringify(fakeAgentCommand("--plan", planFile, "--style", n === "two" ? "claude" : "kiro"))}\n`).join("") + "[leases]\nttl_seconds = 30\n",
      );
      fs.mkdirSync(path.join(repo, ".foundry"), { recursive: true });
      const ledger = await Ledger.open(path.join(repo, ".foundry/foundry.db"));
      const ws: Workspace = { repo, stateDir: path.join(repo, ".foundry"), config, ledger, owner: "w", out: () => {}, selfCommand: foundryCommand() };
      const ev = await openEvals(ws);
      try {
        const [t] = await replayCase(ev, c, loadPack(packDir), "one", 1);
        const judged = (await Promise.all((await ev.ledger.listItems()).map((i) => ev.ledger.events(i.id)))).flat().filter((e) => e.type === "judge_agent_started").at(-1);
        return { t: t!, judgeAgent: judged?.payload.agent };
      } finally {
        await ev.ledger.close();
        await ledger.close();
      }
    };
    const good = await run({});
    expect(good.t).toMatchObject({ passed: true, reason: "judge reviewer@two: meets the rubric" });
    expect(good.judgeAgent).toBe("two");
    const bad = await run({ resolve: { criteria: { complete: false }, comment: "misses the risks section" } });
    expect(bad.t.passed).toBe(false);
    expect(bad.t.reason).toBe("judge reviewer@two: not complete: misses the risks section");
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(packDir, { recursive: true, force: true });
  }, 60_000);
});

describe("code grading", () => {
  // The accepted change added a test; a trial that adds nothing must fail it.
  it("puts the accepted change's tests into each trial before the verify", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evalcode-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@e");
    git("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
    git("add", "-A");
    git("commit", "-qm", "init");
    const planFile = path.join(repo, "..", `${path.basename(repo)}-plan.json`);
    const code = { path: "src/add.js", content: "export const add = (a, b) => a + b;\n" };
    const test = { path: "test/add.test.js", content: 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/add.js";\ntest("adds", () => assert.equal(add(1, 2), 3));\n' };
    const config = parseConfig(`[agents.fake]\ncommand = ${JSON.stringify(fakeAgentCommand("--plan", planFile))}\n[leases]\nttl_seconds = 30\n`);
    fs.mkdirSync(path.join(repo, ".foundry"));
    const ledger = await Ledger.open(path.join(repo, ".foundry/foundry.db"));
    const ws: Workspace = { repo, stateDir: path.join(repo, ".foundry"), config, ledger, owner: "w", out: () => {}, selfCommand: foundryCommand() };
    try {
      fs.writeFileSync(planFile, JSON.stringify({ writes: [code, test] }));
      const { itemId } = await ledger.createRun({ formula: "f", formulaVersion: 1, stepId: "code", title: "add add()", goal: "add add() with a test", input: "add add()", verify: "npm test" });
      await workQueue(ws);
      expect((await ledger.getItem(itemId))?.status).toBe("done");
      const c = await benchAdd(ws, itemId);
      expect(c.verify.tests).toEqual(["test/add.test.js"]);
      expect(fs.existsSync(path.join(repo, "benchmarks", c.id, "tests/test/add.test.js"))).toBe(true);
      const ev = await openEvals(ws);
      try {
        const pack = loadPack(writeFormula(repo));
        fs.writeFileSync(planFile, JSON.stringify({ writes: [{ path: "NOTES.md", content: "nothing\n" }] }));
        expect((await replayCase(ev, c, pack, "fake", 1))[0]).toMatchObject({ passed: false });
        fs.writeFileSync(planFile, JSON.stringify({ writes: [code] }));
        expect((await replayCase(ev, c, pack, "fake", 1))[0]).toMatchObject({ passed: true });
      } finally {
        await ev.ledger.close();
      }
    } finally {
      await ledger.close();
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(planFile, { force: true });
      fs.rmSync(path.join(repo, "..", `${path.basename(repo)}-formula.toml`), { force: true });
    }
  }, 60_000);
});

function writeFormula(repo: string): string {
  const f = path.join(repo, "..", `${path.basename(repo)}-formula.toml`);
  fs.writeFileSync(f, 'formula = "f"\nversion = 1\n[step]\nid = "code"\ngoal = "add add() with a test"\nverify = "npm test"\n');
  return f;
}
