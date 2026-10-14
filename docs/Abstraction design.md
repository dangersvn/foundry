# Abstraction design

Every Foundry abstraction is a glass box: it hides the common case, names how it leaks, and offers a documented way down to the layer beneath.

Joel Spolsky's law says all non-trivial abstractions leak, and abstractions save time working but not time learning. Foundry stacks several leaky layers (agents, models, quotas, git, processes), so the design goal is not to stop leaks but to make every leak visible, explainable and recoverable.

## Lessons from Joel Spolsky

Nine of Joel's essays map directly onto decisions Foundry has to get right; the leaky-abstractions law is the root, the others say what to do about it.

| Essay | Lesson | What Foundry does |
| --- | --- | --- |
| The Law of Leaky Abstractions (2002) | Every non-trivial abstraction leaks; when it does you must understand the layer below | Every layer is inspectable and has a documented way down (leak register) |
| Don't Let Architecture Astronauts Scare You (2001) | Abstractions too general to mean anything solve no real problem | Build three concrete packs before generalizing any primitive |
| Things You Should Never Do, Part I (2000) | Rewriting from scratch throws away years of bug fixes | Small stable kernel, versioned packs and migrations; evolve, never rewrite |
| Making Wrong Code Look Wrong (2005) | Conventions should make mistakes visible on sight | Unverified output has a different type, status and ID marker than verified output |
| Martian Headsets (2008) | Standards are implemented differently by every vendor | Runtimes declare capabilities; contract tests per agent and version, no assumed uniformity |
| Back to Basics (2001) | Hidden low-level costs (Shlemiel the painter) make high-level code slow | Every abstraction reports its cost: requests, minutes, items spawned |
| Five Worlds (2002) | Rules that fit one kind of software are wrong for another | Autonomy level and gates set per pack, repo and path, not globally |
| The Iceberg Secret, Revealed (2002) | People judge progress by what they can see | Board, trace and run summaries make invisible agent work visible |
| Strategy Letter V (2002) | Commoditize your complements | ACP makes agents interchangeable; Foundry owns the process, audit and packs |

The common thread: hide complexity for the common case, never hide it from the person who has to debug.

## The abstraction stack

Foundry has two kinds of layers, and the most important design decision is the single, narrow boundary between them.

&#91;embedded content: abstraction stack · deterministic kernel, one boundary, agents below\]

Everything above the boundary is ordinary software that can be unit tested; everything below it is an agent we observe but never trust, and its output becomes kernel data only after the schema check and verifiers pass.

## Leak register

Each layer is listed with the leaks we already expect and the command that takes you one level down; a new leak found in production gets a row here.

| Layer | What it hides | How it leaks | Way down |
| --- | --- | --- | --- |
| Pack / factory | Domain process as configuration | Domains without executable verifiers; generic packs that fit nobody | `foundry catalog`, read the pack files in git |
| Formula | Orchestration and fan-out | Fan-out explosion (`per` over combinations), dependency deadlock, hidden cost | `foundry plan --dry-run` shows the compiled item graph, item count and estimated requests |
| Role | Prompt engineering and agent setup | Prompt works on one agent or model but not another; knowledge exceeds context | `foundry pack build --show <role>` prints the exact rendered profile and prompt |
| Verifier | Quality judgment | Tests that pass wrong code; lenient reviewer agents; checks agents learn to game | Verifier output attached to every item; hold-out scenarios; `foundry verify WI-n --explain` |
| Work item + ledger | Concurrency and crash recovery | Slow agent loses its lease and work runs twice; external side effects repeated | `foundry why WI-n` replays the event history; idempotency keys on side effects |
| ACP runtime | Agent process and protocol | Hangs, quota limits, permission stalls, agent version changes behavior, non-determinism | `foundry attach WI-n` streams the live session; `foundry session replay` shows the full transcript |
| Agent and model | Reasoning | Plausible wrong answers, ignored instructions, silent model upgrades | Transcript plus prompt envelope in `events`; rerun the same item on another runtime |
| Substrate | Git, filesystem, processes, network, quotas | Merge conflicts, disk, credentials, rate limits | Plain git worktree on disk; `foundry doctor` checks each dependency |

**Rule:** every error message names the layer that leaked and the command for the layer below, for example `ACP runtime: session idle 300s with pending permission request; run foundry attach WI-42`.

