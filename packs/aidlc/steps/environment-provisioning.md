<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/operation/environment-provisioning.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.
- **This stage would change a real environment.** Do not run anything that changes it (deploy, apply, provision). Write the exact plan and commands into your artifacts and submit; the person carries them out at the gate.

---

# Environment Provisioning

## Steps

### Step 1: Load Prior Context

- Read infrastructure design from `<record>/construction/infrastructure-design/`
- Read security requirements from `<record>/construction/nfr-requirements/`

### Step 2: Generate Clarifying Questions

Create questions file covering:
- Are all environments provisioned per Infra Design?
- Are VPCs, subnets, security groups, NACLs correct?
- Are secrets in Secrets Manager / Parameter Store correctly injected?
- Is cross-account / cross-VPC connectivity validated?

Follow stage-protocol.md question flow.

### Step 3: Provision and Validate

Provision target AWS environments using IaC from Construction. Validate infrastructure configuration. The orchestrator will invoke aidlc-devsecops-agent for security posture validation.

### Step 4: Generate Artifacts

Create provisioned environment inventory, infrastructure validation report, secrets & parameter store audit, stack deployment logs, and environment health check results.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :cloud:
Review path: `<record>/operation/environment-provisioning/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/environment-provisioning/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `infrastructure-specification`, `cd-config`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
