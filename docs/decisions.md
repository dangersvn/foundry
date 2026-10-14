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

## D8. A `foundry work` command beside run/status/log
- What: the brief lists `run`, `status` and `log`, but the crash scenario
  needs a way to restart, and the two-worker scenario needs processes that
  pick up an existing ready item.
- Options: make `foundry run` also resume old items; add `--resume` to
  `run`; add `foundry work`.
- Choice: `foundry work`. It recovers expired leases, works every ready
  item, waits while other workers hold live leases, then exits. `run`
  creates one item and works only that item, so re-running `run` never
  duplicates work.

## D9. Lease TTL is configurable in foundry.toml
- What: the spec's lease is 120 s; the crash scenario would wait 2 minutes.
- Choice: `[leases] ttl_seconds` (default 120), renewed every TTL/3. Tests
  use 2 s. This is the only setting beyond the brief's example config.

## D10. One worktree and branch per attempt, under `.foundry/` in the repo
- Options: inside the repo (`.foundry/worktrees/WI-n-aN`); a sibling folder;
  `~/.local/state`.
- Choice: inside the repo, with `/.foundry/` added to `.git/info/exclude`
  (no tracked file is touched). A new attempt gets a fresh worktree; the old
  one is kept for diagnosis (spec).
- **Assumption:** tools run in the main checkout that scan every folder
  (jest, tsc with broad `include`) may pick up worktree files. The sample
  app's `npm test` uses an explicit glob for that reason. Recorded in later.md.

## D11. Merge = squash, rebase, verify, fast-forward
- Choice: after the agent's turn the engine squashes everything in the
  worktree (including any commits the agent made) into one commit on the
  attempt's base, rebases it onto the current target, runs the verifier on
  exactly that commit, then fast-forwards the target. If the target is
  checked out in the main repo, `git merge --ff-only` there updates the
  working tree too; otherwise `git update-ref` with the old value.
- Why: "one item produces exactly one commit on main", and what is verified
  is what lands.
- Target branch: `main` if it exists, else the repo's current branch.
  **Assumption:** that matches teams that use `master`.

## D12. Idempotent merge through a commit trailer
- What: a crash between moving main and writing "done" must not merge twice.
- Choice: each commit carries `Foundry-Item: WI-n`. Before working a claimed
  item, the dispatcher looks for that trailer on the target and, if found,
  just records `merged` (`recovered: true`).

## D13. Item outcomes
- Agent can't start (missing command, exits during initialize or
  session/new): item goes back to `ready` without using an attempt; the
  error names the ACP runtime layer; `foundry work` stops instead of
  retrying in a loop.
- Agent dies mid-turn: item `failed`, layer `agent`.
- Agent ends its turn with no file changes: item `failed`, layer `agent`
  (there would be nothing to commit).
- Verify fails: item `failed`, layer `verifier`, output stored in the
  `failed` event and the full log as an artifact. No automatic retry in v0;
  later.md has the idea.
- Any stop reason (`end_turn`, `refusal`, `max_tokens`...) still goes to
  the verifier; the agent's own claim decides nothing.
- Lease expired after the last of 3 attempts: `failed`, layer `ledger`.

## D14. A `config` error layer
- What: CLAUDE.md lists ledger, runtime, agent, verifier and git. A missing
  or invalid `foundry.toml` or formula fits none of them.
- Choice: add `config`. The runtime layer is printed as `ACP runtime`.

## D15. Client capabilities: none
- What: the spike showed neither agent uses client `fs/*` or terminals.
- Choice: initialize with `clientCapabilities: {}`, so agents use their own
  tools and every write goes through a permission request.

## D16. Audit events for tool calls
- Choice: one `tool_call` event when a call reaches `completed` or `failed`
  (with its title, kind and paths), and one `permission` event per request
  with the decision, the reason and the full request payload. Streaming
  chunks are in the transcript file only (spec: transcripts are files
  referenced from events).

## D17. Formula lookup and `--input`
- Choice: `foundry run <formula>` takes a path to a `.toml` file or a
  built-in name from the package's `formulas/` folder. `--input` is
  optional and reaches the agent as "Request:" in the prompt.
- The acceptance step maps "add a health endpoint with a test" to the
  shipped `health-endpoint`; "make the failing test pass" is written by the
  step as a scenario-local formula, since the brief ships only one example.

## D18. "Fake agent reports success without making the test pass"
- Choice: the step adds a failing test to the sample repo, and the fake
  agent's `fake-success` mode writes an unrelated `NOTES.md` and says
  "all tests pass". It must change something, or the item would fail as
  "no changes" (D13) instead of at the verifier.

## D19. The fake agent speaks raw JSON-RPC
- Choice: not the SDK. The SDK chooses its own request ids, so it can't
  copy Kiro's UUID-string ids or the exact request shapes. It has `kiro` and
  `claude` styles, and the runtime tests run both.

## D20. Layout additions
- `examples/sample-app` (the quickstart repo, also the acceptance fixture),
  `formulas/` (the shipped formula), `scripts/acp-spike.mjs`. `src/kernel/`
  also holds `git.ts`; the dispatcher imports the runtime through
  `runAgent` only.

## D21. Package name `foundry-factory`
- **Assumption:** `foundry` is taken on npm, so the package is
  `foundry-factory` with a `foundry` bin. Nothing is published; the README
  installs from a checkout or an `npm pack` tarball.

## D22. Tests strip NODE_OPTIONS
- What: Cucumber loads TypeScript through `NODE_OPTIONS=--import tsx`, which
  every child process inherited (the sample's `npm test`, the agents).
- Choice: the cucumber world deletes it after loading; the fake agent is
  started with an absolute tsx loader URL.

## D23. I ran the @real-agent scenarios once
- What: CLAUDE.md says they are run by hand and use quota; the brief asks
  for baseline numbers after real runs.
- Choice: ran them once (plus one Kiro rerun) to confirm the runtime works
  with both agents and to fill in `docs/baseline.md`. Cost of the scenario
  runs: about 0.7 Kiro credits (two runs) and USD 0.16 of Claude usage, plus
  the spike's five short sessions.

## D24. Factory board, parallel workers and `foundry add` (asked for after v0)
- What: the user asked for a demo workspace where two features build at
  once in separate worktrees, shown live in the terminal, with a way to
  "chat" more work in. That is beyond the v0 brief (one item per process).
- Choice, kept small:
  - `foundry work --workers N` runs N worker loops in one process, each with
    its own lease owner (`host:pid:wN`). Creating worktrees and the
    rebase-verify-fast-forward step run one at a time in the process, so
    workers never race to move main; agents still run in parallel.
  - `foundry add <formula> --input` queues an item without working it.
  - `foundry factory <formula> [--workers N]` draws the board from the
    ledger and git every 0.7 s (ANSI only, no UI library) and turns each
    line typed at its prompt into a work item with that formula. Workers
    there keep waiting for new items instead of exiting.
  - A formula without `title` uses the request as the item's title.
- "Chat" is a queue, not a conversation: Foundry makes no LLM calls (rule 1),
  so it never replies or plans. A planning chat is the Phase 3 Mayor
  (`foundry mcp` in your own Kiro/Claude session).
- **Assumption:** in-process merge serialization is enough for the demo.
  Two separate `foundry` processes moving main at the same moment can still
  make one item fail at the git layer (the ref update refuses, nothing is
  lost); a cross-process merge lock is in later.md.
- Demo workspace: `~/workspaces/test-foundry`, a Node app where each feature
  is its own route file and test file, so parallel items don't conflict.