## Design rules

Twelve rules apply to every abstraction in the kernel, the runtimes and the packs; a design that breaks one needs a written reason.

1. **Glass box.** Every abstraction can show what it is doing in terms of the layer below: the compiled graph, the rendered prompt, the transcript, the SQL row.
2. **One documented way down.** Every layer has an escape hatch: `script` steps, `foundry attach`, a raw runtime command override, an audited manual status change.
3. **Compile, then run.** Formulas compile into a concrete item graph stored in the ledger before anything runs. What runs is exactly what the dry-run showed.
4. **Concrete first, then abstract.** A primitive is generalized only after three real packs need it (the rule of three). No speculative keywords.
5. **Honest capabilities.** Runtimes declare what they support (cancel, parallel sessions, MCP, permission requests, resume). The kernel adapts to declared capabilities and never pretends two runtimes are the same.
6. **Determinism boundary.** Everything inside the kernel is deterministic and tested without agents. Non-determinism enters only through a runtime and leaves only through a schema-validated `submit_result`.
7. **Wrong looks wrong.** Agent output starts as `unverified` and only verifiers can promote it. Unverified artifacts carry a distinct status, path and marker, so no one consumes them by accident.
8. **Costs are visible.** Every step, item and run reports requests, minutes and items spawned; dry-run estimates them before you start.
9. **Side effects at the edge, once.** External actions (open PR, comment on ticket, publish doc) go through an outbox with idempotency keys, so retries never repeat them.
10. **Version everything that persists.** Runs pin the formula and pack versions they started with; ledger schema changes ship with migrations; plugin interfaces carry a version.
11. **Errors teach.** Messages name the layer, the cause, and the next command to run. People do not read manuals; errors are the manual.
12. **Small, boring kernel.** New behavior goes into packs or plugins. A kernel change needs a reason no pack or plugin can satisfy.

## Proven patterns

Foundry invents no new infrastructure patterns; each concern uses one that has decades of production use behind it.

| Pattern | Where Foundry uses it | Why |
| --- | --- | --- |
| Ports and adapters (hexagonal) | Runtimes, stores, trackers, publishers, verifiers behind interfaces | Swap Kiro for Claude, SQLite for Postgres, Jira for Bitbucket without touching the kernel |
| Event log plus projections | `events` is append-only; item status and dashboards are projections | Full audit, replay, and rebuildable views |
| Reconciliation loop | Patrol compares desired state (ledger) with actual state (processes, leases) and corrects it | Same model as Kubernetes controllers; converges after any crash |
| Lease-based work queue | Atomic claim, timed lease, renewal, expiry | Exactly one active worker per item without a central lock server |
| Idempotent consumer | Every step keyed by item and attempt | Retries and duplicate deliveries are harmless |
| Transactional outbox | PRs, ticket comments, publishes written to an outbox in the same transaction, sent by a relay | External effects happen once, even across crashes |
| Saga with compensation | Multi-system steps (branch, PR, ticket) record undo actions | Partial failure can be rolled back or completed cleanly |
| Bulkhead and rate limiting | Concurrency caps per runtime account and per workspace | One quota limit or noisy run cannot starve the rest |
| Circuit breaker | Repeated runtime failures pause dispatch to that runtime | Stops burning quota against a broken agent |
| Contract tests | Each runtime adapter tested against a recorded ACP session suite per agent version | Detects when a vendor update changes behavior |
| Schema-first configuration | Formulas, roles, packs validated against published JSON Schemas | Mistakes fail at `validate`, not mid-run |
| Strangler fig | New kernel features run beside the old path behind flags until proven | Evolution without rewrites |

## Ports and contracts

Eight versioned interfaces are the only way anything plugs into the kernel: three core ports and five integration ports, each small enough to implement in an afternoon.

