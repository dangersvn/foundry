// The ledger is the only source of truth. Every status change goes through a
// function here that updates the item and appends its event in one
// BEGIN IMMEDIATE transaction, so concurrent processes serialize on writes.
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql, type Generated, type Selectable } from "kysely";
import { Step as StepSchema, type Formula, type Step } from "../schemas/formula.js";
import type { AgentDecision, Result } from "../schemas/result.js";
import { FoundryError } from "./errors.js";

export type Status =
  | "ready"
  | "running"
  | "verifying"
  | "waiting_input"
  | "at_gate"
  | "merge_ready"
  | "merging"
  | "done"
  | "skipped"
  | "failed";
export const MAX_ATTEMPTS = 3;
const TERMINAL: Status[] = ["done", "skipped", "failed"];
const LEASED: Status[] = ["running", "verifying", "merging"];

interface RunsTable {
  id: string;
  formula: string;
  formula_version: number;
  input: string;
  goal: string;
  status: string;
  created_at: number;
  title: string | null;
  formula_json: string | null;
  pack_dir: string | null;
  params_json: string | null;
}
interface RunStepsTable {
  run_id: string;
  step_id: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}
interface ItemsTable {
  id: string;
  run_id: string;
  step_id: string;
  title: string;
  goal: string;
  inputs: string;
  verify: string;
  status: Status;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  agent: string | null;
  worktree: string | null;
  branch: string | null;
  created_at: number;
  updated_at: number;
  role: string | null;
  unit: string | null;
  spec_json: string | null;
  inputs_json: string | null;
  result_json: string | null;
  commit_sha: string | null;
  lane_id: string | null;
  lane_start: string | null; // the lane commit this item's current attempt builds on
}
// A lane is one worktree and branch that items build on in turn: one per
// unit of work, one per run for document-only steps, else one per item.
export type LaneStatus = "open" | "merge_ready" | "merging" | "merged" | "failed" | "abandoned";
interface LanesTable {
  id: string;
  key: string;
  run_id: string;
  kind: "item" | "unit" | "docs";
  unit: string | null;
  per: string | null;
  worktree: string | null;
  branch: string | null;
  head: string | null; // the lane's last committed item commit
  status: LaneStatus;
  lease_owner: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}
interface EventsTable {
  id: Generated<number>;
  ts: number;
  run_id: string;
  item_id: string | null;
  type: string;
  actor: string;
  payload_json: string;
}
interface ArtifactsTable {
  id: Generated<number>;
  item_id: string;
  kind: string;
  path: string;
  content_hash: string | null;
  created_at: number;
}
interface SubmissionsTable {
  id: Generated<number>;
  item_id: string;
  attempt: number;
  valid: number;
  payload_json: string;
  created_at: number;
}
interface NotesTable {
  id: Generated<number>;
  item_id: string;
  attempt: number;
  kind: string; // design, note, handoff, rejection, verifier, refinery, review
  author: string;
  body: string;
  created_at: number;
}
interface QuestionsTable {
  id: string;
  item_id: string;
  attempt: number;
  question: string;
  options_json: string;
  allow_other: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  created_at: number;
}
interface DecisionsTable {
  id: string;
  run_id: string;
  item_id: string | null;
  step_id: string | null;
  attempt: number | null;
  actor: string;
  kind: "decision" | "assumption" | "deviation" | "control";
  question: string;
  choice: string;
  alternatives_json: string;
  rationale: string;
  evidence_json: string;
  affects_json: string;
  reversible: number;
  supersedes: string | null;
  created_at: number;
}
interface DB {
  runs: RunsTable;
  run_steps: RunStepsTable;
  items: ItemsTable;
  events: EventsTable;
  artifacts: ArtifactsTable;
  submissions: SubmissionsTable;
  item_notes: NotesTable;
  questions: QuestionsTable;
  decisions: DecisionsTable;
  lanes: LanesTable;
}

export type Item = Selectable<ItemsTable>;
export type Lane = Selectable<LanesTable>;
export type Run = Selectable<RunsTable>;
export type Note = Selectable<NotesTable>;
export type Question = Selectable<QuestionsTable>;
export type DecisionRecord = Selectable<DecisionsTable>;
export type LedgerEvent = Omit<Selectable<EventsTable>, "payload_json"> & { payload: Record<string, unknown> };
type ItemFields = Partial<Pick<ItemsTable, "agent" | "worktree" | "branch" | "result_json" | "commit_sha" | "lane_start">>;
const OPEN_LANE: LaneStatus[] = ["open", "merge_ready", "merging"];

// What an item reads from the steps it needs.
export interface InputRef {
  step: string;
  item: string;
  unit: string | null;
  status: "done" | "skipped";
  summary: string;
  artifacts: { path: string; summary: string }[];
  outputs: Record<string, string | string[]>;
}

export interface NewRun {
  formula: string;
  formulaVersion: number;
  stepId: string;
  title: string;
  goal: string;
  input: string;
  verify: string;
}

export interface StartRun {
  formula: Formula;
  title: string;
  input: string;
  packDir: string | null;
  params?: Record<string, string>;
}

export class Ledger {
  private constructor(private readonly db: Kysely<DB>) {}

