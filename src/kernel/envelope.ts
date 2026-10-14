// The envelope is the agent's whole task: nothing it needs lives only in an
// earlier session. It is rebuilt from the ledger for every attempt.
import type { Step } from "../schemas/formula.js";
import type { DecisionRecord, InputRef, Item, Note, Question, Run } from "./ledger.js";

export interface EnvelopeParts {
  item: Item;
  run: Run;
  step: Step;
  rolePrompt: string;
  instructions: string;
  worktree: string;
  branch: string;
  inputs: InputRef[];
  inputDecisions: DecisionRecord[];
  notes: Note[];
  questions: Question[];
  runItems: Item[];
  context: string[]; // files the agent should read, relative to the worktree
  rules: { layer: string; text: string }[]; // org, team, project; later wins
  params: Record<string, string>;
  fullVerify?: string;
  review?: boolean; // this session reviews another role's work
}

const indent = (s: string, n = 4) => s.trim().split("\n").map((l) => " ".repeat(n) + l).join("\n");

export function buildEnvelope(p: EnvelopeParts): string {
  const { item, step } = p;
  const out: string[] = [];
  out.push(`# Foundry work item ${item.id}`, "");
  out.push("```yaml");
  out.push(`item: ${item.id}`);
  out.push(`attempt: ${item.attempt}   # of ${item.max_attempts}`);
  out.push(`run: ${p.run.id} — ${JSON.stringify(p.run.title ?? p.run.goal)}`);
  out.push(`step: ${step.id}`);
  if (item.unit) out.push(`unit: ${item.unit}`);
  out.push(`role: ${p.review ? `${step.review} (reviewing ${step.role})` : step.role}`);
  if (Object.keys(p.params).length) out.push(`params: {${Object.entries(p.params).map(([k, v]) => `${k}: ${v}`).join(", ")}}`);
  out.push(`title: ${JSON.stringify(item.title)}`);
  if (item.goal.trim()) out.push("goal: |", indent(item.goal, 2));
  if (item.inputs.trim()) out.push("request: |", indent(item.inputs, 2));

  out.push("inputs:");
  if (p.inputs.length === 0) out.push("  []");
  for (const i of p.inputs) {
    out.push(`  - ${i.step}${i.unit ? ` (${i.unit})` : ""} ${i.item} [${i.status}]: ${JSON.stringify(i.status === "skipped" ? `absent by design, ${i.summary}` : i.summary)}`);
    for (const a of i.artifacts) out.push(`      artifact: ${a.path} — ${a.summary}`);
    for (const [k, v] of Object.entries(i.outputs)) out.push(`      output ${k}: ${JSON.stringify(v)}`);
  }

  out.push("acceptance:");
  if (step.submit) out.push("  submit: ./.foundry/bin/foundry submit --file .foundry/result.json   # required, see below");
  if (step.verify) out.push(`  verify: ${JSON.stringify(step.verify)}   # Foundry runs it in this worktree when you end your turn`);
  if (p.fullVerify && p.fullVerify !== step.verify) out.push(`  merge_verify: ${JSON.stringify(p.fullVerify)}   # run again on main's next commit before merging`);
  if (step.gate || step.environment_change) out.push("  gate: a person approves this output before it merges");
  if (step.review && !p.review) out.push(`  review: ${step.review} reviews your work (advisory)`);

  out.push("context:");
  if (p.context.length === 0) out.push("  []");
  for (const c of p.context) out.push(`  - ${c}`);

  const history = historyLines(p);
  out.push("history:");
  if (history.length === 0) out.push("  []   # first attempt");
  out.push(...history);

  const counts = new Map<string, number>();
  for (const i of p.runItems) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  out.push(`run_status: ${[...counts].map(([s, n]) => `${n} ${s.replace("_", " ")}`).join(", ")}`);
  out.push("```", "");

  if (p.rules.length) {
    out.push("## Rules", "", "Layered from general to specific; where they differ, the later one wins.", "");
    for (const r of p.rules) out.push(`### ${r.layer} rules`, "", r.text.trim(), "");
  }
  if (p.rolePrompt.trim()) out.push("## Your role", "", p.rolePrompt.trim(), "");
  if (p.instructions.trim()) out.push("## Step instructions", "", p.instructions.trim(), "");
  out.push(...protocol(p));
  return out.join("\n") + "\n";
}

function historyLines(p: EnvelopeParts): string[] {
  const lines: string[] = [];
  for (const q of p.questions) {
    lines.push(`  - attempt ${q.attempt} question ${q.id}: ${JSON.stringify(q.question)}`);
    lines.push(q.answer === null ? "      answer: (not answered yet)" : `      answer: ${JSON.stringify(q.answer)}   # by ${q.answered_by}`);
  }
  const label: Record<string, string> = {
    handoff: "handoff",
    rejection: "rejected at the gate",
    verifier: "verifier failure",
    refinery: "sent back by the merge queue",
    review: "review finding",
    note: "note",
    design: "design note",
  };
  for (const n of p.notes) {
    lines.push(`  - attempt ${n.attempt} ${label[n.kind] ?? n.kind} (${n.author}):`);
    lines.push(indent(n.body.length > 3000 ? "…" + n.body.slice(-3000) : n.body, 6));
  }
  for (const d of p.inputDecisions) {
    lines.push(`  - input decision ${d.id} (${d.kind}, ${d.step_id}): ${JSON.stringify(d.question)} -> ${JSON.stringify(d.choice)}`);
  }
  return lines;
}

function protocol(p: EnvelopeParts): string[] {
  const f = "./.foundry/bin/foundry";
  const lines = [
    "## How to work with Foundry",
    "",
    `- Work only inside this directory: ${p.worktree} (git branch ${p.branch}). Do not run git push and do not merge; Foundry commits and merges.`,
  ];
  if (p.review) {
    lines.push(
      "- You are reviewing, not changing: read the work and do not edit files. Your findings are advisory and shown to the person at the gate.",
      `- When done, write .foundry/result.json with \`status: "done"\`, a \`summary\`, \`findings\` (one string each) and \`decisions: []\`, then run \`${f} submit --file .foundry/result.json\`.`,
    );
    return lines;
  }
  if (!p.step.submit) {
    lines.push("- When you are finished, end your turn. Foundry runs the verify command above; the item is done only if it passes, so run it yourself first.");
    return lines;
  }
  lines.push(
    "- Talk to Foundry only with these commands, run from this directory:",
    `  - \`${f} ask --question "..." --option "A" --option "B"\`: ask the person. Then end your turn; you are resumed with the answer in history.`,
    `  - \`${f} note "..."\`: record a finding or a dead end for later attempts.`,
    `  - \`${f} handoff "..."\`: what the next attempt should know if this one does not pass.`,
    `  - \`${f} submit --file .foundry/result.json\`: hand in your result. It is checked against the schema; fix and resubmit if it is rejected.`,
    "- result.json (JSON):",
    "  ```json",
    '  {"status": "done", "summary": "one line", "outputs": {"name": ["list", "or string"]},',
    '   "artifacts": [{"path": "docs/x.md", "summary": "one line"}],',
    '   "decisions": [{"kind": "decision", "question": "...", "choice": "...", "alternatives": ["..."],',
    '                  "rationale": "...", "evidence": ["file or source"], "affects": ["path"]}]}',
    "  ```",
    "  `decisions` is required (it may be empty). Kinds: decision, assumption, deviation. To skip a step that does not apply, submit",
    '  `{"status": "skipped", "summary": "...", "reason": "why", "decisions": []}`.',
    "- Your own claim of success counts for nothing: Foundry runs the verifiers itself.",
  );
  return lines;
}
