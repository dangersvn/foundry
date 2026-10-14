# Foundry v0 build plan

Each step ends with a commit; "verify" is how I know the step works.

1. **ACP spike** against kiro-cli and claude-agent-acp.
   Verify: `docs/acp-spike/*.jsonl` show hello.txt created by both agents. Done.
2. **Scaffold**: package.json scripts, tsconfig, vitest, cucumber config,
   folder layout.
   Verify: `npm test`, `npm run features` (pending steps), `npm run build` all run.
3. **Schemas** (zod): `foundry.toml` config, formula TOML, agent events (the
   one boundary between agent output and the kernel).
   Verify: unit tests for valid and invalid config and formulas.
4. **Ledger**: Kysely + better-sqlite3, migrations, `runs`, `items`,
   `events`, `artifacts`; kernel functions that change status and write the
   event in one `BEGIN IMMEDIATE` transaction; atomic claim, lease renewal,
   recovery of expired leases.
   Verify: unit tests, including two claimers racing for one item.
5. **Fake ACP agent** built from the spike transcripts (kiro and claude
   styles, plan-driven writes, `fake-success` mode, delay, escape attempts).
   Verify: unit test drives it over the SDK and checks the message order.
6. **Permission policy**: classify requests (kind from the earlier tool_call),
   allow paths inside the worktree, deny outside and deny `git push`.
   Verify: unit tests built from requests recorded in the spike.
7. **ACP runtime**: spawn the agent, initialize, session/new, prompt, stream
   updates as validated events, answer permissions via the policy, keep a
   raw transcript file, kill the process group at the end.
   Verify: unit test with the fake agent in the escape mode.
8. **Git, verifier, merge**: worktree per attempt, squash to one commit,
   rebase onto main, run the verify command, fast-forward main, idempotent
   merge marker (`Foundry-Item:` trailer).
   Verify: unit tests on a temp repo.
9. **Dispatcher + CLI**: `foundry run`, `foundry work`, `foundry status`,
   `foundry log`; errors with layer and next command.
   Verify: cucumber scenarios in `run_item.feature` and `ledger.feature`.
10. **Packaging and docs**: build `dist/`, bin `foundry`, README quickstart
    with `examples/sample-app`, the shipped formula.
    Verify: `npm run build`, `npm pack`, install the tarball in a temp prefix
    and run the quickstart against the fake agent.
11. **Real agents**: `npm run features:real` once per agent, record
    `docs/baseline.md`.
    Verify: both scenario rows pass.
