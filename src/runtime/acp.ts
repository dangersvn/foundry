// Agent-neutral ACP runtime: one agent process and one session per attempt.
// It answers permission requests with the policy, turns ACP traffic into
// validated AgentEvents, and keeps the raw wire transcript in a file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { FoundryError } from "../kernel/errors.js";
import { AgentEvent } from "../schemas/agent.js";
import { decide, ToolCallTracker } from "./policy.js";

export interface AgentRun {
  agent: string; // the name from foundry.toml, for messages only
  command: string[];
  cwd: string; // the item's worktree
  prompt: string;
  transcriptPath: string;
  onEvent: (e: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
}

// The agent could not be started or set up; the item itself is fine.
export class AgentStartError extends FoundryError {}

export async function runAgent(run: AgentRun): Promise<{ stopReason: string }> {
  const [cmd, ...args] = run.command as [string, ...string[]];
  const transcript = fs.createWriteStream(run.transcriptPath, { flags: "a" });
  const t0 = Date.now();
  const log = (dir: string, msg: unknown) => transcript.write(JSON.stringify({ t: Date.now() - t0, dir, msg }) + "\n");

  // Its own process group, so npx wrappers and their children die together.
  const child = spawn(cmd, args, { cwd: run.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    log("stderr", d.toString());
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  const exited = new Promise<never>((_, reject) => {
    child.on("error", (e: NodeJS.ErrnoException) => reject(e));
    child.on("exit", (code, sig) => {
      log("exit", { code, sig });
      reject(Object.assign(new Error(`agent process exited (code ${code}, signal ${sig})`), { code: "EXITED" }));
    });
  });
  exited.catch(() => {});
  const kill = () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 3000).unref();
    } catch {}
  };
  run.signal?.addEventListener("abort", kill);
  process.on("exit", kill);

  // Record each line in both directions while the SDK reads and writes them.
  lineTap(child.stdout, (line) => log("in", tryParse(line)));
  const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const writer = toAgent.getWriter();
  const tapped = new WritableStream<Uint8Array>({
    write(chunk) {
      for (const line of Buffer.from(chunk).toString().split("\n")) if (line.trim()) log("out", tryParse(line));
      return writer.write(chunk);
    },
    close: () => writer.close(),
  });
  const stream = acp.ndJsonStream(tapped, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

  // Events are written in arrival order; a failed write (lost lease) stops the run.
  let queue = Promise.resolve();
  let eventError: unknown;
  const emit = (e: AgentEvent) => {
    const parsed = AgentEvent.parse(e);
    queue = queue.then(() => run.onEvent(parsed)).catch((err) => {
      eventError ??= err;
      kill();
    });
  };

  const tracker = new ToolCallTracker();
  const reported = new Set<string>();
  let message = "";
  const conn = new acp.ClientSideConnection(
    () => ({
      async requestPermission(req) {
        const d = decide(req, tracker.get(req.toolCall.toolCallId), run.cwd);
        emit({
          type: "permission",
          toolCallId: req.toolCall.toolCallId,
          title: req.toolCall.title ?? tracker.get(req.toolCall.toolCallId)?.title ?? "",
          kind: d.kind,
          allow: d.allow,
          reason: d.reason,
          paths: d.paths,
          ...(d.command !== undefined ? { command: d.command } : {}),
          request: req,
        });
        // Only ever *_once, so every later call still comes to the policy.
        const want = d.allow ? ["allow_once"] : ["reject_once", "reject_always"];
        const option = want.map((k) => req.options.find((o) => o.kind === k)).find(Boolean);
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(n) {
        const u = n.update as acp.SessionUpdate & Record<string, unknown>;
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") message += u.content.text;
        const call = tracker.update(u as never);
        const id = (u as { toolCallId?: string }).toolCallId;
        if (call && id && (call.status === "completed" || call.status === "failed") && !reported.has(id)) {
          reported.add(id);
          emit({
            type: "tool_call",
            toolCallId: id,
            title: call.title ?? "",
            kind: call.kind ?? "other",
            status: call.status,
            paths: (call.locations ?? []).map((l) => l.path),
          });
        }
      },
      // Agents' own extensions (e.g. _kiro.dev/*) are kept in the transcript only.
      async extNotification() {},
      async extMethod(method) {
        throw acp.RequestError.methodNotFound(method);
      },
    }),
    stream,
  );

  const startError = (what: string, e: unknown) => {
    const err = e as NodeJS.ErrnoException & { message?: string };
    if (err?.code === "ENOENT") {
      return new AgentStartError(
        "ACP runtime",
        `could not start agent "${run.agent}": command "${cmd}" was not found`,
        `install ${cmd}, or fix [agents.${run.agent}].command in foundry.toml; then run \`foundry work\``,
      );
    }
    const detail = err instanceof Error ? err.message : JSON.stringify(err);
    return new AgentStartError(
      "ACP runtime",
      `agent "${run.agent}" failed during ${what}: ${detail}${stderrTail ? `\n  agent stderr: ${stderrTail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" | ")}` : ""}`,
      `run \`${run.command.join(" ")}\` by hand to check it starts and is signed in; then run \`foundry work\``,
    );
  };

  try {
    let init: acp.InitializeResponse;
    let sessionId: string;
    try {
      init = await Promise.race([
        conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "foundry", version: "0.1.0" } }),
        exited,
      ]);
      ({ sessionId } = await Promise.race([conn.newSession({ cwd: run.cwd, mcpServers: [] }), exited]));
    } catch (e) {
      throw startError("startup", e);
    }
    emit({
      type: "agent_started",
      agent: run.agent,
      agentInfo: init.agentInfo ?? null,
      capabilities: (init.agentCapabilities as Record<string, unknown>) ?? null,
      transcript: run.transcriptPath,
    });

    let result: acp.PromptResponse;
    try {
      result = await Promise.race([conn.prompt({ sessionId, prompt: [{ type: "text", text: run.prompt }] }), exited]);
    } catch (e) {
      await queue;
      if (eventError) throw eventError;
      const detail = e instanceof Error ? e.message : JSON.stringify(e);
      throw new FoundryError("agent", `agent "${run.agent}" stopped mid-turn: ${detail}`, `see the transcript ${run.transcriptPath}`);
    }
    emit({ type: "agent_finished", stopReason: result.stopReason, message: message.slice(-4000), usage: result.usage ?? undefined });
    await queue;
    if (eventError) throw eventError;
    return { stopReason: result.stopReason };
  } finally {
    run.signal?.removeEventListener("abort", kill);
    process.off("exit", kill);
    child.stdin.end();
    kill();
    await new Promise((r) => transcript.end(r));
  }
}

function lineTap(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buf = "";
  stream.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}
