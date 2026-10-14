<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/observability-setup.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Observability Setup

## Steps

### Step 1: Load Prior Context

- Read NFR design (observability strategy) from `<record>/construction/nfr-design/`
- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read deployment execution log from `<record>/operation/deployment-execution/`

`express` skips NFR Design and Infrastructure Design by design. When those
artifacts are absent, derive the minimum observable surface from approved
requirements, the deployed application's workspace configuration, Build and
Test results, and the Deployment Execution evidence. Ask for any SLO, signal,
retention, or escalation decision that cannot be observed from those sources;
never invent a missing design artifact. If no deployed target exists, this
CONDITIONAL stage reports skipped.

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What are the golden signals to track (latency, traffic, errors, saturation)?
- What SLOs/SLIs are defined?
- What dashboard layouts does the team need?
- What log retention and aggregation rules apply?
- What distributed tracing instrumentation is needed?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create CloudWatch dashboard configurations, alarm definitions (with severity, SNS routing, escalation), SLO/SLI tracking configuration, CloudWatch Logs Insights saved queries, X-Ray tracing configuration, and anomaly detection configuration.

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :eyes:
Review path: `<record>/operation/observability-setup/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/observability-setup/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `performance-design`, `security-design`, `reliability-design`, `monitoring-design`, `infrastructure-specification`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
