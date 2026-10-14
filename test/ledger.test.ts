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
