import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCalls } from "../src/import/calls.js";
import { parseRules, rewrite, UnmatchedCall } from "../src/import/rewrites.js";
import { BUILTIN_CHECKS } from "../src/kernel/checks.js";
import { compile } from "../src/kernel/compile.js";
import { buildEnvelope } from "../src/kernel/envelope.js";
import { Step } from "../src/schemas/formula.js";
import { loadPack } from "../src/schemas/pack.js";

const rules = parseRules("docs/aidlc-rewrites.md");

describe("engine-call rewrites", () => {
  it("finds inline calls, fenced lines with continuations, and bare `next`", () => {
    const text = [
      "Hand completion via `{{INVOKE}} engine orchestrate report --stage x --result <outcome>`.",
      "```bash",
      "{{INVOKE}} engine state practices-event \\",
      "  --type discovered",
      "echo fine",
      "```",
      "then run `next`, not `next door`.",
    ].join("\n");
    expect(findCalls(text).map((c) => c.text)).toEqual([
      "{{INVOKE}} engine orchestrate report --stage x --result <outcome>",
      "{{INVOKE}} engine state practices-event \\\n  --type discovered",
      "next",
    ]);
  });

  it("rewrites calls to Foundry commands and reports each one", () => {
    const { text, applied } = rewrite("Finish with `{{INVOKE}} engine orchestrate report --stage a --result <outcome>` and read `{{HARNESS_DIR}}/knowledge/x/y.md`.", rules, "a.md");
    expect(text).toBe("Finish with `./.foundry/bin/foundry submit --file .foundry/result.json` and read `.foundry/pack/knowledge/x/y.md`.");
    expect(applied.map((a) => a.rule)).toEqual(["report", "knowledge-path"]);
  });

  it("fails on a call the table does not cover, naming where and what", () => {
    expect(() => rewrite("line one\nrun `{{INVOKE}} engine frobnicate`", rules, "stage x.md")).toThrow(UnmatchedCall);
    try {
      rewrite("line one\nrun `{{INVOKE}} engine frobnicate`", rules, "stage x.md");
    } catch (e) {
      expect((e as Error).message).toBe("stage x.md line 2: no rewrite rule matches the engine call `{{INVOKE}} engine frobnicate`");
    }
  });
});

describe("profile compile", () => {
  const pack = loadPack("packs/aidlc");

  it("bugfix: 6 steps, needs re-linked past dropped stages, no per without units-generation", () => {
    const c = compile(pack, { profile: "bugfix" });
    expect(c.formula.steps.map((s) => s.id)).toEqual([
      "reverse-engineering",
      "requirements-analysis",
      "code-generation",
      "build-and-test",
      "deployment-pipeline",
      "deployment-execution",
    ]);
    const ids = new Set(c.formula.steps.map((s) => s.id));
    for (const s of c.formula.steps) {
      for (const n of s.needs) expect(ids.has(n)).toBe(true);
      for (const i of s.inputs) expect(ids.has(i.from)).toBe(true);
    }
    expect(c.formula.steps.find((s) => s.id === "code-generation")!.per).toBeUndefined();
    expect(c.params).toMatchObject({ depth: "Minimal", project_type: "brownfield" });
  });

  it("feature: 30 steps, fan-out per unit, project_type detected from the repo", () => {
    const greenfield = fs.mkdtempSync(path.join(os.tmpdir(), "green-"));
    const c = compile(pack, { profile: "feature", repo: greenfield, testCommand: "npm test" });
    expect(c.formula.steps).toHaveLength(30);
    expect(c.formula.steps.find((s) => s.id === "code-generation")!.per).toBe("unit-of-work");
    expect(c.params.project_type).toBe("greenfield");
    expect(c.formula.verify).toBe("npm test");
  });

  it("refuses an unknown profile", () => {
    expect(() => compile(pack, { profile: "nope" })).toThrow(expect.objectContaining({ layer: "config", next: expect.stringMatching(/bugfix/) }));
  });
});