  static async open(file: string): Promise<Ledger> {
    let sqlite: Database.Database;
    try {
      sqlite = new Database(file);
    } catch (e) {
      throw new FoundryError("ledger", `cannot open ${file}: ${(e as Error).message}`, `check that ${file} is writable`);
    }
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 10000");
    const ledger = new Ledger(new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) }));
    await ledger.migrate();
    return ledger;
  }

  close(): Promise<void> {
    return this.db.destroy();
  }

  // BEGIN IMMEDIATE takes the write lock up front, so two processes never
  // both read "ready" and then race to write.
  private tx<T>(fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.connection().execute(async (conn) => {
      await sql`begin immediate`.execute(conn);
      try {
        const result = await fn(conn);
        await sql`commit`.execute(conn);
        return result;
      } catch (e) {
        await sql`rollback`.execute(conn);
        throw e;
      }
    });
  }

  private async migrate(): Promise<void> {
    await this.tx(async (db) => {
      const { rows } = await sql<{ user_version: number }>`pragma user_version`.execute(db);
      const version = rows[0]?.user_version ?? 0;
      if (version < 1) await migrateV1(db);
      if (version < 2) await migrateV2(db);
      if (version < 3) await migrateV3(db);
      if (version < 3) await sql`pragma user_version = 3`.execute(db);
    });
  }

  private async insertEvent(
    db: Kysely<DB>,
    runId: string,
    itemId: string | null,
    type: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await db
      .insertInto("events")
      .values({ ts: Date.now(), run_id: runId, item_id: itemId, type, actor, payload_json: JSON.stringify(payload) })
      .execute();
  }

  private async nextId(db: Kysely<DB>, table: "runs" | "items" | "questions" | "decisions", prefix: string): Promise<string> {
    const { rows } = await sql<{ n: number | null }>`select max(cast(substr(id, ${prefix.length + 1}) as integer)) as n from ${sql.table(table)}`.execute(db);
    return `${prefix}${(rows[0]?.n ?? 0) + 1}`;
  }

  // Phase 0 shape: one run with one step.
  async createRun(r: NewRun): Promise<{ runId: string; itemId: string }> {
    const formula: Formula = {
      formula: r.formula,
      version: r.formulaVersion,
      title: r.title,
      verify: undefined,
      oneStep: true,
      steps: [StepSchema.parse({ id: r.stepId, goal: r.goal, verify: r.verify, submit: false })],
    };
    const { runId, itemIds } = await this.startRun({ formula, title: r.title, input: r.input, packDir: null });
    return { runId, itemId: itemIds[0]! };
  }

  // Pins the formula to the run, then materializes the steps that can start.
  async startRun(r: StartRun): Promise<{ runId: string; itemIds: string[] }> {
    return this.tx(async (db) => {
      const runId = await this.nextId(db, "runs", "RUN-");
      await db
        .insertInto("runs")
        .values({
          id: runId,
          formula: r.formula.formula,
          formula_version: r.formula.version,
          input: r.input,
          goal: r.title,
          title: r.title,
          status: "open",
          created_at: Date.now(),
          formula_json: JSON.stringify(r.formula),
          pack_dir: r.packDir,
          params_json: JSON.stringify(r.params ?? {}),
        })
        .execute();
      for (const s of r.formula.steps) await db.insertInto("run_steps").values({ run_id: runId, step_id: s.id, status: "pending" }).execute();
      await this.insertEvent(db, runId, null, "run_started", "kernel", { formula: r.formula.formula, title: r.title });
      const itemIds = await this.advance(db, runId);
      return { runId, itemIds };
    });
  }

  // The run graph: start steps whose needs are done or skipped (fanning out
  // over `per`), close steps whose items are all finished, close the run.
  // Idempotent; called inside every transaction that finishes an item.
  private async advance(db: Kysely<DB>, runId: string): Promise<string[]> {
    const run = await db.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirstOrThrow();
    if (!run.formula_json || run.status !== "open") return [];
    const formula = JSON.parse(run.formula_json) as Formula;
    const created: string[] = [];
    for (let changed = true; changed; ) {
      changed = false;
      const steps = new Map((await db.selectFrom("run_steps").selectAll().where("run_id", "=", runId).execute()).map((s) => [s.step_id, s.status]));
      const items = await db.selectFrom("items").selectAll().where("run_id", "=", runId).execute();
      for (const step of formula.steps) {
        const status = steps.get(step.id);
        if (status === "pending" && step.needs.every((n) => steps.get(n) === "done" || steps.get(n) === "skipped")) {
          const inputs = collectInputs(step, items);
          let units: (string | null)[] = [null];
          if (step.per) {
            units = [...new Set(inputs.flatMap((i) => toList(i.outputs[step.per!])))];
            // A step that needs another step run per the same list runs per its units.
            if (units.length === 0) {
              const perOf = new Map(formula.steps.map((s) => [s.id, s.per]));
              units = [...new Set(inputs.filter((i) => i.unit && perOf.get(i.step) === step.per).map((i) => i.unit!))];
            }
            if (units.length === 0) {
              await this.setStep(db, runId, step.id, "skipped");
              await this.insertDecision(db, {
                run_id: runId,
                step_id: step.id,
                actor: "kernel",
                kind: "control",
                question: `How many "${step.id}" items to create?`,
                choice: "none: skipped",
                rationale: `no upstream step produced any "${step.per}"`,
              });
              changed = true;
              continue;
            }
          }
          for (const unit of units) created.push(await this.createItem(db, run, formula, step, unit, inputs));
          await this.setStep(db, runId, step.id, "active");
          changed = true;
        } else if (status === "active") {
          const mine = items.filter((i) => i.step_id === step.id);
          if (mine.length && mine.every((i) => TERMINAL.includes(i.status))) {
            const next = mine.some((i) => i.status === "failed") ? "failed" : mine.every((i) => i.status === "skipped") ? "skipped" : "done";
            await this.setStep(db, runId, step.id, next);
            changed = true;
          }
        }
      }
    }
    const steps = await db.selectFrom("run_steps").select("status").where("run_id", "=", runId).execute();
    const failed = steps.some((s) => s.status === "failed");
    const finished = steps.every((s) => s.status === "done" || s.status === "skipped");
    // A lane whose work is all finished but whose commits have not merged yet
    // goes to the merge queue on its own (the docs lane once the whole run is
    // finished); the run closes only when that merge is done.
    const lanes = await db.selectFrom("lanes").selectAll().where("run_id", "=", runId).where("status", "in", OPEN_LANE).execute();
    if (failed) {
      for (const l of lanes.filter((l) => l.status === "open" || l.status === "merge_ready")) await this.setLane(db, l, "abandoned", "lane_abandoned", { reason: "the run failed" });
    } else {
      const items = await db.selectFrom("items").selectAll().where("run_id", "=", runId).execute();
      const stepStatus = new Map((await db.selectFrom("run_steps").selectAll().where("run_id", "=", runId).execute()).map((s) => [s.step_id, s.status]));
      for (const l of lanes.filter((l) => l.status === "open")) {
        const complete = l.kind === "docs" ? finished : laneComplete(l, formula, items, stepStatus);
        if (!complete) continue;
        if (l.head) await this.setLane(db, l, "merge_ready", "lane_merge_queued", { head: l.head });
        else await this.setLane(db, l, "merged", "lane_merged", { commit: null, reason: "nothing to merge" });
      }
    }
    const merging = (await db.selectFrom("lanes").select("id").where("run_id", "=", runId).where("status", "in", ["merge_ready", "merging"]).executeTakeFirst()) !== undefined;
    const runStatus = failed ? "failed" : finished && !merging ? "done" : "open";
    if (runStatus !== "open") {
      await db.updateTable("runs").set({ status: runStatus }).where("id", "=", runId).execute();
      await this.insertEvent(db, runId, null, runStatus === "done" ? "run_done" : "run_failed", "kernel", {});
    }
    return created;
  }

  private async setStep(db: Kysely<DB>, runId: string, stepId: string, status: RunStepsTable["status"]) {
    await db.updateTable("run_steps").set({ status }).where("run_id", "=", runId).where("step_id", "=", stepId).execute();
    await this.insertEvent(db, runId, null, `step_${status}`, "kernel", { step: stepId });
  }

  private async setLane(db: Kysely<DB>, lane: Lane, status: LaneStatus, type: string, payload: Record<string, unknown>, actor = "kernel") {
    await db.updateTable("lanes").set({ status, lease_owner: null, lease_expires_at: null, updated_at: Date.now() }).where("id", "=", lane.id).execute();
    await this.insertEvent(db, lane.run_id, null, type, actor, { lane: lane.id, ...payload });
  }

  // The open lane for `key`, or a new one (a lane that merged or failed is
  // never reused; the next one gets the key plus a generation number).
  private async openLane(db: Kysely<DB>, runId: string, key: string, kind: Lane["kind"], unit: string | null, per: string | null): Promise<string> {
    const lanes = await db.selectFrom("lanes").select(["id", "status"]).where("key", "=", key).orderBy("created_at").orderBy("id").execute();
    const open = lanes.find((l) => l.status === "open");
    if (open) return open.id;
    const id = lanes.length ? `${key}.${lanes.length + 1}` : key;
    const now = Date.now();
    await db
      .insertInto("lanes")
      .values({ id, key, run_id: runId, kind, unit, per, worktree: null, branch: null, head: null, status: "open", lease_owner: null, lease_expires_at: null, created_at: now, updated_at: now })
      .execute();
    await this.insertEvent(db, runId, null, "lane_opened", "kernel", { lane: id, kind, unit });
    return id;
  }

  private async createItem(db: Kysely<DB>, run: Run, formula: Formula, step: Step, unit: string | null, inputs: InputRef[]): Promise<string> {
    const now = Date.now();
    const id = await this.nextId(db, "items", "WI-");
    const title = formula.oneStep ? (run.title ?? formula.formula) : `${step.id}${unit ? ` (${unit})` : ""}`;
    const kind: Lane["kind"] = step.docs_only ? "docs" : step.per && unit ? "unit" : "item";
    const key = kind === "docs" ? `${run.id}-docs` : kind === "unit" ? `${run.id}-${step.per}-${unit}`.replace(/[^A-Za-z0-9._-]+/g, "-") : id;
    const laneId = await this.openLane(db, run.id, key, kind, unit, kind === "unit" ? step.per! : null);
    await db
      .insertInto("items")
      .values({
        id,
        run_id: run.id,
        step_id: step.id,
        title,
        goal: step.goal,
        inputs: run.input,
        verify: step.verify ?? "",
        status: "ready",
        attempt: 1,
        max_attempts: step.max_attempts,
        lease_owner: null,
        lease_expires_at: null,
        agent: null,
        worktree: null,
        branch: null,
        created_at: now,
        updated_at: now,
        role: step.role,
        unit,
        spec_json: JSON.stringify(step),
        inputs_json: JSON.stringify(inputs),
        result_json: null,
        commit_sha: null,
        lane_id: laneId,
        lane_start: null,
      })
      .execute();
    await this.insertEvent(db, run.id, id, "created", "kernel", { formula: formula.formula, title, step: step.id, unit, lane: laneId });
    // A required input whose step finished without producing it is missing.
    // One from a skipped step is absent by design and is not reported.
    for (const want of step.inputs.filter((i) => i.required && i.name)) {
      const from = inputs.filter((i) => i.step === want.from && i.status === "done");
      const produced = from.some((i) => want.name! in i.outputs || i.artifacts.some((a) => a.path.includes(want.name!)));
      if (from.length && !produced) await this.insertEvent(db, run.id, id, "input_missing", "kernel", { from: want.from, name: want.name });
    }
    return id;
  }

  async advanceRun(runId: string): Promise<string[]> {
    return this.tx((db) => this.advance(db, runId));
  }

  // Atomic claim: zero rows updated means another worker won.
  async claim(itemId: string, owner: string, ttlSeconds: number): Promise<boolean> {
    return this.tx(async (db) => {
      const now = Date.now();
      // One item works in a lane at a time: the lane belongs to the item that
      // started in it until that item finishes.
      const mine = await db.selectFrom("items").select("lane_id").where("id", "=", itemId).executeTakeFirst();
      if (mine?.lane_id) {
        const holder = await db
          .selectFrom("items")
          .select("id")
          .where("lane_id", "=", mine.lane_id)
          .where("id", "!=", itemId)
          .where("status", "not in", TERMINAL)
          .where((eb) => eb.or([eb("status", "!=", "ready"), eb("lane_start", "is not", null)]))
          .executeTakeFirst();
        if (holder) return false;
      }
      const res = await db
        .updateTable("items")
        .set({ status: "running", lease_owner: owner, lease_expires_at: now + ttlSeconds * 1000, updated_at: now })
        .where("id", "=", itemId)
        .where("status", "=", "ready")
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) return false;
      const item = await db.selectFrom("items").select(["run_id", "attempt"]).where("id", "=", itemId).executeTakeFirstOrThrow();
      await this.insertEvent(db, item.run_id, itemId, "claimed", owner, { attempt: item.attempt });
      return true;
    });
  }

  async claimNext(owner: string, ttlSeconds: number, runId?: string): Promise<string | null> {
    let q = this.db.selectFrom("items").select("id").where("status", "=", "ready");
    if (runId) q = q.where("run_id", "=", runId);
    // An item that already holds its lane goes first, so the lane is freed.
    for (const next of await q.orderBy(sql`lane_start is null`).orderBy("created_at").orderBy("id").execute()) {
      if (await this.claim(next.id, owner, ttlSeconds)) return next.id;
    }
    return null;
  }

  // The refinery merges one change at a time across every process: an item
  // or a lane is claimed for merging only while nothing else is merging.
  async claimMerge(owner: string, ttlSeconds: number, runId?: string): Promise<{ kind: "item" | "lane"; id: string } | null> {
    return this.tx(async (db) => {
      const busy =
        (await db.selectFrom("items").select("id").where("status", "=", "merging").executeTakeFirst()) ??
        (await db.selectFrom("lanes").select("id").where("status", "=", "merging").executeTakeFirst());
      if (busy) return null;
      const now = Date.now();
      const lease = { lease_owner: owner, lease_expires_at: now + ttlSeconds * 1000, updated_at: now };
      let q = db.selectFrom("items").select(["id", "run_id"]).where("status", "=", "merge_ready");
      if (runId) q = q.where("run_id", "=", runId);
      const next = await q.orderBy("updated_at").orderBy("id").executeTakeFirst();
      if (next) {
        await db.updateTable("items").set({ status: "merging", ...lease }).where("id", "=", next.id).execute();
        await this.insertEvent(db, next.run_id, next.id, "merge_started", owner, {});
        return { kind: "item", id: next.id };
      }
      let lq = db.selectFrom("lanes").select(["id", "run_id"]).where("status", "=", "merge_ready");
      if (runId) lq = lq.where("run_id", "=", runId);
      const lane = await lq.orderBy("updated_at").orderBy("id").executeTakeFirst();
      if (!lane) return null;
      await db.updateTable("lanes").set({ status: "merging", ...lease }).where("id", "=", lane.id).execute();
      await this.insertEvent(db, lane.run_id, null, "lane_merge_started", owner, { lane: lane.id });
      return { kind: "lane", id: lane.id };
    });
  }

  async renewLease(itemId: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .updateTable("items")
      .set({ lease_expires_at: now + ttlSeconds * 1000 })
      .where("id", "=", itemId)
      .where("lease_owner", "=", owner)
      .where("status", "in", LEASED)
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  // Change status (and optionally item fields) and write the event, but only
  // while `owner` still holds the lease.
  async transition(
    itemId: string,
    owner: string,
    from: Status | Status[],
    to: Status,
    type: string,
    payload: Record<string, unknown>,
    fields: ItemFields = {},
  ): Promise<void> {
    await this.tx((db) => this.move(db, itemId, owner, owner, from, to, type, payload, fields));
  }

  // A status change made by a person or the kernel, not a lease holder.
  async transitionBy(
    itemId: string,
    actor: string,
    from: Status | Status[],
    to: Status,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.tx((db) => this.move(db, itemId, null, actor, from, to, type, payload, {}));
  }

  private async move(
    db: Kysely<DB>,
    itemId: string,
    owner: string | null,
    actor: string,
    from: Status | Status[],
    to: Status,
    type: string,
    payload: Record<string, unknown>,
    fields: ItemFields,
    bumpAttempt = false,
  ): Promise<void> {
    const leaseEnds = !LEASED.includes(to);
    let q = db
      .updateTable("items")
      .set({
        ...fields,
        status: to,
        updated_at: Date.now(),
        ...(leaseEnds ? { lease_owner: null, lease_expires_at: null } : {}),
        ...(bumpAttempt ? { attempt: sql<number>`attempt + 1` } : {}),
      })
      .where("id", "=", itemId)
      .where("status", "in", Array.isArray(from) ? from : [from]);
    if (owner) q = q.where("lease_owner", "=", owner);
    const res = await q.executeTakeFirst();
    if (res.numUpdatedRows === 0n) {
      if (owner) throw leaseLost(itemId);
      const item = await db.selectFrom("items").select("status").where("id", "=", itemId).executeTakeFirst();
      throw new FoundryError(
        "ledger",
        item ? `${itemId} is ${item.status.replace("_", " ")}, not ${[from].flat().join(" or ").replaceAll("_", " ")}` : `no item ${itemId}`,
        `foundry status ${itemId}`,
      );
    }
    const runId = await this.runOf(db, itemId);
    await this.insertEvent(db, runId, itemId, type, actor, payload);
    await this.laneAfterMove(db, itemId, to, type, fields);
    if (TERMINAL.includes(to)) await this.advance(db, runId);
  }

  // The item's lane follows it: a lane commit moves the lane's head, the
  // merge of its last item merges the lane, a failed item fails the lane.
  private async laneAfterMove(db: Kysely<DB>, itemId: string, to: Status, type: string, fields: ItemFields) {
    const item = await db.selectFrom("items").select(["lane_id", "commit_sha"]).where("id", "=", itemId).executeTakeFirstOrThrow();
    const lane = item.lane_id ? await db.selectFrom("lanes").selectAll().where("id", "=", item.lane_id).executeTakeFirst() : undefined;
    if (!lane) return;
    if (type === "lane_committed" && fields.commit_sha) {
      await db.updateTable("lanes").set({ head: fields.commit_sha, updated_at: Date.now() }).where("id", "=", lane.id).execute();
    } else if (to === "done" && type === "merged") {
      await db.updateTable("lanes").set({ head: item.commit_sha }).where("id", "=", lane.id).execute();
      await this.setLane(db, lane, "merged", "lane_merged", { commit: item.commit_sha, item: itemId });
    } else if (to === "failed" && lane.status === "open") {
      await this.setLane(db, lane, "failed", "lane_failed", { item: itemId });
    }
  }

  // Does this item's verified work merge now, or stay on its lane for a
  // later step? Docs lanes merge at the end of the run; a unit lane merges
  // with the unit's last step.
  async laneRoute(itemId: string): Promise<"merge" | "commit"> {
    return this.tx((db) => this.laneRouteIn(db, itemId));
  }

  private async laneRouteIn(db: Kysely<DB>, itemId: string): Promise<"merge" | "commit"> {
    const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
    const lane = item.lane_id ? await db.selectFrom("lanes").selectAll().where("id", "=", item.lane_id).executeTakeFirst() : undefined;
    if (!lane || lane.kind === "item") return "merge";
    if (lane.kind === "docs") return "commit";
    const run = await db.selectFrom("runs").selectAll().where("id", "=", item.run_id).executeTakeFirstOrThrow();
    // Counted as finished: is anything else of the unit still to come?
    const items = (await db.selectFrom("items").selectAll().where("run_id", "=", item.run_id).execute()).map((i) => (i.id === itemId ? { ...i, status: "done" as Status } : i));
    const steps = new Map((await db.selectFrom("run_steps").selectAll().where("run_id", "=", item.run_id).execute()).map((s) => [s.step_id, s.status]));
    return laneComplete(lane, JSON.parse(run.formula_json!) as Formula, items, steps) ? "merge" : "commit";
  }

  async getLane(id: string): Promise<Lane | undefined> {
    return this.db.selectFrom("lanes").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async lanes(runId?: string): Promise<Lane[]> {
    let q = this.db.selectFrom("lanes").selectAll();
    if (runId) q = q.where("run_id", "=", runId);
    return q.orderBy("created_at").orderBy("id").execute();
  }

  // The worker starts an attempt in the item's lane: the item records where
  // it works and the commit it builds on.
  async enterLane(itemId: string, owner: string, payload: Record<string, unknown>, fields: ItemFields & { worktree: string; branch: string; lane_start: string }): Promise<void> {
    await this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      if (item.lease_owner !== owner || !LEASED.includes(item.status)) throw leaseLost(itemId);
      await db.updateTable("items").set({ ...fields, updated_at: Date.now() }).where("id", "=", itemId).execute();
      if (item.lane_id) await db.updateTable("lanes").set({ worktree: fields.worktree, branch: fields.branch, updated_at: Date.now() }).where("id", "=", item.lane_id).execute();
      await this.insertEvent(db, item.run_id, itemId, "worktree_created", owner, { ...payload, lane: item.lane_id });
    });
  }

  // Items from before lanes existed get their own lane on their next attempt.
  async ensureLane(itemId: string): Promise<Lane> {
    return this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      let lane = item.lane_id ? await db.selectFrom("lanes").selectAll().where("id", "=", item.lane_id).executeTakeFirst() : undefined;
      if (!lane || lane.status !== "open") {
        const key = lane?.key ?? itemId;
        const id = await this.openLane(db, item.run_id, key, lane?.kind ?? "item", lane?.unit ?? null, lane?.per ?? null);
        await db.updateTable("items").set({ lane_id: id, lane_start: null }).where("id", "=", itemId).execute();
        lane = await db.selectFrom("lanes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      }
      return lane;
    });
  }

  async renewLaneLease(laneId: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.db
      .updateTable("lanes")
      .set({ lease_expires_at: Date.now() + ttlSeconds * 1000 })
      .where("id", "=", laneId)
      .where("lease_owner", "=", owner)
      .where("status", "=", "merging")
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  // The refinery merged a lane on its own (docs lane, or a unit lane whose
  // last step had nothing to merge): close it and let the run finish.
  async laneMerged(laneId: string, owner: string, commit: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.tx(async (db) => {
      const lane = await db.selectFrom("lanes").selectAll().where("id", "=", laneId).executeTakeFirstOrThrow();
      if (lane.status !== "merging" || lane.lease_owner !== owner) throw new FoundryError("ledger", `lane ${laneId} is ${lane.status}, not merging for this worker`, "foundry status");
      await db.updateTable("lanes").set({ head: commit }).where("id", "=", laneId).execute();
      await this.setLane(db, lane, "merged", "lane_merged", { commit, ...payload }, owner);
      await this.advance(db, lane.run_id);
    });
  }

  // A lane merge failed: the lane opens again and its last committed item
  // goes back for another attempt with the error in its history.
  async laneSendBack(laneId: string, owner: string, reason: string, payload: Record<string, unknown>, note: string): Promise<{ itemId: string | null; next: "ready" | "failed" }> {
    return this.tx(async (db) => {
      const lane = await db.selectFrom("lanes").selectAll().where("id", "=", laneId).executeTakeFirstOrThrow();
      await this.setLane(db, lane, "open", "lane_sent_back", { reason }, owner);
      const last = (await db.selectFrom("items").selectAll().where("lane_id", "=", laneId).where("status", "=", "done").orderBy("updated_at", "desc").orderBy("id", "desc").execute())[0];
      if (!last) return { itemId: null, next: "failed" as const };
      await db.insertInto("item_notes").values({ item_id: last.id, attempt: last.attempt, kind: "refinery", author: "foundry", body: note, created_at: Date.now() }).execute();
      return { itemId: last.id, next: await this.reopen(db, last, owner, reason, payload) };
    });
  }

  // A finished item goes back to Ready for another attempt (or fails when
  // it has none left); its step and run open again. It starts from its
  // lane's current tip, since later items may have built on its commit.
  private async reopen(db: Kysely<DB>, item: Item, actor: string, reason: string, payload: Record<string, unknown>): Promise<"ready" | "failed"> {
    const exhausted = item.attempt >= item.max_attempts;
    const to: Status = exhausted ? "failed" : "ready";
    await db
      .updateTable("items")
      .set({ status: to, attempt: exhausted ? item.attempt : item.attempt + 1, lane_start: null, lease_owner: null, lease_expires_at: null, updated_at: Date.now() })
      .where("id", "=", item.id)
      .execute();
    await this.insertEvent(db, item.run_id, item.id, exhausted ? "failed" : "retry", actor, { reason, ...payload });
    if (!exhausted) {
      await this.insertDecision(db, {
        run_id: item.run_id,
        item_id: item.id,
        step_id: item.step_id,
        attempt: item.attempt,
        actor: "kernel",
        kind: "control",
        question: `What next for ${item.id} after attempt ${item.attempt}?`,
        choice: `retry as attempt ${item.attempt + 1} of ${item.max_attempts}`,
        rationale: reason,
      });
    }
    await db.updateTable("run_steps").set({ status: exhausted ? "failed" : "active" }).where("run_id", "=", item.run_id).where("step_id", "=", item.step_id).execute();
    const run = await db.selectFrom("runs").select("status").where("id", "=", item.run_id).executeTakeFirstOrThrow();
    if (run.status !== "open") {
      await db.updateTable("runs").set({ status: "open" }).where("id", "=", item.run_id).execute();
      await this.insertEvent(db, item.run_id, null, "run_reopened", actor, { item: item.id });
    }
    if (item.lane_id) {
      const lane = await db.selectFrom("lanes").selectAll().where("id", "=", item.lane_id).executeTakeFirst();
      if (lane && lane.status !== "open") {
        const id = await this.openLane(db, item.run_id, lane.key, lane.kind, lane.unit, lane.per);
        await db.updateTable("items").set({ lane_id: id }).where("id", "=", item.id).execute();
      }
    }
    if (exhausted) await this.laneAfterMove(db, item.id, "failed", "failed", {});
    await this.advance(db, item.run_id);
    return to;
  }

  // Back to ready for another attempt, or failed once attempts run out. The
  // reason goes into the item's history and a control decision.
  async retry(itemId: string, owner: string | null, actor: string, from: Status | Status[], reason: string, payload: Record<string, unknown>): Promise<"ready" | "failed"> {
    return this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      if (item.attempt >= item.max_attempts) {
        await this.move(db, itemId, owner, actor, from, "failed", "failed", payload, {});
        return "failed";
      }
      await this.move(db, itemId, owner, actor, from, "ready", "retry", { reason, ...payload }, {}, true);
      await this.insertDecision(db, {
        run_id: item.run_id,
        item_id: itemId,
        step_id: item.step_id,
        attempt: item.attempt,
        actor: "kernel",
        kind: "control",
        question: `What next for ${itemId} after attempt ${item.attempt}?`,
        choice: `retry as attempt ${item.attempt + 1} of ${item.max_attempts}`,
        rationale: reason,
      });
      return "ready";
    });
  }

  // An event (plus optional item fields) that does not change status.
  async record(itemId: string, owner: string, type: string, payload: Record<string, unknown>, fields: ItemFields = {}): Promise<void> {
    await this.tx(async (db) => {
      const res = await db
        .updateTable("items")
        .set({ ...fields, updated_at: Date.now() })
        .where("id", "=", itemId)
        .where("lease_owner", "=", owner)
        .where("status", "in", LEASED)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw leaseLost(itemId);
      await this.insertEvent(db, await this.runOf(db, itemId), itemId, type, owner, payload);
    });
  }

  // An event about an item from outside its lease (agent commands, people).
  async note(itemId: string, type: string, actor: string, payload: Record<string, unknown>): Promise<void> {
    await this.tx(async (db) => this.insertEvent(db, await this.runOf(db, itemId), itemId, type, actor, payload));
  }

  // A run-level event (run setup, for instance).
  async runNote(runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.tx((db) => this.insertEvent(db, runId, null, type, "kernel", payload));
  }

  async addArtifact(itemId: string, kind: string, path: string, contentHash: string | null = null): Promise<void> {
    await this.db.insertInto("artifacts").values({ item_id: itemId, kind, path, content_hash: contentHash, created_at: Date.now() }).execute();
  }

  async artifacts(itemId: string) {
    return this.db.selectFrom("artifacts").selectAll().where("item_id", "=", itemId).orderBy("id").execute();
  }

  // Patrol: leased items whose lease expired. Agent work goes back to ready
  // with the next attempt (or fails after the last); a merge goes back to the
  // merge queue.
  async recoverExpired(now = Date.now()): Promise<string[]> {
    const expired = await this.db
      .selectFrom("items")
      .select("id")
      .where("status", "in", LEASED)
      .where("lease_expires_at", "<", now)
      .execute();
    const recovered: string[] = [];
    for (const { id } of expired) {
      await this.tx(async (db) => {
        const item = await db
          .selectFrom("items")
          .selectAll()
          .where("id", "=", id)
          .where("status", "in", LEASED)
          .where("lease_expires_at", "<", now)
          .executeTakeFirst();
        if (!item) return;
        const payload = { previousOwner: item.lease_owner, attempt: item.attempt, worktree: item.worktree };
        if (item.status === "merging") {
          await db.updateTable("items").set({ status: "merge_ready", lease_owner: null, lease_expires_at: null, updated_at: Date.now() }).where("id", "=", id).execute();
          await this.insertEvent(db, item.run_id, id, "lease_expired", "patrol", payload);
          recovered.push(id);
          return;
        }
        const exhausted = item.attempt >= item.max_attempts;
        await db
          .updateTable("items")
          .set({
            status: exhausted ? "failed" : "ready",
            attempt: exhausted ? item.attempt : item.attempt + 1,
            lease_owner: null,
            lease_expires_at: null,
            updated_at: Date.now(),
          })
          .where("id", "=", id)
          .execute();
        await this.insertEvent(db, item.run_id, id, "lease_expired", "patrol", payload);
        if (exhausted) {
          await this.insertEvent(db, item.run_id, id, "failed", "patrol", {
            layer: "ledger",
            message: `lease expired on the last attempt (${item.attempt} of ${item.max_attempts})`,
          });
          await this.laneAfterMove(db, id, "failed", "failed", {});
          await this.advance(db, item.run_id);
        }
        recovered.push(id);
      });
    }
    // A lane merge whose worker died goes back to the merge queue.
    const lanes = await this.db.selectFrom("lanes").selectAll().where("status", "=", "merging").where("lease_expires_at", "<", now).execute();
    for (const lane of lanes) {
      await this.tx(async (db) => {
        const l = await db.selectFrom("lanes").selectAll().where("id", "=", lane.id).where("status", "=", "merging").where("lease_expires_at", "<", now).executeTakeFirst();
        if (l) await this.setLane(db, l, "merge_ready", "lane_lease_expired", { previousOwner: l.lease_owner }, "patrol");
      });
      recovered.push(lane.id);
    }
    return recovered;
  }

  // Patrol: a leased item with no event for `stallMs` is flagged once.
  async flagStalls(stallMs: number, now = Date.now()): Promise<string[]> {
    const leased = await this.db.selectFrom("items").select(["id", "run_id"]).where("status", "in", LEASED).execute();
    const flagged: string[] = [];
    for (const it of leased) {
      const last = await this.db.selectFrom("events").select(["ts", "type"]).where("item_id", "=", it.id).orderBy("id", "desc").executeTakeFirst();
      if (last && last.type !== "stalled" && now - last.ts > stallMs) {
        await this.note(it.id, "stalled", "patrol", { quietSeconds: Math.round((now - last.ts) / 1000) });
        flagged.push(it.id);
      }
    }
    return flagged;
  }

  // ---- agent commands (data only; status stays with the worker)

  async addSubmission(itemId: string, attempt: number, valid: boolean, payload: unknown): Promise<void> {
    await this.db.insertInto("submissions").values({ item_id: itemId, attempt, valid: valid ? 1 : 0, payload_json: JSON.stringify(payload), created_at: Date.now() }).execute();
  }

  async latestSubmission(itemId: string, attempt: number): Promise<Result | null> {
    const row = await this.db
      .selectFrom("submissions")
      .select("payload_json")
      .where("item_id", "=", itemId)
      .where("attempt", "=", attempt)
      .where("valid", "=", 1)
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row ? (JSON.parse(row.payload_json) as Result) : null;
  }

  async addNote(itemId: string, attempt: number, kind: string, author: string, body: string): Promise<void> {
    await this.db.insertInto("item_notes").values({ item_id: itemId, attempt, kind, author, body, created_at: Date.now() }).execute();
  }

  async notes(itemId: string): Promise<Note[]> {
    return this.db.selectFrom("item_notes").selectAll().where("item_id", "=", itemId).orderBy("id").execute();
  }

  async addQuestions(itemId: string, attempt: number, qs: { question: string; options: string[]; allow_other: boolean }[]): Promise<string[]> {
    return this.tx(async (db) => {
      const ids: string[] = [];
      for (const q of qs) {
        const id = await this.nextId(db, "questions", "Q-");
        await db
          .insertInto("questions")
          .values({ id, item_id: itemId, attempt, question: q.question, options_json: JSON.stringify(q.options), allow_other: q.allow_other ? 1 : 0, answer: null, answered_by: null, answered_at: null, created_at: Date.now() })
          .execute();
        ids.push(id);
      }
      await this.insertEvent(db, await this.runOf(db, itemId), itemId, "asked", "agent", { questions: ids.map((id, i) => ({ id, question: qs[i]!.question })) });
      return ids;
    });
  }

  async questions(itemId: string): Promise<Question[]> {
    return this.db.selectFrom("questions").selectAll().where("item_id", "=", itemId).orderBy("created_at").orderBy("id").execute();
  }

  // ---- people

  async answer(questionId: string, answer: string, actor: string): Promise<{ itemId: string; resumed: boolean }> {
    return this.tx(async (db) => {
      const q = await db.selectFrom("questions").selectAll().where("id", "=", questionId).executeTakeFirst();
      if (!q) throw new FoundryError("ledger", `no question ${questionId}`, "foundry status");
      if (q.answer !== null) throw new FoundryError("ledger", `${questionId} is already answered ("${q.answer}")`, `foundry status ${q.item_id}`);
      const options = JSON.parse(q.options_json) as string[];
      if (!q.allow_other && !options.includes(answer)) {
        throw new FoundryError("ledger", `"${answer}" is not one of the options: ${options.join(", ")}`, `foundry answer ${q.item_id} "${options[0]}"`);
      }
      await db.updateTable("questions").set({ answer, answered_by: actor, answered_at: Date.now() }).where("id", "=", questionId).execute();
      const item = await db.selectFrom("items").selectAll().where("id", "=", q.item_id).executeTakeFirstOrThrow();
      await this.insertDecision(db, {
        run_id: item.run_id,
        item_id: item.id,
        step_id: item.step_id,
        attempt: q.attempt,
        actor,
        kind: "decision",
        question: q.question,
        choice: answer,
        alternatives: options.filter((o) => o !== answer),
        rationale: "answered by a person",
        evidence: [questionId],
      });
      await this.insertEvent(db, item.run_id, item.id, "answered", actor, { question: questionId, answer });
      const open = await db.selectFrom("questions").select("id").where("item_id", "=", item.id).where("answer", "is", null).executeTakeFirst();
      if (open || item.status !== "waiting_input") return { itemId: item.id, resumed: false };
      await this.move(db, item.id, null, actor, "waiting_input", "ready", "resumed", { reason: "every question is answered" }, {}, true);
      return { itemId: item.id, resumed: true };
    });
  }

  async gate(itemId: string, actor: string, approve: boolean, comment: string): Promise<void> {
    await this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirst();
      if (!item) throw new FoundryError("ledger", `no item ${itemId}`, "foundry status");
      if (item.status !== "at_gate") throw new FoundryError("ledger", `${itemId} is ${item.status.replace("_", " ")}, not at a gate`, `foundry status ${itemId}`);
      await this.insertDecision(db, {
        run_id: item.run_id,
        item_id: itemId,
        step_id: item.step_id,
        attempt: item.attempt,
        actor,
        kind: "decision",
        question: `Approve the "${item.step_id}" output of ${itemId}?`,
        choice: approve ? "approved" : "rejected",
        rationale: comment || (approve ? "approved at the gate" : "rejected at the gate"),
      });
      if (approve) {
        await this.insertEvent(db, item.run_id, itemId, "approved", actor, { comment });
        if ((await this.laneRouteIn(db, itemId)) === "commit") {
          await this.move(db, itemId, null, actor, "at_gate", "done", "lane_committed", { commit: item.commit_sha, lane: item.lane_id }, { commit_sha: item.commit_sha });
        } else {
          await this.move(db, itemId, null, actor, "at_gate", "merge_ready", "merge_queued", { commit: item.commit_sha }, {});
        }
      } else {
        await db.insertInto("item_notes").values({ item_id: itemId, attempt: item.attempt, kind: "rejection", author: actor, body: comment, created_at: Date.now() }).execute();
        await this.move(db, itemId, null, actor, "at_gate", "ready", "rejected", { comment }, {}, true);
      }
    });
  }

  // ---- decisions

  private async insertDecision(
    db: Kysely<DB>,
    d: {
      run_id: string;
      item_id?: string | null;
      step_id?: string | null;
      attempt?: number | null;
      actor: string;
      kind: DecisionsTable["kind"];
      question: string;
      choice: string;
      alternatives?: string[];
      rationale: string;
      evidence?: string[];
      affects?: string[];
      reversible?: boolean;
      supersedes?: string | null;
    },
  ): Promise<string> {
    const id = await this.nextId(db, "decisions", "DEC-");
    await db
      .insertInto("decisions")
      .values({
        id,
        run_id: d.run_id,
        item_id: d.item_id ?? null,
        step_id: d.step_id ?? null,
        attempt: d.attempt ?? null,
        actor: d.actor,
        kind: d.kind,
        question: d.question,
        choice: d.choice,
        alternatives_json: JSON.stringify(d.alternatives ?? []),
        rationale: d.rationale,
        evidence_json: JSON.stringify(d.evidence ?? []),
        affects_json: JSON.stringify(d.affects ?? []),
        reversible: d.reversible === false ? 0 : 1,
        supersedes: d.supersedes ?? null,
        created_at: Date.now(),
      })
      .execute();
    return id;
  }

  // Agents write decision, assumption and deviation records only; `control`
  // is the kernel's.
  async addAgentDecisions(itemId: string, attempt: number, actor: string, decisions: AgentDecision[]): Promise<string[]> {
    return this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      const ids: string[] = [];
      for (const d of decisions) {
        ids.push(await this.insertDecision(db, { ...d, run_id: item.run_id, item_id: itemId, step_id: item.step_id, attempt, actor }));
      }
      return ids;
    });
  }

  async addControl(itemId: string, question: string, choice: string, rationale: string): Promise<void> {
    await this.tx(async (db) => {
      const item = await db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirstOrThrow();
      await this.insertDecision(db, { run_id: item.run_id, item_id: itemId, step_id: item.step_id, attempt: item.attempt, actor: "kernel", kind: "control", question, choice, rationale });
    });
  }

  async decisions(filter: { runId?: string; itemId?: string }): Promise<DecisionRecord[]> {
    let q = this.db.selectFrom("decisions").selectAll();
    if (filter.runId) q = q.where("run_id", "=", filter.runId);
    if (filter.itemId) q = q.where("item_id", "=", filter.itemId);
    return q.orderBy("created_at").orderBy("id").execute();
  }

  // ---- reads

  async getItem(itemId: string): Promise<Item | undefined> {
    return this.db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirst();
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return this.db.selectFrom("runs").selectAll().where("id", "=", runId).executeTakeFirst();
  }

  async runSteps(runId: string) {
    return this.db.selectFrom("run_steps").selectAll().where("run_id", "=", runId).execute();
  }

  async listItems(runId?: string): Promise<Item[]> {
    let q = this.db.selectFrom("items").selectAll();
    if (runId) q = q.where("run_id", "=", runId);
    return q.orderBy("created_at").orderBy("id").execute();
  }

  async listRuns(): Promise<Run[]> {
    return this.db.selectFrom("runs").selectAll().orderBy("created_at").orderBy("id").execute();
  }

  // Work a worker could still pick up or finish (not counting people's turns).
  async hasActiveItems(runId?: string): Promise<boolean> {
    let q = this.db.selectFrom("items").select("id").where("status", "in", [...LEASED, "merge_ready"]);
    if (runId) q = q.where("run_id", "=", runId);
    let lq = this.db.selectFrom("lanes").select("id").where("status", "in", ["merge_ready", "merging"]);
    if (runId) lq = lq.where("run_id", "=", runId);
    return !!(await q.executeTakeFirst()) || !!(await lq.executeTakeFirst());
  }

  async events(itemId: string): Promise<LedgerEvent[]> {
    const rows = await this.db.selectFrom("events").selectAll().where("item_id", "=", itemId).orderBy("id").execute();
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }

  async runEvents(runId: string): Promise<LedgerEvent[]> {
    const rows = await this.db.selectFrom("events").selectAll().where("run_id", "=", runId).orderBy("id").execute();
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }

  private async runOf(db: Kysely<DB>, itemId: string): Promise<string> {
    const row = await db.selectFrom("items").select("run_id").where("id", "=", itemId).executeTakeFirst();
    if (!row) throw new FoundryError("ledger", `no item ${itemId}`, "foundry status");
    return row.run_id;
  }
}

