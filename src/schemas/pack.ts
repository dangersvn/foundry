// A pack is a folder that defines a factory: pack.toml, a formula, roles
// (prompt, knowledge, tools, output schema) and step instructions.
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { FoundryError } from "../kernel/errors.js";
import { BUILTIN_CHECKS } from "../kernel/checks.js";
import { parseFormula, type Formula } from "./formula.js";

export const Role = z.object({
  role: z.string().min(1),
  description: z.string().default(""),
  prompt: z.string().optional(), // a markdown file relative to the pack
  knowledge: z.array(z.string()).default([]), // files relative to the pack
  tools_allowed: z.array(z.enum(["read", "write", "shell"])).default(["read", "write", "shell"]),
  output_schema: z.string().optional(),
});
export type Role = z.infer<typeof Role>;

export const PackManifest = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  formula: z.string().default("formula.toml"),
  // The roles that resolve decision points in autopilot.
  autopilot: z.object({ answerer: z.string().default("answerer"), reviewer: z.string().default("reviewer") }).default({ answerer: "answerer", reviewer: "reviewer" }),
});

// A profile resolves at compile time into a concrete plan: which steps run,
// parameter defaults, and the settings the run uses.
export const Profile = z.object({
  profile: z.string().min(1),
  description: z.string().default(""),
  steps: z.array(z.string()),
  params: z.record(z.string(), z.string()).default({}),
  settings: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  source_settings: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
});
export type Profile = z.infer<typeof Profile>;

// A pack verifier: a built-in deterministic check (src/kernel/checks.ts).
export const VerifierDef = z.object({
  id: z.string().min(1),
  builtin: z.string().min(1),
  severity: z.enum(["advisory", "blocking"]).default("advisory"),
  description: z.string().default(""),
  matches: z.string().optional(),
  fire_on: z.string().optional(),
});
export type VerifierDef = z.infer<typeof VerifierDef>;

// Run setup: what happens before the first step (detect parameters).
export const Setup = z.object({
  detect_project_type: z.boolean().default(false),
  dropped: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

export interface Pack {
  dir: string | null; // null for a bare formula file
  name: string;
  version: string;
  formula: Formula;
  roles: Map<string, Role & { promptText: string }>;
  profiles: Map<string, Profile>;
  verifiers: Map<string, VerifierDef>;
  setup: z.infer<typeof Setup>;
  autopilot: { answerer: string; reviewer: string };
}

export const DEFAULT_ROLE = "worker";

function readToml(file: string): unknown {
  try {
    return parseToml(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new FoundryError("config", `${file} is not valid TOML: ${(e as Error).message}`, `fix ${file}`);
  }
}

function check<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new FoundryError("config", `${file} is invalid: ${issues}`, `fix ${file}`);
  }
  return r.data;
}

// Loads a pack folder, or wraps a bare formula file as a pack with no roles.
export function loadPack(target: string): Pack {
  if (fs.statSync(target).isFile()) {
    const formula = parseFormula(fs.readFileSync(target, "utf8"), target);
    return { dir: null, name: formula.formula, version: String(formula.version), formula, roles: new Map(), profiles: new Map(), verifiers: new Map(), setup: Setup.parse({}), autopilot: { answerer: "answerer", reviewer: "reviewer" } };
  }
  const manifestPath = path.join(target, "pack.toml");
  if (!fs.existsSync(manifestPath)) throw new FoundryError("config", `${target} has no pack.toml`, "pass a pack folder or a formula .toml file");
  const manifest = check(PackManifest, readToml(manifestPath), manifestPath);
  const formulaPath = path.join(target, manifest.formula);
  const formula = parseFormula(fs.readFileSync(formulaPath, "utf8"), formulaPath);
  const roles = new Map<string, Role & { promptText: string }>();
  const rolesDir = path.join(target, "roles");
  if (fs.existsSync(rolesDir)) {
    for (const f of fs.readdirSync(rolesDir).filter((f) => f.endsWith(".toml")).sort()) {
      const file = path.join(rolesDir, f);
      const role = check(Role, readToml(file), file);
      const promptText = role.prompt ? fs.readFileSync(path.join(target, role.prompt), "utf8") : "";
      roles.set(role.role, { ...role, promptText });
    }
  }
  const tomls = (sub: string) => {
    const d = path.join(target, sub);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".toml")).sort().map((f) => path.join(d, f)) : [];
  };
  const profiles = new Map(tomls("profiles").map((f) => check(Profile, readToml(f), f)).map((p) => [p.profile, p] as const));
  const verifiers = new Map(tomls("verifiers").map((f) => check(VerifierDef, readToml(f), f)).map((v) => [v.id, v] as const));
  const setupPath = path.join(target, "setup.toml");
  const setup = fs.existsSync(setupPath) ? check(Setup, readToml(setupPath), setupPath) : Setup.parse({});
  return { dir: target, name: manifest.name, version: manifest.version, formula, roles, profiles, verifiers, setup, autopilot: manifest.autopilot };
}

// Every reference in a pack resolves: roles, instructions, knowledge, schemas.
export function validatePack(pack: Pack): string[] {
  const problems: string[] = [];
  const exists = (rel: string) => pack.dir !== null && fs.existsSync(path.join(pack.dir, rel));
  for (const s of pack.formula.steps) {
    if (s.type === "agent" && s.role !== DEFAULT_ROLE && !pack.roles.has(s.role)) problems.push(`step ${s.id}: role "${s.role}" is not in roles/`);
    if (s.review && !pack.roles.has(s.review)) problems.push(`step ${s.id}: review role "${s.review}" is not in roles/`);
    if (s.instructions && !exists(s.instructions)) problems.push(`step ${s.id}: instructions ${s.instructions} not found`);
    if (s.per && !s.needs.length) problems.push(`step ${s.id}: per "${s.per}" needs an earlier step to produce it`);
    for (const i of s.inputs) if (!pack.formula.steps.some((x) => x.id === i.from)) problems.push(`step ${s.id}: input from unknown step "${i.from}"`);
  }
  for (const s of pack.formula.steps) {
    for (const v of s.verifiers) if (!pack.verifiers.has(v)) problems.push(`step ${s.id}: verifier "${v}" is not in verifiers/`);
    for (const c of s.context) if (!exists(c)) problems.push(`step ${s.id}: context file ${c} not found`);
  }
  for (const [name, v] of pack.verifiers) if (!BUILTIN_CHECKS.has(v.builtin)) problems.push(`verifier ${name}: no built-in check "${v.builtin}"`);
  // A role named in [autopilot] must exist; the default names may be absent.
  for (const [k, role] of Object.entries(pack.autopilot)) if (role !== k && !pack.roles.has(role)) problems.push(`autopilot ${k}: role "${role}" is not in roles/`);
  for (const [name, p] of pack.profiles) {
    for (const id of p.steps) if (!pack.formula.steps.some((s) => s.id === id)) problems.push(`profile ${name}: step "${id}" is not in the formula`);
  }
  for (const [name, r] of pack.roles) {
    for (const k of r.knowledge) if (!exists(k)) problems.push(`role ${name}: knowledge ${k} not found`);
    if (r.output_schema && !exists(r.output_schema)) problems.push(`role ${name}: output schema ${r.output_schema} not found`);
  }
  return problems;
}
