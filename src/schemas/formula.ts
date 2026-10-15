import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { FoundryError } from "../kernel/errors.js";

// A step: an agent (or a script the engine runs) works toward a goal in its
// own worktree. `needs` orders steps; `per` fans a step out over a list an
// earlier step submitted under that name.
export const Step = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
  type: z.enum(["agent", "script"]).default("agent"),
  role: z.string().default("worker"),
  instructions: z.string().optional(), // a step instructions file, relative to the pack
  goal: z.string().default(""),
  needs: z.array(z.string()).default([]),
  per: z.string().optional(),
  verify: z.string().optional(),
  gate: z.enum(["human"]).optional(),
  review: z.string().optional(), // a reviewer role; advisory in v1
  max_attempts: z.number().int().positive().default(3),
  run: z.string().optional(), // the command of a script step
  // v0 one-step formulas finish on the verifier alone; v1 steps must submit.
  submit: z.boolean().default(true),
  // Upstream outputs this step reads; `required = false` inputs may be absent.
  inputs: z
    .array(z.object({ from: z.string(), name: z.string().optional(), required: z.boolean().default(false), conditional_on: z.string().optional() }))
    .default([]),
  // Set by imported packs: a step that may legitimately be skipped.
  conditional: z.boolean().default(false),
  // A step that would change a real environment stops at a gate with its plan.
  environment_change: z.boolean().default(false),
  // Named outputs later steps may read (imported packs list the artifacts).
  outputs: z.array(z.string()).default([]),
  // Pack verifiers run after `verify` (see verifiers/<id>.toml).
  verifiers: z.array(z.string()).default([]),
  // Pack files the step's instructions refer to; copied into the worktree.
  context: z.array(z.string()).default([]),
  // Roles that could help; recorded only (collaborators are off in v1).
  support_roles: z.array(z.string()).default([]),
  phase: z.string().optional(),
  // What the gate is for, e.g. "plan approval".
  gate_note: z.string().optional(),
  // The step only writes documents: it works in the run's docs lane, whose
  // commits merge together at the end of the run.
  docs_only: z.boolean().default(false),
});
export type Step = z.infer<typeof Step>;

const V0Step = z.object({ id: z.string().min(1), goal: z.string().min(1), verify: z.string().min(1) });

export const Formula = z
  .object({
    formula: z.string().min(1),
    version: z.number().int().positive(),
    title: z.string().optional(),
    // The full verify the refinery runs on main's next commit; defaults to each step's verify.
    verify: z.string().optional(),
    step: V0Step.optional(),
    steps: z.array(Step).optional(),
  })
  .transform((f, ctx) => {
    if (f.step && f.steps) ctx.addIssue({ code: "custom", message: "use either [step] or [[steps]], not both" });
    if (!f.step && !f.steps?.length) {
      ctx.addIssue({ code: "custom", path: ["step", "verify"], message: "a formula needs [step] (with goal and verify) or [[steps]]" });
      return z.NEVER;
    }
    const steps: Step[] = f.step
      ? [Step.parse({ id: f.step.id, goal: f.step.goal, verify: f.step.verify, submit: false })]
      : f.steps!;
    return { formula: f.formula, version: f.version, title: f.title, verify: f.verify, steps, oneStep: !!f.step };
  })
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    for (const s of f.steps) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps"], message: `step "${s.id}" is defined twice` });
      ids.add(s.id);
    }
    for (const s of f.steps) {
      for (const n of s.needs) if (!ids.has(n)) ctx.addIssue({ code: "custom", path: ["steps", s.id, "needs"], message: `"${n}" is not a step` });
      if (s.type === "script" && !s.run) ctx.addIssue({ code: "custom", path: ["steps", s.id, "run"], message: "a script step needs a run command" });
      if (s.type === "agent" && !s.goal && !s.instructions) {
        ctx.addIssue({ code: "custom", path: ["steps", s.id], message: "an agent step needs a goal or an instructions file" });
      }
    }
    const cycle = findCycle(f.steps);
    if (cycle) ctx.addIssue({ code: "custom", path: ["steps"], message: `steps depend on each other in a cycle: ${cycle.join(" -> ")}` });
  });
export type Formula = z.infer<typeof Formula>;

function findCycle(steps: Step[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const n of byId.get(id)?.needs ?? []) {
      const c = visit(n);
      if (c) return c;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const s of steps) {
    const c = visit(s.id);
    if (c) return c;
  }
  return null;
}

export function parseFormula(text: string, source = "formula"): Formula {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new FoundryError("config", `${source} is not valid TOML: ${(e as Error).message}`, `fix ${source}`);
  }
  const result = Formula.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new FoundryError("config", `${source} is invalid: ${issues}`, `fix ${source} (see formulas/health-endpoint.toml)`);
  }
  return result.data;
}
