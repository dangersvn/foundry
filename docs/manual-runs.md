# Manual runs: AI-DLC through Foundry (Phase 1c)

This runbook covers the two `@manual` scenarios in
`features/p1_aidlc_runs.feature`: a **bugfix** run and a **feature** run of
the imported AI-DLC pack, with a real agent and you answering every question
and gate. Plan on about 30–60 minutes for the bugfix run and 2–4 hours for
the feature run, most of it reading at gates.

You drive everything with `foundry` commands. Foundry never decides for you:
an item waits until you answer its question or approve its gate.

## 0. Before you start (once)

1. Build and install Foundry from this checkout:

   ```sh
   cd ~/workspaces/foundry
   npm ci && npm run build && npm install -g .
   foundry help        # lists plan, answer, approve, reject, why
   ```

2. Check the imported pack is there and valid (it is committed; to
   regenerate it, `foundry import aidlc` with AI-DLC v2.11.0 in
   `vendor/aidlc-workflows/`):

   ```sh
   foundry validate packs/aidlc     # aidlc 2.11.0: valid (30 steps, 14 roles)
   ```

3. Check your agent is signed in: `kiro-cli whoami`, or start `claude` once.

4. Keep two terminals open in the run's repo: one where you type commands,
   one showing progress:

   ```sh
   watch -n 5 foundry status RUN-1
   ```

## 1. Bugfix run

**Scenario:** a sample repo with a known bug and a failing test that shows
it; you start an AI-DLC bugfix run and answer every question and gate; the
run completes with the fix merged and every test passing.

### Setup

```sh
cp -r ~/workspaces/foundry/examples/bugfix-app ~/aidlc-bugfix
cd ~/aidlc-bugfix
git init -b main && git add -A && git commit -m "bugfix app with a failing test"
npm test            # 1 failing test: GET /sum adds two numbers ({"sum":"12"})
```

Create `foundry.toml` (pick one agent block):

```toml
[agents.kiro]
command = ["kiro-cli", "acp"]
render = "kiro"

# [agents.claude]
# command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
# render = "claude"

[project]
test_command = "npm test"     # the refinery runs it on every code merge

[workers]
count = 1                     # one agent at a time is easier to follow
```

Leave `foundry.toml` untracked or commit it; either works.

### Look at the plan first

```sh
foundry plan ~/workspaces/foundry/packs/aidlc --profile bugfix --dry-run
```

Expect: run setup `project_type=brownfield`, `depth=Minimal`, settings with
collaborators off, reviews advisory and plan approval on, `merge verify:
npm test`, and **6 stage steps**:

| # | Step | Role | Gate | Notes |
| --- | --- | --- | --- | --- |
| 1 | reverse-engineering | developer | human | conditional; writes codebase knowledge under `aidlc/` or `aidlc-docs/` |
| 2 | requirements-analysis | product | human | advisory review by product-lead |
| 3 | code-generation | developer | human (plan approval) | advisory review by architecture-reviewer; this is where the fix lands |
| 4 | build-and-test | quality | human | |
| 5 | deployment-pipeline | pipeline-deploy | human | conditional; likely skipped (no pipeline in this repo) |
| 6 | deployment-execution | pipeline-deploy | human | conditional; changes an environment, so it only writes a plan |

### Start

```sh
foundry run ~/workspaces/foundry/packs/aidlc --profile bugfix \
  --input "GET /sum?a=1&b=2 returns {\"sum\":\"12\"} instead of {\"sum\":3}; test/sum.test.js shows it"
```

`foundry run` works until the run needs you, then prints what it is waiting
on, for example:

```
WI-1 asks Q-1: Which areas should I analyze? [Whole repo / src only]  ->  foundry answer WI-1 "<answer>"
WI-1 is at its gate  ->  foundry status WI-1, then foundry approve WI-1 or foundry reject WI-1 --comment "..."
```

### The loop (repeat until the run is done)

1. **Question?** Read it in `foundry status WI-n` (options are listed; any
   other text is allowed unless it says otherwise) and answer:

   ```sh
   foundry answer WI-n "your answer"
   foundry work                  # the agent resumes with your answer in its history
   ```

2. **Gate?** Read what the step did:

   ```sh
   foundry status WI-n           # result, outputs, artifacts, decisions, advisory review and check findings
   git -C .foundry/worktrees/WI-n-a1 show --stat HEAD     # the files it changed (use the attempt shown)
   ```

   Then approve or send it back with what to change:

   ```sh
   foundry approve WI-n
   foundry reject WI-n --comment "the fix must also handle missing a or b"
   foundry work                  # merges approved work, starts the next step or the retry
   ```

3. **Failed?** `foundry status WI-n` shows the failing layer and output.
   `foundry log WI-n` shows every step; the agent's task is in
   `.foundry/envelopes/WI-n-aN.md` and its full session in
   `.foundry/transcripts/WI-n-aN.jsonl`.

### What to expect at each step

- **reverse-engineering:** may ask what to scan. At the gate, expect
  codebase knowledge documents (architecture, code structure, technology
  stack…) under the record folder `aidlc-docs/RUN-1/` (or AI-DLC's
  `aidlc/spaces/default/codekb/`). Approve if they describe this small app
  correctly. It may also submit **skipped** if it judges the scan
  unnecessary; that is fine and recorded as a decision.
- **requirements-analysis:** expect questions about what "fixed" means
  (e.g. invalid numbers, missing parameters). Answer briefly. At the gate,
  check `requirements.md` and the product-lead's advisory findings.
- **code-generation:** this is the **plan approval** gate. The agent may ask
  you to approve its plan with `foundry ask` first (answer
  "Approve Plan" or say what to change), then it writes the fix and a test.
  At the gate, check the diff: `src/app.js` should convert `a` and `b` to
  numbers; `npm test` must pass in the worktree. When you approve, the
  refinery rebases, runs `npm test`, and only then merges.
