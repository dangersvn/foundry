import { describe, expect, it } from "vitest";
import { parseConfig, pickAgent } from "../src/schemas/config.js";
import { parseFormula } from "../src/schemas/formula.js";
import { FoundryError } from "../src/kernel/errors.js";

describe("foundry.toml", () => {
  it("parses the brief's example", () => {
    const cfg = parseConfig(`
[agents.kiro]
command = ["kiro-cli", "acp"]

[agents.claude]
command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]

[dispatch]
prefer = ["kiro", "claude"]
`);
    expect(cfg.agents.kiro?.command).toEqual(["kiro-cli", "acp"]);
    expect(cfg.leases.ttl_seconds).toBe(120);
    expect(pickAgent(cfg)).toBe("kiro");
  });

  it("works with one agent and no dispatch table", () => {
    const cfg = parseConfig(`[agents.claude]\ncommand = ["claude-acp"]\n`);
    expect(pickAgent(cfg)).toBe("claude");
  });

  it("rejects prefer naming an agent that is not configured", () => {
    expect(() => parseConfig(`[agents.kiro]\ncommand=["k"]\n[dispatch]\nprefer=["claude"]\n`)).toThrow(
      /claude/,
    );
  });

  it("names the config layer when the file is invalid", () => {
    try {
      parseConfig(`[agents.kiro]\ncommand = "kiro-cli acp"\n`);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FoundryError);
      expect((e as FoundryError).layer).toBe("config");
      expect((e as FoundryError).next).toBeTruthy();
    }
  });
});

describe("formula", () => {
  it("parses a one-step formula", () => {
    const f = parseFormula(`
formula = "health-endpoint"
version = 1
title = "add a health endpoint with a test"

[step]
id = "code"
goal = "Add GET /health"
verify = "npm test"
`);
    expect(f.step.verify).toBe("npm test");
    expect(f.title).toBe("add a health endpoint with a test");
  });

  it("requires a verify command", () => {
    expect(() => parseFormula(`formula="x"\nversion=1\n[step]\nid="a"\ngoal="g"\n`)).toThrow(/verify/);
  });
});

describe("factory board", () => {
  it("draws main, one lane per worker with its worktree, the queue and the input line", async () => {
    const { renderBoard } = await import("../src/cli/factory.js");
    const item = (id: string, status: string, owner: string | null, title: string) =>
      ({ id, status, lease_owner: owner, title, worktree: `/r/.foundry/worktrees/${id}-a1`, branch: `foundry/${id}-a1` }) as never;
    const screen = renderBoard({
      repo: "/r",
      agent: "kiro",
      target: "main",
      workers: [{ id: "w1" }, { id: "w2" }],
      items: [item("WI-1", "running", "w1", "add /health"), item("WI-2", "verifying", "w2", "add /time"), item("WI-3", "ready", null, "add /echo")],
      latest: new Map(),
      mainLog: ["abc1234 demo app"],
      activity: [],
      input: "add a /quote route",
      notice: "",
      width: 120,
    }).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    expect(screen).toContain("worker 1  WI-1 [running]  add /health");
    expect(screen).toContain("worktree .foundry/worktrees/WI-1-a1");
    expect(screen).toContain("worker 2  WI-2 [verifying]  add /time");
    expect(screen).toMatch(/queued\s+WI-3 add \/echo/);
    expect(screen).toContain("factory › add a /quote route");
  });
});
