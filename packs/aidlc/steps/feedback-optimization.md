<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/feedback-optimization.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Continuous Feedback & Optimization

## Steps

### Step 1: Load Prior Context

- Read observability setup from `<record>/operation/observability-setup/`
- Read performance validation results from `<record>/operation/performance-validation/`
- Read SLO/SLI configuration
- Read infrastructure design for drift comparison

### Step 2: Generate Questions

Create questions file covering:
- Are SLOs being met? What is the error budget burn rate?
- Are there cost optimization opportunities?
- Is there configuration or infrastructure drift?
- What user behavior patterns suggest new features or issues?
- What operational toil can be automated?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create SLO compliance report, AWS Cost Explorer analysis & optimization recommendations, AWS Config drift detection report, Trusted Advisor recommendations review, operational insights & improvement proposals, and feedback loop document (inputs to next Ideation cycle).

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :recycle:
Review path: `<record>/operation/feedback-optimization/`
Approval gate: Approve (workflow complete) / Request Changes / Start New Ideation Cycle.

This is the final stage. Upon approval, the full AI-DLC workflow is complete. The feedback loop document feeds insights back into the next Ideation cycle if the user chooses to continue iterating.

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/feedback-optimization/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `dashboards`, `alarms`, `slo-config`, `deployment-log`, `load-test-results`, `incident-plan`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
