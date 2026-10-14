// The permission policy answers every session/request_permission: writes
// inside the item's worktree are allowed; anything outside it, `git push`
// and network fetches are denied. See docs/decisions.md D6.
import fs from "node:fs";
import path from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

export interface SeenToolCall {
  kind?: string;
  title?: string;
  status?: string;
  locations?: { path: string }[];
  rawInput?: Record<string, unknown>;
  content?: unknown[];
}

export interface Decision {
  allow: boolean;
  reason: string;
  kind: string;
  paths: string[];
  command?: string;
}

// Kiro's permission requests carry no kind or locations; those arrive in the
// earlier tool_call update, so remember every tool call by id.
export class ToolCallTracker {
  private calls = new Map<string, SeenToolCall>();

  update(u: { sessionUpdate: string; toolCallId?: string } & Record<string, unknown>): SeenToolCall | undefined {
    if ((u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") || !u.toolCallId) return undefined;
    const prev = this.calls.get(u.toolCallId) ?? {};
    const next: SeenToolCall = { ...prev };
    for (const key of ["kind", "title", "status", "locations", "content"] as const) {
      if (u[key] !== undefined && u[key] !== null) (next as Record<string, unknown>)[key] = u[key];
    }
    const raw = u.rawInput as Record<string, unknown> | undefined;
    if (raw && Object.keys(raw).length > 0) next.rawInput = { ...prev.rawInput, ...raw };
    this.calls.set(u.toolCallId, next);
    return next;
  }

  get(id: string): SeenToolCall | undefined {
    return this.calls.get(id);
  }
}

const WRITE_KINDS = new Set(["edit", "delete", "move"]);

export function decide(req: RequestPermissionRequest, seen: SeenToolCall | undefined, worktree: string): Decision {
  const tc = req.toolCall as SeenToolCall & { toolCallId: string };
  const rawInput = { ...seen?.rawInput, ...tc.rawInput };
  const paths = collectPaths([seen, tc], rawInput);
  const rawCommand = typeof rawInput.command === "string" ? rawInput.command : undefined;
  let kind = tc.kind ?? seen?.kind;
  if (!kind && rawCommand && paths.length === 0) kind = "execute";
  kind ??= "other";
  const base = { kind, paths };

  if (kind === "fetch") return { ...base, allow: false, reason: "network access is not allowed in v0" };

  if (kind === "execute") {
    const command = rawCommand ?? tc.title ?? "";
    if (isGitPush(command)) return { ...base, command, allow: false, reason: "git push is not allowed; only the engine merges" };
    const outside = absolutePaths(command).find((p) => !p.startsWith("/dev/") && !inside(p, worktree));
    if (outside) return { ...base, command, allow: false, reason: `command names ${outside}, outside the worktree` };
    return { ...base, command, allow: true, reason: "shell command inside the worktree" };
  }

  const outside = paths.find((p) => !inside(p, worktree));
  if (outside) return { ...base, allow: false, reason: `${outside} is outside the worktree` };
  if (WRITE_KINDS.has(kind) && paths.length === 0) {
    return { ...base, allow: false, reason: `${kind} request names no path, so it cannot be checked` };
  }
  return { ...base, allow: true, reason: paths.length ? "inside the worktree" : "names no path or command" };
}

function collectPaths(calls: (SeenToolCall | undefined)[], rawInput: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const c of calls) {
    for (const l of c?.locations ?? []) if (l?.path) out.add(l.path);
    for (const item of c?.content ?? []) {
      const p = (item as { type?: string; path?: unknown }).path;
      if ((item as { type?: string }).type === "diff" && typeof p === "string") out.add(p);
    }
  }
  for (const key of ["path", "file_path", "notebook_path"]) {
    if (typeof rawInput[key] === "string") out.add(rawInput[key] as string);
  }
  return [...out];
}

// True when `p` (absolute, or relative to the worktree) resolves inside it,
// following symlinks as far as the path exists.
export function inside(p: string, worktree: string): boolean {
  const root = realish(worktree);
  const target = realish(path.resolve(worktree, p));
  return target === root || target.startsWith(root + path.sep);
}

function realish(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

// `git [global options] push ...` in any segment of a shell command line.
export function isGitPush(command: string): boolean {
  for (const segment of command.split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/);
    let i = tokens.indexOf("git");
    if (i < 0) continue;
    for (i++; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === "-C" || t === "-c") i++;
      else if (!t.startsWith("-")) break;
    }
    if (tokens[i] === "push") return true;
  }
  return false;
}

function absolutePaths(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s=:'"(<>])((?:\/|~\/)[^\s'";|&<>()]*)/g)].map((m) =>
    m[1]!.startsWith("~/") ? path.join(process.env.HOME ?? "/", m[1]!.slice(2)) : m[1]!,
  );
}
