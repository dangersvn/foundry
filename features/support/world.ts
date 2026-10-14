import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { After, Before, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import { fakeAgentCommand } from "../../test/helpers.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tsx = import.meta.resolve("tsx");
setDefaultTimeout(60_000);
// tsx is loaded into this process through NODE_OPTIONS; children (the sample
// repo's npm test, the agents) must not inherit it.
delete process.env.NODE_OPTIONS;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class FoundryWorld extends World {
  dir = "";
  repo = "";
  itemId = "";
  mainBefore = "";
  result?: CliResult;
  background: ChildProcess[] = [];
  results: CliResult[] = [];
  mainObservations: { t: number; sha: string; clean: boolean }[] = [];

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.repo, encoding: "utf8" }).trim();
  }

  createSampleRepo(): void {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-feature-"));
    this.repo = path.join(this.dir, "sample-app");
    fs.cpSync(path.join(root, "examples/sample-app"), this.repo, { recursive: true });
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.email", "dev@example.com");
    this.git("config", "user.name", "Dev");
    this.git("add", "-A");
    this.git("commit", "-qm", "sample app");
  }

  npmTest(): CliResult {
    try {
      const stdout = execFileSync("npm", ["test"], { cwd: this.repo, encoding: "utf8", stdio: "pipe" });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  }

  writeConfig(agents: Record<string, string[]>, extra = ""): void {
    const body = Object.entries(agents)
      .map(([name, cmd]) => `[agents.${name}]\ncommand = ${JSON.stringify(cmd)}\n`)
      .join("\n");
    // foundry.toml is team config, so it lives untracked here to keep main's history to the sample.
    fs.writeFileSync(path.join(this.repo, "foundry.toml"), body + extra);
    fs.appendFileSync(path.join(this.repo, ".git/info/exclude"), "/foundry.toml\n");
  }

  configureFake(...args: string[]): void {
    const plan = path.join(root, "features/support/plans/health-endpoint.json");
    this.writeConfig({ fake: fakeAgentCommand("--plan", plan, ...args) }, "\n[leases]\nttl_seconds = 2\n");
  }

  foundryArgs(args: string[]): string[] {
    return ["--import", tsx, path.join(root, "src/cli/main.ts"), ...args];
  }

  startFoundry(args: string[]): { child: ChildProcess; done: Promise<CliResult> } {
    const child = spawn(process.execPath, this.foundryArgs(args), { cwd: this.repo, stdio: ["ignore", "pipe", "pipe"] });
    this.background.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const done = new Promise<CliResult>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
    return { child, done };
  }

  async foundry(...args: string[]): Promise<CliResult> {
    return this.startFoundry(args).done;
  }

  itemFrom(stdout: string): string {
    const m = stdout.match(/created (WI-\d+)/);
    if (!m) throw new Error(`no item id in output:\n${stdout}`);
    return m[1]!;
  }
}

setWorldConstructor(FoundryWorld);

Before(function (this: FoundryWorld) {
  this.background = [];
});

// Real-agent repos are kept so their ledger can be read for docs/baseline.md.
After(function (this: FoundryWorld, { result, pickle }) {
  for (const c of this.background) if (c.exitCode === null) c.kill("SIGKILL");
  const real = pickle.tags.some((t) => t.name === "@real-agent");
  if (result?.status === "PASSED" && !real && this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
  else if (this.dir) console.log(`\n  repo kept for inspection: ${this.repo}  (try: cd there && foundry status ${this.itemId})`);
});
