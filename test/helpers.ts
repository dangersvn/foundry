import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Absolute loader URL: the agent runs with cwd = a worktree, where a bare
// `--import tsx` would not resolve.
const tsx = import.meta.resolve("tsx");

export const fakeAgentCommand = (...args: string[]) => [process.execPath, "--import", tsx, path.join(root, "test/fake-agent.ts"), ...args];

// This repo's foundry CLI, as the `./.foundry/bin/foundry` wrapper runs it.
export const foundryCommand = () => [process.execPath, "--import", tsx, path.join(root, "src/cli/main.ts")];