```typescript
// ---- core ports ----
export interface Runtime {                    // port version 1
  readonly name: string;
  capabilities(): Capabilities;               // cancel, parallel, mcp, permissions, resume
  run(item: ItemEnvelope, role: RoleSpec, ctx: RunContext): Promise<RunResult>; // settles on submit, fail or cancel
  cancel(runId: string): Promise<void>;
}

export interface Verifier {
  readonly name: string;
  check(artifact: UnverifiedArtifact, ctx: VerifyContext): Promise<Verdict>;
}

export interface Store {                      // SQLite now, Postgres later
  claimNext(role: string, worker: string, leaseSeconds: number): Promise<Item | null>;
  transition(itemId: string, to: Status, event: Event): Promise<void>;
  appendEvent(event: Event): Promise<void>;
}

// ---- integration ports (v1 adapters: Jira, Bitbucket, Jenkins, Confluence) ----
export interface Adapter {                    // shared by every integration port
  readonly vendor: string;                    // "jira", "bitbucket", ...
  readonly edition: "cloud" | "datacenter";
  capabilities(): Set<string>;                // checked at foundry validate
}

export interface WorkTracker extends Adapter {
  poll(): Promise<WorkRequest[]>;             // label or JQL intake
  get(key: string): Promise<WorkRequest>;
  setStatus(key: string, state: FoundryState, idem: string): Promise<void>;
  comment(key: string, body: string, idem: string): Promise<void>;
  link(key: string, url: string, title: string, idem: string): Promise<void>;
}

export interface CodeHost extends Adapter {
  createBranch(repo: string, name: string, base: string): Promise<void>;
  openChange(req: ChangeRequestSpec, idem: string): Promise<ChangeRequest>;
  getChange(ref: string): Promise<ChangeRequest>;  // reviews, comments, build statuses
  merge(ref: string, strategy: string, idem: string): Promise<MergeResult>;
}

export interface CI extends Adapter {
  trigger(job: string, params: Record<string, string>, idem: string): Promise<PipelineRun>;
  getRun(ref: string): Promise<PipelineRun>;
  logExcerpt(ref: string, maxLines?: number): Promise<string>;
}

export interface DocsStore extends Adapter {
  getPage(ref: string): Promise<Document>;
  publish(doc: DocumentSpec, idem: string): Promise<Document>;  // new version, never overwrite human edits
}

export interface Notifier extends Adapter {
  notify(to: string[], message: string, link: string, idem: string): Promise<void>;
}
```

The shared model stays minimal: `WorkRequest`, `ChangeRequest`, `PipelineRun` and `Document` carry only fields every vendor has, plus a `vendor` map for the rest, and every type here is defined once as a zod schema that yields the TypeScript type, the runtime check and the JSON Schema. Every write takes an idempotency key (`idem`) and is called only from the outbox relay.

**Contract rules**

- Every port has a conformance test suite in the kernel; an adapter ships only when it passes.
- `ItemEnvelope` and `RunResult` are plain data (JSON-serializable), so runtimes in any language can be wrapped as a subprocess.
- Breaking a port means a new version beside the old one, with at least one release of overlap.

## What we refuse to abstract

Some things stay exposed on purpose, because hiding them would create the worst leaks.

- **Git.** Worktrees, branches and commits stay plain git. Anyone can `cd` into a worktree and use normal tools.
- **The agent itself.** Foundry does not wrap agents in a fake universal interface; roles name a real agent and its capabilities are declared.
- **Agent output quality.** No "confidence" number pretends an agent is right. Only verifier results and human decisions count.
- **Cost.** Requests and time are always shown, never folded into a vague "effort" score.
- **Human judgment.** Gates are explicit and named; nothing silently auto-approves unless a policy for that path says so.
- **The ledger.** It is a normal SQL database with a documented schema. Read it with any SQL tool; no hidden state lives anywhere else.
- **Business logic in formulas.** Conditions and loops go to `script` steps, so the formula language never becomes a second programming language.

## Review checklist for a new abstraction

Any new keyword, primitive, port or pack-level concept passes this checklist in its design review.

- [ ] At least three concrete uses exist today, not imagined ones.
- [ ] Its leaks are listed and added to the leak register.
- [ ] It has a way down: a command or file that shows the layer beneath.
- [ ] It shows its cost (requests, minutes, items) before and after running.
- [ ] Its persisted data is versioned and has a migration path.
- [ ] Failure messages name the layer, the cause and the next command.
- [ ] It is testable without a real agent (fake runtime or recorded session).
- [ ] It does not move non-deterministic behavior into the kernel.
- [ ] Unverified output cannot be mistaken for verified output.
- [ ] Removing it later would not require a rewrite.
