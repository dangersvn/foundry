# Foundry — Agent Factory Platform: Architecture & Design Spec

Oct 11, 2026 · @Dang

## 

Foundry is an agent factory platform: a model-free engine that turns requirements into&#32;

## Summaryverified, traceable outputs by dispatching work items to the AI agents a company has already approved (Kiro, Claude Code, Copilot, Codex) over ACP. The engine supplies the workflow, state, gates and audit; the agents supply the thinking.

**Problem.** Regulated enterprises cannot hand direct LLM API keys to engineers, but they do approve specific agent tools. Today's factory platforms assume open model access or lock buyers into one vendor's agents.

**Positioning.** Run an agent factory with the agents your company already approved, with every decision traced from requirement to commit.

**Goals**

- Turn a written requirement into merged, tested code through human-gated phases (requirements, BDD scenarios, architecture, specs, code).
- Run the same engine for business work items (policy changes, reviews, onboarding) via domain packs.
- Make every output traceable to its requirement, agent session, prompt and verifier result.
- Stay agent- and model-neutral: any ACP agent is a worker; roles choose their runtime.
- Recover from any crash by re-reading the ledger, with no lost or duplicated work.

**No****n-goa****ls (v1)**

- Deploying to environments; Foundry ends at a green merge to main and hands off to existing CI/CD.
- Running its own LLM agent loop; agents run their own loops.
- A full web UI; v1 is a CLI plus a Kiro chat interface over MCP.
- Kubernetes, multi-machine scheduling, or Dolt.

## Design principles

These seven rules decide every trade-off in this spec.

