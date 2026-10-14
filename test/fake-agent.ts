#!/usr/bin/env node
// Fake ACP agent for tests. It speaks raw newline-delimited JSON-RPC and copies
// the message shapes recorded in docs/acp-spike/ (see notes.md there):
// a tool_call update, then session/request_permission, then a direct disk
// write, then a tool_call_update, then agent_message_chunks, then end_turn.
//
//   fake-agent.ts [--style kiro|claude] [--mode work|fake-success|escape]
//                 [--plan plan.json] [--delay-ms N]
//
// work          apply the plan's writes ({writes: [{path, content}], message})
// fake-success  write an unrelated note and claim success without fixing anything
// escape        try to write outside cwd and to run `git push`, then write inside
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    style: { type: "string", default: "kiro" },
    mode: { type: "string", default: "work" },
    plan: { type: "string" },
    "delay-ms": { type: "string", default: "0" },
  },
});
const style = opts.style === "claude" ? "claude" : "kiro";

interface Plan {
  writes: { path: string; content: string }[];
  message?: string;
}
const plan: Plan = opts.plan ? JSON.parse(fs.readFileSync(opts.plan, "utf8")) : { writes: [] };

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const notify = (method: string, params: Json) => send({ method, params });
const update = (sessionId: string, u: Json) => notify("session/update", { sessionId, update: u });

let nextId = style === "claude" ? 0 : 1;
const waiting = new Map<string | number, (result: Json) => void>();
const request = (method: string, params: Json) =>
  new Promise<Json>((resolve) => {
    const id = style === "kiro" ? randomUUID() : nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cwd = process.cwd();
let toolSeq = 0;

// One tool call, shaped the way the chosen agent style sends it. Returns
// whether the client allowed it.
async function toolCall(
  sessionId: string,
  kind: "edit" | "execute",
  target: { path?: string; command?: string },
  run: () => void,
): Promise<boolean> {
  const toolCallId = `${style === "kiro" ? "tooluse" : "toolu"}_fake${++toolSeq}`;
  const abs = target.path ? path.resolve(cwd, target.path) : undefined;
  const title = kind === "edit" ? `Write ${path.basename(abs!)}` : target.command!;
  const rawInput: Json =
    kind === "edit"
      ? style === "kiro"
        ? { command: "create", path: abs, content: "…" }
        : { file_path: abs, content: "…" }
      : { command: target.command };
  const locations = abs ? [{ path: abs }] : [];

  if (style === "kiro") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, kind, locations, rawInput });
  } else {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Preparing…", kind, status: "pending", rawInput: {}, locations: [] });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, title, rawInput, locations });
  }
  const toolCallParams: Json =
    style === "kiro" ? { toolCallId, title, rawInput } : { toolCallId, title, kind, status: "pending", rawInput, locations };
  const options =
    style === "kiro"
      ? [
          { optionId: "allow_once", name: "Yes", kind: "allow_once" },
          { optionId: "allow_always", name: "Always", kind: "allow_always" },
          { optionId: "reject_once", name: "No", kind: "reject_once" },
        ]
      : [
          { optionId: "allow-once", name: "Yes", kind: "allow_once" },
          { optionId: "allow-with-updates", name: "Yes, always", kind: "allow_always" },
          { optionId: "reject", name: "No", kind: "reject_once" },
        ];
  const res = await request("session/request_permission", { sessionId, toolCall: toolCallParams, options });
  const outcome = res.outcome as { outcome: string; optionId?: string };
  const chosen = options.find((o) => o.optionId === outcome.optionId);
  const allowed = outcome.outcome === "selected" && !!chosen?.kind.startsWith("allow");
  if (allowed) run();
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: allowed ? "completed" : "failed",
    rawOutput: allowed ? "ok" : "User denied tool execution",
  });
  return allowed;
}

function writeFile(p: string, content: string) {
  const abs = path.resolve(cwd, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function say(sessionId: string, text: string) {
  for (const chunk of text.match(/.{1,24}/gs) ?? []) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  }
}

async function prompt(sessionId: string) {
  await sleep(Number(opts["delay-ms"]));
  if (opts.mode === "fake-success") {
    await toolCall(sessionId, "edit", { path: "NOTES.md" }, () => writeFile("NOTES.md", "Fixed the failing test.\n"));
    await say(sessionId, "Done. I fixed the failing test and all tests pass now.");
  } else if (opts.mode === "escape") {
    const outside = await toolCall(sessionId, "edit", { path: "../escape.txt" }, () => writeFile("../escape.txt", "escaped\n"));
    const push = await toolCall(sessionId, "execute", { command: "git push origin main" }, () => {});
    const inside = await toolCall(sessionId, "edit", { path: "inside.txt" }, () => writeFile("inside.txt", "inside\n"));
    await say(sessionId, JSON.stringify({ outside, push, inside }));
  } else {
    for (const w of plan.writes) {
      await toolCall(sessionId, "edit", { path: w.path }, () => writeFile(w.path, w.content));
    }
    await say(sessionId, plan.message ?? "Done.");
  }
  if (style === "kiro") notify("_kiro.dev/metadata", { sessionId, contextUsagePercentage: 1.2, turnDurationMs: 10 });
  return { stopReason: "end_turn" };
}

async function handle(msg: Json) {
  const { id, method, params } = msg as { id?: string | number; method?: string; params: Json };
  if (method === undefined) {
    if (id !== undefined) waiting.get(id)?.((msg.result as Json) ?? {});
    return;
  }
  if (id === undefined) return; // notifications such as session/cancel
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false } },
        authMethods: [],
        agentInfo: { name: `fake-agent (${style} style)`, version: "0.0.0" },
      },
    });
  }
  if (method === "session/new") {
    cwd = params.cwd as string;
    return send({ id, result: { sessionId: randomUUID() } });
  }
  if (method === "session/prompt") return send({ id, result: await prompt(params.sessionId as string) });
  send({ id, error: { code: -32601, message: `fake agent does not support ${method}` } });
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) void handle(JSON.parse(line));
  }
});
// Real agents exit when the client goes away; so does this one.
process.stdin.on("end", () => process.exit(0));
