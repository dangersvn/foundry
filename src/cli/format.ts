import type { LedgerEvent } from "../kernel/ledger.js";

// One-line summary of a ledger event, shared by `foundry log` and the factory board.
export function summarize(e: LedgerEvent): string {
  const p = e.payload as Record<string, any>; // eslint-disable-line
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
    case "retry": return `attempt ${p.attempt ?? "?"} sent back: ${String(p.reason).split("\n")[0]}`;
    case "submitted": return `${p.status}: ${p.summary} (${p.decisions} decisions)`;
    case "submission_rejected": return `schema check failed: ${p.errors}`;
    case "asked": return (p.questions as { id: string; question: string }[]).map((q) => `${q.id} ${q.question}`).join("; ");
    case "waiting_for_input": return `waiting on ${(p.questions as string[]).join(", ")}`;
    case "answered": return `${p.question}: ${JSON.stringify(p.answer)}`;
    case "resumed": return String(p.reason);
    case "at_gate": return p.environmentChange ? "waiting for a person to carry out the plan" : "waiting for approval";
    case "approved": case "rejected": return p.comment ? JSON.stringify(p.comment) : "";
    case "reviewed": return `${p.reviewer}: ${(p.findings as string[]).length} findings (advisory)`;
    case "skipped": return String(p.reason);
    case "merge_queued": return `commit ${String(p.commit).slice(0, 12)}`;
    case "merge_started": return "";
    case "merge_verified": return `\`${p.command}\` passed on top of main`;
    case "completed": return "no file changes to merge";
    case "note": case "handoff": case "design": return String(p.body);
    case "stalled": return `no activity for ${p.quietSeconds}s`;
    default: return JSON.stringify(p);
  }
}
