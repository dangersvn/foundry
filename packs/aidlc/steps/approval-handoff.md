<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/approval-handoff.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Initiative Approval & Handoff

## Steps

### Step 1: Load Prior Context

Read ALL Ideation phase artifacts:
- Intent statement and stakeholder map from `<record>/ideation/intent-capture/`
- Market research from `<record>/ideation/market-research/` (if exists)
- Feasibility assessment, constraint register, RAID log from `<record>/ideation/feasibility/` (if exists)
- Scope definition and intent backlog from `<record>/ideation/scope-definition/`
- Team formation artifacts from `<record>/ideation/team-formation/` (if exists)
- Mockups/wireframes from `<record>/ideation/rough-mockups/` (if exists)

### Step 2: Generate Approval Questions

Create `<record>/ideation/approval-handoff/approval-handoff-questions.md` with questions:
- Do all stakeholders agree on the intent and scope?
- Have all critical risks been acknowledged with mitigations?
- Is there budget/resource commitment?
- Do the rough mockups reflect the shared vision?
- Does the market research support the investment?
- Are mobs staffed and scheduled?

Follow stage-protocol.md question flow.

### Step 3: Compile Initiative Brief

Create `<record>/ideation/approval-handoff/initiative-brief.md` — a one-pager combining:
- Intent and problem statement
- Market validation summary
- Feasibility and risk highlights
- Scope boundary
- Concept visuals
- Team plan
- Go/no-go recommendation

Create `<record>/ideation/approval-handoff/decision-log.md` — record of all decisions made during Ideation.

### Step 4: Phase Boundary Verification

Run Ideation → Inception verification check:
- Intent → Scope → Intent Backlog consistency
- All scope items have feasibility backing
- Write results to `<record>/verification/phase-check-ideation.md`

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :white_check_mark:
Review path: `<record>/ideation/approval-handoff/`
Approval gate: Approve (proceed to Inception) / Request Changes / Reject Initiative (end workflow).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/approval-handoff/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `stakeholder-map`, `scope-document`, `intent-backlog`, `competitive-analysis`, `feasibility-assessment`, `constraint-register`, `team-assessment`, `wireframes`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
