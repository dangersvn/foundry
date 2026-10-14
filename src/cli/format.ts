import type { LedgerEvent } from "../kernel/ledger.js";

// One-line summary of a ledger event, shared by `foundry log` and the factory board.
export function summarize(e: LedgerEvent): string {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case "created": return `formula ${p.formula}`;
    case "claimed": return `attempt ${p.attempt}`;
    case "worktree_created": return `${p.branch} at ${p.path}`;
    case "agent_started": return `${p.agent} (${p.agentInfo?.name ?? "?"} ${p.agentInfo?.version ?? ""})`.replace(" )", ")");
    case "tool_call": return `${p.kind}: ${p.title} [${p.status}]`;
    case "permission": return `${p.allow ? "allowed" : "denied"} ${p.kind}: ${p.command ?? p.title} (${p.reason})`;
    case "agent_finished": return `stop reason ${p.stopReason}`;
    case "verifying": return p.command;
    case "verified": return `\`${p.command}\` passed`;
    case "merged": return `${String(p.commit).slice(0, 12)} into ${p.target}${p.recovered ? " (found after restart)" : ""}`;
    case "failed": case "agent_unavailable": return `[${p.layer}] ${p.message}`;
    case "lease_expired": return `held by ${p.previousOwner}, attempt ${p.attempt}`;
    default: return JSON.stringify(p);
  }
}
