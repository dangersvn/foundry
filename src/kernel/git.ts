// Plain git: one worktree and branch per attempt, one squashed commit per
// item, and a fast-forward of the target branch. Only the engine merges.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { FoundryError } from "./errors.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], next = "fix the repository state shown above, then run `foundry work`"): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new FoundryError("git", `git ${args.join(" ")} failed in ${cwd}: ${(err.stderr || err.message).trim()}`, next);
  }
}

async function ok(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec("git", args, { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"], "run foundry inside a git repository (or `git init` one first)");
}

// `main` if it exists, else the branch the repo has checked out.
export async function targetBranch(repo: string): Promise<string> {
  if (await ok(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main"])) return "main";
  const current = await git(repo, ["symbolic-ref", "--short", "HEAD"], "check out a branch to merge into, then run `foundry work`");
  return current;
}

// Keep Foundry's state dir (and any extra patterns, such as rendered role
// files) out of `git status` and commits without touching tracked files.
export async function excludeStateDir(repo: string, extra: string[] = []): Promise<void> {
  const common = path.resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"]));
  const exclude = path.join(common, "info", "exclude");
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const have = new Set(current.split("\n"));
  const missing = ["/.foundry/", ...extra].filter((p) => !have.has(p));
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

export async function createWorktree(repo: string, itemId: string, attempt: number): Promise<Worktree> {
  await excludeStateDir(repo);
  const name = `${itemId}-a${attempt}`;
  const wtPath = path.join(repo, ".foundry", "worktrees", name);
  const branch = `foundry/${name}`;
  const base = await git(repo, ["rev-parse", await targetBranch(repo)]);
  // A worktree for this same attempt exists only if a start was interrupted
  // before the agent ran; start it again clean.
  if (fs.existsSync(wtPath)) await git(repo, ["worktree", "remove", "--force", wtPath]);
  await git(repo, ["worktree", "prune"]);
  await git(repo, ["worktree", "add", "-q", "-B", branch, wtPath, base]);
  return { path: wtPath, branch, base };
}

async function identityArgs(cwd: string): Promise<string[]> {
  const email = await ok(cwd, ["config", "user.email"]);
  return email ? [] : ["-c", "user.name=Foundry", "-c", "user.email=foundry@localhost"];
}

// Squash everything in the worktree (agent commits and uncommitted changes)
// into one commit on top of `base`. Returns null when nothing changed.
export async function squashCommit(wt: string, base: string, subject: string, itemId: string): Promise<string | null> {
  await git(wt, ["reset", "-q", "--soft", base]);
  await git(wt, ["add", "-A"]);
  if (await ok(wt, ["diff", "--cached", "--quiet"])) return null;
  await git(wt, [...(await identityArgs(wt)), "commit", "-q", "--no-verify", "-m", subject, "-m", `Foundry-Item: ${itemId}`]);
  return git(wt, ["rev-parse", "HEAD"]);
}

// Put the item's commit on top of the current target, so what the verifier
// checks is exactly what lands.
export async function rebaseOnto(wt: string, target: string): Promise<string> {
  if (!(await ok(wt, ["merge-base", "--is-ancestor", target, "HEAD"]))) {
    if (!(await ok(wt, [...(await identityArgs(wt)), "rebase", "-q", target]))) {
      await ok(wt, ["rebase", "--abort"]);
      throw new FoundryError(
        "git",
        `the item's changes conflict with ${target}`,
        `resolve by hand in ${wt}, or re-run the formula on the new ${target}`,
      );
    }
  }
  return git(wt, ["rev-parse", "HEAD"]);
}

// Undo anything left in the worktree after `commit` (e.g. a reviewer's edits).
export async function resetWorktree(wt: string): Promise<void> {
  await git(wt, ["reset", "-q", "--hard", "HEAD"]);
  await git(wt, ["clean", "-q", "-fd"]);
}

export async function headSha(cwd: string, ref = "HEAD"): Promise<string> {
  return git(cwd, ["rev-parse", ref]);
}

export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return ok(cwd, ["merge-base", "--is-ancestor", a, b]);
}

// The commit that last changed `file:line` on `ref`, and its message.
export async function blameLine(repo: string, ref: string, file: string, line: number): Promise<{ sha: string; message: string }> {
  const out = await git(repo, ["blame", "-L", `${line},${line}`, "--porcelain", ref, "--", file], `check that ${file} has a line ${line} on ${ref}`);
  const sha = out.split(" ")[0]!;
  return { sha, message: await git(repo, ["log", "-1", "--format=%B", sha]) };
}

export async function fastForward(repo: string, target: string, sha: string): Promise<void> {
  const checkedOut = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  if (checkedOut === target) {
    await git(
      repo,
      ["merge", "-q", "--ff-only", sha],
      `commit or stash your changes in ${repo}, then run \`foundry work\` to retry the merge`,
    );
  } else {
    const old = await git(repo, ["rev-parse", target]);
    await git(repo, ["update-ref", `refs/heads/${target}`, sha, old]);
  }
}

// The merge marker: a commit on the target whose trailer names the item.
export async function findItemCommit(repo: string, target: string, itemId: string): Promise<string | null> {
  const out = await git(repo, ["log", target, "--format=%H", `--grep=^Foundry-Item: ${itemId}$`]);
  return out.split("\n")[0] || null;
}
