# Manual runs v2: the Phase 2 proof (2d)

This runbook covers the three `@manual` scenarios in
`features/p2_proof.feature`:

1. a baseline for AI-DLC's Construction steps on the held-out set,
2. one prompt change you make by hand, proven better with `foundry eval`,
3. one AI-DLC bugfix run in autopilot, then a review of its assumptions.

They use real agents and cost quota. Every command that starts agent
sessions prints how many it will start and does nothing without `--yes`, so
you can always check the cost first. Plan on half a day: most of it is agents
working while you wait. Write the numbers into `docs/baseline.md` as you go
(section 5 lists them).

## 0. Before you start (once)

1. Install this checkout and check the pack:

   ```sh
   cd ~/workspaces/foundry
   npm ci && npm run build && npm install -g .
   foundry validate packs/aidlc        # aidlc 2.11.0: valid (30 steps, 14 roles)
   ```

2. Sign in to both agents (`kiro-cli whoami`; start `claude` once). Phase 2
   works with one, but with both configured every judge and autopilot
   resolver runs on the other agent than the one whose work it judges.

3. Use one repository for all the benchmark work, so the cases collect in
   one `benchmarks/` folder. The Phase 1 feature run's repo is the natural
   choice (`~/aidlc-feature`); the Phase 1 bugfix repo (`~/aidlc-bugfix`)
   works the same way. Its `foundry.toml` gets both agents:

   ```toml
   [agents.kiro]
   command = ["kiro-cli", "acp"]
   render = "kiro"

   [agents.claude]
   command = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"]
   render = "claude"

   [project]
   test_command = "npm test"

   [workers]
   count = 1
   ```

   The first agent listed does the work; the other judges and resolves. To
   swap them, add `[dispatch] prefer = ["claude"]`.

## 1. Baseline for the Construction steps (held-out)

**Scenario:** benchmark cases from the Phase 1 runs; eval the current aidlc
pack on the held-out set; record the baseline pass counts per Construction
step.

### 1.1 Collect enough cases

A case is an approved, merged item. The Construction step that tests grade
is **code-generation** (its cases are graded by `npm test` plus the test
files the accepted change added, which the replay never sees). About 30% of
cases land in the held-out set, decided by a hash of the case id, so you
need about **8 or more code-generation cases** to get at least 2 held-out
ones.

List the candidates from the Phase 1 runs:

```sh
cd ~/aidlc-feature
foundry status | grep code-generation       # items with status done
```

Each Phase 1 run gives one code-generation item per unit (usually one). To
get more cases, run a few more small feature runs in this repo, in autopilot
to save your time (section 3 explains autopilot; any run works):

```sh
for f in "Add GET /version returning {\"version\":\"1.0.0\"} and a test" \
         "Add GET /echo?msg=x returning {\"msg\":\"x\"} and a test" \
         "Return 404 with {\"error\":\"not found\"} for unknown paths, with a test" \
         "Add GET /time returning the ISO time and a test that checks its format"; do
  foundry run ~/workspaces/foundry/packs/aidlc --profile feature --mode autopilot --input "$f"
done
```

Freeze each done code-generation item:

```sh
foundry bench add WI-12        # prints the case id and its split (dev or held-out)
foundry bench list             # every case, its split, step and verify command
foundry bench list --set held-out
git add benchmarks && git commit -m "benchmark cases"   # benchmarks/ is yours to commit
```

Expect `benchmarks/<case>/` to hold `case.json` (envelope as data, base
commit, verifier setup, split), `accepted.patch`, `envelope.md` and `tests/`
(the hidden tests). Agents can never change `benchmarks/`: the refinery
rejects any change that touches it.

If `bench add` says the item "has no merged commit", it changed no files or
its lane has not merged yet; pick another item.

### 1.2 Record the baseline

One pack is a baseline run:

```sh
foundry eval ~/workspaces/foundry/packs/aidlc --set held-out --trials 3
#  -> prints: ... N agent sessions ... next: ... --yes      (nothing started yet)
foundry eval ~/workspaces/foundry/packs/aidlc --set held-out --trials 3 --yes
```

Each case is replayed 3 times, each trial in a fresh worktree from the case's
base commit with the role prompt and step instructions of the pack you name.
Expect lines like:

