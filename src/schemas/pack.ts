// A pack is a folder that defines a factory: pack.toml, a formula, roles
// (prompt, knowledge, tools, output schema) and step instructions.
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { FoundryError } from "../kernel/errors.js";
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
});

export interface Pack {
  dir: string | null; // null for a bare formula file
  name: string;
  version: string;
  formula: Formula;
  roles: Map<string, Role & { promptText: string }>;
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
    return { dir: null, name: formula.formula, version: String(formula.version), formula, roles: new Map() };
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
  return { dir: target, name: manifest.name, version: manifest.version, formula, roles };
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
  for (const [name, r] of pack.roles) {
    for (const k of r.knowledge) if (!exists(k)) problems.push(`role ${name}: knowledge ${k} not found`);
    if (r.output_schema && !exists(r.output_schema)) problems.push(`role ${name}: output schema ${r.output_schema} not found`);
  }
  return problems;
}
