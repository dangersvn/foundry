<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/performance-validation.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Performance Validation & Load Testing

## Steps

### Step 1: Load Prior Context

- Read NFR requirements from `<record>/construction/nfr-requirements/`
- Read NFR design from `<record>/construction/nfr-design/`
- Read observability configuration from `<record>/operation/observability-setup/`

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What are the expected traffic patterns (steady state, peak, burst)?
- What are the target latency percentiles (p50, p95, p99)?
- What throughput must the system sustain?
- Where are the likely bottlenecks?

Follow stage-protocol.md question flow.

### Step 3: Design and Execute Tests

Design load test plan, execute performance tests against production-like environments, analyze results using CloudWatch/X-Ray evidence.

### Step 4: Generate Artifacts

Create load test plan, performance test results (latency, throughput, error rates), bottleneck analysis, auto-scaling validation report, capacity planning recommendations, and NFR validation matrix (target vs. actual).

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :zap:
Review path: `<record>/operation/performance-validation/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/performance-validation/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `performance-requirements`, `scalability-requirements`, `performance-design`, `scalability-design`, `dashboards`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