```
code-generation-0b1c2d3e    code-generation    2/3
...
per step:
code-generation             3 cases            5/9
report: .foundry/evals/reports/eval-<time>.json
```

Record the per-step line (passes out of trials) for code-generation, the
number of held-out cases, the agent, and the report path. Also record the
factory numbers for the same step from the real runs:

```sh
foundry stats --by step        # first-pass yield, attempts/item, human rejection rate, ...
```

`foundry replay <case> --trials 3 --yes` re-runs one case on its own when you
want to look at a single failure; every trial's envelope and transcript are
in `.foundry/evals/envelopes/` and `.foundry/evals/transcripts/`, and
`.foundry/evals/evals.db` is a ledger like any other
(`sqlite3 .foundry/evals/evals.db "select type, payload_json from events where type = 'graded'"`).

## 2. A hand-made improvement, proven

**Scenario:** take the weakest Construction step in the baseline, change its
prompt or step instructions, eval the change on the held-out set; the new
version must be better with no case losing passes.

1. **Pick the change.** Look at the failed trials of the weakest step (in
   the baseline: code-generation unless you benched others):

   ```sh
   sqlite3 ~/aidlc-feature/.foundry/evals/evals.db \
     "select item_id, json_extract(payload_json, '$.reason') from events where type = 'graded' and json_extract(payload_json, '$.passed') = 0"
   ```

   Read the failing trials' transcripts. Typical causes: the agent stops
   before running the tests, writes the code in the wrong file, or forgets
   to submit. Make **one** change aimed at the most common cause, so a
   regression has one cause.

2. **Make version b** (a copy; never edit `packs/aidlc` itself, and do not
   run `foundry import aidlc` into the copy):

   ```sh
   cd ~/workspaces/foundry
   cp -r packs/aidlc packs/aidlc-b
   sed -i 's/^version = "2.11.0"/version = "2.11.0-b1"/' packs/aidlc-b/pack.toml
   $EDITOR packs/aidlc-b/steps/code-generation.md      # or roles/aidlc-developer-agent.md
   foundry validate packs/aidlc-b
   ```

   Example of one change: at the end of `steps/code-generation.md`, add
   "Before you submit, run the project's test command in your worktree and
   fix every failure; submit only when it passes."

3. **Iterate on dev, prove on held-out.** The dev set is for trying ideas;
   held-out is the proof, so look at it only once you are done changing:

   ```sh
   cd ~/aidlc-feature
   foundry eval ~/workspaces/foundry/packs/aidlc ~/workspaces/foundry/packs/aidlc-b --set dev --trials 3 --yes
   # change, eval on dev again ... then once:
   foundry eval ~/workspaces/foundry/packs/aidlc ~/workspaces/foundry/packs/aidlc-b --set held-out --trials 3 --yes
   ```

   Expect a table with a and b pass counts per case, the totals and the
   verdict:

   ```
   verdict: b is better (8 passes against 5, and no case lost passes)
   verdict: b is not better (cases that lost passes: code-generation-...)
   ```

   **Done when** the held-out verdict is "b is better". If it is not, the
   change is not proven: record the result anyway (it is a finding), go back
   to dev with a new change, and only then use held-out again.

4. Optional: compare the agents on the same cases, role by role:

   ```sh
   foundry eval ~/workspaces/foundry/packs/aidlc --agents kiro,claude --set held-out --trials 3 --yes
   ```

## 3. A bugfix run in autopilot

**Scenario:** a sample repo with a known bug and a failing test; start an
AI-DLC bugfix run in autopilot; it completes with the fix merged and every
test passing, nobody is asked anything outside locked areas, every answer
and gate decision is in the decision log, and you review the assumptions.

### Setup

```sh
cp -r ~/workspaces/foundry/examples/bugfix-app ~/aidlc-autopilot
cd ~/aidlc-autopilot
git init -b main && git add -A && git commit -m "bugfix app with a failing test"
npm test            # 1 failing test: GET /sum adds two numbers
```

Use the `foundry.toml` from section 0 (both agents) and add a locked path
the fix does not need, so you can see that locks are respected without
blocking the run:

```toml
[autopilot]
locked_paths = ["src/server.js"]
```

### Run