- **build-and-test:** writes build and test instructions/results. Docs-only
  changes merge without re-running the suite.
- **deployment-pipeline / deployment-execution:** expect **skipped** (no CI
  or environment here). If deployment-execution runs, it must not deploy:
  its artifact is a plan for you to carry out; approving it does not run it.

### Done when

```sh
foundry status RUN-1     # [done], every step done or skipped
git log --oneline        # one commit per item that changed files, each with Foundry-Item: WI-n
npm test                 # all tests pass on main, including GET /sum adds two numbers
```

## 2. Feature run

**Scenario:** a sample repo; you start an AI-DLC feature run for a small
feature and answer every question and gate; the run completes with the
feature merged and its scenarios passing, and `foundry why` traces a changed
line to its stage, decisions and your answers.

### Setup

```sh
cp -r ~/workspaces/foundry/examples/sample-app ~/aidlc-feature
cd ~/aidlc-feature
git init -b main && git add -A && git commit -m "sample app"
npm test            # 2 passing tests
```

Use the same `foundry.toml` as the bugfix run. You may set
`[workers] count = 3`: independent steps (for example reverse-engineering
and the ideation steps) then run at the same time in separate worktrees.

```sh
foundry plan ~/workspaces/foundry/packs/aidlc --profile feature --dry-run   # 30 stage steps
foundry run ~/workspaces/foundry/packs/aidlc --profile feature \
  --input "Add GET /health that returns 200 with {\"status\":\"ok\"} and a test for it"
```

### What to expect

The plan runs the whole lifecycle in this order: ideation (intent-capture,
market-research, feasibility, scope-definition, team-formation,
rough-mockups, approval-handoff), inception (reverse-engineering,
practices-discovery, requirements-analysis, user-stories, refined-mockups,
domain-design, contract-design, units-generation, delivery-planning),
construction (per unit: functional-design, nfr-requirements, nfr-design,
infrastructure-design, code-generation; then build-and-test, ci-pipeline),
and operation (deployment-pipeline, environment-provisioning,
deployment-execution, observability-setup, performance-validation,
incident-response, feedback-optimization).

- For a feature this small, **expect many conditional steps to be
  skipped** with a reason (market research, team formation, mockups,
  infrastructure, environment provisioning and most operation steps).
  Skipped steps do not stop at a gate. Their outputs are absent by design
  for later steps; that is not an error.
- **Every step that runs stops at a gate.** Expect roughly 10–15 gates and
  a handful of questions, mostly in intent-capture, requirements-analysis
  and units-generation.
- **units-generation:** at its gate, `foundry status WI-n` must show
  `output: unit-of-work = [...]` (one name per unit; for this feature
  probably one). If it is missing, reject with
  `--comment "list the units in outputs.unit-of-work"`; without it the
  per-unit construction steps are skipped.
- **code-generation** (once per unit): plan approval, then the code. The
  refinery runs `npm test` before merging.
- **Environment-changing steps** (environment-provisioning,
  deployment-execution) only produce plans. Do not carry them out for this
  sample.

### Done when

```sh
foundry status RUN-1     # [done]
npm test                 # passes on main, including the new /health test
```

Then trace a changed line:

```sh
grep -n health src/*.js                  # pick a line the run added
foundry why src/app.js:<line>
```

Expect the commit, the item and its step (code-generation, with its unit),
the run and your request, the step's inputs, and the decisions behind it:
the agent's own, the upstream steps' (your answers to questions appear as
decisions with you as the actor, e.g. `person:<your git user.name>`), and
gate approvals.

## 3. What to record in docs/baseline.md

For each run, `foundry status RUN-1` prints a metrics line:

```
metrics: 4 questions, 6 gates (6 approved, 0 rejected), 8 agent sessions, 41 tool calls, 17 permission requests, 0 retries, 37.5 min
```

Record per profile (bugfix, feature):

| What | Where |
| --- | --- |
| Questions | metrics line |
| Gates (approved / rejected) | metrics line |
| Agent sessions (incl. reviews) | metrics line |
| Total time | metrics line (run start to done; includes your reading time) |
| Agent requests | tool calls + permission requests from the metrics line; for Kiro also credits: `cat .foundry/transcripts/*.jsonl \| grep -o '"meteringUsage":\[[^]]*\]' \| grep -o '"value":[0-9.]*' \| cut -d: -f2 \| paste -sd+ \| bc`; for Claude the cost in the last `usage_update` of each transcript |
| Retries and why | `foundry decisions RUN-1` (control decisions) and `foundry log WI-n` |
| Anything you had to fix by hand | your notes |

Also note the agent and its version (`foundry log WI-1` shows it at
`agent_started`).

## 4. If something goes wrong

| You see | Do |
| --- | --- |
| `error [ACP runtime]: could not start agent` | fix `foundry.toml` or sign in, then `foundry work` (the item kept its place) |
| An item `failed` | `foundry status WI-n` for the layer and output; the run stops at that step. Note it in the baseline; to retry, start a new run |
| `waiting for input` but you answered | each question needs its own answer: `foundry answer WI-n --question Q-2 "..."` |
| An agent asked for approval with `foundry ask` instead of submitting | answer "Approve" (or say what to change); the item comes back and then stops at its gate as usual |
| A session runs very long | `foundry status WI-n` shows its lease; `foundry log WI-n` its latest tool calls; Ctrl-C and `foundry work` resumes it as a new attempt |
| The merge queue sends an item back (`sent back by the merge queue`) | it conflicted with main or `npm test` failed on top of main; the next attempt gets the error in its history |
