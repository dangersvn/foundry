import { z } from "zod";

// What an agent hands back with `foundry submit --file result.json`. This and
// `foundry ask` are the only ways agent output enters the kernel.
export const AgentDecision = z.object({
  kind: z.enum(["decision", "assumption", "deviation"]),
  question: z.string().min(1),
  choice: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  affects: z.array(z.string()).default([]),
  reversible: z.boolean().default(true),
  supersedes: z.string().optional(),
});
export type AgentDecision = z.infer<typeof AgentDecision>;

export const Result = z
  .object({
    status: z.enum(["done", "skipped"]),
    summary: z.string().min(1),
    reason: z.string().optional(),
    // Named outputs later steps can read; a list can drive a `per` fan-out.
    outputs: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
    artifacts: z.array(z.object({ path: z.string(), summary: z.string() })).default([]),
    // Reviewer roles report findings here.
    findings: z.array(z.string()).default([]),
    decisions: z.array(AgentDecision),
  })
  .superRefine((r, ctx) => {
    if (r.status === "skipped" && !r.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "a skipped step needs a reason" });
  });
export type Result = z.infer<typeof Result>;

export const Questions = z.object({
  questions: z
    .array(z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(1), allow_other: z.boolean().default(true) }))
    .min(1),
});
export type Questions = z.infer<typeof Questions>;

export function formatIssues(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// Evidence an autopilot resolver cites. The kernel checks that each one
// resolves: the run's request, an approved artifact, a file in the
// workspace, or a decision record.
export const Citation = z.object({
  kind: z.enum(["request", "artifact", "context", "decision"]),
  ref: z.string().optional(), // artifact or file path, or DEC-n
  quote: z.string().optional(), // for request: words that appear in it
});
export type Citation = z.infer<typeof Citation>;

// What the answerer submits for a question, and the reviewer for a gate.
export const AnswerResolution = z.object({
  answers: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1), rationale: z.string().min(1), evidence: z.array(Citation).default([]) }))
    .min(1),
});
export const GateResolution = z.object({
  verdict: z.enum(["approve", "reject"]),
  comment: z.string().min(1),
  findings: z.array(z.string()).default([]),
  evidence: z.array(Citation).default([]),
});
export type AnswerResolution = z.infer<typeof AnswerResolution>;
export type GateResolution = z.infer<typeof GateResolution>;

// What an eval judge submits: the rubric for a replayed document output.
export const JudgeResult = z.object({
  criteria: z.object({ goal: z.boolean(), inputs: z.boolean(), grounded: z.boolean(), complete: z.boolean() }),
  comment: z.string().min(1),
});
export type JudgeResult = z.infer<typeof JudgeResult>;
