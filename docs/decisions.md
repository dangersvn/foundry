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

# Phase 1

## D25. Phase 1 package installed; tag filters
- The brief, three `features/p1_*.feature` files and the new CLAUDE.md were
  copied in unchanged. `npm run features` now runs
  `not @real-agent and not @manual`; `features:real` runs
  `@real-agent and not @manual`.
- CLAUDE.md names `docs/v0-brief.md`; the v0 brief is still at the repo root
  (D1). Left as is: reference files are not to be moved.
- Phase 0 recheck before starting: `npm run features:real` passed with Kiro
  and Claude Code on 2026-10-14.

## D26. AI-DLC source pinned at v2.11.0
- `git clone --depth 1 --branch v2.11.0` of awslabs/aidlc-workflows into
  `vendor/aidlc-workflows/` (gitignored; tag commit 6a378b5). Path is
  `[aidlc] source` in foundry.toml. The `~/workspaces/aidlc-claude` copy on
  this machine is an installed rendering, not the source; not used.

## D27. Pack format is TOML
- Options: YAML as in the spec; TOML as in v0 formulas.
- Choice: TOML (`pack.toml`, `formula.toml` with `[[steps]]`,
  `roles/<name>.toml` + `.md`), so one parser and one style serve v0 and v1.
  A v0 `[step]` formula loads as a one-step run (`submit = false`: done by
  the verifier alone, as in Phase 0).

## D28. Steps materialize when their needs finish
- Options: compile every item up front; create items when a step can start.
- Choice: `run_steps` records each step as pending/active/done/skipped/
  failed; `advance` (inside every transaction that finishes an item) starts
  steps whose needs are done or skipped. A `per` fan-out can only be counted
  once the upstream step has submitted its list. An empty list skips the step
  with a kernel `control` decision.
- **Assumption:** "compile, then run" (spec rule 3) is met by pinning the
  formula to the run and compiling the step plan (1b dry-run); item counts
  for fan-outs are known only at run time.

## D29. Agent commands find their item through the worktree
- `.foundry/item.json` (item, attempt, ledger path) and a
  `./.foundry/bin/foundry` wrapper are written into the worktree's excluded
  `.foundry/`. The wrapper is relative, so the permission policy (which
  denies absolute paths outside the worktree) lets it run.
- `submit`, `note`, `handoff`, `ask` only add rows (submissions, notes,
  questions) and events; the worker decides status after the turn. A
  command for a stale attempt is refused.

## D30. Verifier failures retry (changes D13)
- Options: fail at once (Phase 0); retry with the output in history.
- Choice: retry up to `max_attempts` (default 3), the verifier output and
  any handoff in the next envelope's history, plus a `control` decision. This
  also applies to v0 one-step formulas, so the Phase 0 "cannot fake
  completion" item now fails after 3 attempts instead of 1.
- Rejections at a gate and answers start a new attempt too, but never fail
  the item.

## D31. Statuses, merge queue and refinery
- New statuses: `waiting_input`, `at_gate`, `merge_ready`, `merging`,
  `skipped`. A verified change goes to `merge_ready` (or `at_gate` first).
- The refinery claims a `merge_ready` item only while no item is `merging`,
  checked in the same `BEGIN IMMEDIATE` transaction, so merges are serial
  across every process (replaces D24's in-process lock). It rebases, runs the
  formula's `verify` (or the step's), and fast-forwards; a conflict or
  failure retries the item with the error in its history. When the rebase
  was a no-op and the same command already passed on that commit, the full
  verify is not run twice.
- An expired lease while `merging` returns the item to `merge_ready`.

## D32. Review step
- After a step passes its verifier, a second session runs in the same
  worktree with the reviewer role (read and shell tools only). It submits
  `findings`, stored as review notes and shown at the gate. Afterwards the
  worktree is reset to the step's commit, so a reviewer cannot change it.
  Findings are advisory in v1: they never block.

## D33. Questions and gates
- `foundry ask` stores structured questions (options plus "other" unless
  `--no-other`); the item goes to `waiting_input` when the turn ends and the
  agent process exits. When every question of the item is answered it goes
  back to ready with the next attempt. Each answer is a `decision` record
  with the person as actor.
- People are `person:<git user.name>` (else `$USER`).
- `foundry approve` moves `at_gate` to `merge_ready`; `foundry reject
  --comment` (required) adds a rejection note and starts a new attempt.

## D34. Decision log
- `decisions` table, ids `DEC-n`, kinds decision/assumption/deviation (from
  `submit`, actor `<role>@<agent>`) and control (kernel only: retries, empty
  fan-outs). Never updated; `supersedes` names the older record and
  "superseded" is derived. A skip is recorded as a decision with the reason.
- The envelope's history carries the non-control decisions of the item's
  inputs.

## D35. Role rendering
- `render = "kiro" | "claude" | "none"` per agent in foundry.toml (agent
  code stays in `src/runtime/render.ts`).