1. **The engine is model-free.** No LLM call lives in the kernel. Thinking happens inside agent runtimes; the kernel is deterministic, testable code.
2. **The ledger is the only source of truth.** Agents, sessions and processes are disposable. Delete every running process, restart, and nothing is lost.
3. **Assigned work must run.** An idle worker with ready work claims it; patrol treats a stalled claim as a fault (Gas Town's GUPP).
4. **Every step is safe to repeat.** Steps are idempotent by item and attempt, so retries converge (Gas Town's NDI).
5. **Verify, never trust.** An agent's claim of completion is never what closes an item; engine-run verifiers do.
6. **Humans own judgment gates.** Requirements, scenarios, architecture and promotion are approved by people; agents cannot reach approval tools.
7. **Behavior is configuration.** Roles, formulas, knowledge and verifiers live in versioned packs, not in kernel code. The kernel stays small and boring.

How each abstraction leaks and how Foundry exposes the layer beneath: Abstraction design

## System overview

You and your Mayor chat steer the kernel; the kernel dispatches each work item to an approved agent over ACP and merges only verified work.

&#91;embedded content: system overview · kernel, agents, tools, workspace\]

The ledger (highlighted) is the single source of truth: every box around it reads and writes there, and every agent session can be killed and restarted without losing work.

## Core primitives

Ten nouns describe everything Foundry does; each maps to a Gas Town or Gas City concept.

| Primitive | What it is | Gas Town / City equivalent |
| --- | --- | --- |
| Work item | The unit of work: status, deps, role, lease, attempts, budget, trace links | Bead |
| Formula | Declarative YAML workflow template: steps, deps, fan-out, gates, verifiers | Formula |
| Run | One instantiation of a formula for one input (a requirement, a request) | Molecule / convoy |
| Artifact | A versioned output (requirement doc, `.feature` file, ADR, spec, diff, report) | Bead payload |
| Role | A named job (product-analyst, architect, developer) with its profile, knowledge, tools and output schema | Mayor, polecat, refinery |
| Runtime | How a role executes: `acp` (Kiro, Claude), `subprocess`, `langgraph` (optional) | tmux / subprocess / ACP providers |
| Gate | A checkpoint that blocks downstream items until passed: `human` or `auto` | Molecule gate |
| Verifier | Engine-run check that decides done: tests, schema, rules, reviewer agent | Refinery checks |
| Pack | A versioned folder of roles, formulas, knowledge, verifiers and prompts | Pack |
| Workspace | A registered target (git repo or document store) with its own item namespace | Rig |

An **order** (a schedule or event that starts a run) is deferred to v2.

## Component architecture

Foundry has five layers: a small kernel, pluggable runtimes, a role-scoped tool plane, user interfaces, and (paid) an enterprise control plane.

**Kernel (open source, TypeScript on Bun, \~1,500 lines in v0)**

| Module | Responsibility |
| --- | --- |
| `ledger` | Items, deps, artifacts, events, leases; SQLite in v0, Postgres in v1 |
| `formulas` | Parse and validate YAML; expand a run into items; `per:` fan-out; script-step escape hatch |
| `dispatcher` | Find ready items, atomically claim, start the role's runtime, record results |
| `verify` | Run verifiers (tests, schema, rules, reviewer role); decide pass, retry or escalate |
| `gates` | Hold items at gates; accept `approve` / `reject` with comment from humans only |
| `patrol` | Expire leases, recover orphans, flag stalls, enforce budgets, pause on quota limits |
| `refinery` | Single-concurrency merge queue: rebase, full test suite, fast-forward or send back |
| `trace` | Requirement-to-commit links; stale propagation on upstream change |

**Runtimes (plugins behind one interface: `run(item, role, ctx) -> Result`)**

- `acp` — spawns an ACP agent (`kiro-cli acp --agent <role>`, or Claude Code through its ACP adapter; the agent is picked per team and role), streams events to the ledger, answers permissions by policy. **Primary runtime; confirmed working with Kiro.**
- `subprocess` — headless CLIs without ACP (for example `claude -p`).
- `script` — deterministic steps (split, merge, transform) that run any command, in any language, with no agent.
- `langgraph` — optional, for API-based roles if an approved API exists later.

**Tool plane** — `foundry mcp --role <role>`, an MCP server whose tool set depends on the role (see the MCP section). Domain MCP servers (domain-service search, contracts, rules) attach per role.

**Interfaces**

- `foundry` CLI: init, run, status, approve, reject, trace, log, patrol, pause.
- Mayor chat: the user's own Kiro or Claude Code session with `foundry mcp --role mayor` attached.
- Web dashboard and approvals inbox: v2.

**Enterprise control plane (paid, v2+)** — SSO, RBAC, policy engine, audit export, multi-team management, private pack registry, hosted dashboard.

## Data model

Nine tables hold all durable state; `events` is append-only and is the audit trail.

| Table | Key columns | Notes |
| --- | --- | --- |
| `workspaces` | id, kind (git, docs), path, default\_branch, pack\_imports | One per repo or document store |
| `runs` | id, workspace\_id, formula, formula\_version, input\_ref, goal, status, created\_by | One per requirement or request; `goal` is the run's one-line purpose |
| `items` | id, run\_id, step\_id, role, **title, goal, inputs, acceptance, context\_refs**, status, parent\_id, attempt, max\_attempts, budget, lease\_owner, lease\_expires\_at, worktree, created\_at | The work queue; the bold columns say what the work is (see Work item envelope) |
| `item_notes` | id, item\_id, attempt, kind (design, note, handoff, question, answer, rejection), author, body, created\_at | The item's working memory: planned approach, findings, dead ends, handoffs, human comments |
| `decisions` | id, run\_id, item\_id, step\_id, attempt, actor, kind, question, choice, alternatives, rationale, evidence, affects, reversible, status, superseded\_by, created\_at | Every material choice by an agent, the kernel, a policy or a person (see Decision log) |
| `item_deps` | item\_id, depends\_on\_id, kind (blocks, traces\_to) | DAG edges and trace links |
| `artifacts` | id, item\_id, kind, path, version, content\_hash, schema, supersedes\_id | Outputs; never mutated, only superseded |
| `gate_decisions` | id, item\_id, decision, actor, comment, decided\_at | Human approvals and rejections, and policy auto-passes |
| `events` | id, ts, item\_id, run\_id, type, actor, payload\_json | Every transition, agent event, tool call, permission decision |

**Rules**

- Item status changes only through kernel functions that also write an `events` row in the same transaction.
- Artifacts are content-addressed; a change creates a new version and marks downstream items stale.
- Agent session transcripts are stored as files referenced from `events`, not inline.
- IDs are human-readable and prefixed (`RUN-7`, `WI-42`) so agents and people can quote them.

## Work item envelope

Every item carries a self-contained description of its work, and the dispatcher assembles it into an envelope the agent receives as its task; nothing the agent needs lives only in a previous session.

| Field | Meaning | Comes from |
| --- | --- | --- |
| `title` | One line, human-readable: "Implement CSV export for loan report" | Formula step template filled from the input |
| `goal` | What this item must achieve, 2–5 sentences | Step template + the upstream artifact that spawned it |
| `inputs` | Artifact references with a one-line summary each (scenario, spec, mapping entry) | Upstream items' approved artifacts |
| `acceptance` | What done means: output schema, verifiers, the linked scenario | Formula `output` and `verify` |
| `context_refs` | Workspace context areas and knowledge to load | Role knowledge + `AGENTS.md` + modules touched |
| `history` | Previous attempts: handoffs, verifier failures, rejection comments | `item_notes` and verifier events |
| `run_status` | Where this item sits: done, in progress and not started siblings | Live query of the run's items |

**Example envelope (what Kiro receives in `session/prompt`)**

```yaml
item: WI-42            # attempt 2 of 3
run: RUN-7 — "Loan officers export loan reports to CSV"
role: developer
title: Implement CSV export endpoint
goal: >
  Add GET /reports/{id}/export?format=csv returning the report rows as CSV.
  Streams large reports; respects existing report permissions.
inputs:
  - scenario: features/export_csv.feature#large-report  — 10k rows export in <30s
  - spec: SPEC-3 reports-service component — endpoint contract and errors
  - mapping: MAP-1 — field order and source services
acceptance:
  submit: schemas/code_change.json
  verifiers: [lint, unit_tests, cucumber_scenario: export_csv.feature#large-report]
context: [AGENTS.md, modules/reports.md, conventions.md#streaming]
history:
  - handoff (attempt 1): csv-stream hangs above 10k rows; header row tests pass;
    next: page in batches of 1000.
run_status: 6 done, 2 running (WI-43 PDF export), 3 waiting on this item
```

**Rules**

- The envelope holds references and one-line summaries, not full documents; the agent pulls full content with `get_artifact` and `get_context`, so the prompt stays small.
- `title`, `goal`, `inputs` and `acceptance` are written when the item is created and never change; new information goes to `item_notes`.
- What is done and what is left is always answered from the ledger (`run_status`, `foundry status RUN-7`), never from an agent's memory.
- An item without a goal or acceptance fails `foundry validate` before any agent sees it.

## Decision log

Every material choice made during a run is recorded with its rationale and evidence, so in autopilot any output can be traced back to who decided what, why, and on what basis.

**What counts as a decision.** Not every keystroke: a choice among real alternatives that affects behavior, interfaces, data, security or scope. Four kinds are recorded:

| Kind | Example | Who records it |
| --- | --- | --- |
| `decision` | "Page exports in batches of 1,000 instead of streaming" | Agent, via `record_decision` |
| `assumption` | "Treat a missing currency as USD; no spec covers it" | Agent |
| `deviation` | "Skipped convention X because the module predates it" | Agent; always flagged for review |
| `control` | "Gate code-review auto-passed by policy rule 2"; "Retry 2 after verifier failure" | Kernel and policy, automatically |

**Record shape**

```yaml
id: DEC-118
run: RUN-7   item: WI-42   step: code   attempt: 2
actor: developer@kiro-cli (role profile v3)
kind: decision
question: How to export reports larger than 10k rows within 30s?
choice: Page through the repository in batches of 1,000 and write rows incrementally
alternatives:
  - csv-stream library: hangs above 10k rows (verifier log, attempt 1)
  - async job + download link: changes the API contract in SPEC-3
rationale: Meets the 30s scenario without changing the contract
evidence: [scenario export_csv#large-report, verifier run VR-311, SPEC-3]
affects: [src/reports/export.py, artifact ART-88]
reversible: true
status: active          # active | superseded | rejected
```

**How it is enforced**

- `submit_result` requires a `decisions` list (it may be empty). The role prompt defines what is material for that role; a reviewer role flags code changes with no matching decision.
- `assumption` and `deviation` records are surfaced at the next gate, and in autopilot they go to the sampled after-the-fact review first.
- The kernel writes `control` records itself; agents cannot write or edit them.
- Records are never edited. A changed mind creates a new decision with `supersedes`, so the history stays intact.

**How it is used**

- `foundry decisions RUN-7` lists every decision in a run, filterable by kind, role or step.
- `foundry why src/reports/export.py:42` walks back from a line: commit → item → decisions → inputs → requirement.
- Downstream items receive the active decisions of their inputs in the envelope, so the developer respects the architect's choices.
- Decisions of kind `decision` from architecture steps are compiled into ADRs and published to Confluence with the run.

## Work item lifecycle

An item moves forward only through the kernel; every way back leads to Ready, so recovery is always the same operation.

&#91;embedded content: work item lifecycle · 6 states, 4 ways back to Ready\]

Items wait in Blocked until their dependencies are Done; a step with no gate goes straight from Verifying to Done.

Phase 1 adds one more state, **Waiting for input**: a worker that raises a question leaves Running, its agent session ends, and the item returns to Ready once the question is resolved (see Autonomy policy).

**Claiming and leases**

- A worker claims with one atomic update: `status = running, lease_owner = me, lease_expires_at = now + 120s WHERE id = ? AND status = 'ready'` (Postgres: `SELECT ... FOR UPDATE SKIP LOCKED`). Zero rows updated means someone else won.
- The runtime renews the lease every 60 seconds while its agent process is alive.
- Patrol returns any item whose lease expired to Ready and increments `attempt`; the stale worktree is kept for diagnosis.
- Every transition writes an `events` row in the same transaction, so the state history is complete and replayable.

## Formula spec

A formula is declarative: steps, dependencies, fan-out, gates, verifiers and limits, and nothing more. Any step that needs logic is a `script` step.

```yaml
formula: sdlc-bdd
version: 1
input: requirement            # markdown file or text
steps:
  - id: refine
    role: product-analyst
    output: {kind: requirement-analysis, schema: schemas/requirement_analysis.json}
    spawns: feature             # one child per feature in the output
    gate: human

  - id: scenarios
    role: bdd-writer
    per: feature
    output: {kind: feature-file, path: "features/{feature.slug}.feature"}
    verify: [gherkin_lint]
    gate: human

  - id: architecture
    role: architect
    needs: [scenarios]          # waits for all scenario items
    output: {kind: adr, schema: schemas/architecture.json}
    spawns: component
    gate: human

  - id: spec
    role: spec-writer
    per: component
    verify: [compiles, steps_bind]
    gate: auto

  - id: code
    role: developer
    per: [component, scenario]
    workspace: worktree
    verify: [unit_tests, cucumber_scenario]
    max_attempts: 3
    budget: {requests: 60, minutes: 45}

  - id: merge
    type: refinery
    verify: [cucumber_all]
```

**Keywords:** `role`, `type` (agent, script, refinery), `needs`, `per`, `spawns`, `output`, `verify`, `gate`, `max_attempts`, `budget`, `workspace`.

**Rule against drift:** if a formula needs an `if`, a loop or a variable, that logic moves to a `script` step. The formula language must never grow into a programming language.

## Packs and roles

A pack is a git folder that fully defines a factory's behavior; the kernel loads packs and contains no roles of its own.

```text
packs/sdlc-bdd/
  pack.yaml                 # name, version, imports, default runtime
  formulas/sdlc-bdd.yaml
  roles/
    product-analyst.yaml    # runtime, agent profile, tools, output schema
    product-analyst.md      # role prompt: method, rules, output contract
    architect.yaml / .md
    bdd-writer.yaml / .md
    developer.yaml / .md
  knowledge/                # glossaries, principles, examples, style guides
  schemas/                  # JSON Schemas for every role's output
  verifiers/                # gherkin_lint, steps_bind, cucumber_scenario ...
  agents/                   # generated per-agent profiles (Kiro JSON, Claude Code files)
  benchmarks/               # hold-out work items for this pack
```

**Role definition**

```yaml
role: product-analyst
runtime: acp
agents: [any]                 # or [kiro] / [claude]; the team's config supplies the commands
prompt: product-analyst.md
knowledge: [knowledge/domain-glossary.md, knowledge/product-principles.md]
mcp: [foundry:worker, domain-services]
tools_allowed: [read, "@foundry", "@domain-services"]   # no write, no shell
output_schema: schemas/requirement_analysis.json
```

**How a role reaches the agent.** `foundry pack build` renders each role into the agent's native profile (for Kiro, an agent JSON with prompt, resources, MCP servers and allowed tools; for Claude Code, instruction and settings files in the item's worktree). Runtime launches the agent by profile name, so role prompts stay in one place and work across agents.

**Business packs** use the same structure: `change-request`, `policy-update`, `compliance-review`. Their verifiers are schema checks, rule checks and reviewer roles, and they end with a human gate more often than software packs.

## Workspace context

Before an existing project takes work, an `onboard-workspace` run builds a context pack: verified facts about its stack, structure, capabilities and conventions, each with a source and a freshness check.

**Why.** Without it, every agent rediscovers the codebase on every item (wasted quota), puts code in the wrong layer, re-implements capabilities that already exist, and breaks conventions nobody wrote down. Brownfield work needs its own setup; greenfield does not.

| Context | Source of truth | Produced by | Verified by |
| --- | --- | --- | --- |
| Tech stack and versions | Build files, Dockerfiles, lockfiles | Parser, no agent | Deterministic re-extraction |
| Build, test and run commands | Jenkinsfile, scripts, README | Parser, then agent confirms | The command runs green in a fresh worktree |
| Module and dependency map | Source tree, imports | Static analysis | Deterministic re-extraction |
| APIs and data contracts | OpenAPI files, schemas, domain-service catalog | Parser | Spec files parse; endpoints exist |
| Architecture overview | Code, existing Confluence pages | Architect role | Every claim cites a file or page; human review once |
| Capability and feature catalog | Routes, handlers, feature flags, tests | Analyst role, one item per module | Each capability cites an endpoint or test that exists |
| Coding conventions | Linter and formatter configs first; observed patterns second | Parser, then agent | Rules a tool enforces are linked, not restated |
| Diagrams (C4 context and container, key sequences) | Module map and API specs | Generated as Mermaid or PlantUML | Regenerated from source, never hand-drawn |

**Layered so it fits in context**

- `AGENTS.md` at the repo root: one page with stack, commands, where things live, the top rules and links. Every role loads it.
- `.foundry/context/`: deeper files per area (`architecture.md`, `capabilities.yaml`, `conventions.md`, `modules/<name>.md`, `diagrams/`). Roles load them on demand through the MCP tool `get_context(area)`.
- Every fact records `source` and `source_hash`.

**Freshness.** When a merge changes a source file, the facts that cite it become stale and a small refresh item re-derives only those. Agents see stale facts with a warning flag. A full re-onboard is needed only after large restructures.

**The formula** (`brownfield` pack): inventory (script) → analyze, `per: module` → synthesize architecture and capability catalog → extract conventions → verify → human gate once → publish to the repo as a PR and to Confluence.

## ACP runtime contract

One ACP session runs one step of one work item, then ends; continuity lives in the ledger and the worktree, never in the session.

**Session sequence**

1. Spawn the role's command with `cwd` = the item's worktree or scratch dir.
2. `initialize`; record the agent's advertised capabilities in `events`.
3. `session/new` with `cwd` and `mcpServers` = `foundry mcp --role worker --item WI-n` plus the role's domain servers.
4. `session/prompt` with a short task envelope: item id, step, inputs as artifact references, the output contract ("call `submit_result` with schema X").
5. Stream every `session/update` (messages, tool calls, tool results) into `events`.
6. On end of turn: if `submit_result` was called, run verifiers; if not, mark the attempt failed with reason `no_submission`.

**Permission policy (answered by the runtime, never a human)**

- Allow: reads anywhere in the workspace; writes inside the item's worktree; MCP tools on the role's allow-list.
- Deny: writes outside the worktree, `git push`, network calls not on the allow-list, deleting files outside the worktree.
- Every decision is logged with the request payload.

**Limits**

- Wall-clock and request budgets per item; on breach send `session/cancel`, then kill the process after a grace period.
- Lease renewed every 60 seconds while the session is alive; a dead process lets the lease expire and patrol re-queues the item.
- Concurrency cap per agent account to stay under quota; on a quota error, patrol pauses dispatch for that runtime until reset.

**Status:** Kiro ACP connectivity is confirmed; Claude Code is next, through its ACP adapter. Still to measure on the spike: parallel sessions, cancel behavior, and custom-agent plus MCP loading.

## Agents side by side

Foundry runs Kiro and Claude Code side by side: each team declares the agents it has, roles stay agent-neutral, and the dispatcher picks an available agent for every attempt. A Kiro-only team and a Claude-only team use the same packs and formulas.

```toml
# foundry.toml: the agents this team or machine can use
[agents.kiro]
command = ["kiro-cli", "acp"]
max_sessions = 3                  # stay under this account's quota

[agents.claude]
command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
max_sessions = 2

[dispatch]
prefer = ["kiro", "claude"]       # first agent with free capacity wins
review_on_other_agent = true      # reviews use a different agent than the author when both exist
```

A Kiro-only team lists only `[agents.kiro]`; a Claude-only team lists only `[agents.claude]`.

|  | Kiro | Claude Code |
| --- | --- | --- |
| Launch | `kiro-cli acp --agent <role>` | Claude Code through its ACP adapter |
| Role prompt and knowledge | Kiro agent profile rendered by `foundry pack build` | Instruction and settings files written into the item's worktree |
| Tools | MCP servers passed in `session/new` | Same |
| Permissions | Foundry's policy answers `session/request_permission` | Same |
| Sign-in | The team's Kiro account | The team's Claude Code sign-in |

The role prompt also travels in the task envelope, so a role behaves the same even where an agent ignores its native files.

**Dispatch rules**

- A role names agents only when it must (`agents = ["claude"]`); by default it runs on any agent the team has.
- Every attempt records the agent and its version, so audits, evals and handoffs show who did what.
- An item can change agents between attempts: when one agent's quota runs out, the next attempt goes to the other with the same envelope and handoff notes, because continuity lives in the ledger, not the session.
- Quota limits, circuit breakers and contract tests are kept per agent, so one agent's outage or update never stalls the other.
- Phase 2 evals compare the agents role by role on the same frozen envelopes, so which agent runs which role becomes a measured choice.

**Next check:** run the ACP spike again with `--cmd "npx -y @agentclientprotocol/claude-agent-acp"` on a machine signed in to Claude Code.

## MCP tool plane

One MCP server, `foundry mcp`, exposes a different tool set per role; approval tools exist only in the human CLI.

| Tool | worker | mayor | human CLI |
| --- | --- | --- | --- |
| `get_item`, `get_artifact`, `get_trace` (own item only for worker) | yes | yes | yes |
| `submit_result` (schema-validated) | yes | no | no |
| `report_blocked`, `ask_question`, record\_decision, add\_note, handoff | yes | no | no |
| `create_run`, `list_items`, `status`, `explain_failure` | no | yes | yes |
| `retry_item`, `pause_queue`, `resume_queue` | no | yes | yes |
| `approve`, `reject` (gates) | no | **never** | yes |
| Edit packs, verifiers, gate config | no | **never** | yes (via git review) |

**Domain servers** sit beside Foundry's: a domain-service search MCP (`search_services`, `get_service_contract`, `get_business_rules`) is attached to analyst, architect and spec roles so they cite real contracts instead of guessing.

**Fallback without MCP:** the same operations exist as `foundry` CLI commands, so any agent with a shell can call `foundry submit WI-42 --file result.json`.

## Integrations

v1 ships adapters for Jira, Bitbucket, Confluence and Jenkins, plus a plain-git and markdown-folder set for zero-setup use; every other vendor plugs into the same five ports later.

| Port | Foundry's job with it | v1 adapter | Later |
| --- | --- | --- | --- |
| WorkTracker | Pull requests for work, move status, post run summaries, link PRs | Jira | Trello, GitHub Issues, GitLab Issues |
| CodeHost | Branch per item, open PR, read review comments and build status, merge | Bitbucket | GitHub, GitLab |
| CI | Trigger jobs, read results and console logs | Jenkins | GitLab CI, GitHub Actions |
| DocsStore | Read source pages, publish artifacts as versioned pages | Confluence | Notion, SharePoint |
| Notifier | Tell people a gate is waiting | Jira comment + email | Slack, Teams |

**Agents read, the kernel writes.** Adapters perform every change to an outside system, through the outbox with an idempotency key. Agents only read, through MCP tools (ticket text, Confluence pages, PR comments). Adapter credentials belong to a service account; agents never hold them.

**The v1 flow for the team**

1. A Jira issue gets the label `foundry` (or matches a saved JQL filter). Intake creates a run and comments the run link on the issue.
2. Jira status follows the run through a configured status map.
3. Each code item gets a Bitbucket branch `foundry/WI-n-slug`; the refinery opens one PR per run, linked to the Jira key.
4. Jenkins builds the PR as it does today and reports build status to Bitbucket; Foundry reads that status from the PR, so most runs need no direct Jenkins call.
5. On a red build, the Jenkins adapter fetches the failing console log excerpt and attaches it to the item for the next attempt.
6. Published artifacts (requirement analysis, scenarios, ADRs, mapping docs) become Confluence pages under a configured parent page, one version per approved artifact, linked from the Jira issue.
7. On merge, the Jira issue moves to Done with a summary: PR, commits, scenarios passed, pages published.

**Configuration**

```toml
[integrations]
tracker   = "jira"
code_host = "bitbucket"
ci        = "jenkins"
docs      = "confluence"

[integrations.jira]
base_url = "https://jira.example.com"
intake   = { label = "foundry" }          # or jql = "project = LOC AND labels = foundry"
status_map = { ready = "To Do", running = "In Progress", at_gate = "In Review", done = "Done" }

[integrations.bitbucket]
base_url   = "https://bitbucket.example.com"
repo       = "PROJ/loan-service"
branch_prefix = "foundry/"
merge      = "policy"                    # human approval unless a path policy allows auto

[integrations.jenkins]
base_url = "https://jenkins.example.com"
status_source = "bitbucket"              # read build status from the PR
trigger_jobs  = { rc = "loan-service-release-candidate" }

[integrations.confluence]
base_url = "https://confluence.example.com"
space    = "ENG"
parent_page = "Foundry runs"
```

**Known leaks to design for**

- Jira workflows differ per project; a status missing from the map fails at `foundry validate`, not mid-run.
- Bitbucket, Jira and Confluence each have Cloud and Data Center editions with different APIs; each adapter declares which it supports.
- Jenkins only reports to Bitbucket if the team's build-status plugin is installed; otherwise set `status_source = "jenkins"` and Foundry polls the job.
- Confluence pages edited by people after publishing are not overwritten; the next publish creates a new version and flags the conflict.

**Open questions for the team**

- [ ] Cloud or Data Center for Jira, Bitbucket and Confluence?
- [ ] Does Jenkins already post build status to Bitbucket PRs?
- [ ] Which Jira statuses map to ready, running, at gate and done?
- [ ] Which service account owns adapter credentials, and with what permissions?

## Verification, gates and traceability

An item is done only when engine-run verifiers pass and, where configured, a human approves; the agent's own claim never closes it.

**Verifier ladder (cheapest first, stop at first failure)**

1. Schema: `submit_result` payload validates against the role's JSON Schema.
2. Static: lint, compile, Gherkin syntax, step definitions bind.
3. Behavioral: unit tests, then the item's linked Cucumber scenario.
4. Hold-out: scenarios the coding agents never see, run at merge and release candidate.
5. Reviewer role: a separate agent with a review rubric, used for business packs and non-testable artifacts.
6. Human gate: for judgment phases.

A failure attaches the verifier output to the item and re-queues it for the same role, up to `max_attempts`; then it escalates to the human queue.

**Traceability.** Every item links up the chain: commit, code item, spec, scenario, feature, requirement. `foundry trace REQ-7` prints the tree with statuses and artifact versions.

**Change propagation.** When an artifact gets a new version, every downstream item that consumed the old version becomes `stale` and re-queues; unrelated branches keep their approvals. This works like a build system's dependency invalidation.

## Autonomy policy

Formulas and agents create decision points, and the run's mode decides who resolves them: you in manual mode, a designated role in autopilot. Moving toward full autonomy never changes the formulas.

**Decision points: one path, two resolvers.** A question a worker raises puts its item in Waiting for input, and an output awaiting approval puts it At gate. Both follow the same path in every mode; only the resolver changes, and every resolution lands in the decision log.

&#91;embedded content: decision points · one path, two resolvers\]

| Mode | Questions answered by | Gates passed by | Logged as |
| --- | --- | --- | --- |
| Manual | You, with `foundry answer` | You, with `foundry approve` or `reject` | Decision; the actor is you |
| Autopilot | Answerer role | Reviewer role, after the verifiers pass | Decision with evidence, or assumption without; the actor is the role |

**Autopilot guards**

- The role that answers is never the role that asked.
- Every answer cites evidence: the requirement, an approved artifact, workspace context or an earlier decision. An answer without evidence is logged as an assumption, and the answerer picks the most reversible option.
- Assumptions form the run's review list (`foundry decisions RUN-7 --kind assumption`); rejecting one later re-queues the items that relied on it.
- Locked areas (payments, auth, infra) wait for you even in autopilot.

Until Phase 4 the mode is one switch per run (`--mode manual | autopilot`). Phase 4 adds the per-area rules below, so autopilot can expand where the track record earns it.

**Formula side.** A judgment gate has a name: `gate: {name: scenario-approval, kind: judgment}`. Mechanical gates stay `gate: auto`.

**Per-area rules (Phase 4): three gate modes**

| Mode | Who passes the gate | Typical use |
| --- | --- | --- |
| `human` | A person approves | Default; requirements, architecture, risky paths |
| `reviewer` | Verifiers plus an independent reviewer agent | Low-risk judgment once rejection rates are low |
| `auto` | Verifiers only | Mechanical work and mature areas with strong tests |

```toml
[autonomy]
default = "human"

[[autonomy.rules]]                       # small, low-risk changes
match = { pack = "ticket-to-pr", paths = ["docs/**", "tests/**"], max_lines = 200 }
mode  = "auto"

[[autonomy.rules]]                       # earned: only while the record holds
match = { gate = "code-review", workspace = "loan-service" }
mode  = "reviewer"
requires = { last_n = 50, max_human_rejection_rate = 0.05, escaped_defects = 0 }

[[autonomy.rules]]                       # never automated
match = { paths = ["payments/**", "auth/**", "infra/**"] }
mode  = "human"
locked = true
```

**How it stays safe**

- **Earned, not declared.** A rule with `requires` applies only while its track record holds; the kernel checks it at every gate.
- **Automatic demotion.** An escaped defect linked to an item, or a spike in verifier failures, drops that area back to `human` and notifies you.
- **Locked rules.** `locked = true` rules and the policy file itself are protected paths; agents cannot relax them.
- **Audited.** Every automatic pass is recorded as a gate decision with actor `policy:<rule>`.
- **Sampled.** A configurable share (for example 5%) of auto-passed gates goes to a person for after-the-fact review, without blocking.
- **Kill switch.** `foundry autonomy off` returns every gate to `human` immediately.

**Kept simple.** This adds one kernel concept (the decision-point resolver) and one policy file. Formulas, roles and verifiers do not change as autonomy grows.

## Release integration

Foundry never deploys: it ends at a green merge to main, cuts release candidates, and turns pipeline failures back into work items.

| Stage | Trigger | Gate | Owner |
| --- | --- | --- | --- |
| main | Refinery merge | Unit tests + full Cucumber suite | Foundry |
| dev | Every merge | Smoke tests | Existing CI/CD |
| RC cut | `foundry release cut` or schedule | Tag `vX.Y.0-rc.N` + changelog traced to requirements | Foundry |
| QA / staging | RC tag | Hold-out scenarios, performance, security scan | Existing CI/CD |
| UAT | Staging pass | Business sign-off on scenarios | Human |
| prod | Approved RC | Canary or progressive rollout, auto-rollback on SLO breach | Human approval, CI/CD executes |

**Rules**

- Build once, promote the same artifact; environments differ only in config and secrets.
- Agents never hold deployment or production credentials.
- A failed staging or UAT check calls `foundry intake` with the failure, which creates a bug item linked to the RC and the scenario; the RC is re-cut after the fix merges.

## Self-improvement

Foundry improves its own process (prompts, formulas, packs, verifiers) with evidence from the ledger, but it can never change its own safety checks.

**Bootstrap.** v0 kernel is hand-built and fully tested. v0 then builds v1 features under human gates; each stable version builds the next.

**Two-version rule.** The *stable* factory works on a *next* checkout in a separate worktree. A running factory never edits itself in place, so a broken *next* can always be fixed by *stable*.

**Protected paths (human-only).** `verifiers/`, gate configuration, `schemas/`, the ledger schema, `benchmarks/`, and the kernel's own test suite. The refinery rejects agent commits that touch them; agents may only propose changes there as a review request.

**Improvement loop**

1. The ledger records failures, retries, rejections, budgets and verifier outputs per role and step.
2. An `improve` formula analyses one weak spot and proposes a change to *next*.
3. *next* runs the hold-out benchmark: a fixed set of about 20 work items it never sees in development.
4. Promotion requires no regression on pass rate, attempts, requests per item and human rejection rate, plus your approval.
5. One kind of change per cycle, so a regression has one cause.

## Security, compliance and policy

Agents are treated as untrusted workers with least privilege; trust comes from isolation, verification and the audit trail.

- **Isolation.** One git worktree per item; agents write only there. Merges happen only through the refinery.
- **Credentials.** The engine holds no model keys; agents use their own approved logins. No agent receives push, deploy or production credentials.
- **Prompt injection.** Artifact and document content is passed as data references, never merged into role prompts. Agents cannot reach approval or pack-editing tools, so injected instructions cannot pass a gate.
- **Policy as code (v2, paid).** Rules such as "payment repos require two human approvals" or "no agent may touch `/infra`", evaluated before dispatch and before merge.
- **Audit.** Every transition, prompt envelope, tool call, permission decision and gate decision is in `events`, exportable as JSONL for compliance review.
- **Data residency.** Runs locally or on customer infrastructure by default; nothing leaves except what the approved agent itself sends to its model provider.
- **Company policy.** Confirm that automated, unattended use of the corporate Kiro or Claude account is permitted before scaling past a few workers.

## Deployment topologies

The same kernel scales from one laptop to a team server by swapping storage and the worker host, not the code.

| Topology | Ledger | Workers | Interface | When |
| --- | --- | --- | --- | --- |
| Solo (v0) | SQLite file | Local ACP processes, 2–4 concurrent | CLI + Kiro Mayor chat | Proving the model |
| Team server (v1) | Postgres | Worker hosts claim over the DB with leases | CLI + web dashboard | 2–20 engineers |
| Enterprise (v2+) | Postgres, HA | Containerised workers per workspace, quota-aware pools | Dashboard, SSO, approvals inbox | Business units |

**Scaling path.** If waits, retries or cross-host durability outgrow the kernel's dispatcher, move orchestration to a durable workflow engine such as Temporal behind the same runtime interface; packs, roles and formulas do not change.

## Observability and metrics

All metrics derive from the `events` table, so they are reproducible and auditable.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Throughput | Items closed per day, by pack and role | Capacity of the factory |
| First-pass yield | Items passing verifiers on attempt 1 | Quality of role prompts and knowledge |
| Human rejection rate | Gate rejections / gate decisions | Whether agents understand intent |
| Lead time | Requirement created to merged | The headline customer outcome |
| Requests per merged item | Agent requests / merged items | Quota and cost proxy |
| Escalation rate | Items exceeding `max_attempts` | Where the process breaks |
| Stale rework | Items re-run due to upstream change | Cost of late requirement changes |

v0 exposes these through `foundry stats`; v1 adds a dashboard and OpenTelemetry export.

## Open-core split

Everything one engineer needs is free and open source; everything an organization needs to govern many factories is paid.

| Open source (MIT) | Paid control plane |
| --- | --- |
| Kernel: ledger, formulas, dispatcher, gates, patrol, refinery | SSO, RBAC, multi-team workspaces |
| ACP, subprocess and script runtimes | Policy engine and approval routing |
| `foundry mcp` with role scoping | Audit export, retention, compliance reports |
| CLI and Mayor chat | Hosted dashboard and approvals inbox |
| Reference packs: `sdlc-bdd`, `change-request` | Private pack registry, certified domain packs |
| Benchmarks format and runner | Fleet metrics, quota pooling across agent accounts |

Pricing hypothesis: per factory or business unit, roughly $50k–250k per year, not per seat.

## Roadmap

Phase 0 is the only phase that matters now: the kernel must build its own next version before anything is released.

&#91;embedded content: roadmap · 4 phases, 3 gates\]

Phases are not drawn to scale. The Build plan tab breaks Prove it and Open core into six engineering phases, each closed by an exit test.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Agent vendors (AWS, GitHub, Anthropic) ship their own factory layer | Core differentiation shrinks | Stay vendor-neutral; sell governance and audit across agents |
| Agents fail many structured tasks | Low yield, user distrust | Verifier ladder, small steps, human gates on judgment phases |
| Quota limits on approved agents | Throughput ceiling | Quota-aware dispatch, pause on limit, multiple runtimes per role |
| Formula language creep | Kernel becomes an unmaintainable DSL | Declarative-only rule; script steps for logic |
| Business work lacks executable verifiers | Errors slip through | Schemas, rule checks, reviewer roles, mandatory human final gate |
| Long enterprise sales cycles | Slow revenue | Open-source bottom-up adoption before procurement |

**Open questions**

- [ ] Does Kiro ACP handle two or more parallel sessions on one corporate account without throttling?
- [ ] Does `kiro-cli acp --agent <name>` load custom profiles with their MCP servers and resources?
- [ ] Is automated, unattended Kiro use within company policy?
- [ ] Is Foundry built on personal time and equipment, so the IP is clearly yours?
- [ ] Which business pack comes first after `sdlc-bdd`?
