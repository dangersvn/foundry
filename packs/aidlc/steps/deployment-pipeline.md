<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/deployment-pipeline.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Deployment Pipeline Configuration

## Steps

### Step 1: Load Prior Context

- Read CI pipeline config from `<record>/construction/ci-pipeline/` (if exists)
- Read infrastructure design from `<record>/construction/infrastructure-design/` (if exists)
- Read NFR design (deployment-related NFRs) from `<record>/construction/nfr-design/` (if exists)

Incremental scopes (`bugfix`, `refactor`, and `security-patch`) and `express`
skip CI Pipeline and Infrastructure Design by design. On brownfield, inspect
the workspace's existing pipeline and infrastructure configuration plus the
code knowledge base. On Express greenfield, use the approved requirements,
Build and Test results, and deployment artifacts generated in the workspace
(for example a Dockerfile, service manifest, or IaC); if no deployable target
exists, this CONDITIONAL stage reports skipped. Design only against evidence
that exists - never invent a missing CI or infrastructure artifact.

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What deployment strategy (blue/green, canary, rolling)?
- What environment promotion gates (dev → staging → prod)?
- What approval workflows for production?
- What rollback procedure?
- What feature flag strategy (CloudWatch Evidently, AppConfig)?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create CD pipeline configuration, deployment strategy document, rollback runbook, feature flag configuration, and environment promotion matrix.

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :rocket:
Review path: `<record>/operation/deployment-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-pipeline/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `ci-config`, `quality-gates`, `infrastructure-specification`, `cicd-pipeline`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
