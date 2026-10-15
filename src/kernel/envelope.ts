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
  replay?: string; // an eval trial: "<case> trial t of n (pack <name> <version>)"
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
  if (p.replay) out.push(`replay: ${p.replay}`);
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
    check: "check finding",
    note: "note",
    design: "design note",
    decision_rejected: "decision rejected",
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

export interface ResolverParts {
  kind: "answer" | "gate";
  item: Item;
  run: Run;
  step: Step;
  roleName: string;
  rolePrompt: string;
  worktree: string;
  inputs: InputRef[];
  questions: Question[]; // the open ones
  notes: Note[];
  decisions: DecisionRecord[]; // active decisions of the run
  approved: { path: string; summary: string; item: string; step: string }[];
  result: { summary: string; outputs?: Record<string, unknown>; artifacts?: { path: string; summary: string }[]; decisions?: { kind: string; question: string; choice: string }[] } | null;
  changed: string[];
  checks: Record<string, unknown>[];
  rules: { layer: string; text: string }[];
  context: string[];
}

// The envelope of an autopilot resolver: the decision point, everything it
// may cite as evidence, and how to submit a resolution.
export function buildResolverEnvelope(p: ResolverParts): string {
  const { item, step } = p;
  const out: string[] = [];
  out.push(`# Foundry decision point for work item ${item.id}`, "");
  out.push("```yaml");
  out.push(`item: ${item.id}`);
  out.push(`attempt: ${item.attempt}`);
  out.push(`run: ${p.run.id} — ${JSON.stringify(p.run.title ?? p.run.goal)}`);
  out.push(`step: ${step.id}`);
  if (item.unit) out.push(`unit: ${item.unit}`);
  out.push(`role: ${p.roleName} (${p.kind === "answer" ? `answering questions from ${step.role}` : `judging the gate of ${step.role}'s work`})`);
  out.push(`resolve: ${p.kind}`);
  if (item.goal.trim()) out.push("goal: |", indent(item.goal, 2));
  out.push("request: |", indent(p.run.input.trim() || "(none)", 2));
  if (p.kind === "answer") {
    out.push("open_questions:");
    for (const q of p.questions) {
      out.push(`  - id: ${q.id}`, `    question: ${JSON.stringify(q.question)}`, `    options: ${JSON.stringify(JSON.parse(q.options_json))}${q.allow_other ? "   # another answer is allowed" : "   # pick one of these"}`);
    }
  } else {
    out.push("output:");
    out.push(`  summary: ${JSON.stringify(p.result?.summary ?? "(no result submitted)")}`);
    out.push(`  commit: ${item.commit_sha ?? "none"}   # \`git show HEAD\` in this worktree`);
    out.push(`  changed_files: ${JSON.stringify(p.changed)}`);
    for (const [k, v] of Object.entries(p.result?.outputs ?? {})) out.push(`  output ${k}: ${JSON.stringify(v)}`);
    for (const a of p.result?.artifacts ?? []) out.push(`  artifact: ${a.path} — ${a.summary}`);
    for (const d of p.result?.decisions ?? []) out.push(`  decision: (${d.kind}) ${JSON.stringify(d.question)} -> ${JSON.stringify(d.choice)}`);
    out.push("verifiers:   # all passed, or the item would not be at its gate");
    if (p.checks.length === 0) out.push("  []");
    for (const c of p.checks) out.push(`  - ${JSON.stringify(c)}`);
  }
  out.push("inputs:");
  if (p.inputs.length === 0) out.push("  []");
  for (const i of p.inputs) out.push(`  - ${i.step}${i.unit ? ` (${i.unit})` : ""} ${i.item} [${i.status}]: ${JSON.stringify(i.summary)}`);
  out.push("approved_artifacts:   # cite as {\"kind\": \"artifact\", \"ref\": \"<path>\"}");
  if (p.approved.length === 0) out.push("  []");
  for (const a of p.approved) out.push(`  - ${a.path} — ${a.summary} (${a.item} ${a.step})`);
  out.push("decisions:   # cite as {\"kind\": \"decision\", \"ref\": \"DEC-n\"}");
  if (p.decisions.length === 0) out.push("  []");
  for (const d of p.decisions) out.push(`  - ${d.id} (${d.kind}, ${d.step_id ?? "-"}): ${JSON.stringify(d.question)} -> ${JSON.stringify(d.choice)}`);
  out.push("history:");
  if (p.notes.length === 0) out.push("  []");
  for (const n of p.notes) out.push(`  - attempt ${n.attempt} ${n.kind} (${n.author}):`, indent(n.body.length > 3000 ? "…" + n.body.slice(-3000) : n.body, 6));
  out.push("context:");
  if (p.context.length === 0) out.push("  []");
  for (const c of p.context) out.push(`  - ${c}`);
  out.push("```", "");
  if (p.rules.length) {
    out.push("## Rules", "", "Layered from general to specific; where they differ, the later one wins.", "");
    for (const r of p.rules) out.push(`### ${r.layer} rules`, "", r.text.trim(), "");
  }
  if (p.rolePrompt.trim()) out.push("## Your role", "", p.rolePrompt.trim(), "");
  const f = "./.foundry/bin/foundry";
  out.push(
    "## How to resolve this decision point",
    "",
    `- The run is in autopilot: you decide instead of a person. Read what you need in ${p.worktree}, but do not change any file; your changes are discarded.`,
    "- Base every choice on evidence and cite it. Foundry checks each citation: the run's request (`{\"kind\": \"request\", \"quote\": \"words from it\"}`), an approved artifact listed above, a file in this workspace (`{\"kind\": \"context\", \"ref\": \"src/app.js\"}`) or a decision listed above. A choice with no citation, or with one that does not resolve, is logged as an assumption for a person to review later.",
  );
  if (p.kind === "answer") {
    out.push(
      "- Answer every open question. When the evidence does not settle it, pick the most reversible option and say so in the rationale.",
      "- Write .foundry/resolution.json:",
      "  ```json",
      '  {"answers": [{"question": "Q-1", "answer": "one of the options, or your own", "rationale": "why", "evidence": [{"kind": "request", "quote": "..."}]}]}',
      "  ```",
    );
  } else {
    out.push(
      "- Approve when the work does what the goal and the request ask and is consistent with the inputs and decisions above; reject otherwise. A rejection sends the work back with your comment, so say exactly what to change.",
      "- Write .foundry/resolution.json:",
      "  ```json",
      '  {"verdict": "approve", "comment": "why (or what to change)", "findings": ["one string each"], "evidence": [{"kind": "artifact", "ref": "..."}]}',
      "  ```",
    );
  }
  out.push(`- Then run \`${f} submit --file .foundry/resolution.json\`. It is checked against the schema; fix and resubmit if it is rejected. Then end your turn.`);
  return out.join("\n") + "\n";
}

export interface JudgeParts {
  caseId: string;
  step: Step;
  request: string;
  goal: string;
  inputs: InputRef[];
  roleName: string;
  rolePrompt: string;
  worktree: string;
  accepted: { summary: string; artifacts: { path: string; summary: string }[]; files: string[] };
  trial: { summary: string; artifacts: { path: string; summary: string }[]; files: string[] };
  findings: string[];
}

// The envelope of an eval judge: score a replayed document output against
// the rubric, with the accepted output as the reference.
export function buildJudgeEnvelope(p: JudgeParts): string {
  const out: string[] = [];
  out.push(`# Foundry eval judge for case ${p.caseId}`, "");
  out.push("```yaml");
  out.push(`case: ${p.caseId}`);
  out.push(`step: ${p.step.id}`);
  out.push(`role: ${p.roleName} (judging ${p.step.role}'s output)`);
  out.push("resolve: judge");
  out.push("goal: |", indent(p.goal || p.step.goal || "(none)", 2));
  out.push("request: |", indent(p.request.trim() || "(none)", 2));
  out.push("inputs:");
  if (p.inputs.length === 0) out.push("  []");
  for (const i of p.inputs) out.push(`  - ${i.step} ${i.item} [${i.status}]: ${JSON.stringify(i.summary)}`);
  out.push("accepted_output:   # what a person approved for this case; its diff is .foundry/accepted.patch");
  out.push(`  summary: ${JSON.stringify(p.accepted.summary)}`);
  for (const a of p.accepted.artifacts) out.push(`  artifact: ${a.path} — ${a.summary}`);
  out.push(`  files: ${JSON.stringify(p.accepted.files)}`);
  out.push("trial_output:   # what you judge; the files are in this worktree");
  out.push(`  summary: ${JSON.stringify(p.trial.summary)}`);
  for (const a of p.trial.artifacts) out.push(`  artifact: ${a.path} — ${a.summary}`);
  out.push(`  files: ${JSON.stringify(p.trial.files)}`);
  out.push("sensor_findings:");
  if (p.findings.length === 0) out.push("  []");
  for (const f of p.findings) out.push(`  - ${JSON.stringify(f)}`);
  out.push("```", "");
  if (p.rolePrompt.trim()) out.push("## Your role", "", p.rolePrompt.trim(), "");
  out.push(
    "## Rubric",
    "",
    "Judge the trial output, not the accepted one. Read its files in this worktree; do not change anything. For each criterion answer true or false:",
    "",
    "- `goal`: it does what the step's goal and the request ask.",
    "- `inputs`: it is consistent with the inputs and builds on them.",
    "- `grounded`: it invents no facts, requirements or files that the request, inputs or repository do not support.",
    "- `complete`: it covers at least what the accepted output covers.",
    "",
    "Write .foundry/resolution.json and run `./.foundry/bin/foundry submit --file .foundry/resolution.json`, then end your turn:",
    "",
    "```json",
    '{"criteria": {"goal": true, "inputs": true, "grounded": true, "complete": false}, "comment": "what is missing or wrong"}',
    "```",
    "",
    "The trial passes only when every criterion is true.",
  );
  return out.join("\n") + "\n";
}
