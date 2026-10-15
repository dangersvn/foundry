// `foundry stats`: factory metrics derived from the event log (and the
// decision log for assumptions), grouped by role, agent or step.
import type { Formula } from "../schemas/formula.js";
import type { Ledger, LedgerEvent } from "./ledger.js";

export type GroupBy = "role" | "agent" | "step";

export interface StatRow {
  group: string;
  items: number;
  firstPassYield: number | null; // share of items whose first attempt passed its verifiers
  attemptsPerItem: number | null;
  humanRejections: { rejected: number; decided: number };
  requestsPerMerged: number | null; // agent tool calls and permission requests per merged item
  escalationRate: number | null; // share of items that failed after their last attempt
  assumptions: number;
}

// Where an attempt counts as having passed its verifiers.
const PASSED = new Set(["at_gate", "merge_queued", "lane_committed", "completed"]);
const REQUEST = /^(review_|resolver_)?(tool_call|permission)$/;

export async function stats(ledger: Ledger, by: GroupBy): Promise<StatRow[]> {
  const rows = new Map<string, StatRow>();
  const row = (g: string) => {
    if (!rows.has(g)) rows.set(g, { group: g, items: 0, firstPassYield: null, attemptsPerItem: null, humanRejections: { rejected: 0, decided: 0 }, requestsPerMerged: null, escalationRate: null, assumptions: 0 });
    return rows.get(g)!;
  };
  const acc = new Map<string, { firstPass: number; judged: number; attempts: number; claimed: number; requests: number; merged: number; failed: number }>();
  const groupOf = new Map<string, string>();
  for (const run of await ledger.listRuns()) {
    const roles = new Map(((JSON.parse(run.formula_json ?? '{"steps":[]}') as Formula).steps ?? []).map((s) => [s.id, s.role]));
    const byItem = new Map<string, LedgerEvent[]>();
    for (const e of await ledger.runEvents(run.id)) if (e.item_id) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
    for (const [itemId, events] of byItem) {
      const created = events.find((e) => e.type === "created");
      if (!created) continue;
      const step = String(created.payload.step ?? "-");
      const agent = String(events.find((e) => e.type === "agent_started")?.payload.agent ?? events.find((e) => e.type === "worktree_created")?.payload.agent ?? "-");
      const g = by === "step" ? step : by === "agent" ? agent : (roles.get(step) ?? "worker");
      groupOf.set(itemId, g);
      const r = row(g);
      const a = acc.get(g) ?? { firstPass: 0, judged: 0, attempts: 0, claimed: 0, requests: 0, merged: 0, failed: 0 };
      acc.set(g, a);
      r.items++;
      const claims = events.filter((e) => e.type === "claimed");
      if (claims.length) {
        a.claimed++;
        a.attempts += claims.length;
      }
      // The first attempt: events between the first and second claim.
      const second = claims[1] ? events.indexOf(claims[1]) : events.length;
      const first = events.slice(0, second);
      const skipped = events.some((e) => e.type === "skipped");
      if (claims.length && !skipped) {
        a.judged++;
        if (first.some((e) => PASSED.has(e.type))) a.firstPass++;
      }
      for (const e of events) {
        if (REQUEST.test(e.type)) a.requests++;
        if ((e.type === "approved" || e.type === "rejected") && e.actor.startsWith("person:")) {
          r.humanRejections.decided++;
          if (e.type === "rejected") r.humanRejections.rejected++;
        }
      }
      if (events.some((e) => e.type === "merged" || (e.type === "lane_committed" && e.payload.commit))) a.merged++;
      if (events.some((e) => e.type === "failed")) a.failed++;
    }
  }
  for (const d of await ledger.decisions({ kind: "assumption" })) if (d.item_id && groupOf.has(d.item_id)) row(groupOf.get(d.item_id)!).assumptions++;
  for (const [g, a] of acc) {
    const r = row(g);
    r.firstPassYield = a.judged ? a.firstPass / a.judged : null;
    r.attemptsPerItem = a.claimed ? a.attempts / a.claimed : null;
    r.requestsPerMerged = a.merged ? a.requests / a.merged : null;
    r.escalationRate = r.items ? a.failed / r.items : null;
  }
  return [...rows.values()].sort((x, y) => x.group.localeCompare(y.group));
}

const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);
const num = (v: number | null) => (v === null ? "-" : v.toFixed(2));

export function formatStats(rows: StatRow[], by: GroupBy): string[] {
  const header = [by, "items", "first-pass yield", "attempts/item", "human rejection rate", "agent requests/merged item", "escalation rate", "assumptions"];
  const cells = rows.map((r) => [
    r.group,
    String(r.items),
    pct(r.firstPassYield),
    num(r.attemptsPerItem),
    r.humanRejections.decided ? `${pct(r.humanRejections.rejected / r.humanRejections.decided)} (${r.humanRejections.rejected}/${r.humanRejections.decided})` : "- (0/0)",
    num(r.requestsPerMerged),
    pct(r.escalationRate),
    String(r.assumptions),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...cells.map(line)];
}
