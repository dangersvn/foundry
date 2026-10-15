import { describe, expect, it } from "vitest";
import { globToRegExp, lockedFiles } from "../src/kernel/autopilot.js";

describe("locked paths", () => {
  it("matches ** across folders and * within one", () => {
    expect(globToRegExp("payments/**").test("payments/charge.ts")).toBe(true);
    expect(globToRegExp("payments/**").test("payments/a/b.ts")).toBe(true);
    expect(globToRegExp("payments/**").test("src/payments.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/app.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/auth/app.ts")).toBe(false);
    expect(globToRegExp("**/secrets.json").test("config/prod/secrets.json")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("lists the changed files a gate must hold for", () => {
    expect(lockedFiles(["src/app.js", "payments/charge.ts", "infra/main.tf"], ["payments/**", "infra/**"])).toEqual(["payments/charge.ts", "infra/main.tf"]);
    expect(lockedFiles(["src/app.js"], [])).toEqual([]);
  });
});

describe("evidence", () => {
  it("resolves the request, approved artifacts, workspace files and live decisions; anything else is a problem", async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { Ledger } = await import("../src/kernel/ledger.js");
    const { checkEvidence } = await import("../src/kernel/autopilot.js");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    git("init", "-q", "-b", "main");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/app.js"), "x\n");
    git("add", "-A");
    git("-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "init");
    const ledger = await Ledger.open(path.join(repo, "l.db"));
    const steps = ["a", "b"].map((id, i) => ({ id, type: "agent", role: "worker", goal: "g", needs: i ? ["a"] : [], max_attempts: 3, submit: true, inputs: [], conditional: false, environment_change: false, docs_only: false }));
    const { runId } = await ledger.startRun({ formula: { formula: "f", version: 1, oneStep: false, steps } as never, title: "t", input: "use a database for units", packDir: null });
    await ledger.claim("WI-1", "w", 60);
    await ledger.transition("WI-1", "w", "running", "done", "merged", {}, { result_json: JSON.stringify({ summary: "s", artifacts: [{ path: "src/app.js", summary: "app" }], decisions: [] }) });
    const [dec] = await ledger.addAgentDecisions("WI-1", 1, "worker@fake", [{ kind: "decision", question: "q", choice: "c", alternatives: [], rationale: "r", evidence: [], affects: [], reversible: true }]);
    const ws = { repo, ledger } as never;
    const run = (await ledger.getRun(runId))!;
    const item = (await ledger.getItem("WI-2"))!;
    const ok = await checkEvidence(ws, run, item, [
      { kind: "request", quote: "database" },
      { kind: "artifact", ref: "src/app.js" },
      { kind: "context", ref: "src/app.js" },
      { kind: "decision", ref: dec },
    ]);
    expect(ok).toEqual({ valid: true, resolved: ["request", "artifact:src/app.js", "context:src/app.js", `decision:${dec}`], problems: [] });
    const bad = await checkEvidence(ws, run, item, [{ kind: "request", quote: "Postgres" }, { kind: "artifact", ref: "README.md" }, { kind: "context", ref: "../etc/passwd" }, { kind: "decision", ref: "DEC-99" }]);
    expect(bad.valid).toBe(false);
    expect(bad.problems).toEqual(['the request does not say "Postgres"', "README.md is not an artifact of a finished item in RUN-1", "../etc/passwd is not a file in the workspace", "no decision DEC-99"]);
    expect((await checkEvidence(ws, run, item, [])).problems).toEqual(["no evidence cited"]);
    await ledger.rejectDecision(dec!, "person:T", "wrong");
    expect((await checkEvidence(ws, run, item, [{ kind: "decision", ref: dec }])).problems).toEqual([`${dec} was rejected`]);
    await ledger.close();
  });
});
