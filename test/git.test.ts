import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as git from "../src/kernel/git.js";
import { runVerify } from "../src/kernel/verifier.js";

let repo: string;
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const count = (ref = "main") => Number(sh(repo, "rev-list", "--count", ref));

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "init");
});

describe("git", () => {
  it("creates a worktree on its own branch and keeps .foundry out of git status", async () => {
    const wt = await git.createWorktree(repo, "WI-1", 1);
    expect(wt.branch).toBe("foundry/WI-1-a1");
    expect(fs.existsSync(path.join(wt.path, "a.txt"))).toBe(true);
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("recreates a worktree left from an interrupted start", async () => {
    const first = await git.createWorktree(repo, "WI-1", 1);
    fs.writeFileSync(path.join(first.path, "junk.txt"), "x");
    const again = await git.createWorktree(repo, "WI-1", 1);
    expect(fs.existsSync(path.join(again.path, "junk.txt"))).toBe(false);
  });

  it("squashes the agent's work, including its own commits, into one commit", async () => {
    const wt = await git.createWorktree(repo, "WI-1", 1);
    expect(await git.squashCommit(wt.path, wt.base, "WI-1: t", "WI-1")).toBeNull();
    fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n");
    sh(wt.path, "add", "-A");
    sh(wt.path, "commit", "-qm", "agent commit");
    fs.writeFileSync(path.join(wt.path, "c.txt"), "c\n");
    const sha = await git.squashCommit(wt.path, wt.base, "WI-1: t", "WI-1");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(count(sha!)).toBe(2);
    expect(sh(wt.path, "log", "-1", "--format=%B")).toContain("Foundry-Item: WI-1");
  });

  it("rebases onto main when main moved, then fast-forwards main and its checkout", async () => {
    const wt = await git.createWorktree(repo, "WI-1", 1);
    fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n");
    await git.squashCommit(wt.path, wt.base, "WI-1: t", "WI-1");
    fs.writeFileSync(path.join(repo, "other.txt"), "o\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "someone else");
    const target = await git.targetBranch(repo);
    const sha = await git.rebaseOnto(wt.path, target);
    await git.fastForward(repo, target, sha);
    expect(sh(repo, "rev-parse", "main")).toBe(sha);
    expect(fs.readFileSync(path.join(repo, "b.txt"), "utf8")).toBe("b\n");
    expect(sh(repo, "status", "--porcelain")).toBe("");
    expect(await git.findItemCommit(repo, "main", "WI-1")).toBe(sha);
    expect(await git.findItemCommit(repo, "main", "WI-11")).toBeNull();
  });

  it("names the git layer when the repo is not a git repo", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"));
    await expect(git.repoRoot(plain)).rejects.toMatchObject({ layer: "git" });
  });
});

describe("verifier", () => {
  it("passes on exit 0 and fails with the output otherwise", async () => {
    expect((await runVerify(repo, "echo ok")).passed).toBe(true);
    const r = await runVerify(repo, "echo boom >&2; exit 3");
    expect(r).toMatchObject({ passed: false, exitCode: 3 });
    expect(r.output).toContain("boom");
  });
});
