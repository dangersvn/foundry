# Decisions

Each entry gives what was decided, the options, the choice and the reason.
**Assumption** marks a guess that someone should check.

## D1. Brief and reference doc locations
- What: CLAUDE.md points to `docs/v0-brief.md`, `docs/foundry-spec.md`,
  `docs/build-plan.md` and `docs/abstraction-design.md`, but the files are at
  `v0-brief.md` (repo root), `docs/Build plan.md`, `docs/Abstraction design.md`
  and `docs/Foundry — Agent Factory Platform Architecture & Design Spec.md`.
- Options: rename them; leave them.
- Choice: leave them. They count as reference docs, which I must not edit.
- **Assumption:** these are the files CLAUDE.md means.

## D2. Node, not Bun
- What: `docs/Build plan.md` says "TypeScript kernel on Bun"; CLAUDE.md says
  Node 22+ with tsc.
- Choice: Node. CLAUDE.md is the build instruction; the plan describes the
  destination.

## D3. Git repository created
- What: the folder was not a git repo, and CLAUDE.md asks for a commit
  after each step.
- Choice: `git init -b main` in the project folder. No remote was added.

## D4. Spike uses a raw JSON-RPC client; the engine uses the SDK
- Options: write the spike with the SDK; write it with raw JSON-RPC.
- Choice: raw for the spike, so the transcript is exactly what goes over the
  wire. The engine uses `@agentclientprotocol/sdk` as CLAUDE.md requires. I
  checked the SDK against Kiro; it handles the `_kiro.dev/*` extensions.

## D5. Account emails redacted from spike transcripts
- What: Claude's `_auth/status_update` puts the account email on the wire.
- Choice: replace emails with `<redacted-email>` before committing. Nothing
  else was changed.

## D6. Permission policy reads the earlier tool_call
- What: Kiro's permission requests have no `kind`/`locations` (spike note 2).
- Choice: the runtime remembers each `tool_call`/`tool_call_update` by id and
  the policy merges that with the request. Kind comes from the request, else
  the remembered call. Paths come from `locations`, `rawInput.path`,
  `rawInput.file_path`, `rawInput.notebook_path` and diff content.
- Rules: `execute` is denied if the command contains `git ... push` or an
  absolute path outside the worktree (`/dev/*` allowed); `fetch` is denied (no
  network allow-list in v0); any request that names paths is allowed only if
  every path is inside the worktree; an `edit`/`delete`/`move` that names no
  path is denied; anything else that names no path or command (think,
  switch_mode, other) is allowed.
- Options for the answer: always choose `allow_once`/`reject_once` by
  `kind`; or follow what the agent offers.
- Choice: always `allow_once` or `reject_once`, never `allow_always`,
  so every later call still comes to the policy.
- **Assumption:** allowing requests that name no path or command is
  acceptable for v0. Deny-by-default could stall agents on harmless internal
  tools.

## D7. Policy can only see what agents ask about
- What: both agents write to disk themselves and only ask for permission
  when their own settings say to; user settings can pre-allow tools.
- Choice: v0 relies on the agents asking (both did in the spike, in their
  default modes) plus the verifier and the engine-only merge. Recorded in
  `docs/later.md`.
- **Assumption:** the teammate's agent settings do not pre-allow writes
  outside the project or `git push`.
