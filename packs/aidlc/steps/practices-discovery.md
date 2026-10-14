<!-- Imported by `foundry import aidlc` from AI-DLC core/aidlc-common/stages/inception/practices-discovery.md. Engine calls are rewritten; see packs/aidlc/import-report.md. -->

## Reading this stage in Foundry

- `<record>` is the folder `aidlc-docs/<run>` at the root of your worktree, where `<run>` is the `run` id in your envelope. Write this stage's artifacts there and list each one in your result's `artifacts`.
- `<directive.unit>`, `<unit>` and `<unit-name>` are the `unit` in your envelope; `<directive.stage>` is the `step`; `<repo>` is this repository.
- Ask the person with `./.foundry/bin/foundry ask`, then end your turn; you are resumed with the answer in your history.
- Approval: where this text says to present your result and wait for "Approve" or "Request Changes", do not ask. Submit your result: Foundry holds it at a gate, and the person approves it or rejects it with a comment that reaches your next attempt.
- `stage-protocol.md` and its modules are AI-DLC's engine protocol and are not used here; the envelope's "How to work with Foundry" replaces them.
- Work at the `depth` in your envelope's params (Minimal, Standard or Comprehensive). Collaborators are off: you are the only role in this step.

---

# Practices Discovery

This stage discovers how the team works: way of working, walking-skeleton
stance, testing posture, deployment, and code style. It is a hub-and-spoke
ensemble. The pipeline-deploy lead drafts; quality, developer, and devsecops
inspect the draft independently; the human resolves the practice choices; and
the lead integrates the result.

At the affirmation gate, a deterministic tool promotes the affirmed content
into the active space's `memory/team.md` and `memory/project.md`. Human approval
is not committed until that promotion succeeds.

## Steps

### Step 1: Check Conditions

Read `<record>/aidlc-state.md` to determine project type and active space:

- **Brownfield:** use available reverse-engineering artifacts and workspace
  configuration as evidence.
- **Greenfield:** use
  `aidlc/spaces/<active-space>/memory/org.md` as the default-practice source.

If `aidlc/spaces/<active-space>/memory/team.md` already contains affirmed
content, use it as re-run context for either project type. Steps 2-8 run for
both project types.

Do not skip this stage based on project type. Skip it only when the active
scope's compiled plan marks `practices-discovery` as `SKIP`.

### Step 2: Lead Draft (Always)

Delegate the first turn to `aidlc-pipeline-deploy-agent`. The lead loads its own
persona and knowledge; pass paths, not pasted persona prose.

- **Brownfield:** inspect git history, CI/deployment configuration, and the
  available reverse-engineering artifact paths. Infer branching strategy,
  deployment cadence, environment topology, and visible team conventions.
- **Greenfield:** read the five matching sections from
  `aidlc/spaces/<active-space>/memory/org.md` and treat them as suggested
  defaults, not established team facts.
- **Re-run:** read matching non-empty sections in
  `aidlc/spaces/<active-space>/memory/team.md` as the current affirmed baseline.

The lead writes an initial version of all four declared artifacts under
`<record>/inception/practices-discovery/`. The timestamp artifact remains a
draft until final integration. Only the lead edits these declared artifacts.

### Step 3: Blind Support Review

Dispatch exactly the collaborators the directive lists in `support_agents`, as
one parallel batch when the harness supports parallel delegation. Every brief
contains only the stage path, the lead draft paths, and relevant evidence
paths. No brief or context may contain a sibling's contribution: the spokes are
mutually blind.

**If `directive.support_agents` is empty, skip this step entirely** — the
collaborators switch is off for this scope, so the stage runs lead-only
(`stage-protocol-ensemble.md` §5): the lead's draft stands as the practices,
the interview resolves them, and no spoke review runs. The full roster, when
present, is:

- **aidlc-quality-agent** - assess testing posture, coverage tooling, CI
  quality gates, test/code patterns, and gaps the interview must resolve.
- **aidlc-developer-agent** - assess naming, layer boundaries, error handling,
  file organization, and code-style conventions.
- **aidlc-devsecops-agent** - assess lint/format rules, SAST/DAST, secret and
  dependency scanning, and supply-chain controls.

Each dispatched support agent writes:

`<record>/inception/practices-discovery/contributions/<agent-slug>.md`

The first line must be `**Collaborator:** <agent-slug>`, followed by
`## Contribution` and `## Positions` as defined by
`stage-protocol-ensemble.md` §11. Collect every dispatched collaborator's file
before the interview. Their presence and identity markers are deterministic
completion evidence checked by the engine.

### Step 4: Interview (Always)

Create
`<record>/inception/practices-discovery/practices-discovery-questions.md` and
present structured questions for the five `memory/team.md` sections: Way of
Working, Walking Skeleton, Testing Posture, Deployment, and Code Style.

- **Brownfield:** ask only what the lead draft and independent reviews could
  not establish. Evidence can suggest an answer, but team intent remains a
  human judgment.
- **Greenfield:** ask all five areas, using the matching `memory/org.md`
  sections as suggested answers.
- **Re-run:** show the matching `memory/team.md` content as the default.

The `memory/*.md` sections you draw the suggested answers from are written for
this framework's own resolution rules, so they carry vocabulary the person
answering has no reason to know. Two obligations follow, and they apply to the
question text as much as to the options:

- **Ask in their words, not the section's.** A section's phrasing is an input to
  your question, never the question itself. "Walking Skeleton" is the name of a
  practice; "Should we build a thin end-to-end slice first?" is a question
  someone can answer. Drop the framework's process nouns from what you present.
