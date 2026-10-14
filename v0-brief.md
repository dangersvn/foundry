# Foundry v0 brief

## Goal

The first shareable version of Foundry: one work item goes from request to a
merged commit through a real agent (Kiro or Claude Code), is checked by the
engine, and survives a crash. A teammate can install it and run it from the
README.

This is Phase 0 of `docs/build-plan.md`, plus what a teammate needs to try it.

## Build

- **Ledger:** SQLite tables for runs, items, events and artifacts. Every status
  change writes an event in the same transaction.
- **CLI:** `foundry run <formula> --input <text>`, `foundry status [item]`,
  `foundry log <item>`.
- **Formula:** a one-step formula format (TOML) with a step, a goal and a
  verify command. Ship one example: "add a health endpoint with a test".
- **Agents:** an agent-neutral ACP runtime, one session per item. Agents are
  configured in `foundry.toml`:

  ```toml
  [agents.kiro]
  command = ["kiro-cli", "acp"]

  [agents.claude]
  command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]

  [dispatch]
  prefer = ["kiro", "claude"]
  ```

  A team with only one agent lists only that one.
- **Isolation:** a git worktree per item. The permission policy answers the
  agent's permission requests: allow inside the worktree, deny outside it and
  deny `git push`. Log every decision as an event.
- **Leases:** an item is claimed atomically with a lease that is renewed while
  the agent runs. On restart, items with expired leases go back to ready.
- **Verifier:** when the agent's turn ends, the engine runs the formula's
  verify command in the worktree. Only a pass lets the item merge.
- **Merge:** the engine merges the worktree branch into main locally. One item
  produces exactly one commit on main.
- **Audit:** every step is an event: claimed, agent started, each tool call,
  each permission decision, verified, merged or failed.
- **Errors:** each names the failing layer and the next command to run.
- **Packaging:** an npm package with a `foundry` command (Node 22 or later),
  and a `README.md` with install steps and a 5-minute quickstart.

## Not in v0

Multi-step formulas, roles, questions, gates, autopilot, MCP, AI-DLC import,
integrations (Jira, Bitbucket, Jenkins, Confluence), evals, a dashboard,
Postgres. Note ideas for these in `docs/later.md`.

## Done when

- Every scenario in `features/` passes. Fake-agent scenarios run on every
  commit; `@real-agent` scenarios pass when run by hand with Kiro and with
  Claude Code.
- A teammate follows the README from install to a first successful run in
  under 10 minutes.

## Record in docs/baseline.md

After the real-agent runs, record for each agent:

- Time per item, from `foundry run` to the merged commit.
- Number of agent requests per item.
- Anything that failed or needed a retry, and why.
