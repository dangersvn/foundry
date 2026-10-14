import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStartError, runAgent } from "../src/runtime/acp.js";
import type { AgentEvent } from "../src/schemas/agent.js";
import { fakeAgentCommand as fakeAgent } from "./helpers.js";


let dir: string;
let wt: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-"));
  wt = path.join(dir, "wt");
  fs.mkdirSync(wt);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function run(command: string[]) {
  const events: AgentEvent[] = [];
  const result = await runAgent({
    agent: "fake",
    command,
    cwd: wt,
    prompt: "do it",
    transcriptPath: path.join(dir, "t.jsonl"),
    onEvent: async (e) => void events.push(e),
  });
  return { result, events };
}

describe.each(["kiro", "claude"])("ACP runtime with the fake agent in %s style", (style) => {
  it("denies writes outside the worktree and git push, allows writes inside", async () => {
    const { result, events } = await run(fakeAgent("--style", style, "--mode", "escape"));
    expect(result.stopReason).toBe("end_turn");
    const perms = events.filter((e) => e.type === "permission");
    expect(perms.map((p) => [p.kind, p.allow])).toEqual([
      ["edit", false],
      ["execute", false],
      ["edit", true],
    ]);
    expect(fs.existsSync(path.join(dir, "escape.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(wt, "inside.txt"), "utf8")).toBe("inside\n");
    expect(events.map((e) => e.type)).toEqual([
      "agent_started",
      "permission",
      "tool_call",
      "permission",
      "tool_call",
      "permission",
      "tool_call",
      "agent_finished",
    ]);
    const finished = events.at(-1) as Extract<AgentEvent, { type: "agent_finished" }>;
    expect(JSON.parse(finished.message)).toEqual({ outside: false, push: false, inside: true });
    const transcript = fs.readFileSync(path.join(dir, "t.jsonl"), "utf8").trim().split("\n");
    expect(transcript.some((l) => l.includes("session/request_permission"))).toBe(true);
  });
});

describe("ACP runtime start failures", () => {
  it("names the ACP runtime layer when the command does not exist", async () => {
    const err = await run(["definitely-not-an-agent-xyz", "acp"]).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.layer).toBe("ACP runtime");
    expect(err.next).toMatch(/foundry work/);
  });

  it("reports an agent that exits during startup", async () => {
    const err = await run([process.execPath, "-e", "console.error('not signed in'); process.exit(3)"]).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err.message).toMatch(/not signed in/);
  });
});
