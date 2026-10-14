<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/deployment-execution.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.
- **This stage would change a real environment.** Do not run anything that changes it (deploy, apply, provision). Write the exact plan and commands into your artifacts and submit; the person carries them out at the gate.

---

# Deployment Execution

## Steps

### Step 1: Load Prior Context

- Read CD pipeline config and deployment strategy from `<record>/operation/deployment-pipeline/` (if they exist)
- Read environment inventory from `<record>/operation/environment-provisioning/` (if exists)
- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read rollback runbook (if exists)

Incremental scopes (`bugfix`, `refactor`, `security-patch`, and `infra`) plus
`express` may skip Environment Provisioning or Build and Test by design.
`bugfix`, `refactor`, `security-patch`, and `express` retain Build and Test but
skip Environment Provisioning; `infra` retains Environment Provisioning but
skips Build and Test. Deployment Pipeline may also report skipped when the
workspace's existing pipeline is already adequate; in that case its absent
`cd-config` and `deployment-strategy` artifacts are expected, and this stage
must inspect and use the real pipeline configuration in the workspace instead
of invoking missing-artifact recovery. Inventory actual target environments
from that workspace configuration and any approved Deployment Pipeline
artifacts. For Express greenfield, deployment proceeds only when those files
identify a real target; otherwise this CONDITIONAL stage reports skipped.
Never invent an environment inventory or deployment path.

### Step 2: Pre-Deployment Checks

Create questions file covering:
- Are all pre-deployment checks passing?
- Are database migrations required and tested?
- Are dependent services available and healthy?
- What is the deployment window?

Follow stage-protocol.md question flow.

### Step 3: Execute Deployment

Push artifacts through the pipeline. Run smoke tests. Validate health checks. Execute database migrations if needed: delegate to Task tool with subagent_type="aidlc-developer-agent" for migration execution.

### Step 4: Generate Artifacts

Create deployment execution log, smoke test results, health check validation report, and database migration log (if applicable).

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :package:
Review path: `<record>/operation/deployment-execution/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-execution/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `cd-config`, `deployment-strategy`, `environment-inventory`, `build-test-results`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
