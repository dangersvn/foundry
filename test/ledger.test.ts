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
    expect(await ledger.claimMerge("m1", 60)).toBe("WI-1");
    expect(await ledger.claimMerge("m2", 60)).toBeNull();
    await ledger.transition("WI-1", "m1", "merging", "done", "merged", {});
    expect(await ledger.claimMerge("m2", 60)).toBe("WI-2");
    expect(runId).toBe("RUN-1");
  });
});
