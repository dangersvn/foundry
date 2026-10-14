#!/usr/bin/env node
// ACP spike: talk raw JSON-RPC (newline-delimited) to a real agent and record
// every message in both directions. Usage:
//   node scripts/acp-spike.mjs <name> <command...>
// Writes docs/acp-spike/<name>.jsonl. Runs in a fresh temp git repo.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Optional: SPIKE_PROMPT overrides the prompt; SPIKE_DENY_EXEC=1 rejects every
// shell (execute) permission request, to record how agents take a denial.
const [name, ...cmd] = process.argv.slice(2);
const promptText = process.env.SPIKE_PROMPT ?? "create hello.txt containing hi";
const denyExec = process.env.SPIKE_DENY_EXEC === "1";
if (!name || cmd.length === 0) {
  console.error("usage: acp-spike.mjs <name> <command...>");
  process.exit(2);
}
const outDir = path.resolve("docs/acp-spike");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.jsonl`);
const out = fs.createWriteStream(outFile);
const t0 = Date.now();
const log = (dir, msg) => out.write(JSON.stringify({ t: Date.now() - t0, dir, msg }) + "\n");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `acp-spike-${name}-`));
execFileSync("git", ["init", "-q"], { cwd });
console.error(`cwd: ${cwd}`);

const child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => log("stderr", d.toString()));
child.on("exit", (code, sig) => log("exit", { code, sig }));

let nextId = 1;
const pending = new Map();
const send = (msg) => {
  log("out", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
};
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });

function handleAgentRequest(msg) {
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (message) => send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
  const inside = (p) => path.resolve(cwd, p).startsWith(cwd + path.sep);
  if (method === "session/request_permission") {
    const isExec = params.toolCall.kind === "execute" || typeof params.toolCall.rawInput?.command === "string" && params.toolCall.rawInput?.command !== "create";
    if (denyExec && isExec) {
      const rej = params.options.find((o) => o.kind === "reject_once") ?? params.options.at(-1);
      return reply({ outcome: { outcome: "selected", optionId: rej.optionId } });
    }
    const opt =
      params.options.find((o) => o.kind === "allow_once") ??
      params.options.find((o) => o.kind === "allow_always") ??
      params.options[0];
    return reply({ outcome: { outcome: "selected", optionId: opt.optionId } });
  }
  if (method === "fs/write_text_file") {
    if (!inside(params.path)) return fail("outside cwd");
    fs.mkdirSync(path.dirname(params.path), { recursive: true });
    fs.writeFileSync(params.path, params.content);
    return reply(null);
  }
  if (method === "fs/read_text_file") {
    if (!inside(params.path)) return fail("outside cwd");
    try {
      return reply({ content: fs.readFileSync(params.path, "utf8") });
    } catch (e) {
      return fail(String(e));
    }
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
}

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("stdout-nonjson", line);
      continue;
    }
    log("in", msg);
    if (msg.method && msg.id !== undefined) handleAgentRequest(msg);
    else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    }
  }
});

const timeout = setTimeout(() => {
  log("note", "timeout after 300s");
  finish(1);
}, 300_000);

function finish(code) {
  clearTimeout(timeout);
  const hello = path.join(cwd, "hello.txt");
  const result = fs.existsSync(hello) ? JSON.stringify(fs.readFileSync(hello, "utf8")) : "missing";
  log("note", { helloTxt: result });
  console.error(`hello.txt: ${result}`);
  child.kill("SIGTERM");
  out.end(() => process.exit(code));
}

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "foundry-spike", version: "0.0.0" },
  });
  console.error("initialized:", JSON.stringify(init).slice(0, 300));
  const sess = await request("session/new", { cwd, mcpServers: [] });
  console.error("session:", sess.sessionId);
  const res = await request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  console.error("prompt result:", JSON.stringify(res));
  finish(0);
} catch (e) {
  log("note", { error: e });
  console.error("error:", JSON.stringify(e));
  finish(1);
}
