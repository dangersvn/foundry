# Plan v2: autopilot and evals

Brief: `docs/v2-brief.md`. Acceptance: `features/p2_*.feature`. Every
Phase 0 and Phase 1 scenario keeps passing after each milestone. Each
milestone ends with `npm test`, `npm run features`, `npm run typecheck` and
`npm run build` green, then a commit. Decisions go to `docs/decisions.md`
from D50 on.

## 2a. Worktree lanes

What changes:

- Ledger schema v3: a `lanes` table (id, run, kind `item | unit | docs`,
  worktree, branch, base, head, status `open | merge_ready | merging |
  merged | failed`), and on items `lane_id` and `lane_start` (the lane
  commit the item builds on). Existing ledgers migrate; old items get an
  item lane on their next attempt.
- The lane is chosen when an item is created: a `docs_only` step goes to
  the run's docs lane, a `per` step to its unit's lane, anything else to
  its own item lane.
- One item at a time per lane: claiming skips an item whose lane another
  started item still holds.
- Every attempt starts in the lane's worktree, reset to the item's start
  and brought up to date with main; attempts never get a fresh worktree.
- An item in a unit lane that is not the unit's last step, and every
  docs-lane item, finishes as `done` with its commit on the lane
  (`lane_committed`). The unit's last step merges the whole lane. The docs
  lane merges after every other step of the run has finished; the run
  closes when it is merged.
- Merged lanes are removed (worktree and branch); failed lanes are kept.
  `foundry gc` removes failed and abandoned lanes.
- `foundry import aidlc` marks steps `docs_only` except the ones listed in
  `docs/aidlc-rewrites.md` as writing code.

Verify: `features/p2_worktree_lanes.feature` (a `plan-build` test pack
with units, a retry and two docs-only steps), unit tests for lane keys,
claiming and gc, and all Phase 0 and 1 scenarios.

## 2b. Autopilot

What changes:

- `--mode manual | autopilot` on `run` and `add` (stored on the run).
  Manual is the Phase 1 path, unchanged.
- In autopilot, workers claim open decision points (`waiting_input`,
  `at_gate`) with a lease and run a resolver session in the item's lane:
  questions go to the pack's answerer role, gates to the step's reviewer
  (or the pack's reviewer role). Both submit a schema-checked resolution
  through `foundry submit`.
- Guards in the kernel: the resolver role is never the role that asked or
  authored the work; evidence citations (request, artifact, context,
  decision) are resolved against the ledger and git, and an answer whose
  citations do not all resolve is logged as an `assumption`; the resolver
  runs on a different configured agent than the author when there is one;
  locked paths and environment-changing steps hold for a person.
- `foundry decisions RUN-n --kind assumption`; `foundry reject-decision
  DEC-n --comment` records the rejection and re-queues the item that made
  the decision and everything downstream of it, with the comment in their
  envelopes.
- `foundry autopilot off | on | status`: the kill switch.
- The AI-DLC pack names its answerer (product lead) and reviewer
  (architecture reviewer) in `pack.toml`.

Verify: `features/p2_autopilot.feature` with the fake agent playing the
resolvers (new plan keys for answer and gate sessions), unit tests for
evidence checking and path globs, Phase 0 and 1 scenarios unchanged.

## 2c. Evals and stats

What changes:

- `foundry bench add WI-n`: freezes a done item into `benchmarks/<case>/`
  (case.json with the envelope parts, base commit, verifier setup and
  split; accepted.patch; result.json). The case id comes from a hash of the
  item's content, the split from a hash of the id. A git ref keeps the
  base commit alive. The refinery rejects changes under `benchmarks/`.
- `foundry replay CASE --trials N --yes`: each trial runs the case's role
  in a fresh worktree from the base commit, with the role prompt and
  instructions from the pack being evaluated, recorded in a separate eval
  ledger (`.foundry/evals.db`) so stats stay clean. Code steps are graded by
  the frozen verify command; docs-only steps by the pack's checks plus a
  judge session (reviewer role, other agent when available).
- `foundry eval PACK_A PACK_B [--set dev|held-out|all] [--trials N] --yes`
  and `foundry eval PACK --agents a,b`: per-case (or per-role) pass counts
  and the verdict rule from the brief.
- The cost guard: without `--yes`, print the number of agent sessions and
  stop.
- `foundry stats [--by role|agent|step]` from the events table.

Verify: `features/p2_evals.feature` (fake agent plans keyed by pack version
and trial), unit tests for the split, the verdict rule and stats, Phase 0
and 1 scenarios unchanged.

## 2d. Proof (manual)

Not automated. `docs/manual-runs-v2.md` walks a person through the held-out
baseline for the Construction steps, one hand-made prompt change compared
with `foundry eval`, and one AI-DLC bugfix run in autopilot with its
assumption review, and says what to record in `docs/baseline.md`.

I stop after 2a to 2c and the runbook.
