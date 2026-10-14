<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/team-formation.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Team Formation & Mob Planning

## Steps

### Step 1: Load Prior Context

- Read scope definition from `<record>/ideation/scope-definition/`
- Read feasibility assessment and constraint register (if exist)
- Read intent backlog for work volume estimation

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/team-formation/team-formation-questions.md` with questions:
- What teams and individuals are available?
- What is the current capacity and utilization?
- What skills are required vs. available?
- Are there competing initiatives drawing from the same talent pool?
- What is the preferred team topology?
- What time zones and locations are team members in?
- Are external partners, contractors, or AWS Professional Services needed?
- Who are the decision-makers for each phase?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run gap analysis between required skills and available skills.

### Step 4: Generate Artifacts

Create team availability assessment, skill matrix (with gap analysis), mob composition plan, RACI matrix, capacity allocation agreement, skill gap remediation plan, and onboarding checklist.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :people_holding_hands:
Review path: `<record>/ideation/team-formation/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/team-formation/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `scope-document`, `intent-backlog`, `feasibility-assessment`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
