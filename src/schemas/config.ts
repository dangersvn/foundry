import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { FoundryError } from "../kernel/errors.js";

export const AgentConfig = z.object({
  command: z.array(z.string()).min(1),
  // How roles are rendered into the agent's native files (see runtime/render.ts).
  render: z.enum(["kiro", "claude", "none"]).default("none"),
});

export const Config = z
  .object({
    agents: z.record(z.string(), AgentConfig).refine((a) => Object.keys(a).length > 0, {
      message: "list at least one agent under [agents.<name>]",
    }),
    dispatch: z.object({ prefer: z.array(z.string()).optional() }).default({}),
    leases: z.object({ ttl_seconds: z.number().positive().default(120) }).default({ ttl_seconds: 120 }),
    workers: z
      .object({ count: z.number().int().positive().default(3), stall_seconds: z.number().positive().default(600) })
      .default({ count: 3, stall_seconds: 600 }),
    aidlc: z.object({ source: z.string().default("vendor/aidlc-workflows") }).default({ source: "vendor/aidlc-workflows" }),
    // Layered rules loaded into every envelope, general to specific.
    rules: z.object({ org: z.string().optional(), team: z.string().optional(), project: z.string().optional() }).default({}),
  })
  .superRefine((cfg, ctx) => {
    for (const name of cfg.dispatch.prefer ?? []) {
      if (!cfg.agents[name]) {
        ctx.addIssue({
          code: "custom",
          path: ["dispatch", "prefer"],
          message: `"${name}" is not configured; add [agents.${name}] or remove it from prefer`,
        });
      }
    }
  });
export type Config = z.infer<typeof Config>;

export function parseConfig(text: string, source = "foundry.toml"): Config {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (e) {
    throw new FoundryError("config", `${source} is not valid TOML: ${(e as Error).message}`, `fix ${source}`);
  }
  const result = Config.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new FoundryError("config", `${source} is invalid: ${issues}`, `fix ${source} (see README.md)`);
  }
  return result.data;
}

// The first preferred agent, else the first configured one.
export function pickAgent(cfg: Config): string {
  return cfg.dispatch.prefer?.[0] ?? Object.keys(cfg.agents)[0]!;
}
