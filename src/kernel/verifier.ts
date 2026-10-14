// The verifier runs the formula's verify command in the worktree. Its exit
// code is the only thing that can let an item merge.
import { spawn } from "node:child_process";

export interface VerifyResult {
  passed: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export function runVerify(cwd: string, command: string, timeoutMs = 10 * 60_000): Promise<VerifyResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (d: Buffer) => (output += d.toString());
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      output += `\n[foundry] verify command timed out after ${timeoutMs / 1000}s\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, exitCode: code, output, durationMs: Date.now() - t0 });
    });
  });
}