- Kiro: `.kiro/agents/foundry-<role>.json` with the prompt, tools from
  `tools_allowed`, `allowedTools` limited to reads (so writes and shell still
  come to Foundry's policy), knowledge as `resources`; launched with
  `--agent foundry-<role>`.
- Claude Code: `CLAUDE.local.md` with the prompt and `@` knowledge links,
  and `.claude/settings.local.json` denying tools the role may not use.
- Knowledge files are copied to the worktree's `.foundry/pack/`; rendered
  files are added to `.git/info/exclude`.
- **Assumption:** target repos do not track `CLAUDE.local.md`,
  `.claude/settings.local.json` or `.kiro/agents/foundry-*.json`.

## D36. Workers, patrol, `foundry run`
- `[workers] count` (default 3) worker loops per process; `--workers`
  overrides. Each loop does patrol, then merge-queue work, then ready items.
- Patrol flags an item once when it has had no event for
  `[workers] stall_seconds` (600).
- `foundry run` works only its own run and exits when nothing in it is left
  for a worker; it prints each open question and gate with the command to
  resolve it. Exit 1 only if an item failed.

## D37. Envelopes are kept
- Every session's envelope is written to `.foundry/envelopes/WI-n-aN.md`
  and recorded as an artifact, so what an agent was told is auditable.

## D38. The import works on calls, not raw text
- A call is the inline code span holding an engine token, or a fenced-block
  line holding one (with `\` continuations). Engine tokens: `{{INVOKE}}`,
  `{{HARNESS_DIR}}`, `aidlc-*.ts` tool names, `aidlc engine`,
  `aidlc-orchestrate`, `/aidlc`, and a code span that is just `next`.
- Each call is matched whole against the rules in `docs/aidlc-rewrites.md`
  (first match wins); an unmatched call fails the import with the file, line
  and call. After writing, the importer scans every step and role prompt
  again and fails if any engine token is left.
- v2.11.0 has 144 calls: 119 in the 30 stages and 25 in the 14 agent
  prompts; 37 rules cover them. The 3 initialization stages are dropped, so
  their calls are not rewritten (the report counts them).
- **Assumption:** rewriting role prompts too is in scope ("no call may
  survive in the step instructions"; agents read their role prompt as well).
  Knowledge files are copied without rewriting.

## D39. What a stage becomes
- id = slug; role = `lead_agent` (support agents recorded, collaborators
  off); instructions = rewritten body with a short Foundry header (what
  `<record>`, `<unit>` mean, how to ask, submit instead of asking for
  approval); `requires_stage` -> needs (minus initialization stages);
  `for_each` -> per; `produces`/`optional_produces` -> outputs; `consumes` ->
  inputs from each producing stage, keeping `required` and
  `conditional_on`; `reviewer` -> review; `sensors` -> verifiers;
  `CONDITIONAL` -> conditional (may be skipped with a reason).
- Every step has a human gate: all 30 stage texts end in an Approve /
  Request Changes approval, and v1 is manual mode. code-generation's gate is
  marked "plan approval" (its text has the plan-approval checkpoint).
- `<record>` is `aidlc-docs/<run>` in the worktree, so artifacts are
  committed with the item.
- Environment-changing stages (listed in docs/aidlc-rewrites.md):
  environment-provisioning and deployment-execution. **Assumption:** the
  other operation stages (observability, performance, incident response,
  feedback) only write plans and configuration in the repo.
- Step order: dependency order, then phase order, then slug.

## D40. Profiles compile at run start
- `profiles/<scope>.toml` lists the stages whose `scopes` include it.
  Compiling keeps those steps, turns a need on a dropped step into a need on
  that step's own needs, drops a `per` whose producer is not in the plan (so
  bugfix's code-generation runs once), and drops inputs from absent steps
  (absent by the profile's design).
- Run parameters: `depth` from the scope, `test_strategy` from its
  `testStrategy` or else its depth, `project_type` brownfield for scopes with
  `existing_code: true`, else detected at run setup (brownfield when the repo
  tracks source files). `--param k=v` overrides.
- Settings are AI-DLC's simplest for every profile: collaborators off,
  reviews advisory, learnings off, summary confirmation off, no walking
  skeleton, plan approval on. The scope's own values are kept as
  `source_settings` for the record.
- `foundry plan <pack> --profile <p> --dry-run [--json]` prints the compiled
  plan; `foundry run`/`add` take the same `--profile`/`--param`.

## D41. A `[project] test_command` setting (beyond the brief)
- What: AI-DLC's code stages leave verification to the agent ("build and
  test"), but rule 4 needs the engine to run the tests.
- Choice: `[project] test_command` in foundry.toml; when a formula has no
  `verify` of its own, the refinery runs it on every merge. Without it the
  plan says "merge verify: none".

## D42. The six sensors as built-in checks
- Pack `verifiers/<id>.toml` name a built-in check (`aidlc.<id>`, in
  `src/kernel/checks.ts`) and a severity; all six are advisory in AI-DLC and
  stay advisory: findings become notes shown at the gate, never a retry.
- Ports follow each sensor's documented contract but are simpler:
  required-sections (2+ H2s; timestamps pass; the `units:` edge block parses
  and is acyclic), upstream-coverage (deliverables name every consumed
  artifact that was produced), claim-sources (an Assumptions & Open
  Questions section; substantive lines carry `[desc]`, `[scope]`, `[Q<n>]`,
  `[memory:..]` or `[assumption]`; assumptions only in their section),
  traceability (shape, closed statuses, no GAP/ORPHAN, a row per upstream
  id), linter and type-check (the project's own eslint/tsc if installed).
- **Assumption:** the simpler ports are enough for v1; claim-sources does
  not resolve tags against the source register or answers, and traceability
  does not resolve targets in other artifacts.

## D43. Layered rules
- The import copies AI-DLC's `memory/org.md`, `team.md`, `project.md` to
  `packs/aidlc/rules/`. Each envelope carries org, then team, then project;
  a team's own file for a layer (`[rules] org|team|project` in foundry.toml)
  replaces the pack default for that layer.

## D44. Missing required inputs
- When an item is created, a required input whose producing step is done
  but did not name it (in outputs or an artifact path) is recorded as an
  `input_missing` event. An input from a skipped step is absent by design
  and not reported.

## D45. packs/aidlc is committed
- Options: generate it on every machine; commit it.
- Choice: commit it (1.4 MB, MIT-0 content), so `foundry run packs/aidlc`
  works without the vendor clone and reviewers can read what agents are
  told. `foundry import aidlc` regenerates it byte for byte.
