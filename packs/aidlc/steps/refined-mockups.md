<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/inception/refined-mockups.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Refined Mockups & UX Design

## Steps

### Step 1: Load Prior Context

- Read rough mockups from `<record>/ideation/rough-mockups/` (if exists)
- Read user stories from `<record>/inception/user-stories/`
- Read requirements from `<record>/inception/requirements-analysis/`

The classic scope skips rough-mockups by design (no Ideation phase); when the wireframes and user-flow inputs are absent, design the refined mockups directly from the user stories and requirements — never invent the content of a missing artifact.

### Step 2: Generate Clarifying Questions

Create `<record>/inception/refined-mockups/refined-mockups-questions.md` with questions:
- How should each user story be represented in the UI?
- What interaction patterns are needed (modals, inline edits, wizards, progressive disclosure)?
- What states must each screen handle (loading, empty, error, success, partial)?
- Does the design align with the existing design system / component library?
- What accessibility requirements apply (WCAG level)?
- What responsive breakpoints are needed?
- For APIs: what does the developer experience look like?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate design decisions against user stories and requirements for consistency.

### Step 4: Generate Artifacts

Create mid-to-high fidelity mockups (per user story/screen), interaction specification document (use `.foundry/pack/knowledge/aidlc-design-agent/component-spec-template.md` as the format for component-level specifications), design system mapping, responsive behavior specification, and accessibility compliance checklist.

For non-UI: create API developer experience specification.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :art:
Review path: `<record>/inception/refined-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/refined-mockups/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `wireframes`, `user-flow`, `stories`, `requirements`, `team-practices`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
