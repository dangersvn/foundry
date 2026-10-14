# Later

Ideas for later phases, kept out of v0 code.

- Wall-clock and request budgets per item, with `session/cancel` then kill
  (spec "Limits"). v0 has no turn timeout; a hung agent holds its lease until
  you kill Foundry.
- `submit_result` through `foundry mcp` (Phase 3), so an agent can return
  structured output instead of only worktree changes.
- Agent-side permission rules (`~/.claude/settings.json`, Kiro trusted
  commands) can let tool calls run without asking Foundry. Options: start
  agents with an isolated settings home, or check after each turn that
  nothing outside the worktree changed.
- Shell command policy is a heuristic (deny `git push` and absolute paths
  outside the worktree). A sandbox (bubblewrap, containers) would make it a
  guarantee.
- Retry a verifier failure on another attempt with the failure output as
  handoff notes (Phase 1 notes and handoff).
- Capacity per agent (`max_sessions`) and falling back to the next agent in
  `prefer` on quota errors.
- `foundry attach` / `foundry session replay` over the stored transcripts.
- `foundry init` to write a starter `foundry.toml`.
- Redact account details (Claude's `_auth/status_update` carries the account
  email) from stored transcripts, on write or before any export.
- Clean up merged attempts' worktrees and `foundry/WI-n-aN` branches
  (`foundry gc`); v0 keeps them all.
- Worktrees outside the repo, so tools that scan the main checkout never
  see them (decisions D10).
