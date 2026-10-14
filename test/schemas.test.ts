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
