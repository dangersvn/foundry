<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/rough-mockups.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Rough Mockups & Concept Visualization

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read scope definition and intent backlog from `<record>/ideation/scope-definition/`

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/rough-mockups/rough-mockups-questions.md` with questions:
- What are the primary user entry points and key screens/views?
- What is the core user flow (happy path)?
- What does the information hierarchy look like?
- Are there existing brand guidelines, design systems, or UI patterns to follow?
- What device/form factors must be supported?
- Are there known accessibility requirements (WCAG level, screen reader support, keyboard-only navigation)?
- For non-UI initiatives: what are the key system interactions and data flows?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run contradiction analysis between UX expectations and scope constraints.

### Step 4: Generate Artifacts

For UI initiatives: Create low-fidelity wireframes (ASCII art or structured descriptions), core user flow diagram, information architecture outline. Include a one-line accessibility note per screen: heading level (h1–h3), primary landmark regions (header/main/nav/footer), keyboard entry point.

For non-UI initiatives: Create system context diagram, key interaction flow sketches.

All diagrams follow ASCII diagram standards from stage-protocol.md.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :pencil2:
Review path: `<record>/ideation/rough-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/rough-mockups/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `scope-document`, `intent-backlog`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