describe("ported AI-DLC checks", () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
  const ctx = (files: Record<string, string>, step = {}) => {
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), c);
    }
    return { worktree: wt, step: Step.parse({ id: "s", goal: "g", ...step }), result: null, changedFiles: Object.keys(files), inputs: [] };
  };

  it("required-sections wants two H2s and a cycle-free units block", async () => {
    const check = BUILTIN_CHECKS.get("aidlc.required-sections")!;
    expect((await check(ctx({ "d/a.md": "## One\n## Two\n" }))).pass).toBe(true);
    expect((await check(ctx({ "d/b.md": "## One\n" }))).findings[0]).toMatch(/needs at least 2/);
    const dag = (deps: string) => `## A\n## B\n\`\`\`yaml\nunits:\n  - name: a\n    depends_on: [${deps}]\n  - name: b\n    depends_on: [a]\n\`\`\`\n`;
    expect((await check(ctx({ "u/unit-of-work-dependency.md": dag("") }))).pass).toBe(true);
    expect((await check(ctx({ "u/unit-of-work-dependency.md": dag("b") }))).findings).toContain("u/unit-of-work-dependency.md: the units: edge block is cyclic");
  });

  it("traceability rejects gaps and missing rows", async () => {
    const check = BUILTIN_CHECKS.get("aidlc.traceability")!;
    const t = (rows: object[]) => ({ "x/traceability.json": JSON.stringify({ upstream_ids: ["A1", "A2"], coverage: rows }) });
    expect((await check(ctx(t([{ id: "A1", status: "OK", target: "B" }, { id: "A2", status: "N/A", target: "-" }])))).pass).toBe(true);
    const bad = await check(ctx(t([{ id: "A1", status: "GAP" }])));
    expect(bad.findings).toEqual(["x/traceability.json: A1 is GAP", "x/traceability.json: no coverage row for upstream id A2"]);
  });

  it("claim-sources wants tags and an assumptions section", async () => {
    const check = BUILTIN_CHECKS.get("aidlc.claim-sources")!;
    const good = "## Goals\n- Ship CSV export [desc]\n## Assumptions & Open Questions\n- Users have Excel [assumption]\n";
    expect((await check(ctx({ "i/intent.md": good }))).pass).toBe(true);
    const bad = await check(ctx({ "i/intent2.md": "## Goals\n- Ship CSV export\n- Fast [assumption]\n" }));
    expect(bad.findings.join("\n")).toMatch(/no "## Assumptions & Open Questions"/);
    expect(bad.findings.join("\n")).toMatch(/untagged claim: - Ship CSV export/);
    expect(bad.findings.join("\n")).toMatch(/\[assumption\] outside/);
  });
});

describe("envelope", () => {
  it("lays rules out general to specific and shows params, inputs and history", () => {
    const step = Step.parse({ id: "build", goal: "Build it", verify: "npm test", gate: "human" });
    const text = buildEnvelope({
      item: { id: "WI-2", attempt: 2, max_attempts: 3, title: "build (u1)", goal: "Build it", inputs: "add CSV export", unit: "u1" } as never,
      run: { id: "RUN-1", title: "CSV export", goal: "" } as never,
      step,
      rolePrompt: "You build.",
      instructions: "Do the unit.",
      worktree: "/w",
      branch: "foundry/WI-2-a2",
      inputs: [{ step: "design", item: "WI-1", unit: null, status: "skipped", summary: "skipped: n/a", artifacts: [], outputs: {} }],
      inputDecisions: [],
      notes: [{ attempt: 1, kind: "rejection", author: "person:dev", body: "missing error cases" } as never],
      questions: [],
      runItems: [],
      context: [],
      rules: [
        { layer: "org", text: "Use main." },
        { layer: "project", text: "Use pnpm." },
      ],
      params: { depth: "Minimal" },
    });
    expect(text).toMatch(/^attempt: 2/m);
    expect(text).toMatch(/^unit: u1$/m);
    expect(text).toMatch(/params: \{depth: Minimal\}/);
    expect(text).toMatch(/design WI-1 \[skipped\]: "absent by design, skipped: n\/a"/);
    expect(text).toMatch(/attempt 1 rejected at the gate \(person:dev\):\n\s+missing error cases/);
    expect(text.indexOf("### org rules")).toBeLessThan(text.indexOf("### project rules"));
    expect(text).toMatch(/gate: a person approves/);
  });
});
