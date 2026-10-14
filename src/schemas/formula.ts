import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { FoundryError } from "../kernel/errors.js";

// v0 formulas have exactly one step: a goal for the agent and a verify
// command the engine runs in the worktree.
export const Formula = z.object({
  formula: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().optional(),
  step: z.object({
    id: z.string().min(1),
    goal: z.string().min(1),
    verify: z.string().min(1),
  }),
});
export type Formula = z.infer<typeof Formula>;

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
