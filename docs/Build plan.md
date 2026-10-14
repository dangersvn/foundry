# Build plan

Foundry is built in six phases, and each phase adds only the concepts its exit test needs: the spec describes where Foundry ends up, not what to build first.

Phases 0 to 2 are the roadmap's Prove it phase and run on your own or an open-source repository, which keeps the proof separate from your employer's code. Phases 3 to 5 are Open core and bring Foundry to your team's tools. Sizes are rough estimates for one engineer.

## Phase map

&#91;embedded content: phase map · 6 phases, each closed by an exit test\]

Start with Phase 0 (highlighted). Each box lists what the phase builds; the line beside its diamond is the exit test that closes it.

## The six phases

### Phase 0 · Walking skeleton (about 2 weeks)

One work item goes from request to merged commit, and survives a crash.

- **Builds:** a TypeScript kernel on Bun with a SQLite ledger (runs, items, events, artifacts); `foundry run`, `status` and `log`; an ACP runtime for both Kiro and Claude Code, one session per item, using whichever agents the team's config lists; a git worktree and a lease per item; a verifier that runs the tests; local merge to main.
- **Not yet:** roles, multi-step formulas, questions, gates, MCP, integrations, evals.
- **Exit test:** a one-step formula fixes a small task in a sample repo and the commit lands on main, once with Kiro and once with Claude Code; killing Foundry mid-run and restarting it finishes the item with no duplicated work.

### Phase 1 · Full AI-DLC, manual mode (about 9 weeks)

AI-DLC's whole lifecycle runs through Foundry, imported from its source rather than hand-ported, with you answering every question and gate.

- **Imports:** all 33 stages, 14 agents with their knowledge, 11 scopes and 6 sensors, read straight from the AI-DLC repository, so a new AI-DLC release is a re-import rather than a re-port. The 85 places where stage texts call AI-DLC's own engine are rewritten as `foundry` commands, and you review that rewrite once.
- **Builds:** what every run needs (multi-step formulas, the envelope, notes and handoff, the decision log, decision points answered with `foundry answer`, `approve` and `reject`, the refinery, patrol, three parallel workers) plus five features AI-DLC needs: profiles for its scopes, a skipped outcome for its 22 conditional stages, run parameters (depth, test strategy, project type), layered org, team and project rules, and a review step for its 13 reviewed stages. Agents reach Foundry through the `foundry` CLI until MCP arrives in Phase 3. Every role renders for both Kiro and Claude Code, as AI-DLC itself already ships for both.
- **Runs on AI-DLC's simplest settings:** lead agent only (collaborators off), advisory reviews, learnings off, summary confirmations off and no walking skeleton, all settings AI-DLC itself offers; plan approval stays on. Each comes back in a later phase.
- **Maps rather than ports:** AI-DLC's three initialization stages become Foundry's run setup, where the existing-code check sets the project type; its swarm becomes Foundry's parallel workers; BDD comes from AI-DLC itself once the team's Testing Posture is set to BDD.
- **Operation stages:** they write pipeline and environment changes; a step that would touch a real environment stops at a gate for you to run it, until the Jenkins adapter arrives in Phase 3.
- **Not yet:** autopilot, evals, integrations and mid-run plan changes.
- **Exit test:** a bugfix run (9 stages) and then a feature run (all 33) finish end to end on your own or an open-source repo, and `foundry why <file>:<line>` traces any changed line to its stage, decisions and your answers.

### Phase 2 · Autopilot and evals (about 4 weeks)

Roles resolve decision points instead of you, and the factory's quality becomes a number.