- **Gloss a term of art the first time it appears, in the question itself.** A
  practice with a name the user may not share gets a single clause defining it,
  in the question line rather than tucked inside one option, so the definition is
  read before the choice is made. For the Walking Skeleton area, ask it as
  **"Build a thin end-to-end slice first? A walking skeleton is a minimal
  version that runs the whole way through, built first to prove the pieces
  connect before the real features go in."** and offer the yes/no choice
  beneath it. Later mentions need no gloss.

Log every interview question with `foundry ask` before presenting it
and every interview answer with `foundry answer` after the response,
following the standard non-gate question flow.

### Step 5: Lead Integration

Delegate a final integration turn to `aidlc-pipeline-deploy-agent`. Pass the
lead draft paths, every contribution path produced in Step 3 (none on a
lead-only run), and the completed interview file. The lead alone updates the
four declared artifacts:

1. **team-practices.md** - five sections matching `memory/team.md`
   (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`,
   `## Deployment`, `## Code Style`), in team voice. `## Testing Posture`
   MUST include:
   - `- **Methodology**: tdd | bdd | atdd | test-after | custom` (one of those
     values and nothing else; put the reasons in a
     `- **Methodology evidence**: ...` bullet)
   - `- **Ordering**: <the affirmed ordering in one explicit sentence>`

   Use `custom` whenever the answer mixes cadences (for example, BDD scenarios
   before implementation with lower-level unit tests after implementation).
   Keep coverage, tooling, test-type, and scope notes as additional bullets;
   they do not replace the two structured fields.
2. **discovered-rules.md** - `## Mandated` rules in `ALWAYS ...` form and
   `## Forbidden` rules in `NEVER ...` form, only for human-stated hard
   constraints.
3. **evidence.md** - what each participant inspected or inferred, the
   interview decisions, and any unresolved uncertainty.
4. **practices-discovery-timestamp.md** - one line:
   `Discovered: <ISO-8601 timestamp> at commit <hash>`.

After integration, emit `PRACTICES_DISCOVERED`:

```bash
./.foundry/bin/foundry note "practices discovered: <sources scanned, drafts written>"
```

### Step 6: Learnings + Affirmation Gate

Run the section 13 learnings ritual only when `directive.protocol_modules` lists `learnings`, then follow the affirmation gate below. When the module is absent, go directly to that gate:

1. Open the gate before the question:
   `./.foundry/bin/foundry submit --file .foundry/result.json # Foundry then holds it at the step's gate`.
2. Do not log the affirmation gate with `foundry ask` or
   `foundry answer`; the lifecycle `report` calls own its audit events.
3. Present `team-practices.md` and `discovered-rules.md` with two options:
   **Approve** (promote, then continue to the next stage) and
   **Request Changes**. Write the actual next stage name into the Approve
   option's description, read from the `next_stage` field of the reply that
   opened the gate, else the run-stage directive's (`Complete workflow` when it
   is null); never show the field name to the user.
4. STOP and wait for the human response.
5. Read their reply and take the matching `report` or promotion path below;
   never call `foundry answer` for this gate.
6. On Request Changes, report `--result rejected --user-input "Request Changes"`
   (their words are kept with the record; add `--reason` only to say more),
   revise through the lead (and re-run a support only when its evidence must be
   refreshed), then report `--result revised` before re-presenting the gate.
   A rejection invalidates any earlier promotion receipt: the engine refuses
   `approved` until Step 7's promotion re-runs after the rejection, so a later
   Approve must always re-promote the revised drafts.
7. On Approve, do not report `approved` yet. Continue to Step 7 in the same
   response turn.

### Step 7: Promote (On Approve Only)

The orchestrator does not edit active-space memory directly. Run:

```bash
list the drafts in your result's artifacts # learnings are off in v1; nothing is promoted into rules
```

The subcommand resolves the active space and:

- revalidates every effective support contribution and its identity marker
  before any memory write (none on a lead-only run);
- reads both drafts and
  `aidlc/spaces/<active-space>/memory/{team,project}.md`;
- replaces the five matching sections in `team.md`;
- appends stamped hard constraints under `project.md`'s `## Mandated` and
  `## Forbidden`;
- writes `project.md` first and `team.md` second;
- emits `PRACTICES_AFFIRMED` and records `Practices Affirmed Timestamp` in
  state on success, or emits `PRACTICES_OVERRIDE` on failure.

If the command exits non-zero, halt. Do not report approval or advance. The
stage remains at its open gate until promotion succeeds.

### Step 8: Commit Approval

After Step 7 prints `{"emitted":"PRACTICES_AFFIRMED",...}` and exits 0:

1. Do not emit `PRACTICES_AFFIRMED` again.
2. Commit the held approval:
   `nothing to run: the person approves at the gate with foundry approve`.

Use the stage-protocol.md completion template:

- summarize all four artifacts, any contribution files produced (none on a
  lead-only run), and both promotion targets;
- use `<record>/inception/practices-discovery/` as the review path;
- name the next stage from the gate-opening reply's `next_stage`, else `directive.next_stage`.

## Sensors

This stage's declared outputs are markdown artifacts under
`<record>/inception/practices-discovery/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `code-structure`, `technology-stack`, `dependencies`, `code-quality-assessment`, `architecture`, `business-overview`.

Brownfield upstream targets are conditional; inputs absent in a greenfield
workspace do not count as missing coverage.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