function toList(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

// What a new item reads: the finished items of the steps it needs (and of any
// steps named in its inputs). Skipped steps appear as absent, by design.
function collectInputs(step: Step, items: Item[]): InputRef[] {
  const from = [...new Set([...step.needs, ...step.inputs.map((i) => i.from)])];
  return items
    .filter((i) => from.includes(i.step_id) && (i.status === "done" || i.status === "skipped"))
    .map((i) => {
      const r = i.result_json ? (JSON.parse(i.result_json) as Result) : null;
      return {
        step: i.step_id,
        item: i.id,
        unit: i.unit,
        status: i.status as "done" | "skipped",
        summary: i.status === "skipped" ? `skipped: ${r?.reason ?? "no reason given"}` : (r?.summary ?? i.title),
        artifacts: i.status === "skipped" ? [] : (r?.artifacts ?? []),
        outputs: i.status === "skipped" ? {} : (r?.outputs ?? {}),
      };
    });
}

// A lane is complete when every item in it has finished and, for a unit
// lane, no step of the unit is still to come.
function laneComplete(lane: Lane, formula: Formula, items: Item[], steps: Map<string, string>): boolean {
  const mine = items.filter((i) => i.lane_id === lane.id);
  if (mine.some((i) => !TERMINAL.includes(i.status))) return false;
  if (lane.kind !== "unit") return mine.length > 0;
  return formula.steps
    .filter((s) => s.per === lane.per)
    .every((s) => {
      const status = steps.get(s.id);
      if (status === "skipped" || status === "failed") return true;
      if (status === "pending") return false;
      return items.some((i) => i.step_id === s.id && i.unit === lane.unit && TERMINAL.includes(i.status)) || status === "done";
    });
}

function leaseLost(itemId: string): FoundryError {
  return new FoundryError(
    "ledger",
    `this worker no longer holds the lease on ${itemId} (it expired or another worker took it over)`,
    `foundry status ${itemId}`,
  );
}

async function migrateV1(db: Kysely<DB>) {
  await db.schema
    .createTable("runs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("formula", "text", (c) => c.notNull())
    .addColumn("formula_version", "integer", (c) => c.notNull())
    .addColumn("input", "text", (c) => c.notNull())
    .addColumn("goal", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("items")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("run_id", "text", (c) => c.notNull().references("runs.id"))
    .addColumn("step_id", "text", (c) => c.notNull())
    .addColumn("title", "text", (c) => c.notNull())
    .addColumn("goal", "text", (c) => c.notNull())
    .addColumn("inputs", "text", (c) => c.notNull())
    .addColumn("verify", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("attempt", "integer", (c) => c.notNull())
    .addColumn("max_attempts", "integer", (c) => c.notNull())
    .addColumn("lease_owner", "text")
    .addColumn("lease_expires_at", "integer")
    .addColumn("agent", "text")
    .addColumn("worktree", "text")
    .addColumn("branch", "text")
    .addColumn("created_at", "integer", (c) => c.notNull())
    .addColumn("updated_at", "integer", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("events")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("ts", "integer", (c) => c.notNull())
    .addColumn("run_id", "text", (c) => c.notNull())
    .addColumn("item_id", "text")
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("payload_json", "text", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("events_item").on("events").columns(["item_id", "id"]).execute();
  await db.schema
    .createTable("artifacts")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("item_id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("path", "text", (c) => c.notNull())
    .addColumn("content_hash", "text")
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
}

// Phase 1: multi-step runs, submissions, notes, questions and decisions.
async function migrateV2(db: Kysely<DB>) {
  for (const col of ["title", "formula_json", "pack_dir", "params_json"]) {
    await db.schema.alterTable("runs").addColumn(col, "text").execute();
  }
  for (const col of ["role", "unit", "spec_json", "inputs_json", "result_json", "commit_sha"]) {
    await db.schema.alterTable("items").addColumn(col, "text").execute();
  }
  await db.schema
    .createTable("run_steps")
    .addColumn("run_id", "text", (c) => c.notNull())
    .addColumn("step_id", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("run_steps_pk", ["run_id", "step_id"])
    .execute();
  await db.schema
    .createTable("submissions")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("item_id", "text", (c) => c.notNull())
    .addColumn("attempt", "integer", (c) => c.notNull())
    .addColumn("valid", "integer", (c) => c.notNull())
    .addColumn("payload_json", "text", (c) => c.notNull())
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("item_notes")
    .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
    .addColumn("item_id", "text", (c) => c.notNull())
    .addColumn("attempt", "integer", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("author", "text", (c) => c.notNull())
    .addColumn("body", "text", (c) => c.notNull())
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("questions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("item_id", "text", (c) => c.notNull())
    .addColumn("attempt", "integer", (c) => c.notNull())
    .addColumn("question", "text", (c) => c.notNull())
    .addColumn("options_json", "text", (c) => c.notNull())
    .addColumn("allow_other", "integer", (c) => c.notNull())
    .addColumn("answer", "text")
    .addColumn("answered_by", "text")
    .addColumn("answered_at", "integer")
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("decisions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("run_id", "text", (c) => c.notNull())
    .addColumn("item_id", "text")
    .addColumn("step_id", "text")
    .addColumn("attempt", "integer")
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("question", "text", (c) => c.notNull())
    .addColumn("choice", "text", (c) => c.notNull())
    .addColumn("alternatives_json", "text", (c) => c.notNull())
    .addColumn("rationale", "text", (c) => c.notNull())
    .addColumn("evidence_json", "text", (c) => c.notNull())
    .addColumn("affects_json", "text", (c) => c.notNull())
    .addColumn("reversible", "integer", (c) => c.notNull())
    .addColumn("supersedes", "text")
    .addColumn("created_at", "integer", (c) => c.notNull())
    .execute();
  // Phase 0 runs: pin a one-step formula so the run graph can close them.
  const runs = await db.selectFrom("runs").selectAll().execute();
  for (const r of runs) {
    const item = await db.selectFrom("items").selectAll().where("run_id", "=", r.id).executeTakeFirst();
    if (!item) continue;
    const formula = {
      formula: r.formula,
      version: r.formula_version,
      title: item.title,
      oneStep: true,
      steps: [{ id: item.step_id, type: "agent", role: "worker", goal: item.goal, needs: [], verify: item.verify, max_attempts: item.max_attempts, submit: false, inputs: [], conditional: false, environment_change: false }],
    };
    const done = ["done", "failed"].includes(item.status);
    await db.updateTable("runs").set({ title: item.title, formula_json: JSON.stringify(formula), status: done ? item.status : "open" }).where("id", "=", r.id).execute();
    await db.insertInto("run_steps").values({ run_id: r.id, step_id: item.step_id, status: done ? (item.status as "done" | "failed") : "active" }).execute();
    await db.updateTable("items").set({ role: "worker", spec_json: JSON.stringify(formula.steps[0]), inputs_json: "[]" }).where("id", "=", item.id).execute();
  }
}

// Phase 2: lanes. Unfinished items from older ledgers get their own lane.
async function migrateV3(db: Kysely<DB>) {
  await db.schema
    .createTable("lanes")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("run_id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("unit", "text")
    .addColumn("per", "text")
    .addColumn("worktree", "text")
    .addColumn("branch", "text")
    .addColumn("head", "text")
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("lease_owner", "text")
    .addColumn("lease_expires_at", "integer")
    .addColumn("created_at", "integer", (c) => c.notNull())
    .addColumn("updated_at", "integer", (c) => c.notNull())
    .execute();
  for (const col of ["lane_id", "lane_start"]) await db.schema.alterTable("items").addColumn(col, "text").execute();
  const open = await db.selectFrom("items").select(["id", "run_id"]).where("status", "not in", TERMINAL).execute();
  for (const i of open) {
    const now = Date.now();
    await db
      .insertInto("lanes")
      .values({ id: i.id, key: i.id, run_id: i.run_id, kind: "item", unit: null, per: null, worktree: null, branch: null, head: null, status: "open", lease_owner: null, lease_expires_at: null, created_at: now, updated_at: now })
      .execute();
    await db.updateTable("items").set({ lane_id: i.id }).where("id", "=", i.id).execute();
  }
}
