// Durable control-plane state.
//
// Uses node:sqlite (built into Node >= 22.5; the deploy image node:22-slim ships
// 22.23.1). Chosen over better-sqlite3 deliberately: better-sqlite3 is a native
// module needing a toolchain in the container, and a build failure days before a
// deadline is a worse risk than an ExperimentalWarning. No ORM.
//
// WHY THIS EXISTS: the previous store was an in-memory Map ("Lost on restart")
// and TransferMeta.options treated `undefined` as "every service enabled". A
// gateway restart between upload and the B2 event therefore erased the sender's
// selections and silently promoted a TRANSFER-ONLY job to full AI QC — and
// billed for it. Note the fidelity requirement that follows: SQL NULL options
// (sender sent none -> all on, by existing contract) must stay distinguishable
// from a recorded JSON object. Persisting faithfully is the fix; the semantics
// are unchanged.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;

// :memory: is the default so dev and the proof suite stay clean and isolated.
// Production must set a real path on a persistent volume — and fails closed
// below if it does not, because a silently ephemeral database is the bug above.
const DB_PATH = process.env.WAYSTATION_DB_PATH || ":memory:";
if (process.env.NODE_ENV === "production" && DB_PATH === ":memory:") {
  throw new Error(
    "WAYSTATION_DB_PATH must point at a persistent volume in production — " +
      "an in-memory control plane loses transfer options and billing on restart",
  );
}

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

function migrate(): void {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
  );
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transfers (
        transfer_id  TEXT PRIMARY KEY,
        object_key   TEXT NOT NULL,
        blake3_root  TEXT,
        -- NULL = the sender supplied no options. By the existing contract that
        -- means all services on. A JSON string = explicit selections. Keeping
        -- these distinct is what makes transfer-only survive a restart.
        options_json TEXT,
        state        TEXT NOT NULL DEFAULT 'created',
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        revoked      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS uploads (
        object_key    TEXT NOT NULL,
        upload_id     TEXT NOT NULL,
        transfer_id   TEXT NOT NULL,
        session_id    TEXT,
        filename      TEXT,
        content_type  TEXT,
        declared_size INTEGER,
        part_size     INTEGER,
        part_count    INTEGER,
        options_json  TEXT,
        state         TEXT NOT NULL DEFAULT 'active',
        created_at    TEXT NOT NULL,
        expires_at    TEXT,
        PRIMARY KEY (object_key, upload_id)
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_session ON uploads(session_id, state);

      CREATE TABLE IF NOT EXISTS meter_events (
        idempotency_key TEXT PRIMARY KEY,
        transfer_id     TEXT NOT NULL,
        event           TEXT NOT NULL,
        units           REAL NOT NULL,
        unit            TEXT NOT NULL,
        ref             TEXT,
        ts              TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meter_transfer ON meter_events(transfer_id);
    `);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
migrate();

export const dbPathLabel = DB_PATH === ":memory:" ? "in-memory (ephemeral)" : DB_PATH;

// ── transfers ──

export interface TransferRow {
  key: string;
  blake3Root?: string;
  createdAt: number;
  options?: Record<string, boolean | string>;
  expiresAt?: number;
  revoked?: boolean;
}

const insertTransfer = db.prepare(`
  INSERT INTO transfers (transfer_id, object_key, blake3_root, options_json, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(transfer_id) DO UPDATE SET
    object_key  = excluded.object_key,
    blake3_root = COALESCE(excluded.blake3_root, transfers.blake3_root),
    -- Only overwrite options when the caller actually supplied them, so a
    -- later partial write cannot erase the sender's original selections.
    options_json = COALESCE(excluded.options_json, transfers.options_json)
`);
const selectTransfer = db.prepare(`SELECT * FROM transfers WHERE transfer_id = ?`);

export function saveTransfer(transferId: string, meta: TransferRow): void {
  insertTransfer.run(
    transferId,
    meta.key,
    meta.blake3Root ?? null,
    meta.options === undefined ? null : JSON.stringify(meta.options),
    new Date(meta.createdAt || Date.now()).toISOString(),
    meta.expiresAt ? new Date(meta.expiresAt).toISOString() : null,
  );
}

export function getTransfer(transferId: string): TransferRow | undefined {
  const row = selectTransfer.get(transferId) as any;
  if (!row) return undefined;
  return {
    key: row.object_key,
    blake3Root: row.blake3_root ?? undefined,
    createdAt: Date.parse(row.created_at),
    // Preserved distinction: SQL NULL -> undefined (all services on).
    options: row.options_json == null ? undefined : JSON.parse(row.options_json),
    expiresAt: row.expires_at ? Date.parse(row.expires_at) : undefined,
    revoked: !!row.revoked,
  };
}

// ── meter events (idempotent) ──

export interface MeterEvent {
  transferId: string;
  event: string;
  units: number;
  unit: string;
  ts: string;
  ref?: string;
}

const insertMeter = db.prepare(`
  INSERT INTO meter_events (idempotency_key, transfer_id, event, units, unit, ref, ts)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(idempotency_key) DO NOTHING
`);
const selectMeter = db.prepare(
  `SELECT * FROM meter_events WHERE transfer_id = ? ORDER BY ts, rowid`,
);

/** Stable key so a retried worker callback cannot double-charge. An explicit
 *  key wins when supplied (Track B will have the worker send one); otherwise it
 *  is derived from the event's own content. Within a pipeline run each step
 *  emits its billable line once, so identical content IS the duplicate case. */
export function meterKey(e: Omit<MeterEvent, "ts">, explicit?: string): string {
  if (explicit) return `k:${explicit}`;
  return createHash("sha256")
    .update([e.transferId, e.event, e.unit, String(e.units), e.ref ?? ""].join("|"))
    .digest("hex");
}

export function recordMeter(e: Omit<MeterEvent, "ts">, explicit?: string): void {
  insertMeter.run(
    meterKey(e, explicit),
    e.transferId,
    e.event,
    e.units,
    e.unit,
    e.ref ?? null,
    new Date().toISOString(),
  );
}

export function usageFor(transferId: string): {
  events: MeterEvent[];
  totals: Record<string, { units: number; unit: string }>;
} {
  const rows = selectMeter.all(transferId) as any[];
  const events: MeterEvent[] = rows.map((r) => ({
    transferId: r.transfer_id,
    event: r.event,
    units: r.units,
    unit: r.unit,
    ref: r.ref ?? undefined,
    ts: r.ts,
  }));
  const totals: Record<string, { units: number; unit: string }> = {};
  for (const e of events) {
    const t = (totals[e.event] ??= { units: 0, unit: e.unit });
    t.units = Number((t.units + e.units).toFixed(6));
  }
  return { events, totals };
}
