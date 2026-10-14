// The ledger is the only source of truth. Every status change goes through a
// function here that updates the item and appends its event in one
// BEGIN IMMEDIATE transaction, so concurrent processes serialize on writes.
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql, type Generated, type Selectable, type Transaction } from "kysely";
import { FoundryError } from "./errors.js";

export type Status = "ready" | "running" | "verifying" | "done" | "failed";
export const MAX_ATTEMPTS = 3;

interface RunsTable {
  id: string;
  formula: string;
  formula_version: number;
  input: string;
  goal: string;
  status: string;
  created_at: number;
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
interface DB {
  runs: RunsTable;
  items: ItemsTable;
  events: EventsTable;
  artifacts: ArtifactsTable;
}

export type Item = Selectable<ItemsTable>;
export type LedgerEvent = Omit<Selectable<EventsTable>, "payload_json"> & { payload: Record<string, unknown> };
type ItemFields = Partial<Pick<ItemsTable, "agent" | "worktree" | "branch">>;

const ACTIVE: Status[] = ["running", "verifying"];

export interface NewRun {
  formula: string;
  formulaVersion: number;
  stepId: string;
  title: string;
  goal: string;
  input: string;
  verify: string;
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
      if ((rows[0]?.user_version ?? 0) >= 1) return;
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
      await sql`pragma user_version = 1`.execute(db);
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

  private async nextId(db: Kysely<DB>, table: "runs" | "items", prefix: string): Promise<string> {
    const { rows } = await sql<{ n: number | null }>`select max(cast(substr(id, ${prefix.length + 1}) as integer)) as n from ${sql.table(table)}`.execute(db);
    return `${prefix}${(rows[0]?.n ?? 0) + 1}`;
  }

  async createRun(r: NewRun): Promise<{ runId: string; itemId: string }> {
    return this.tx(async (db) => {
      const now = Date.now();
      const runId = await this.nextId(db, "runs", "RUN-");
      const itemId = await this.nextId(db, "items", "WI-");
      await db
        .insertInto("runs")
        .values({ id: runId, formula: r.formula, formula_version: r.formulaVersion, input: r.input, goal: r.goal, status: "open", created_at: now })
        .execute();
      await db
        .insertInto("items")
        .values({
          id: itemId,
          run_id: runId,
          step_id: r.stepId,
          title: r.title,
          goal: r.goal,
          inputs: r.input,
          verify: r.verify,
          status: "ready",
          attempt: 1,
          max_attempts: MAX_ATTEMPTS,
          lease_owner: null,
          lease_expires_at: null,
          agent: null,
          worktree: null,
          branch: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await this.insertEvent(db, runId, itemId, "created", "kernel", { formula: r.formula, title: r.title });
      return { runId, itemId };
    });
  }

  // Atomic claim: zero rows updated means another worker won.
  async claim(itemId: string, owner: string, ttlSeconds: number): Promise<boolean> {
    return this.tx(async (db) => {
      const now = Date.now();
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

  async claimNext(owner: string, ttlSeconds: number): Promise<string | null> {
    for (;;) {
      const next = await this.db
        .selectFrom("items")
        .select("id")
        .where("status", "=", "ready")
        .orderBy("created_at")
        .orderBy("id")
        .executeTakeFirst();
      if (!next) return null;
      if (await this.claim(next.id, owner, ttlSeconds)) return next.id;
    }
  }

  async renewLease(itemId: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const res = await this.db
      .updateTable("items")
      .set({ lease_expires_at: now + ttlSeconds * 1000 })
      .where("id", "=", itemId)
      .where("lease_owner", "=", owner)
      .where("status", "in", ACTIVE)
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
    await this.tx(async (db) => {
      const ends = to === "done" || to === "failed" || to === "ready";
      const res = await db
        .updateTable("items")
        .set({ ...fields, status: to, updated_at: Date.now(), ...(ends ? { lease_owner: null, lease_expires_at: null } : {}) })
        .where("id", "=", itemId)
        .where("lease_owner", "=", owner)
        .where("status", "in", Array.isArray(from) ? from : [from])
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw leaseLost(itemId);
      await this.insertEvent(db, await this.runOf(db, itemId), itemId, type, owner, payload);
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
        .where("status", "in", ACTIVE)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw leaseLost(itemId);
      await this.insertEvent(db, await this.runOf(db, itemId), itemId, type, owner, payload);
    });
  }

  async addArtifact(itemId: string, kind: string, path: string, contentHash: string | null = null): Promise<void> {
    await this.db.insertInto("artifacts").values({ item_id: itemId, kind, path, content_hash: contentHash, created_at: Date.now() }).execute();
  }

  // Patrol: items whose lease expired go back to ready with the next attempt,
  // or fail once they have used their last attempt.
  async recoverExpired(now = Date.now()): Promise<string[]> {
    const expired = await this.db
      .selectFrom("items")
      .select("id")
      .where("status", "in", ACTIVE)
      .where("lease_expires_at", "<", now)
      .execute();
    const recovered: string[] = [];
    for (const { id } of expired) {
      await this.tx(async (db) => {
        const item = await db
          .selectFrom("items")
          .selectAll()
          .where("id", "=", id)
          .where("status", "in", ACTIVE)
          .where("lease_expires_at", "<", now)
          .executeTakeFirst();
        if (!item) return;
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
        const payload = { previousOwner: item.lease_owner, attempt: item.attempt, worktree: item.worktree };
        await this.insertEvent(db, item.run_id, id, "lease_expired", "patrol", payload);
        if (exhausted) {
          await this.insertEvent(db, item.run_id, id, "failed", "patrol", {
            layer: "ledger",
            message: `lease expired on the last attempt (${item.attempt} of ${item.max_attempts})`,
          });
        }
        recovered.push(id);
      });
    }
    return recovered;
  }

  async getItem(itemId: string): Promise<Item | undefined> {
    return this.db.selectFrom("items").selectAll().where("id", "=", itemId).executeTakeFirst();
  }

  async listItems(): Promise<Item[]> {
    return this.db.selectFrom("items").selectAll().orderBy("created_at").orderBy("id").execute();
  }

  async hasActiveItems(): Promise<boolean> {
    return !!(await this.db.selectFrom("items").select("id").where("status", "in", ACTIVE).executeTakeFirst());
  }

  async events(itemId: string): Promise<LedgerEvent[]> {
    const rows = await this.db.selectFrom("events").selectAll().where("item_id", "=", itemId).orderBy("id").execute();
    return rows.map(({ payload_json, ...e }) => ({ ...e, payload: JSON.parse(payload_json) }));
  }

  private async runOf(db: Kysely<DB> | Transaction<DB>, itemId: string): Promise<string> {
    const row = await db.selectFrom("items").select("run_id").where("id", "=", itemId).executeTakeFirstOrThrow();
    return row.run_id;
  }
}

function leaseLost(itemId: string): FoundryError {
  return new FoundryError(
    "ledger",
    `this worker no longer holds the lease on ${itemId} (it expired or another worker took it over)`,
    `foundry status ${itemId}`,
  );
}
