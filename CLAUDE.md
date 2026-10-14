# Foundry

Foundry is an agent factory: a model-free TypeScript engine that turns work
items into verified, merged results by dispatching them to approved coding
agents (Kiro and Claude Code) over ACP. The engine supplies workflow, state,
checks and audit; the agents supply the thinking.

## Current build

Build brief: @docs/v0-brief.md
Acceptance contract: `features/*.feature`. Never edit these files.

Reference, read when you need detail (they describe the destination, not this
build): `docs/foundry-spec.md`, `docs/build-plan.md`,
`docs/abstraction-design.md`. `docs/acp-spike/` records how the real agents
speak ACP (you create it in the first step); trust it over the ACP docs where
they differ, and build the fake agent to match it.

## Stack

- TypeScript (strict) on Node 22 LTS or later, compiled with `tsc`; `tsx` for
  running TypeScript directly during development.
- Ship as an npm package with a `foundry` command (`npm i -g` or `npx`).
- SQLite through Kysely with `better-sqlite3`, so the same queries can later
  run on Postgres. If the native install is blocked on a corporate machine,
  switch to Node's built-in `node:sqlite` and log the decision.
- zod for every schema: one definition gives the type, the runtime check and
  the JSON Schema.
- The official ACP TypeScript SDK for talking to agents.
- Vitest for unit tests; Cucumber (`@cucumber/cucumber`) for `features/`.

## Architecture rules

These hold in every phase. Do not trade them for speed.

1. **No LLM calls in the kernel.** All thinking happens inside agent processes.
   Kernel code is deterministic and tested without agents.
2. **The ledger is the only source of truth.** Kill every process, restart, and
   nothing is lost. No state lives only in memory or in an agent session.
3. **Every state change writes an event in the same transaction.** Status
   changes only through kernel functions that do both.
4. **Agents are never trusted to say "done".** An item is done only when the
   engine's verifier passes. Agent output crosses into the kernel only through
   one schema-validated boundary.
5. **Agents work in isolation.** One git worktree per item; the permission
   policy allows writes inside that worktree only and denies `git push` and
   anything outside it. Only the engine merges.
6. **Agents are interchangeable.** Kiro and Claude Code are both configured in
   `foundry.toml`; nothing in the kernel names a specific agent.
7. **Errors teach.** Every error names the layer that failed (ledger, runtime,
   agent, verifier, git) and the next command to run. No raw stack traces for
   users.

## Layout

```
src/kernel/      ledger, dispatcher, leases, verifier, merge
src/runtime/     ACP runtime (agent-neutral) and the permission policy
src/schemas/     zod schemas
src/cli/         the foundry command
test/            unit tests and the fake ACP agent
features/        acceptance scenarios (read-only) and their step definitions
docs/            reference docs plus the logs listed below
```

Adjust the layout if the code argues for it, and log why in
`docs/decisions.md`.

## Commands

Keep these working at all times:

- `npm test`: unit tests, no real agents.
- `npm run features`: every scenario except `@real-agent`.
- `npm run features:real`: `@real-agent` scenarios; run by hand, needs Kiro
  or Claude Code signed in and uses quota.
- `npm run build`: compiles to `dist/` with the `foundry` command ready.

## How to work

- **Decide yourself; don't stop to ask.** Pick the simplest option that passes
  the features, preferring the reversible one. Log every decision in
  `docs/decisions.md`: what, the options, the choice, the reason. Mark guesses
  as assumptions. This log is how choices are surfaced instead of made
  silently.
- **Stop only for blockers outside the repo** (missing credentials, a tool that
  won't install). Record them in `docs/blocked.md` and continue with anything
  not blocked.
- **Stay in the current phase.** Ideas for later phases go in `docs/later.md`,
  not into code.
- **Test first.** Write the failing test or step definition, then the code.
- **Commit after each working step** with a message that says what changed and
  why.
- **Tests never call a real agent.** Use the fake ACP agent, which must support
  a mode that reports success without fixing anything.
- **No secrets in the repo.** Credentials come from the agents' own sign-ins
  or environment variables.

## Files you maintain

- `docs/decisions.md`: every decision, with assumptions marked.
- `docs/blocked.md`: blockers outside the repo.
- `docs/later.md`: ideas for later phases.
- `docs/baseline.md`: numbers the brief asks you to record.
- `README.md`: install and quickstart for teammates.

## Don't

- Edit `features/*.feature` or the reference docs.
- Add features, flags or abstractions the brief doesn't call for.
- Add an LLM API client or SDK to the kernel.
- Let an agent's claim of success close an item.