- **Builds:** a run mode (`--mode manual | autopilot`); an answerer role (from AI-DLC's product lead agent) for questions and a reviewer role (from its architecture reviewer) for gates; replay evals that re-run one role on frozen envelopes from approved items, several trials each, graded by the verifiers; a benchmark with a development set and a held-out set, also used to compare Kiro and Claude Code role by role; `foundry eval` and `foundry stats`.
- **Not yet:** automated improvement, per-area autonomy rules, integrations.
- **Exit test:** baseline numbers for AI-DLC's test-graded Construction stages (first-pass yield, attempts, your rejection rate); one prompt change you make by hand beats the baseline on the held-out set with no regression; one run finishes in autopilot with no human stops and every answer in its decision log.

### Phase 3 · Team integration (about 4 weeks)

Foundry meets your team's real tickets and tools.

- **Builds:** Jira, Bitbucket, Jenkins and Confluence adapters behind the outbox; Jira intake, where a labelled ticket starts an AI-DLC run and its issue type picks the profile (a Bug runs bugfix, a Story runs feature); deployments from AI-DLC's Operation stages go through the Jenkins adapter after your approval; workspace context that stays fresh after merges, built on AI-DLC's reverse engineering; `foundry mcp` with worker and Mayor tools, so your Kiro or Claude Code chat can plan and steer runs.
- **Before it starts:** confirm that automated Kiro and Claude Code use and a service account for the adapters are allowed.
- **Exit test:** your team runs real Jira tickets through Foundry for two weeks, and every PR, Jira transition and Confluence page Foundry made traces back to its run.

### Phase 4 · Self-improvement and earned autonomy (about 4 weeks)

The improvement cycle you ran by hand in Phase 2 becomes a formula, and autopilot expands area by area.

- **Builds:** the `improve` formula (pick one weakness, propose one change in a worktree, run replay evals, check the held-out set); per-area autonomy rules with earned thresholds, automatic demotion and locked paths; sampled after-the-fact review.
- **Exit test:** a change the factory proposed and evaluated itself is promoted with only your approval, and an earned rule turns on autopilot for at least one low-risk area of a repo.

### Phase 5 · Open core release (about 4 weeks)

The kernel is released and other teams start using it.

- **Builds:** run adoption, so a plan can change mid-run without redoing approved work (what AI-DLC's composer does); a Postgres team server; the data-mapping pack; the MIT release.
- **Exit test:** a run reshaped mid-way keeps all its approved work, and five design partners use Foundry weekly.

**One ordering choice.** If getting your team onto Foundry matters more than proving the vision first, swap phases 2 and 3: Phase 3 needs nothing from Phase 2, and Phase 4 needs both.

## Complexity budget

At any point the working system holds only the concepts of its phase and the phases before it, never the whole spec: Phase 0 needs eight, and taking all of AI-DLC makes Phase 1 the biggest step, with 14 new ones.

| Phase | Concepts it adds | Concepts in play |
| --- | --- | --- |
| 0 | Run, work item, formula, agent, verifier, worktree, lease, event log | 8 |
| 1 | Role, step instructions, envelope, notes and handoff, decision log, decision point, review step, refinery, patrol, profile, skipped outcome, run parameters, layered rules, importer | 22 |
| 2 | Run mode, answerer role, replay eval, benchmark | 26 |
| 3 | Adapter and outbox, context freshness, MCP tools and Mayor | 29 |
| 4 | Improve formula, per-area autonomy rules, sampled review | 32 |
| 5 | Run adoption | 33 |

## Where each spec section lands

The main spec tab describes the destination; this table says which phase first needs each of its sections.

| Phase | Spec sections it implements |
| --- | --- |
| 0 | Data model (runs, items, events, artifacts); ACP runtime contract; Security (worktree isolation, permission policy) |
| 1 | Formula spec; Packs and roles; Work item envelope; Decision log; Work item lifecycle; Verification, gates and traceability; plus the AI-DLC import described in this tab |
| 2 | Autonomy policy (decision points and run modes); Self-improvement (replay evals, benchmark); Observability and metrics |
| 3 | Integrations; Workspace context (freshness); MCP tool plane; Release integration (build status, failure intake) |
| 4 | Autonomy policy (per-area rules); Self-improvement (improve formula, protected paths) |
| 5 | Deployment topologies (team server); Open-core split; Release integration (release candidates) |
| Later | Enterprise control plane, policy as code, business packs |
