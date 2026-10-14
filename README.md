# Foundry

Foundry turns a work item into a verified, merged commit. It hands the work
to a coding agent you already use (Kiro or Claude Code) over ACP, keeps the
agent inside its own git worktree, runs your tests itself, and merges into
`main` only when they pass. Everything is recorded in a local SQLite ledger,
so you can kill Foundry at any point and resume.

This is v0: one-step formulas; `foundry work --workers N` or `foundry factory` run several items at once.

## Install

You need Node 22 or later, git, and at least one agent signed in:

- **Kiro:** `kiro-cli` installed and signed in (`kiro-cli whoami`).
- **Claude Code:** Claude Code signed in (`claude` works). Foundry starts it
  through its ACP adapter with `npx -y @agentclientprotocol/claude-agent-acp`,
  so there's nothing else to install.

Install Foundry from a checkout of this repo:

```sh
git clone <this repo> foundry && cd foundry
npm ci
npm run build
npm install -g .        # puts `foundry` on your PATH
foundry help
```

Or build a tarball once and share it: `npm pack` creates
`foundry-factory-0.1.0.tgz`, and teammates run
`npm install -g foundry-factory-0.1.0.tgz`.

## Quickstart (5 minutes)

1. Copy the sample app somewhere and make it a git repo:

   ```sh
   cp -r "$(npm root -g)/foundry-factory/examples/sample-app" ~/foundry-try
   cd ~/foundry-try
   git init -b main && git add -A && git commit -m "sample app"
   npm test                # 2 passing tests
   ```

2. Tell Foundry which agents you have. Create `foundry.toml` in the repo
   root and keep only the agents you have:

   ```toml
   [agents.kiro]
   command = ["kiro-cli", "acp"]

   [agents.claude]
   command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]

   [dispatch]
   prefer = ["kiro", "claude"]   # the first one listed is used
   ```

   Foundry reads it from the repo root, so you can commit it for your team
   (`git add foundry.toml && git commit -m "foundry config"`) or leave it
   untracked.

3. Run the built-in formula:

   ```sh
   foundry run health-endpoint --input "keep it in src/app.js"
   ```

   You see the item get claimed, the agent's tool calls with each
   permission decision, `npm test` run by Foundry, and the merge:

   ```
   WI-1 done: merged 3f2a9c1 into main
   ```

4. Look at what happened:

   ```sh
   git log --oneline -2    # one new commit, with a "Foundry-Item: WI-1" trailer
   foundry status          # every item
   foundry status WI-1     # detail: attempt, worktree, timing, any failure
   foundry log WI-1        # the audit trail: claimed, agent_started, tool_call, verified, merged
   ```

It usually takes one to three minutes, depending on the agent.

## Commands

| Command | What it does |
| --- | --- |
| `foundry run <formula> [--input <text>]` | Creates an item from a formula and works it now. `<formula>` is a built-in name (`health-endpoint`) or a path to a `.toml` file. `--input` adds request details for the agent. |
| `foundry add <formula> --input <text>` | Queues an item without working it. |
| `foundry work [--workers N]` | Works every ready item, N at a time (each in its own worktree), then exits. Run it after a crash or Ctrl-C: items whose lease expired go back to ready and are retried as a new attempt. |
| `foundry factory <formula> [--workers N]` | Live terminal board: main, each worker with its worktree and latest steps, the queue and activity. Each line you type at the `factory ›` prompt becomes a work item with that formula. `/quit` exits. |
| `foundry status [item]` | Lists items, or shows one in detail, including the verifier output when it failed. |
| `foundry log <item>` | Prints the item's audit log from the ledger. |

Exit code is 0 when the item (or every worked item) is done, 1 otherwise.

## Formulas

A v0 formula has one step: a goal for the agent and a verify command that
Foundry runs in the agent's worktree.

```toml
formula = "health-endpoint"
version = 1
title = "add a health endpoint with a test"

[step]
id = "code"
goal = "Add a GET /health endpoint ... and a test for it."
verify = "npm test"
```

Write your own and run it with `foundry run ./my-formula.toml`.

## How it works

- **Ledger:** `.foundry/foundry.db` (SQLite) in your repo holds runs, items,
  events and artifacts. Every status change writes an event in the same
  transaction. It's plain SQL, so you can read it with `sqlite3`.
- **Isolation:** each attempt gets a git worktree at
  `.foundry/worktrees/WI-n-aN` on branch `foundry/WI-n-aN`. Foundry answers
  the agent's permission requests: writes inside the worktree are allowed;
  writes outside it, `git push` and network fetches are denied. Every
  decision is in `foundry log`. `.foundry/` is added to `.git/info/exclude`,
  so it never shows in `git status`.
- **Verification:** the agent's claim that it's done counts for nothing.
  When its turn ends, Foundry squashes its changes into one commit, rebases
  that onto `main`, and runs the verify command. Only a pass fast-forwards
  `main`.
- **Leases:** a worker holds a lease on its item (120 s, renewed while it
  works). If Foundry dies, `foundry work` waits for the lease to expire and
  retries the item from a fresh worktree (up to 3 attempts). An item already
  merged is never merged twice.
- **Transcripts:** the full ACP traffic for each attempt is in
  `.foundry/transcripts/WI-n-aN.jsonl`.

## When something fails

Every error names the layer that failed and the next command to run:

```
error [ACP runtime]: could not start agent "kiro": command "kiro-cli" was not found
  next: install kiro-cli, or fix [agents.kiro].command in foundry.toml; then run `foundry work`
```

| Layer | Typical cause |
| --- | --- |
| `config` | `foundry.toml` or a formula is missing or invalid |
| `ACP runtime` | the agent command is missing, not signed in, or exits at start (the item stays ready) |
| `agent` | the agent died mid-turn, or ended without changing any file |
| `verifier` | the verify command failed; `foundry status WI-n` shows its output, and the worktree is kept |
| `git` | the change conflicts with `main`, or `main`'s checkout has uncommitted changes in the way |
| `ledger` | the database is unwritable, or another worker took the item over |

## Developing Foundry

```sh
npm test                # unit tests (no real agents)
npm run features        # acceptance scenarios with the fake ACP agent
npm run features:real   # @real-agent scenarios: needs Kiro and Claude Code signed in, uses quota
npm run build           # compile to dist/
```

`features/*.feature` is the acceptance contract. The design docs are in
`docs/`, and how the real agents speak ACP is recorded in `docs/acp-spike/`.
