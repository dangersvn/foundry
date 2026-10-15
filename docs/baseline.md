# Baseline

Real-agent runs of `features/real_agents.feature` on 2026-10-14: formula
`health-endpoint` on `examples/sample-app`, one laptop (Linux, Node 24.12).
Times come from the ledger's event timestamps.

| | Kiro (kiro-cli 2.21.0) | Claude Code (claude-agent-acp 0.90.0) |
| --- | --- | --- |
| Result | done, attempt 1 | done, attempt 1 |
| `foundry run` to merged commit | 14.0 s | 13.4 s |
| of which agent start (spawn to `session/new` done) | 0.7 s | 1.7 s |
| of which agent turn | 13.0 s | 11.4 s |
| of which verify + merge | 0.3 s | 0.3 s |
| ACP prompts (`session/prompt`) | 1 | 1 |
| Model requests | 6 (one `meteringUsage` entry each) | not reported per request |
| Tool calls | 5 (2 reads, 2 edits, `npm test`) | 5 (2 shell reads, 2 edits, `npm test`) |
| Permission requests | 3 (2 edits, 1 shell), all allowed | 3 (2 edits, 1 shell), all allowed |
| Usage reported by the agent | 0.35 credits | 110.9k tokens (95k cached), USD 0.16 |
| Change | `src/app.js` +5, `test/app.test.js` +6 | `src/app.js` and `test/app.test.js` edited |

Both runs also add about 0.3 s of CLI start time under `tsx`, which the
built `dist/` command doesn't add.

## Failures and retries

- None in the recorded runs: each agent passed on its first attempt, and
  neither request was denied.
- The first full `npm run features:real` passed for both agents. The Kiro row
  was run a second time only because that run's repo had been deleted
  before its timing was read. The step hook now keeps real-agent repos.
- Neither agent asked permission for reads: Kiro's read tool and Claude's
  `git ls-files` / `cat` ran without a permission request (spike note 11).
  The permission log therefore shows only writes and the `npm test` runs.

## Phase 2 (to fill in after the 2d runs in docs/manual-runs-v2.md)

Not recorded yet: the 2d proof needs a person and real agents.

| What | Value |
| --- | --- |
| Held-out baseline, code-generation (cases, trials, passes) | |
| `foundry stats --by step` for code-generation (first-pass yield, attempts/item, human rejection rate) | |
| Hand-made change (file, what, why) | |
| Its held-out result (a vs b per case, totals, verdict) | |
| Autopilot bugfix run: decisions | |
| Autopilot bugfix run: assumptions (reviewed / rejected) | |
| Autopilot bugfix run: human stops outside locked areas (should be 0) | |
| Autopilot bugfix run: agent sessions, tool calls, permission requests | |
| Agents and versions | |
