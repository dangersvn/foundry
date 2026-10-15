# Foundry v2 brief: Phase 2, autopilot and evals

## Goal

Roles resolve decision points instead of a person when a run is in autopilot,
and the factory's quality becomes a number you can compare between versions
and between agents. This is Phase 2 of `docs/build-plan.md`.

## Prerequisites

- Phases 0 and 1 are done. All their scenarios keep passing.
- Approved items from the Phase 1 manual runs exist in the ledger; they seed
  the benchmark.

## Milestones

Build in this order. Each ends with its scenarios passing and a commit.

### 2a. Worktree lanes

Today every work item gets its own worktree. Keep isolation, but group work
the way it builds on itself:

- **Unit lane:** all steps for one unit of work (for example plan, then build)
  share one worktree and branch, so later steps see earlier steps' files. The
  refinery merges the lane once, when its last step passes.
- **Run docs lane:** steps that only produce documents share one worktree per
  run; their artifacts merge together at the end of the run.
- **Attempts** of the same item reuse its lane; they never get a fresh one.
- **Cleanup:** merged lanes are removed; failed or abandoned lanes are kept for
  diagnosis until `foundry gc`.
- Parallel units still get separate lanes, so isolation between units holds.

### 2b. Autopilot

- **Run mode:** `foundry run ... --mode manual|autopilot`, default `manual`.
  Manual mode behaves exactly as in Phase 1.
- **Same path, different resolver:** in autopilot, a question still puts the
  item in Waiting for input and an output still goes At gate; a role resolves
  them instead of a person.
  - Questions go to the **answerer** role, imported from AI-DLC's product lead
    agent.
  - Gates go to the step's AI-DLC reviewer when it has one, otherwise to the
    **reviewer** role imported from AI-DLC's architecture reviewer. A gate
    passes only after the verifiers pass and the reviewer approves; a reviewer
    rejection works like a human rejection, with its comment.
- **Guards:**
  - The answering role is never the role that asked.
  - Every answer cites evidence: the request, an approved artifact, workspace
    context or an earlier decision. The kernel checks that each citation
    resolves to something real. An answer without valid evidence is logged as
    an `assumption`, and the answerer picks the most reversible option.
  - Every resolution is a decision record whose actor is the role and agent.
  - When both agents are configured, the resolver runs on a different agent
    than the author of the work it judges.
- **Locked areas:** `[autopilot] locked_paths` in `foundry.toml`. A gate whose
  change touches a locked path waits for a person even in autopilot. Steps
  that would change a real environment also always wait for a person.
- **Review afterwards:** `foundry decisions <run> --kind assumption` lists the
  assumptions to review. `foundry reject-decision <id> --comment` marks it
  rejected and re-queues every item that relied on it, with the comment in
  their envelopes.
- **Kill switch:** `foundry autopilot off` makes every waiting and future
  decision point wait for a person.

### 2c. Evals and stats

- **Benchmark:** `foundry bench add <item>` freezes an approved item as a
  benchmark case: its envelope, the base commit, the accepted output and its
  verifier setup. Cases live as files in `benchmarks/`, which is a protected
  path: the refinery rejects agent changes to it. Each case is assigned to
  `dev` or `held-out` deterministically (about 70/30 by a hash of its id).
- **Replay:** `foundry replay <case> --trials N` re-runs the case's role on the
  frozen envelope in fresh lanes from the base commit, N times (default 3).
  Code outputs are graded by their verifiers. Document outputs are graded by
  the ported AI-DLC sensors plus a reviewer rubric scored by a judge on a
  different agent than the author where possible.
- **Compare:** `foundry eval <pack-ref-a> <pack-ref-b> [--set held-out]`
  replays every case under both pack versions and reports, per case, the pass
  count for each. Verdict: B is better if its total passes are higher and no
  case loses passes. `--agents kiro,claude` compares agents instead of packs,
  role by role.
- **Cost guard:** before running, `replay` and `eval` print the number of agent
  sessions they will start and require `--yes`.
- **`foundry stats [--by role|agent|step]`:** first-pass yield, attempts per
  item, human rejection rate, agent requests per merged item, escalation rate,
  assumption count. All derived from events.

### 2d. Proof (needs a person)

Claude does not run these. Write `docs/manual-runs-v2.md`, a runbook covering:

1. Recording a baseline with `foundry eval` on the held-out set for AI-DLC's
   Construction steps, where tests grade the output.
2. Making one prompt change by hand to a weak role or step, and comparing it
   with `foundry eval` against the baseline.
3. Running one AI-DLC bugfix run in autopilot, then reviewing its assumption
   list.

## Not in v2

Automated improvement (the factory proposing its own changes), per-area
autonomy rules with earned thresholds, sampled review, integrations, MCP.

## Done when

- Every scenario in `features/` passes except `@real-agent` and `@manual`
  ones, including all Phase 0 and Phase 1 scenarios.
- `docs/manual-runs-v2.md` lets a person carry out the 2d proof without help.

## Record in docs/baseline.md

After the 2d runs: the held-out baseline per Construction step, the result of
the hand-made change, and for the autopilot run the number of decisions,
assumptions, human stops (should be zero outside locked areas) and agent
requests.
