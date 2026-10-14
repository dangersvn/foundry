# Foundry v1 brief: Phase 1, full AI-DLC in manual mode

## Goal

AI-DLC's whole lifecycle runs through Foundry, imported from AI-DLC's own
source rather than hand-ported, with a person answering every question and
gate. This is Phase 1 of `docs/build-plan.md`.

## Prerequisites

- Phase 0 is done. Every Phase 0 scenario keeps passing throughout this phase.
- AI-DLC source, pinned: clone https://github.com/awslabs/aidlc-workflows at
  its v2.11.0 release tag (check the exact tag name) into
  `vendor/aidlc-workflows/` and add that folder to `.gitignore`. The source
  path is configurable in `foundry.toml`. Its licence (MIT No Attribution)
  allows reusing its code, such as its stage parser and sensor scripts.

## Milestones

Build in this order. Each milestone ends with its scenarios passing and a
commit.

### 1a. Multi-step kernel

- **Formulas:** steps with `role`, `instructions` (a step instructions file),
  `needs`, `per` (fan-out over a list an earlier step produced), `verify`,
  `gate`, `review`, `max_attempts`, and `type` (`agent` or `script`).
- **Roles:** prompt, knowledge files, allowed tools and output schema. Rendered
  per agent: a Kiro agent profile, or instruction and settings files written
  into the item's worktree for Claude Code. The role prompt also travels in the
  envelope, so a role works even where an agent ignores its native files.
- **Envelope:** title, goal, inputs (artifact references with one-line
  summaries), acceptance, context references, history, run status.
- **Agent-to-Foundry commands** inside the worktree, scoped to the item:
  `foundry submit --file result.json` (schema-validated and must include a
  `decisions` list, which may be empty), `foundry note`, `foundry ask`
  (structured questions with options plus "other") and `foundry handoff`.
- **Decision points:** a question puts the item in Waiting for input; an
  output awaiting approval puts it At gate. People resolve them with
  `foundry answer`, `foundry approve` and `foundry reject --comment`. The agent
  session ends while waiting; the next attempt gets the questions, answers and
  comments in its envelope history.
- **Decision log:** kinds `decision`, `assumption`, `deviation` and `control`.
  Agents write the first three through `submit`; only the kernel writes
  `control` records. Records are never edited; a change supersedes.
- **Review step:** a reviewer role runs after a step; in v1 its findings are
  advisory and appear at the gate.
- **Skipped outcome:** an agent may submit `skipped` with a reason, recorded as
  a decision. Inputs from a skipped step are absent by design downstream.
- **Refinery:** a serial merge queue: rebase, run the full verify, merge. A
  conflict or failure goes back to its item with the error attached.
- **Patrol:** expired leases return to Ready; stalls are flagged.
- **Workers:** up to 3 in parallel, configurable.
- **`foundry why <file>:<line>`:** commit, item, decisions, inputs and run.

### 1b. AI-DLC import

- **`foundry import aidlc`** reads the pinned source and writes `packs/aidlc/`:
  - formula from stage frontmatter: `requires_stage` to `needs`, `for_each` to
    `per`, `produces` and `consumes` to outputs and inputs (keeping `required`
    and `conditional_on`), `reviewer` to a review step, `CONDITIONAL` stages
    allowed to skip;
  - roles from the 14 agents and their knowledge folders;
  - step instructions from each stage body;
  - profiles from the 11 scopes;
  - verifiers ported from the 6 sensors.
- **Engine-call rewrite:** every call to AI-DLC's own engine in stage text
  (`{{INVOKE}}`, `bun {{HARNESS_DIR}}/tools/...`, `aidlc-orchestrate` and the
  like) is replaced with its Foundry equivalent through a rewrite table kept in
  `docs/aidlc-rewrites.md`. An unmatched call fails the import, naming the
  stage and the call.
- **Initialization stages** become run setup: the existing-code check sets the
  `project_type` parameter; state-init and scaffold are dropped.
- **Profiles:** resolved at compile time into a concrete plan.
- **Run parameters:** `depth`, `test_strategy`, `project_type`, with defaults
  from the profile.
- **Layered rules:** org, team and project memory files are loaded in that
  order into the envelope; more specific wins where they differ.
- **Default settings**, all ones AI-DLC itself offers: lead role only
  (collaborators off), advisory reviews, learnings off, summary confirmation
  off, no walking skeleton, plan approval on as a gate.
- **Operation stages:** a step that would change a real environment stops at a
  gate with its plan for the person to carry out.
- **Determinism:** importing the same source twice gives an identical pack.

### 1c. End-to-end runs (needs a person)

A bugfix run, then a feature run, on a sample repo with a real agent and a
person answering. Claude does not run these: write `docs/manual-runs.md`, a
runbook a person can follow, covering setup, commands, what to expect at each
question and gate, and what to record.

## Not in v1

Autopilot, evals, MCP, integrations, mid-run plan changes, collaborators and
multi-agent stage modes, promoting learnings into rules.

## Done when

- Every scenario in `features/` passes except `@real-agent` and `@manual`
  ones, including all Phase 0 scenarios.
- `docs/manual-runs.md` is complete enough for a person to run the
  `@manual` scenarios without help.

## Record in docs/baseline.md

After the manual runs, for each profile: number of questions, gates and agent
sessions, total time, and agent requests.
