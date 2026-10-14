// Compile, then run: a pack and a profile resolve into the concrete formula a
// run pins, plus its parameters. Deterministic given the pack, profile,
// parameters and repository contents.
import { execFileSync } from "node:child_process";
import type { Formula, Step } from "../schemas/formula.js";
import type { Pack } from "../schemas/pack.js";
import { FoundryError } from "./errors.js";

export interface Compiled {
  formula: Formula;
  profile: string | null;
  params: Record<string, string>;
  settings: Record<string, string | boolean>;
  setup: { project_type?: { value: string; detected: boolean }; dropped: string[] };
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|cs|php|swift|c|cc|cpp|h|scala|sql|sh)$/;

// Brownfield when the repository already tracks source files.
export function detectProjectType(repo: string): "brownfield" | "greenfield" {
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n");
  } catch {}
  return files.some((f) => CODE.test(f)) ? "brownfield" : "greenfield";
}

export function compile(pack: Pack, opts: { profile?: string; params?: Record<string, string>; repo?: string; testCommand?: string }): Compiled {
  const all = pack.formula.steps;
  let steps: Step[] = all;
  let params: Record<string, string> = {};
  let settings: Record<string, string | boolean> = {};
  if (opts.profile) {
    const p = pack.profiles.get(opts.profile);
    if (!p) {
      throw new FoundryError("config", `pack ${pack.name} has no profile "${opts.profile}"`, `pick one of: ${[...pack.profiles.keys()].join(", ")}`);
    }
    const keep = new Set(p.steps);
    const byId = new Map(all.map((s) => [s.id, s]));
    // A need on a step outside the profile becomes a need on that step's own needs.
    const needsIn = (ids: string[], seen = new Set<string>()): string[] =>
      ids.flatMap((n) => {
        if (seen.has(n)) return [];
        seen.add(n);
        return keep.has(n) ? [n] : needsIn(byId.get(n)?.needs ?? [], seen);
      });
    const producedIn = (name: string) => all.some((s) => keep.has(s.id) && s.outputs.includes(name));
    steps = all
      .filter((s) => keep.has(s.id))
      .map((s) => ({
        ...s,
        needs: [...new Set(needsIn(s.needs))],
        // Without the step that lists the units, the step runs once.
        per: s.per && producedIn(s.per) ? s.per : undefined,
        inputs: s.inputs.filter((i) => keep.has(i.from)),
      }));
    params = { ...p.params };
    settings = { ...p.settings };
  }
  params = { ...params, ...(opts.params ?? {}) };
  const setup: Compiled["setup"] = { dropped: pack.setup.dropped };
  if (pack.setup.detect_project_type && (params.project_type ?? "auto") === "auto") {
    params.project_type = opts.repo ? detectProjectType(opts.repo) : "auto";
    setup.project_type = { value: params.project_type, detected: true };
  } else if (params.project_type) {
    setup.project_type = { value: params.project_type, detected: false };
  }
  const formula: Formula = {
    ...pack.formula,
    steps,
    // The refinery runs the project's tests on every merge.
    verify: pack.formula.verify ?? opts.testCommand,
  };
  return { formula, profile: opts.profile ?? null, params, settings, setup };
}

export function describePlan(c: Compiled, pack: Pack) {
  const lead = c.settings.collaborators === false || c.settings.collaborators === undefined;
  return {
    pack: pack.name,
    version: pack.version,
    profile: c.profile,
    params: c.params,
    settings: c.settings,
    setup: c.setup,
    merge_verify: c.formula.verify ?? null,
    steps: c.formula.steps.map((s, i) => ({
      n: i + 1,
      id: s.id,
      phase: s.phase ?? null,
      roles: lead ? [s.role] : [s.role, ...s.support_roles],
      needs: s.needs,
      per: s.per ?? null,
      gate: s.gate ?? (s.environment_change ? "human" : null),
      gate_note: s.gate_note ?? null,
      plan_approval: s.gate === "human" && s.gate_note === "plan approval" && c.settings.plan_approval !== false,
      review: s.review ? { role: s.review, advisory: c.settings.review !== "blocking" } : null,
      conditional: s.conditional,
      environment_change: s.environment_change,
      verifiers: s.verifiers,
      inputs: s.inputs.map((x) => `${x.from}:${x.name ?? "*"}${x.required ? "" : "?"}`),
    })),
  };
}
