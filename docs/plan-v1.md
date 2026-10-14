# Foundry v1 build plan (Phase 1)

Brief: `docs/v1-brief.md`. Every Phase 0 scenario keeps passing after each
step (`npm run features` runs them all). Each milestone ends with its
scenarios passing and a commit.

## 1a. Multi-step kernel (`features/p1_multi_step.feature`)

1. **Schemas:** pack (`pack.toml`), multi-step formula (`[[steps]]` with
   role, instructions, needs, per, verify, gate, review, max_attempts, type),
   role (`roles/<name>.toml` + prompt), agent result (`foundry submit`, with a
   required `decisions` list), questions.
   Verify: unit tests for valid and invalid packs and results; v0 one-step
   formulas still parse.
2. **Ledger v2 migration:** `run_steps`, `submissions`, `item_notes`,
   `questions`, `decisions` tables; items gain step spec, role, unit, review;
   new statuses `blocked`, `waiting_input`, `at_gate`, `merge_ready`,
   `merging`, `skipped`. A v1 ledger upgrades in place.
   Verify: unit tests, including opening a Phase 0 ledger.
3. **Run graph:** `advanceRun` materializes steps whose needs are done or
   skipped, fanning out over `per` lists from upstream submissions; finishes
   or fails the run.
   Verify: unit tests for order, fan-out, skip and failure.
4. **Agent commands:** `foundry submit|note|ask|handoff`, scoped to the item
   through `.foundry/item.json` in the worktree, run through a relative
   `./.foundry/bin/foundry` wrapper so the permission policy allows it.
   Verify: unit tests on a temp ledger.
5. **Envelope:** title, goal, inputs with one-line summaries, acceptance,
   context refs, history (handoffs, verifier failures, questions and answers,
   rejection comments, refinery errors), run status; role prompt and step
   instructions inline; stored per attempt under `.foundry/envelopes/`.
   Verify: unit test of the rendered envelope.
6. **Role rendering:** Kiro agent profile in `.kiro/agents/`, Claude Code
   `CLAUDE.local.md` + `.claude/settings.local.json`, chosen by
   `render = "kiro" | "claude"` in `foundry.toml`; files kept out of commits.
   Verify: unit tests of rendered files.
7. **Dispatcher v2:** agent turn, then submission, ask, skip, step verify with
   retry up to `max_attempts`, advisory review session, gate or merge queue.
   **Refinery:** one merge at a time across all processes (rebase, full
   verify, fast-forward); conflicts go back to the item. **Patrol:** expired
   leases, stalls. **Workers:** `[workers] count` (default 3).
   Verify: fake-agent scenarios in `p1_multi_step.feature`, and all Phase 0.
8. **People commands:** `foundry answer`, `approve`, `reject --comment`,
   `foundry decisions <run>`, `foundry why <file>:<line>`.
   Verify: the question, gate, decision and why scenarios.

## 1b. AI-DLC import (`features/p1_aidlc_import.feature`)

1. **Source:** AI-DLC v2.11.0 in `vendor/aidlc-workflows/` (gitignored); path
   in `foundry.toml` `[aidlc] source`.
2. **Importer:** `foundry import aidlc` reads stage frontmatter and bodies,
   agents and knowledge, scopes and sensors, and writes `packs/aidlc/`
   deterministically (sorted, no timestamps). Initialization stages become run
   setup. Verify: 30 steps + run setup, 14 roles, 11 profiles, 6 verifiers,
   13 review steps; importing twice is byte-identical.
3. **Engine-call rewrite table** in `docs/aidlc-rewrites.md`, parsed by the
   importer; an unmatched call fails naming the stage and the call; an import
   report lists every rewrite applied. Verify: no `{{INVOKE}}`,
   `{{HARNESS_DIR}}`, `bun .../tools/aidlc-*` or `aidlc engine` left.
4. **Profiles, parameters, layered rules, default settings:** a profile
   resolves at compile time into a concrete plan (`foundry plan --dry-run`);
   `depth`, `test_strategy`, `project_type` with profile defaults; org, team,
   project rules loaded in order; lead role only, advisory reviews, plan
   approval as a gate, operation steps gated with their plan.
   Verify: bugfix compiles to 6 stage steps, feature to 30; skipped
   conditional stages leave inputs absent without errors.
5. **Verifiers:** the 6 sensors ported as Foundry verifiers.
   **`foundry validate`** checks a pack. Verify: validate passes on the pack.

## 1c. End-to-end runs (manual)

Not run by Claude. `docs/manual-runs.md` is the runbook for the bugfix and
feature runs: setup, commands, what to expect at each question and gate, what
to record in `docs/baseline.md`.
