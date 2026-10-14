<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/construction/nfr-requirements.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# NFR Requirements

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–4 only (read artifacts, assess categories, generate questions, collect answers).
Do NOT proceed to artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–4 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 5–7 only (generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Read Prior Artifacts

Read functional design artifacts from `<record>/construction/{unit-name}/functional-design/` (if they exist). Read `<record>/inception/requirements-analysis/requirements.md` (if exists), the inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced — its SLAs, retry/timeout, and integration-mechanism decisions constrain this unit's NFR targets), and any reverse engineering artifacts from `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints). Incremental scopes (infra) skip functional-design by design; when its artifacts are absent, derive the NFR context from the requirements and the code knowledge base instead — never invent the content of a missing artifact.

### Step 2: Assess NFR Categories

Analyze the unit across NFR categories:
- **Performance**: Response times, throughput, latency targets, resource utilization
- **Security**: Authentication, authorization, data protection, compliance requirements
- **Scalability**: Load handling, growth projections, scaling strategies
- **Reliability**: Availability targets, fault tolerance, disaster recovery, data durability
- **Observability**: Monitoring, logging, alerting, tracing requirements

### Step 3: Generate Questions

Create a questions file at `<record>/construction/{unit-name}/nfr-requirements/nfr-requirements-questions.md` for unclear NFR areas using [Answer]: tags. Focus on quantifiable targets and specific constraints.

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). Perform MANDATORY ambiguity analysis:
- Identify vague answers ("fast enough", "highly available", "secure")
- Check for contradictions between NFR targets
- Flag missing quantitative targets

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 5: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/nfr-requirements/`:

- **performance-requirements.md**: Response time targets, throughput requirements, latency budgets, resource constraints, benchmarks
- **security-requirements.md**: Authentication requirements, authorization model, data protection, compliance, threat considerations
- **scalability-requirements.md**: Load projections, scaling triggers, capacity planning, data growth, concurrency targets
- **reliability-requirements.md**: Availability targets (SLA/SLO), fault tolerance requirements, backup/recovery, graceful degradation
- **observability-requirements.md**: Monitoring requirements, logging standards, distributed tracing needs, alerting thresholds, dashboard requirements, SLI/SLO definitions
- **tech-stack-decisions.md**: Technology selections and rationale — languages, frameworks, databases, infrastructure tools, and justification for each choice

Every detailed requirement inherits its inception NFR ID and appends a
sub-number, such as `NFR4.1` and `NFR4.2`. Carry these IDs on every requirement
row.

Create
`<record>/construction/{unit-name}/nfr-requirements/traceability.json`.
Enumerate every inception `NFR{n}` applicable to this Unit and target the
derived `NFRx.y` IDs. `N/A` requires a justification:

```json
{
  "stage": "nfr-requirements",
  "unit": "u1-auth",
  "upstream_ids": ["NFR1", "NFR4"],
  "coverage": [
    { "id": "NFR1", "status": "OK", "target": "NFR1.1, NFR1.2" },
    { "id": "NFR4", "status": "N/A", "target": "no persistent data in this Unit" }
  ]
}
```

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Completion

Present completion message and approval gate:

```
# :bar_chart: NFR Requirements Complete — {unit-name}
```

Summary of NFR categories addressed and key targets, then:

```
**Review:** `<record>/construction/{unit-name}/nfr-requirements/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/{unit-name}/nfr-requirements/`. Some sections include code samples that the code-shape sensors can also flag.

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`, `traceability`.

Upstream targets: `functional-spec`, `rules`, `requirements`, `contract-summary`, `technology-stack`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets.
`traceability` verifies that inception NFR IDs are declared and covered by
per-Unit `NFRx.y` requirements.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
