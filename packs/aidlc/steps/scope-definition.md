<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/scope-definition.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Scope Definition & Prioritization

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read feasibility assessment from `<record>/ideation/feasibility/` (if exists)
- Read constraint register and RAID log (if exist)

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/scope-definition/scope-definition-questions.md` with questions:
- What is the minimum viable scope that delivers value?
- What capabilities are must-have vs. nice-to-have?
- What are the dependencies between capabilities?
- What is the sequencing preference (risk-first, value-first, dependency-first)?
- Are there hard deadlines tied to specific capabilities?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run ambiguity detection, contradiction analysis, and scope-vs-timeline validation.

### Step 4: Generate Artifacts

Create scope definition document (in/out boundary), prioritized intent backlog (proto-Units using MoSCoW/WSJF/RICE), and value stream map.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :dart:
Review path: `<record>/ideation/scope-definition/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/scope-definition/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `feasibility-assessment`, `constraint-register`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
