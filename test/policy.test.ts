import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decide, ToolCallTracker } from "../src/runtime/policy.js";

// Replay the permission requests recorded from the real agents.
function replay(file: string, cwdOverride?: string) {
  const lines = fs
    .readFileSync(`docs/acp-spike/${file}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const tracker = new ToolCallTracker();
  let cwd = "";
  const decisions: { title: string; allow: boolean }[] = [];
  for (const { dir, msg } of lines) {
    if (dir === "out" && msg.method === "session/new") cwd = cwdOverride ?? msg.params.cwd;
    if (dir !== "in") continue;
    if (msg.method === "session/update") tracker.update(msg.params.update);
    if (msg.method === "session/request_permission") {
      const d = decide(msg.params, tracker.get(msg.params.toolCall.toolCallId), cwd);
      decisions.push({ title: msg.params.toolCall.title, allow: d.allow });
    }
  }
  return decisions;
}

describe("permission policy on recorded requests", () => {
  it("allows Kiro's write inside the worktree", () => {
    expect(replay("kiro")).toEqual([{ title: "Creating hello.txt", allow: true }]);
  });
  it("allows Claude's write inside the worktree", () => {
    expect(replay("claude")).toEqual([{ title: "Write hello.txt", allow: true }]);
  });
  it("denies the same writes when the worktree is elsewhere", () => {
    expect(replay("kiro", "/somewhere/else")[0]?.allow).toBe(false);
    expect(replay("claude", "/somewhere/else")[0]?.allow).toBe(false);
  });
  it("denies Claude's git push", () => {
    expect(replay("claude-shell-denied")).toEqual([{ title: "git push origin main", allow: false }]);
  });
  it("allows Kiro's ls (classified as execute from the earlier tool_call)", () => {
    expect(replay("kiro-shell-ls")).toEqual([{ title: "Running: ls -la", allow: true }]);
  });
});

describe("permission policy rules", () => {
  const wt = "/repo/.foundry/worktrees/WI-1-a1";
  const ask = (toolCall: Record<string, unknown>, seen?: Record<string, unknown>) =>
    decide({ sessionId: "s", toolCall: { toolCallId: "t", ...toolCall }, options: [] } as never, seen as never, wt);

  it.each([
    ["git push origin main", false],
    ["git -C . push --force", false],
    ["cd /tmp && git push", false],
    ["npm test", true],
    [`cd ${wt} && npm test`, true],
    ["cat /etc/passwd", false],
    ["npm test 2>/dev/null", true],
    ["git commit -m 'push the button'", true],
  ])("shell %s -> allow=%s", (command, allow) => {
    expect(ask({ kind: "execute", rawInput: { command } }).allow).toBe(allow);
  });

  it("denies a write whose path escapes with ..", () => {
    expect(ask({ kind: "edit", rawInput: { file_path: `${wt}/../../x` } }).allow).toBe(false);
  });
  it("denies an edit that names no path", () => {
    expect(ask({ kind: "edit", rawInput: {} }).allow).toBe(false);
  });
  it("denies network fetches", () => {
    expect(ask({ kind: "fetch", rawInput: { url: "https://example.com" } }).allow).toBe(false);
  });
  it("allows a tool that names no path or command", () => {
    expect(ask({ kind: "think" }).allow).toBe(true);
  });
  it("treats Kiro's write tool (command=create) as a write, not a shell command", () => {
    const d = ask({ rawInput: { command: "create", path: "/etc/hosts" } }, { kind: "edit" });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/outside/);
  });
});
