import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/kernel/ledger.js";
import { FoundryError } from "../src/kernel/errors.js";

const execFileAsync = promisify(execFile);
let dir: string;
let ledger: Ledger;
const newItem = () =>
  ledger.createRun({
    formula: "f",
    formulaVersion: 1,
    stepId: "code",
    title: "t",
    goal: "g",
    input: "",
    verify: "true",
  });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  ledger = await Ledger.open(path.join(dir, "foundry.db"));
});
afterEach(async () => {
  await ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ledger", () => {
  it("creates a run with one ready item and a created event", async () => {
    const { runId, itemId } = await newItem();
    expect(runId).toBe("RUN-1");
    expect(itemId).toBe("WI-1");
    expect((await ledger.getItem(itemId))?.status).toBe("ready");
    expect((await ledger.events(itemId)).map((e) => e.type)).toEqual(["created"]);
    expect((await newItem()).itemId).toBe("WI-2");
  });

  it("claims an item exactly once across two processes", async () => {
    const { itemId } = await newItem();
    const file = path.join(dir, "foundry.db");
    const race = (owner: string) =>
      execFileAsync(process.execPath, ["--import", "tsx", "test/claim-race.ts", file, itemId, owner]).then(
        (r) => JSON.parse(r.stdout) as { claimed: boolean },
      );
    const results = await Promise.all([race("a"), race("b"), race("c")]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect((await ledger.events(itemId)).filter((e) => e.type === "claimed")).toHaveLength(1);
  });

  it("claimNext takes the oldest ready item", async () => {
    await newItem();
    await newItem();
    expect(await ledger.claimNext("a", 60)).toBe("WI-1");
    expect(await ledger.claimNext("a", 60)).toBe("WI-2");
    expect(await ledger.claimNext("a", 60)).toBeNull();
  });

  it("writes an event with every status change and refuses changes from a non-owner", async () => {
    const { itemId } = await newItem();
    await ledger.claim(itemId, "a", 60);
    await ledger.transition(itemId, "a", "running", "verifying", "verifying", {});
    await expect(ledger.transition(itemId, "b", "verifying", "done", "merged", {})).rejects.toBeInstanceOf(
      FoundryError,
    );
    await ledger.transition(itemId, "a", "verifying", "done", "merged", { commit: "abc" });
    const item = await ledger.getItem(itemId);
    expect(item?.status).toBe("done");
    expect(item?.lease_owner).toBeNull();
    expect((await ledger.events(itemId)).map((e) => e.type)).toEqual(["created", "claimed", "verifying", "merged"]);
  });

  it("returns items with expired leases to ready and bumps the attempt", async () => {
    const { itemId } = await newItem();
    await ledger.claim(itemId, "a", 60);
    expect(await ledger.recoverExpired(Date.now())).toEqual([]);
    expect(await ledger.recoverExpired(Date.now() + 61_000)).toEqual([itemId]);
    const item = await ledger.getItem(itemId);
    expect(item?.status).toBe("ready");
    expect(item?.attempt).toBe(2);
    expect(await ledger.renewLease(itemId, "a", 60)).toBe(false);
  });

  it("fails an item whose lease expires after its last attempt", async () => {
    const { itemId } = await newItem();
    for (let i = 0; i < 3; i++) {
      await ledger.claim(itemId, "a", 1);
      await ledger.recoverExpired(Date.now() + 2_000);
    }
    expect((await ledger.getItem(itemId))?.status).toBe("failed");
  });

  it("renews a lease only for its owner", async () => {
    const { itemId } = await newItem();
    await ledger.claim(itemId, "a", 1);
    const before = (await ledger.getItem(itemId))!.lease_expires_at!;
    expect(await ledger.renewLease(itemId, "b", 60)).toBe(false);
    expect(await ledger.renewLease(itemId, "a", 60)).toBe(true);
    expect((await ledger.getItem(itemId))!.lease_expires_at!).toBeGreaterThan(before);
  });
});

describe("ledger migration", () => {
  it("upgrades a Phase 0 ledger in place and keeps its history", async () => {
    const file = path.join(dir, "old.db");
    fs.copyFileSync("test/fixtures/ledger-v1.db", file);
    const old = await Ledger.open(file);
    const [item] = await old.listItems();
    expect(item?.status).toBe("done");
    expect((await old.getRun(item!.run_id))?.status).toBe("done");
    expect((await old.events(item!.id)).map((e) => e.type)).toContain("merged");
    const { itemIds } = await old.startRun({
      formula: { formula: "f", version: 1, oneStep: true, steps: [{ id: "a", type: "agent", role: "worker", goal: "g", needs: [], max_attempts: 3, submit: false, inputs: [], conditional: false, environment_change: false }] } as never,
      title: "new",
      input: "",
      packDir: null,
    });
    expect(itemIds).toEqual(["WI-2"]);
    await old.close();
  });
});

describe("run graph", () => {
  const formula = (steps: object[]) => ({ formula: "f", version: 1, oneStep: false, steps: steps.map((s) => ({ type: "agent", role: "worker", goal: "g", needs: [], max_attempts: 3, submit: true, inputs: [], conditional: false, environment_change: false, ...s })) }) as never;
  const finish = async (id: string, result: object, status: "done" | "skipped" = "done") => {
    await ledger.claim(id, "w", 60);
    await ledger.transition(id, "w", "running", status, status, {}, { result_json: JSON.stringify({ outputs: {}, artifacts: [], decisions: [], summary: "s", ...result }) });
  };

  it("starts steps in dependency order and fans out per unit", async () => {
    const { runId, itemIds } = await ledger.startRun({ formula: formula([{ id: "a" }, { id: "b", needs: ["a"], per: "units" }, { id: "c", needs: ["b"] }]), title: "t", input: "", packDir: null });
    expect(itemIds).toEqual(["WI-1"]);
    await finish("WI-1", { outputs: { units: ["x", "y"] } });
    const b = (await ledger.listItems(runId)).filter((i) => i.step_id === "b");
    expect(b.map((i) => i.unit)).toEqual(["x", "y"]);
    await finish(b[0]!.id, {});
    expect((await ledger.listItems(runId)).some((i) => i.step_id === "c")).toBe(false);
    await finish(b[1]!.id, {});
    const c = (await ledger.listItems(runId)).find((i) => i.step_id === "c")!;
    expect(JSON.parse(c.inputs_json!).map((i: { unit: string }) => i.unit)).toEqual(["x", "y"]);
    await finish(c.id, {});
    expect((await ledger.getRun(runId))?.status).toBe("done");
  });

  it("passes a skipped step on as absent and still completes the run", async () => {
    const { runId } = await ledger.startRun({ formula: formula([{ id: "a" }, { id: "b", needs: ["a"] }]), title: "t", input: "", packDir: null });
    await finish("WI-1", { reason: "n/a" }, "skipped");
    const b = (await ledger.listItems(runId)).find((i) => i.step_id === "b")!;
    expect(JSON.parse(b.inputs_json!)[0]).toMatchObject({ status: "skipped", summary: "skipped: n/a", artifacts: [] });
    await finish(b.id, {});
    expect((await ledger.getRun(runId))?.status).toBe("done");
  });

  it("serializes the merge queue: one item merges at a time", async () => {
    const { runId } = await ledger.startRun({ formula: formula([{ id: "a", per: undefined }]), title: "t", input: "", packDir: null });
    const { itemIds } = await ledger.startRun({ formula: formula([{ id: "a" }]), title: "t2", input: "", packDir: null });
    for (const id of ["WI-1", itemIds[0]!]) {
      await ledger.claim(id, "w", 60);
      await ledger.transition(id, "w", "running", "merge_ready", "merge_queued", {});
    }
    expect(await ledger.claimMerge("m1", 60)).toEqual({ kind: "item", id: "WI-1" });
    expect(await ledger.claimMerge("m2", 60)).toBeNull();
    await ledger.transition("WI-1", "m1", "merging", "done", "merged", {});
    expect(await ledger.claimMerge("m2", 60)).toEqual({ kind: "item", id: "WI-2" });
    expect(runId).toBe("RUN-1");
  });
});

describe("lanes", () => {
  const formula = (steps: object[]) => ({ formula: "f", version: 1, oneStep: false, steps: steps.map((s) => ({ type: "agent", role: "worker", goal: "g", needs: [], max_attempts: 3, submit: true, inputs: [], conditional: false, environment_change: false, docs_only: false, ...s })) }) as never;
  const finish = async (id: string, type: string, result: object = {}, commit: string | null = null) => {
    await ledger.claim(id, "w", 60);
    await ledger.transition(id, "w", "running", "done", type, {}, { result_json: JSON.stringify({ outputs: {}, artifacts: [], decisions: [], summary: "s", ...result }), commit_sha: commit });
  };

  it("gives a unit's steps one lane, other units their own, and docs-only steps the run's docs lane", async () => {
    const { runId } = await ledger.startRun({
      formula: formula([{ id: "design" }, { id: "brief", needs: ["design"], docs_only: true }, { id: "notes", needs: ["design"], docs_only: true }, { id: "plan", needs: ["design"], per: "units" }, { id: "build", needs: ["plan"], per: "units" }]),
      title: "t",
      input: "",
      packDir: null,
    });
    await finish("WI-1", "merged", { outputs: { units: ["u1", "u2"] } });
    const items = await ledger.listItems(runId);
    const lane = (step: string, unit: string | null = null) => items.find((i) => i.step_id === step && i.unit === unit)!.lane_id;
    expect(lane("design")).toBe("WI-1");
    expect(lane("brief")).toBe("RUN-1-docs");
    expect(lane("notes")).toBe("RUN-1-docs");
    expect(lane("plan", "u1")).toBe("RUN-1-units-u1");
    expect(lane("plan", "u2")).toBe("RUN-1-units-u2");

    // One item at a time in a lane: the second docs item waits for the first.
    const brief = items.find((i) => i.step_id === "brief")!.id;
    const notes = items.find((i) => i.step_id === "notes")!.id;
    expect(await ledger.claim(brief, "w", 60)).toBe(true);
    expect(await ledger.claim(notes, "w2", 60)).toBe(false);
    expect(await ledger.laneRoute(brief)).toBe("commit");
    await ledger.transition(brief, "w", "running", "done", "lane_committed", {}, { commit_sha: "a".repeat(40), result_json: "{}" });
    expect(await ledger.claim(notes, "w2", 60)).toBe(true);
    await ledger.transition(notes, "w2", "running", "done", "lane_committed", {}, { result_json: "{}" });

    const plan1 = items.find((i) => i.step_id === "plan" && i.unit === "u1")!.id;
    await ledger.claim(plan1, "w", 60);
    expect(await ledger.laneRoute(plan1)).toBe("commit");
    await ledger.transition(plan1, "w", "running", "done", "lane_committed", {}, { commit_sha: "b".repeat(40), result_json: "{}" });
    await finish(items.find((i) => i.step_id === "plan" && i.unit === "u2")!.id, "lane_committed");
    const build1 = (await ledger.listItems(runId)).find((i) => i.step_id === "build" && i.unit === "u1")!;
    expect(build1.lane_id).toBe("RUN-1-units-u1");
    await ledger.claim(build1.id, "w", 60);
    expect(await ledger.laneRoute(build1.id)).toBe("merge");
  });

  it("merges the docs lane after the rest of the run, then closes the run", async () => {
    const { runId } = await ledger.startRun({ formula: formula([{ id: "brief", docs_only: true }, { id: "code", needs: ["brief"] }]), title: "t", input: "", packDir: null });
    await finish("WI-1", "lane_committed", {}, "c".repeat(40));
    expect((await ledger.getLane("RUN-1-docs"))?.head).toBe("c".repeat(40));
    await finish("WI-2", "merged");
    expect((await ledger.getLane("RUN-1-docs"))?.status).toBe("merge_ready");
    expect((await ledger.getRun(runId))?.status).toBe("open");
    expect(await ledger.claimMerge("m", 60)).toEqual({ kind: "lane", id: "RUN-1-docs" });
    expect(await ledger.hasActiveItems(runId)).toBe(true);
    await ledger.laneMerged("RUN-1-docs", "m", "d".repeat(40));
    expect((await ledger.getRun(runId))?.status).toBe("done");
  });

  it("sends a failed lane merge back to the lane's last item, which builds on the lane's tip", async () => {
    const { runId } = await ledger.startRun({ formula: formula([{ id: "brief", docs_only: true }]), title: "t", input: "", packDir: null });
    await ledger.claim("WI-1", "w", 60);
    await ledger.enterLane("WI-1", "w", {}, { worktree: "/w", branch: "b", lane_start: "0".repeat(40) });
    await ledger.transition("WI-1", "w", "running", "done", "lane_committed", {}, { commit_sha: "c".repeat(40), result_json: "{}" });
    expect(await ledger.claimMerge("m", 60)).toEqual({ kind: "lane", id: "RUN-1-docs" });
    expect(await ledger.laneSendBack("RUN-1-docs", "m", "conflict", {}, "the docs conflict with main")).toEqual({ itemId: "WI-1", next: "ready" });
    const item = (await ledger.getItem("WI-1"))!;
    expect(item).toMatchObject({ status: "ready", attempt: 2, lane_start: null, lane_id: "RUN-1-docs" });
    expect((await ledger.getRun(runId))?.status).toBe("open");
    expect((await ledger.notes("WI-1")).at(-1)).toMatchObject({ kind: "refinery", body: "the docs conflict with main" });
  });
});
