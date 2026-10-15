// Commands an agent runs from inside its worktree (`./.foundry/bin/foundry`).
// They find their item through .foundry/item.json and only add data rows
// (submissions, notes, questions); item status stays with the worker.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ItemHandle } from "../kernel/dispatcher.js";
import { FoundryError } from "../kernel/errors.js";
import { Ledger } from "../kernel/ledger.js";
import { AnswerResolution, formatIssues, GateResolution, Questions, Result } from "../schemas/result.js";

function findHandle(): ItemHandle {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const f = path.join(dir, ".foundry", "item.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) as ItemHandle;
    if (path.dirname(dir) === dir) {
      throw new FoundryError("agent", "this command runs only inside a Foundry item's worktree (no .foundry/item.json found)", "cd into the worktree named in your task");
    }
  }
}

async function withItem<T>(fn: (h: ItemHandle, l: Ledger) => Promise<T>): Promise<T> {
  const h = findHandle();
  const ledger = await Ledger.open(h.ledger);
  try {
    const item = await ledger.getItem(h.item);
    // A resolver works on a decision point; everyone else on a running item.
    const active = h.resolve ? (h.resolve === "answer" ? ["waiting_input"] : ["at_gate"]) : ["running", "verifying"];
    if (!item || item.attempt !== h.attempt || !active.includes(item.status)) {
      throw new FoundryError("agent", `${h.item} attempt ${h.attempt} is no longer active (status ${item?.status ?? "unknown"})`, "end your turn");
    }
    return await fn(h, ledger);
  } finally {
    await ledger.close();
  }
}

export async function cmdSubmit(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { file: { type: "string" } } });
  if (!values.file) throw new FoundryError("agent", "submit needs --file <result.json>", "./.foundry/bin/foundry submit --file .foundry/result.json");
  return withItem(async (h, ledger) => {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(values.file!, "utf8"));
    } catch (e) {
      await ledger.addSubmission(h.item, h.attempt, false, { error: (e as Error).message });
      await ledger.note(h.item, "submission_rejected", "agent", { errors: `not readable JSON: ${(e as Error).message}` });
      console.error(`rejected: ${values.file} is not readable JSON: ${(e as Error).message}`);
      return 1;
    }
    if (h.resolve) {
      const r = (h.resolve === "answer" ? AnswerResolution : GateResolution).safeParse(raw);
      if (!r.success) {
        const errors = formatIssues(r.error);
        await ledger.addSubmission(h.item, h.attempt, false, { resolve: h.resolve, raw, errors });
        await ledger.note(h.item, "submission_rejected", "agent", { errors });
        console.error(`rejected, fix and submit again: ${errors}`);
        return 1;
      }
      await ledger.addSubmission(h.item, h.attempt, true, { resolve: h.resolve, ...r.data });
      await ledger.note(h.item, "resolution_submitted", "agent", { kind: h.resolve });
      console.log("accepted. End your turn now; Foundry checks your evidence and applies the resolution.");
      return 0;
    }
    const parsed = Result.safeParse(raw);
    if (!parsed.success) {
      const errors = formatIssues(parsed.error);
      await ledger.addSubmission(h.item, h.attempt, false, { raw, errors });
      await ledger.note(h.item, "submission_rejected", "agent", { errors });
      console.error(`rejected, fix and submit again: ${errors}`);
      return 1;
    }
    if (h.review) {
      for (const f of parsed.data.findings) await ledger.addNote(h.item, h.attempt, "review", "reviewer", f);
      await ledger.note(h.item, "review_submitted", "agent", { findings: parsed.data.findings.length });
      console.log(`accepted ${parsed.data.findings.length} review findings. End your turn now.`);
      return 0;
    }
    await ledger.addSubmission(h.item, h.attempt, true, parsed.data);
    await ledger.note(h.item, "submitted", "agent", { status: parsed.data.status, summary: parsed.data.summary, decisions: parsed.data.decisions.length });
    console.log(`accepted (${parsed.data.status}). End your turn now; Foundry runs the verifiers.`);
    return 0;
  });
}

export async function cmdNote(args: string[], kind: "note" | "handoff"): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { kind: { type: "string" } } });
  const body = positionals.join(" ").trim();
  if (!body) throw new FoundryError("agent", `${kind} needs some text`, `./.foundry/bin/foundry ${kind} "..."`);
  return withItem(async (h, ledger) => {
    const k = kind === "handoff" ? "handoff" : values.kind === "design" ? "design" : "note";
    await ledger.addNote(h.item, h.attempt, k, "agent", body);
    await ledger.note(h.item, k, "agent", { body: body.slice(0, 500) });
    console.log(`recorded ${k} for ${h.item}`);
    return 0;
  });
}

export async function cmdAsk(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { question: { type: "string" }, option: { type: "string", multiple: true }, "no-other": { type: "boolean" }, file: { type: "string" } },
  });
  let raw: unknown;
  if (values.file) raw = JSON.parse(fs.readFileSync(values.file, "utf8"));
  else raw = { questions: [{ question: values.question, options: values.option ?? [], allow_other: !values["no-other"] }] };
  const parsed = Questions.safeParse(raw);
  if (!parsed.success) {
    console.error(`rejected: ${formatIssues(parsed.error)}`);
    return 1;
  }
  return withItem(async (h, ledger) => {
    const ids = await ledger.addQuestions(h.item, h.attempt, parsed.data.questions);
    console.log(`asked ${ids.join(", ")}. End your turn now; you will be resumed with the answer in your history.`);
    return 0;
  });
}
