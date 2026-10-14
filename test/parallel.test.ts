import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { workQueue, type Workspace } from "../src/kernel/dispatcher.js";
import { Ledger } from "../src/kernel/ledger.js";
import { parseConfig } from "../src/schemas/config.js";
import { fakeAgentCommand } from "./helpers.js";

let repo: string;
let ledger: Ledger;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, ".foundry"));
  ledger = await Ledger.open(path.join(repo, ".foundry/foundry.db"));
});
afterEach(async () => {
  await ledger.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

it("two workers in one process build two items in parallel, each in its own worktree", async () => {
  const plan = path.join(repo, "..", `${path.basename(repo)}-plan.json`);
  fs.writeFileSync(plan, JSON.stringify({ writes: [{ path: "features/{item}.txt", content: "{item}\n" }] }));
  const config = parseConfig(
    `[agents.fake]\ncommand = ${JSON.stringify(fakeAgentCommand("--plan", plan, "--delay-ms", "800"))}\n[leases]\nttl_seconds = 5\n`,
  );
  for (const title of ["one", "two"]) {
    await ledger.createRun({ formula: "f", formulaVersion: 1, stepId: "code", title, goal: title, input: "", verify: "true" });
  }
  const ws = (owner: string): Workspace => ({ repo, stateDir: path.join(repo, ".foundry"), config, ledger, owner, out: () => {}, selfCommand: [] });

  const results = await Promise.all([workQueue(ws("w1")), workQueue(ws("w2"))]);

  expect(results.flatMap((r) => r.worked.map((o) => o.status)).sort()).toEqual(["done", "done", "merge_ready", "merge_ready"]);
  expect(git("rev-list", "--count", "main")).toBe("3");
  expect(fs.readFileSync(path.join(repo, "features/WI-1.txt"), "utf8")).toBe("WI-1\n");
  expect(fs.readFileSync(path.join(repo, "features/WI-2.txt"), "utf8")).toBe("WI-2\n");
  const items = await ledger.listItems();
  expect(new Set(items.map((i) => i.worktree)).size).toBe(2);
  // Both agents were running before either item merged.
  const ts = async (id: string, type: string) => (await ledger.events(id)).find((e) => e.type === type)!.ts;
  const firstMerge = Math.min(await ts("WI-1", "merged"), await ts("WI-2", "merged"));
  expect(await ts("WI-1", "agent_started")).toBeLessThan(firstMerge);
  expect(await ts("WI-2", "agent_started")).toBeLessThan(firstMerge);
  fs.rmSync(plan);
});
