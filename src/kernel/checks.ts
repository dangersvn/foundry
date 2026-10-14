// Built-in deterministic checks a pack verifier can name. The aidlc.* checks
// are ports of AI-DLC v2.11.0's six sensors (core/sensors/*.md), following
// each sensor's documented contract; see docs/decisions.md for where they are
// simpler than the originals.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Step } from "../schemas/formula.js";
import type { Result } from "../schemas/result.js";
import type { InputRef } from "./ledger.js";

const exec = promisify(execFile);

export interface CheckContext {
  worktree: string;
  step: Step;
  result: Result | null;
  changedFiles: string[]; // relative to the worktree, from the item's commit
  inputs: InputRef[];
}
export interface CheckResult {
  pass: boolean;
  findings: string[];
}
type Check = (ctx: CheckContext) => Promise<CheckResult>;

const read = (ctx: CheckContext, rel: string) => {
  const f = path.join(ctx.worktree, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};

// The documents a stage delivered: submitted artifacts plus changed markdown.
function deliverables(ctx: CheckContext, ext = ".md"): string[] {
  const files = new Set([...(ctx.result?.artifacts ?? []).map((a) => a.path), ...ctx.changedFiles]);
  return [...files].filter((f) => f.endsWith(ext) && read(ctx, f) !== null).sort();
}

const h2 = (text: string) => [...text.matchAll(/^## +(.+?)\s*$/gm)].map((m) => m[1]!);

function cyclic(units: { name: string; depends_on: string[] }[]): boolean {
  const deps = new Map(units.map((u) => [u.name, u.depends_on]));
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    const hit = (deps.get(n) ?? []).some(visit);
    state.set(n, 2);
    return hit;
  };
  return units.some((u) => visit(u.name));
}

// required-sections: every delivered document has at least two H2 headings;
// timestamp markers always pass; unit-of-work-dependency.md also needs a
// well-formed, cycle-free ```yaml units: block.
const requiredSections: Check = async (ctx) => {
  const findings: string[] = [];
  for (const f of deliverables(ctx)) {
    if (/-timestamp\.md$/.test(f)) continue;
    const text = read(ctx, f)!;
    const headings = h2(text);
    if (headings.length < 2) findings.push(`${f}: has ${headings.length} H2 headings, needs at least 2`);
    if (path.basename(f) === "unit-of-work-dependency.md") {
      const block = text.match(/```yaml\n([\s\S]*?)```/)?.[1];
      if (!block || !/^units:/m.test(block)) {
        findings.push(`${f}: the \`\`\`yaml units: edge block is absent`);
        continue;
      }
      try {
        const units = (parseYaml(block) as { units: { name: string; depends_on?: string[] }[] }).units.map((u) => ({ name: u.name, depends_on: u.depends_on ?? [] }));
        if (cyclic(units)) findings.push(`${f}: the units: edge block is cyclic`);
      } catch {
        findings.push(`${f}: the units: edge block is malformed`);
      }
    }
  }
  return { pass: findings.length === 0, findings };
};

// upstream-coverage: the deliverables mention every upstream artifact the
// step consumes and that was actually produced (skipped inputs are absent).
const upstreamCoverage: Check = async (ctx) => {
  const docs = deliverables(ctx).map((f) => read(ctx, f)!).join("\n");
  if (!docs) return { pass: true, findings: [] };
  const produced = new Set(ctx.inputs.filter((i) => i.status === "done").map((i) => i.step));
  const findings = ctx.step.inputs
    .filter((i) => i.name && produced.has(i.from))
    .filter((i) => !docs.includes(i.name!))
    .map((i) => `no deliverable references the upstream artifact "${i.name}" (from ${i.from})`);
  return { pass: findings.length === 0, findings: [...new Set(findings)] };
};

// claim-sources: Intent Capture deliverables have an "Assumptions & Open
// Questions" section, and every substantive list item or paragraph carries a
// source tag; [assumption] appears only in the assumptions section.
const claimSources: Check = async (ctx) => {
  const findings: string[] = [];
  const tag = /\[(desc|scope|Q\d+|memory:[^\]]+|assumption)\]/;
  for (const f of deliverables(ctx)) {
    if (/-questions\.md$|-timestamp\.md$/.test(f)) continue;
    const text = read(ctx, f)!;
    if (!h2(text).some((h) => /Assumptions & Open Questions/.test(h))) findings.push(`${f}: no "## Assumptions & Open Questions" section`);
    let section = "";
    for (const line of text.split("\n")) {
      const head = line.match(/^## +(.+)/);
      if (head) {
        section = head[1]!;
        continue;
      }
      const t = line.trim();
      const substantive = /^([-*]|\d+\.)\s+\S/.test(t) || (/^\|/.test(t) && !/^\|[\s:-]+\|/.test(t)) || (/^[A-Za-z]/.test(t) && t.length > 40);
      if (!substantive || /^#/.test(t) || /Review/.test(section) || /^Sources/.test(section)) continue;
      if (!tag.test(t)) findings.push(`${f}: untagged claim: ${t.slice(0, 80)}`);
      else if (t.includes("[assumption]") && !/Assumptions/.test(section)) findings.push(`${f}: [assumption] outside the assumptions section: ${t.slice(0, 80)}`);
    }
  }
  return { pass: findings.length === 0, findings: findings.slice(0, 50) };
};

// traceability: traceability.json has the documented shape, closed statuses,
// no GAP or ORPHAN, a row for every upstream id, and targets where required.
const traceability: Check = async (ctx) => {
  const findings: string[] = [];
  const files = deliverables(ctx, ".json").filter((f) => path.basename(f) === "traceability.json");
  const statuses = new Set(["OK", "GAP", "ORPHAN", "Deferred", "N/A"]);
  for (const f of files) {
    let t: { upstream_ids?: unknown; coverage?: unknown; reverse?: unknown };
    try {
      t = JSON.parse(read(ctx, f)!);
    } catch {
      findings.push(`${f}: not valid JSON`);
      continue;
    }
    const ids = Array.isArray(t.upstream_ids) ? (t.upstream_ids as string[]) : null;
    const rows = Array.isArray(t.coverage) ? (t.coverage as { id: string; status: string; target?: string }[]) : null;
    if (!ids || !rows) {
      findings.push(`${f}: needs "upstream_ids" and "coverage" arrays`);
      continue;
    }
    for (const r of [...rows, ...((Array.isArray(t.reverse) ? t.reverse : []) as typeof rows)]) {
      if (!statuses.has(r.status)) findings.push(`${f}: ${r.id} has status "${r.status}" (not one of ${[...statuses].join(", ")})`);
      else if (r.status === "GAP" || r.status === "ORPHAN") findings.push(`${f}: ${r.id} is ${r.status}`);
      else if (!r.target) findings.push(`${f}: ${r.id} is ${r.status} without a target`);
    }
    for (const id of ids) if (!rows.some((r) => r.id === id)) findings.push(`${f}: no coverage row for upstream id ${id}`);
    for (const r of rows) if (!ids.includes(r.id)) findings.push(`${f}: coverage row ${r.id} is not an upstream id`);
  }
  return { pass: findings.length === 0, findings };
};

// linter / type-check: the project's own tools on the changed files; a
// project without them passes with a note, as AI-DLC's sensors do.
async function projectTool(ctx: CheckContext, exts: RegExp, bin: string, args: (files: string[]) => string[]): Promise<CheckResult> {
  const files = ctx.changedFiles.filter((f) => exts.test(f) && read(ctx, f) !== null);
  if (files.length === 0) return { pass: true, findings: [] };
  const tool = path.join(ctx.worktree, "node_modules", ".bin", bin);
  if (!fs.existsSync(tool)) return { pass: true, findings: [`${bin} is not installed in this project; not checked`] };
  try {
    await exec(tool, args(files), { cwd: ctx.worktree, maxBuffer: 16 * 1024 * 1024 });
    return { pass: true, findings: [] };
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`.trim();
    return { pass: false, findings: out.split("\n").filter(Boolean).slice(0, 30) };
  }
}
const linter: Check = (ctx) => projectTool(ctx, /\.(ts|js)$/, "eslint", (files) => files);
const typeCheck: Check = (ctx) =>
  fs.existsSync(path.join(ctx.worktree, "tsconfig.json")) ? projectTool(ctx, /\.(ts|tsx)$/, "tsc", () => ["--noEmit", "-p", "."]) : Promise.resolve({ pass: true, findings: [] });

export const BUILTIN_CHECKS = new Map<string, Check>([
  ["aidlc.required-sections", requiredSections],
  ["aidlc.upstream-coverage", upstreamCoverage],
  ["aidlc.claim-sources", claimSources],
  ["aidlc.traceability", traceability],
  ["aidlc.linter", linter],
  ["aidlc.type-check", typeCheck],
]);