```sh
foundry autopilot status        # autopilot is on
foundry plan ~/workspaces/foundry/packs/aidlc --profile bugfix --dry-run   # the same 6 steps as in Phase 1
foundry run ~/workspaces/foundry/packs/aidlc --profile bugfix --mode autopilot \
  --input "GET /sum?a=1&b=2 returns {\"sum\":\"12\"} instead of {\"sum\":3}; test/sum.test.js shows it"
```

Watch it in a second terminal with `watch -n 5 foundry status RUN-1`.

What to expect:

- Questions are answered by `aidlc-product-lead-agent@<other agent>`; each
  answer shows in the output as `Q-n answered by ...`, with "(logged as an
  assumption)" when its evidence did not resolve.
- Gates are passed by the step's reviewer (product lead or architecture
  reviewer) after the verifiers; a reviewer rejection sends the step back
  with its comment, exactly like yours would.
- **code-generation** lands the fix; the refinery runs `npm test` before it
  merges. Document steps share the run's docs lane and merge at the end.
- **deployment-pipeline / deployment-execution** are usually skipped. If
  deployment-execution runs, it waits for you by design (it would change a
  real environment): read its plan with `foundry status WI-n` and approve it
  without carrying it out. Note it as a human stop with that reason.
- If anything else waits for you, `foundry status WI-n` says why on its
  `hold:` line (a locked path, a role that would judge its own work, a
  resolver that failed twice). Resolve it with `foundry answer` /
  `foundry approve` as in Phase 1, then `foundry work`, and note it.

Kill switch, any time: `foundry autopilot off` hands every open and future
decision point to you (`foundry autopilot on` to resume; points already
handed to you stay with you).

### Done when

```sh
foundry status RUN-1     # [done]; metrics line ends with "0 human stops" (or only the ones explained above)
npm test                 # all tests pass on main
foundry decisions RUN-1  # every answer and gate decision, with the role@agent that made it and its evidence
```

### Review the assumptions

```sh
foundry decisions RUN-1 --kind assumption
```

Read each one: the question, the choice, and the rationale, which says why
its evidence did not count. If one is wrong, reject it:

```sh
foundry reject-decision DEC-7 --comment "treat a missing b as 0, not as an error"
foundry work             # the item that made it and everything after it run again, with your comment
```

Record how many you reviewed, how many you rejected and why.

## 4. If something goes wrong

| You see | Do |
| --- | --- |
| `this would start N agent sessions; nothing started` | expected: add `--yes` when the number is fine |
| `no held-out benchmark cases for pack aidlc` | add more cases (1.1), or check `foundry bench list --set held-out` |
| `pack aidlc ... has no step "..." for case ...` | the case came from a step your version does not have; eval a copy of the same pack |
| every trial of a case fails with `asked a question` | the frozen envelope lacks an answer the role wants; drop the case (`rm -r benchmarks/<case>`) and note it |
| a trial fails with `ACP runtime` | sign in to the agent, then run the eval again |
| `the change touches the protected path benchmarks/` | an agent tried to change the benchmark; it is sent back by design |
| an autopilot item `waits for a person: ...` | see the reason; resolve it by hand and note it as a human stop |
| a lane worktree is left over after a failure | `foundry gc` removes failed and abandoned lanes |

## 5. What to record in docs/baseline.md

| What | Where |
| --- | --- |
| Held-out baseline per Construction step: cases, trials, passes | `foundry eval packs/aidlc --set held-out` "per step" lines |
| Factory numbers per step: first-pass yield, attempts/item, human rejection rate | `foundry stats --by step` |
| The hand-made change: file, what you changed, why | your notes |
| Its held-out result: a and b passes per case, totals, verdict | `foundry eval packs/aidlc packs/aidlc-b --set held-out` |
| Autopilot run: decisions | `foundry decisions RUN-1 \| grep -c '^DEC-'` |
| Autopilot run: assumptions, reviewed and rejected | `foundry decisions RUN-1 --kind assumption` |
| Autopilot run: human stops (should be zero outside locked areas) | metrics line of `foundry status RUN-1`, with the reason for each |
| Autopilot run: agent requests and sessions | metrics line (tool calls + permission requests; sessions include resolvers) |
| Agents and versions | `foundry log WI-1` at `agent_started` |
