# ACP spike notes

Run on 2026-10-14 with `scripts/acp-spike.mjs`, a raw newline-delimited
JSON-RPC client (no SDK), so the transcripts show exactly what each agent puts
on the wire. Each run starts in a fresh temp git repo. Every line in the
`.jsonl` files is `{t: ms since start, dir: out|in|stderr|exit|note, msg}`.
Account emails were replaced with `<redacted-email>`.

| File | Agent | Prompt | Permission answer |
| --- | --- | --- | --- |
| `kiro.jsonl` | kiro-cli 2.21.0 | create hello.txt containing hi | allow_once |
| `claude.jsonl` | claude-agent-acp 0.90.0 (Claude Code 2.1.299) | same | allow_once |
| `kiro-shell-denied.jsonl` | kiro | run `git push origin main` | reject shell |
| `kiro-shell-ls.jsonl` | kiro | run `ls -la` | reject shell |
| `claude-shell-denied.jsonl` | claude | run `git push origin main` | reject shell |

Both agents created `hello.txt` (Kiro wrote `hi`, Claude wrote `hi\n`) and
ended with `stopReason: "end_turn"`. Kiro took 3.8 s end to end, Claude 9.3 s
(5.7 s of that is `initialize`, mostly the `npx` start).

I also checked the official SDK (`ClientSideConnection`) against Kiro. It
handles Kiro's `_kiro.dev/*` notifications through `extNotification` and
accepts its extra fields.

## Surprises

1. **Neither agent uses the client's `fs/*` methods.** We advertised
   `fs.readTextFile` and `fs.writeTextFile`; both agents still wrote to disk
   themselves after asking permission. `session/request_permission` is the
   only place the client can enforce a write policy. A tool call the agent
   doesn't ask about is never seen before it runs.
2. **Kiro's permission request has no `kind` and no `locations`.** Only
   `toolCall.toolCallId`, `title` and `rawInput`. The kind (`edit`,
   `execute`) and locations arrive in the earlier `session/update`
   `tool_call`. The client has to remember tool calls by id to classify a
   permission request.
3. **Kiro's write tool uses `rawInput.command = "create"`** with
   `rawInput.path`; its shell tool uses `rawInput.command = "ls -la"`. So
   "has a `command` field" does not mean "is a shell command".
4. **Claude's shapes differ:** the request carries `kind`, `locations`, and
   `rawInput.file_path` (Write) or `rawInput.command` (Bash). Its first
   `tool_call` update has an empty `rawInput` ("Preparing file…"); later
   `tool_call_update`s fill it in.
5. **JSON-RPC ids:** Kiro uses UUID strings for its requests to the client;
   Claude uses numbers starting at `0`. Clients must accept both.
6. **Options differ by id but not by kind.** Kiro: `allow_once`,
   `allow_always`, `reject_once`. Claude: `allow-once`, `allow-with-updates`
   (kind `allow_always`), `reject` (kind `reject_once`). Pick by `kind`,
   never by `optionId`. Never pick `allow_always`: it would let later calls
   skip the policy.
7. **Kiro sends many extension notifications** (`_kiro.dev/metadata` with
   credits used, `_kiro.dev/commands/available`,
   `_kiro.dev/subagent/list_update`, and `_kiro.dev/session/update` with
   `tool_call_chunk`). Claude sends `_auth/status_update`, which carries the
   account email, so transcripts are not safe to share as they are.
8. **Claude writes logs to stderr** (`[session/create] ... phase=...`), so
   don't treat stderr output as an error.
9. **Kiro refused `git push origin main` on its own** without asking. Claude
   asked, and after `reject_once` it reported "User refused permission". Both
   ended the turn normally (`end_turn`). A denial does not end the turn.
10. **Usage reporting:** Claude returns `usage` (tokens) in the
    `session/prompt` result and `usage_update` notifications with cost; Kiro
    reports credits in `_kiro.dev/metadata.meteringUsage` at turn end.
11. **Claude loads the user's own settings** (stderr `phase=settings`), so
    permission rules in `~/.claude/settings.json` may let some tool calls run
    without a request ever reaching Foundry. Kiro has the same kind of trust
    settings (`_meta.trustOptions`, `allowedCommands`).

## What the fake agent copies

`test/fake-agent.ts` copies these shapes: a `tool_call` update first, then
`session/request_permission`, then a direct disk write, then a
`tool_call_update` with `status: completed` or `failed`, then
`agent_message_chunk`s, then `end_turn`. It has a `kiro` style (no kind or
locations in the request, `rawInput.command = "create"`, string request ids)
and a `claude` style (kind, locations and `rawInput.file_path` in the
request).
