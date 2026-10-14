<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/ideation/market-research.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Market Research & Competitive Analysis

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Identify market-relevant aspects of the initiative

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/market-research/market-research-questions.md` with questions:
- What competing products or solutions exist in the market?
- What are their strengths, weaknesses, and pricing models?
- What industry trends or regulatory shifts are relevant?
- What do customers expect as table-stakes vs. differentiators?
- For internal initiatives: are there existing tools, SaaS products, or open-source alternatives?
- What is the build-vs-buy-vs-partner calculus?
- What market size or addressable audience are we targeting?

Follow stage-protocol.md question flow (Guide Me / Edit File / Chat).

### Step 3: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis on all answers.

### Step 4: Generate Artifacts

Create competitive analysis, market trends report, build-vs-buy assessment, and differentiation strategy brief based on answers and research.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`./.foundry/bin/foundry submit --file .foundry/result.json`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :bar_chart:
Review path: `<record>/ideation/market-research/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/market-research/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
