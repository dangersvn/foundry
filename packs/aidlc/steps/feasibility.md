<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/feasibility.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Feasibility & Constraint Analysis

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read market research from `<record>/ideation/market-research/` (if exists)
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/feasibility/feasibility-questions.md` with questions:
- What existing systems must this integrate with?
- Are there regulatory/compliance requirements (PCI, HIPAA, SOC2, data residency)?
- What is the team's current tech stack and skill profile?
- What are the budget and timeline constraints?
- Are there organizational blockers (change freeze, competing priorities)?
- What AWS services and accounts are currently in use?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis.

### Step 4: Generate Artifacts

Create feasibility assessment (technical viability, risk analysis), constraint register (technical, organizational, regulatory), and RAID log (Risks, Assumptions, Issues, Dependencies).

The orchestrator will pass these artifacts to aidlc-aws-platform-agent for AWS landscape assessment and aidlc-compliance-agent for regulatory scanning, then synthesize all inputs.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :test_tube:
Review path: `<record>/ideation/feasibility/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/feasibility/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `competitive-analysis`, `market-trends`, `build-vs-buy`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
