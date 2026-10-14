<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/construction/ci-pipeline.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# CI Pipeline

## Steps

### Step 1: Load Prior Context

- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read code summary from `<record>/construction/{unit-name}/code-generation/` (if exists)
- Read infrastructure design from `<record>/construction/infrastructure-design/` (if exists)
- Read workspace profile for existing CI configuration

Incremental scopes (infra) skip code-generation and build-and-test by design; when those inputs are absent, base the pipeline stages on the workspace's existing build/test setup (detected from the repo itself) instead — never invent the content of a missing artifact.

### Step 2: Generate Clarifying Questions

Create `<record>/construction/ci-pipeline/ci-pipeline-questions.md` with questions:
- What CI tool is in use (CodePipeline, CodeBuild, GitHub Actions, Jenkins)?
- What is the branch strategy?
- What quality gates are required before merge?
- What artifact repositories are used (ECR, CodeArtifact, S3)?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate CI choices against existing infrastructure and team capabilities.

### Step 4: Generate Artifacts

Create CI pipeline configuration (buildspec.yml, workflow YAML, or equivalent), quality gate definitions, and artifact repository configuration.

### Step 5: Phase Boundary Verification

Run Construction → Operation verification check:
- Read
  `<record>/construction/build-and-test/cross-unit-traceability.md`.
- Read every
  `<record>/construction/*/code-generation/traceability.json`.
- Confirm all Units built and tested, all code-generation tables have no
  unresolved findings, and the cross-Unit FR/NFR/AC gate passed.
- Confirm the CI quality gates enforce the build and test commands recorded by
  Build and Test.
- Write the boundary verdict to
  `<record>/verification/phase-check-construction.md`.

If any traceability file is missing or any unresolved finding remains, stop
the Construction → Operation transition and revisit the owning stage.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Present Completion & Request Approval

Completion emoji: :gear:
Review path: `<record>/construction/ci-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/ci-pipeline/`. Some sections include code samples that the code-shape sensors can also flag.

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`.

Upstream targets: `code-summary`, `build-and-test-summary`, `build-test-results`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets in
the design outputs.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
