// Renders a role into an agent's native files inside the item's worktree.
// Agent-specific code lives here, outside the kernel; foundry.toml picks the
// renderer per agent with `render = "kiro" | "claude"`. The role prompt also
// travels in the envelope, so a role works where an agent ignores these.
import fs from "node:fs";
import path from "node:path";

export type Renderer = "kiro" | "claude" | "none";

export interface RoleToRender {
  name: string;
  description: string;
  prompt: string;
  knowledge: string[]; // paths relative to the worktree
  tools: ("read" | "write" | "shell")[];
}

// Files written here are excluded from commits (see git.excludeStateDir).
export const RENDERED_PATHS = ["/.kiro/agents/foundry-*.json", "/CLAUDE.local.md", "/.claude/settings.local.json"];

export function renderRole(kind: Renderer, worktree: string, role: RoleToRender): { args: string[]; files: string[] } {
  const safe = role.name.replace(/[^a-z0-9-]/gi, "-");
  if (kind === "kiro") {
    const file = path.join(worktree, ".kiro", "agents", `foundry-${safe}.json`);
    const tools = ["fs_read", "thinking", ...(role.tools.includes("write") ? ["fs_write"] : []), ...(role.tools.includes("shell") ? ["execute_bash"] : [])];
    const profile = {
      name: `foundry-${safe}`,
      description: role.description || `Foundry role ${role.name}`,
      prompt: role.prompt,
      tools,
      // Reads run without asking; every write and shell call goes to Foundry's policy.
      allowedTools: ["fs_read", "thinking"],
      resources: role.knowledge.map((k) => `file://${k}`),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n");
    return { args: ["--agent", profile.name], files: [file] };
  }
  if (kind === "claude") {
    const md = path.join(worktree, "CLAUDE.local.md");
    const body = [
      `# Foundry role: ${role.name}`,
      "",
      role.prompt.trim(),
      "",
      ...(role.knowledge.length ? ["## Knowledge", "", ...role.knowledge.map((k) => `- @${k}`), ""] : []),
    ].join("\n");
    fs.writeFileSync(md, body + "\n");
    const deny = [...(role.tools.includes("write") ? [] : ["Edit", "Write", "NotebookEdit"]), ...(role.tools.includes("shell") ? [] : ["Bash"])];
    const settings = path.join(worktree, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ permissions: { deny } }, null, 2) + "\n");
    return { args: [], files: [md, settings] };
  }
  return { args: [], files: [] };
}
