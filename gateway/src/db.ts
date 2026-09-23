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
import { createHash, randomUUID } from "node:crypto";

const SCHEMA_VERSION = 6;

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
        verification_mode TEXT NOT NULL DEFAULT 'range',
        -- NULL = the sender supplied no options. By the existing contract that
        -- means all services on. A JSON string = explicit selections. Keeping
        -- these distinct is what makes transfer-only survive a restart.
        options_json TEXT,
        state        TEXT NOT NULL DEFAULT 'created',
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        revoked      INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT
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
        verification_mode TEXT NOT NULL DEFAULT 'range',
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
  if (current < 2) {
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("transfers").includes("verification_mode"))
      db.exec(`ALTER TABLE transfers ADD COLUMN verification_mode TEXT NOT NULL DEFAULT 'range'`);
    if (!cols("uploads").includes("verification_mode"))
      db.exec(`ALTER TABLE uploads ADD COLUMN verification_mode TEXT NOT NULL DEFAULT 'range'`);
  }
  if (current < 3) {
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("transfers").includes("password_hash"))
      db.exec(`ALTER TABLE transfers ADD COLUMN password_hash TEXT`);
  }
  if (current < 4) {
    // Named sender access codes, administered from the portal, and the durable
    // owner key on every transfer that docs/COMMERCIAL_DELIVERY_PLAN.md says
    // must not be deferred. owner_id is the code_id that sent it, "admin" for
    // the environment code, and NULL for rows that predate identity.
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    db.exec(`
      CREATE TABLE IF NOT EXISTS access_codes (
        code_id      TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        code_hash    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        revoked_at   TEXT,
        last_used_at TEXT
      );
    `);
    if (!cols("uploads").includes("owner_id"))
      db.exec(`ALTER TABLE uploads ADD COLUMN owner_id TEXT`);
    if (!cols("transfers").includes("owner_id"))
      db.exec(`ALTER TABLE transfers ADD COLUMN owner_id TEXT`);
  }
  if (current < 5) {
    // Pay-per-gig checkout. A payment order is priced BEFORE any upload exists:
    // it records the byte budget the sender paid for and how many downloads the
    // resulting link may serve, and it is the durable authorization the upload
    // session is minted from (docs/COMMERCIAL_DELIVERY_PLAN.md, Step 1).
    //
    // download_grants is Step 3's ledger: one download is a GRANT, not an HTTP
    // request, so a resumed or many-connection download of one file counts once.
    // Used-count is derived by COUNTING grants — deliberately no stored counter,
    // because a charged feature needs an audit trail (metering.ts's principle).
    //
    // transfers.downloads_allowed is NULLABLE on purpose: NULL means "unlimited",
    // which is the pre-feature behaviour every existing row and every comped/admin
    // transfer keeps. Only a PAID transfer gets a finite count (2..10), so this
    // migration never retroactively caps a link that was already sent.
    const cols = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("transfers").includes("downloads_allowed"))
      db.exec(`ALTER TABLE transfers ADD COLUMN downloads_allowed INTEGER`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_orders (
        order_id       TEXT PRIMARY KEY,
        gateway        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        priced_bytes   INTEGER NOT NULL,
        downloads      INTEGER NOT NULL DEFAULT 2,
        base_cents     INTEGER NOT NULL DEFAULT 0,
        extra_cents    INTEGER NOT NULL DEFAULT 0,
        fee_cents      INTEGER NOT NULL DEFAULT 0,
        amount_cents   INTEGER NOT NULL,
        currency       TEXT NOT NULL DEFAULT 'USD',
        gateway_ref    TEXT,
        owner_id       TEXT,
        email          TEXT,
        consumed_bytes INTEGER NOT NULL DEFAULT 0,
        session_id     TEXT,
        created_at     TEXT NOT NULL,
        paid_at        TEXT,
        expires_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_gateway_ref ON payment_orders(gateway_ref);

      CREATE TABLE IF NOT EXISTS download_grants (
        grant_id     TEXT PRIMARY KEY,
        transfer_id  TEXT NOT NULL,
        issued_at    TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        bytes_served INTEGER NOT NULL DEFAULT 0,
        completed    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_grants_transfer ON download_grants(transfer_id);
    `);
  }
  if (current < 6) {
    // Link-lifetime weeks a paid order bought (1 included, up to 5). Copied onto
    // the transfer's expiry at complete as weeks*7 + 1 day. Default 1 so any order
    // that predates this column reads as the single included week.
    const cols =
      (db.prepare(`PRAGMA table_info(payment_orders)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("weeks"))
      db.exec(`ALTER TABLE payment_orders ADD COLUMN weeks INTEGER NOT NULL DEFAULT 1`);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
migrate();

export const dbPathLabel = DB_PATH === ":memory:" ? "in-memory (ephemeral)" : DB_PATH;

// ── transfers ──

export interface TransferRow {
  key: string;
  blake3Root?: string;
  verificationMode?: "range" | "root";
  createdAt: number;
  options?: Record<string, boolean | string>;
  expiresAt?: number;
  revoked?: boolean;
  passwordHash?: string;
  ownerId?: string;
  /** How many downloads the link may serve. undefined/NULL = unlimited (comped,
   *  admin, or pre-feature transfers); a finite count is set for PAID transfers. */
  downloadsAllowed?: number;
}

const insertTransfer = db.prepare(`
  INSERT INTO transfers (transfer_id, object_key, blake3_root, verification_mode, options_json, created_at, expires_at, password_hash, owner_id, downloads_allowed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(transfer_id) DO UPDATE SET
    object_key  = excluded.object_key,
    blake3_root = COALESCE(excluded.blake3_root, transfers.blake3_root),
    verification_mode = excluded.verification_mode,
    -- Only overwrite options when the caller actually supplied them, so a
    -- later partial write cannot erase the sender's original selections.
    options_json = COALESCE(excluded.options_json, transfers.options_json),
    password_hash = COALESCE(excluded.password_hash, transfers.password_hash),
    owner_id      = COALESCE(excluded.owner_id, transfers.owner_id),
    downloads_allowed = COALESCE(excluded.downloads_allowed, transfers.downloads_allowed)
`);
const selectTransfer = db.prepare(`SELECT * FROM transfers WHERE transfer_id = ?`);

export function saveTransfer(transferId: string, meta: TransferRow): void {
  insertTransfer.run(
    transferId,
    meta.key,
    meta.blake3Root ?? null,
    meta.verificationMode ?? "range",
    meta.options === undefined ? null : JSON.stringify(meta.options),
    new Date(meta.createdAt || Date.now()).toISOString(),
    meta.expiresAt ? new Date(meta.expiresAt).toISOString() : null,
    meta.passwordHash ?? null,
    meta.ownerId ?? null,
    meta.downloadsAllowed ?? null,
  );
}

const updateRecipientState = db.prepare(
  `UPDATE transfers SET expires_at = ?, revoked = ? WHERE transfer_id = ?`,
);

/** Recipient links are bearer capabilities: anyone holding the URL can open the
 *  delivery. Expiry and revocation are the only ways to take one back, so both
 *  are persisted rather than held in memory. */
export function setRecipientState(
  transferId: string,
  opts: { expiresAt?: number | null; revoked?: boolean },
): void {
  const current = getTransfer(transferId);
  updateRecipientState.run(
    opts.expiresAt === undefined
      ? current?.expiresAt
        ? new Date(current.expiresAt).toISOString()
        : null
      : opts.expiresAt === null
        ? null
        : new Date(opts.expiresAt).toISOString(),
    opts.revoked === undefined ? (current?.revoked ? 1 : 0) : opts.revoked ? 1 : 0,
    transferId,
  );
}

/** A capability is usable only while the record says so. Unknown transfers are
 *  NOT treated as revoked — objects can predate the control-plane database, and
 *  the event-driven path uploads straight to the bucket. */
export function capabilityRevoked(transferId: string): boolean {
  const t = getTransfer(transferId);
  if (!t) return false;
  if (t.revoked) return true;
  return !!t.expiresAt && Date.now() > t.expiresAt;
}

export function getTransfer(transferId: string): TransferRow | undefined {
  const row = selectTransfer.get(transferId) as any;
  if (!row) return undefined;
  return {
    key: row.object_key,
    blake3Root: row.blake3_root ?? undefined,
    verificationMode: row.verification_mode ?? "range",
    createdAt: Date.parse(row.created_at),
    // Preserved distinction: SQL NULL -> undefined (all services on).
    options: row.options_json == null ? undefined : JSON.parse(row.options_json),
    expiresAt: row.expires_at ? Date.parse(row.expires_at) : undefined,
    revoked: !!row.revoked,
    passwordHash: row.password_hash ?? undefined,
    ownerId: row.owner_id ?? undefined,
    downloadsAllowed: row.downloads_allowed ?? undefined,
  };
}

// ── uploads (ownership) ──
//
// Every multipart upload is bound to the session that initiated it. Later
// routes must verify that binding: knowing another sender's key and upload id
// must not be enough to sign parts, attach sidecars, or complete their upload.

export interface UploadRow {
  objectKey: string;
  uploadId: string;
  transferId: string;
  sessionId: string | null;
  ownerId?: string | null;
  filename?: string;
  contentType?: string;
  declaredSize?: number;
  partSize?: number;
  partCount?: number;
  verificationMode: "range" | "root";
  state: string;
  createdAt: number;
}

const insertUpload = db.prepare(`
  INSERT INTO uploads (object_key, upload_id, transfer_id, session_id, owner_id, filename,
                       content_type, declared_size, part_size, part_count, verification_mode, state, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
`);
const selectUpload = db.prepare(`SELECT * FROM uploads WHERE object_key = ? AND upload_id = ?`);
const updateUploadState = db.prepare(
  `UPDATE uploads SET state = ? WHERE object_key = ? AND upload_id = ?`,
);
// Bounded by age on purpose. An upload only leaves 'active' by completing, so
// one that is interrupted — a dropped connection, a closed laptop — stays
// 'active' for ever and permanently consumes a slot against the per-session
// ceiling. With that ceiling at 1, a single dropped upload wedges the session
// and nothing can be sent again.
//
// The cutoff is the caller's, and it is B2's: unfinished multipart uploads are
// swept by a one-day lifecycle rule, so past that window the parts are gone and
// the row cannot be resumed by anyone. Counting it would reserve a slot for
// something that no longer exists.
const countActive = db.prepare(
  `SELECT COUNT(*) AS n FROM uploads WHERE session_id = ? AND state = 'active' AND created_at >= ?`,
);
const countSince = db.prepare(
  `SELECT COUNT(*) AS n FROM uploads WHERE session_id = ? AND state = 'complete' AND created_at >= ?`,
);
const countAllSince = db.prepare(
  `SELECT COUNT(*) AS n FROM uploads WHERE state = 'complete' AND created_at >= ?`,
);

export function createUpload(u: Omit<UploadRow, "state" | "createdAt">): void {
  insertUpload.run(
    u.objectKey, u.uploadId, u.transferId, u.sessionId, u.ownerId ?? null,
    u.filename ?? null, u.contentType ?? null,
    u.declaredSize ?? null, u.partSize ?? null, u.partCount ?? null,
    u.verificationMode,
    new Date().toISOString(),
  );
}

const selectUploadByKey = db.prepare(
  `SELECT * FROM uploads WHERE object_key = ? ORDER BY created_at DESC LIMIT 1`,
);
const selectUploadByTransfer = db.prepare(
  `SELECT * FROM uploads WHERE transfer_id = ? ORDER BY created_at DESC LIMIT 1`,
);

/** Object keys embed a fresh transfer UUID per initiate, so a key identifies
 *  one upload. Used by the outboard/sidecar routes, which address the master by
 *  key alone; ownership is still verified against the returned row. */
export function getUploadByKey(objectKey: string): UploadRow | undefined {
  const r = selectUploadByKey.get(objectKey) as any;
  return r ? rowToUpload(r) : undefined;
}

export function getUploadByTransferId(transferId: string): UploadRow | undefined {
  const r = selectUploadByTransfer.get(transferId) as any;
  return r ? rowToUpload(r) : undefined;
}

export function getUpload(objectKey: string, uploadId: string): UploadRow | undefined {
  const r = selectUpload.get(objectKey, uploadId) as any;
  return r ? rowToUpload(r) : undefined;
}

function rowToUpload(r: any): UploadRow {
  return {
    objectKey: r.object_key, uploadId: r.upload_id, transferId: r.transfer_id,
    sessionId: r.session_id, ownerId: r.owner_id ?? undefined,
    filename: r.filename ?? undefined,
    contentType: r.content_type ?? undefined,
    declaredSize: r.declared_size ?? undefined,
    partSize: r.part_size ?? undefined, partCount: r.part_count ?? undefined,
    verificationMode: r.verification_mode ?? "range",
    state: r.state, createdAt: Date.parse(r.created_at),
  };
}

export const setUploadState = (objectKey: string, uploadId: string, state: string): void => {
  updateUploadState.run(state, objectKey, uploadId);
};

export const activeUploadCount = (sessionId: string, sinceIso: string): number =>
  Number((countActive.get(sessionId, sinceIso) as { n: number }).n);

/** Completed uploads for one session since an ISO timestamp. */
export const completedSince = (sessionId: string, sinceIso: string): number =>
  Number((countSince.get(sessionId, sinceIso) as { n: number }).n);

/** Completed uploads across all sessions since an ISO timestamp (daily cap). */
export const completedSinceAll = (sinceIso: string): number =>
  Number((countAllSince.get(sinceIso) as { n: number }).n);

// ── access codes (named sender identities) ──
//
// The plaintext code exists exactly once: in the create response, on the
// admin's screen. Only its scrypt hash is stored. The list query deliberately
// never selects code_hash, so no route can leak it by spreading a row.

export interface AccessCodeRow {
  codeId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  transfers: number;
}

const insertAccessCode = db.prepare(`
  INSERT INTO access_codes (code_id, label, code_hash, created_at) VALUES (?, ?, ?, ?)
`);
const selectActiveCodes = db.prepare(
  `SELECT code_id, code_hash FROM access_codes WHERE revoked_at IS NULL`,
);
const selectCodeStatus = db.prepare(
  `SELECT revoked_at FROM access_codes WHERE code_id = ?`,
);
const selectCodeList = db.prepare(`
  SELECT a.code_id, a.label, a.created_at, a.revoked_at, a.last_used_at,
         (SELECT COUNT(*) FROM transfers t WHERE t.owner_id = a.code_id) AS transfers
  FROM access_codes a ORDER BY a.created_at DESC
`);
const updateCodeRevoked = db.prepare(
  `UPDATE access_codes SET revoked_at = ? WHERE code_id = ? AND revoked_at IS NULL`,
);
const updateCodeUsed = db.prepare(`UPDATE access_codes SET last_used_at = ? WHERE code_id = ?`);
const countActiveCodes = db.prepare(`SELECT COUNT(*) AS n FROM access_codes WHERE revoked_at IS NULL`);
const selectActiveLabel = db.prepare(
  `SELECT 1 FROM access_codes WHERE revoked_at IS NULL AND label = ? COLLATE NOCASE LIMIT 1`,
);
const selectLabel = db.prepare(`SELECT label FROM access_codes WHERE code_id = ?`);

export function createAccessCode(codeId: string, label: string, codeHash: string): void {
  insertAccessCode.run(codeId, label, codeHash, new Date().toISOString());
}

/** id + hash pairs for login. Bounded by the admin, not by users. */
export const activeAccessCodes = (): { codeId: string; codeHash: string }[] =>
  (selectActiveCodes.all() as any[]).map((r) => ({ codeId: r.code_id, codeHash: r.code_hash }));

/** true only for a code that exists AND is not revoked — the per-request
 *  check that makes revocation take effect on the next call. */
export function accessCodeActive(codeId: string): boolean {
  const r = selectCodeStatus.get(codeId) as { revoked_at: string | null } | undefined;
  return !!r && r.revoked_at === null;
}

export const listAccessCodes = (): AccessCodeRow[] =>
  (selectCodeList.all() as any[]).map((r) => ({
    codeId: r.code_id, label: r.label, createdAt: r.created_at,
    revokedAt: r.revoked_at ?? null, lastUsedAt: r.last_used_at ?? null,
    transfers: Number(r.transfers),
  }));

/** Idempotent: a second revoke leaves the original timestamp. Returns the
 *  timestamp in force, or undefined for an unknown id. */
export function revokeAccessCode(codeId: string): string | undefined {
  const now = new Date().toISOString();
  updateCodeRevoked.run(now, codeId);
  const r = selectCodeStatus.get(codeId) as { revoked_at: string | null } | undefined;
  return r?.revoked_at ?? undefined;
}

export const touchAccessCode = (codeId: string): void => {
  updateCodeUsed.run(new Date().toISOString(), codeId);
};

export const activeAccessCodeCount = (): number =>
  Number((countActiveCodes.get() as { n: number }).n);

/** Two live codes must never share a label: the admin revoked the wrong
 *  "RussoFree" on 2026-09-17 because the list could not tell them apart.
 *  Revoked rows keep their label, so a name can be reused once retired. */
export const activeLabelExists = (label: string): boolean => !!selectActiveLabel.get(label);

export const accessCodeLabel = (codeId: string): string | undefined =>
  (selectLabel.get(codeId) as { label: string } | undefined)?.label;

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

// ── payment orders (pay-per-gig checkout) ──
//
// An order is priced and created BEFORE any upload exists. When the gateway
// confirms payment (webhook, or a direct-lookup fallback), the order becomes the
// durable authorization a payment-backed upload session is minted from (auth.ts).
// priced_bytes is the budget the upload is held to; downloads is copied onto every
// resulting transfer as downloads_allowed. See docs/COMMERCIAL_DELIVERY_PLAN.md.

export interface PaymentOrderRow {
  orderId: string;
  gateway: string;
  status: "pending" | "paid" | "expired" | "canceled";
  pricedBytes: number;
  downloads: number;
  weeks: number;
  baseCents: number;
  extraCents: number;
  feeCents: number;
  amountCents: number;
  currency: string;
  gatewayRef?: string;
  ownerId?: string;
  email?: string;
  consumedBytes: number;
  sessionId?: string;
  createdAt: number;
  paidAt?: number;
  expiresAt?: number;
}

const insertOrder = db.prepare(`
  INSERT INTO payment_orders
    (order_id, gateway, status, priced_bytes, downloads, weeks, base_cents, extra_cents,
     fee_cents, amount_cents, currency, gateway_ref, owner_id, expires_at, created_at)
  VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectOrder = db.prepare(`SELECT * FROM payment_orders WHERE order_id = ?`);
const selectOrderByRef = db.prepare(
  `SELECT * FROM payment_orders WHERE gateway_ref = ? ORDER BY created_at DESC LIMIT 1`,
);
const updateOrderRef = db.prepare(`UPDATE payment_orders SET gateway_ref = ? WHERE order_id = ?`);
// Idempotent paid transition: paid_at is fixed on the first confirmation, and the
// guard keeps a replayed webhook from re-firing anything the caller keys on it.
const updateOrderPaid = db.prepare(`
  UPDATE payment_orders
     SET status = 'paid', paid_at = COALESCE(paid_at, ?), email = COALESCE(?, email)
   WHERE order_id = ? AND status != 'paid'
`);
const updateOrderStatus = db.prepare(
  `UPDATE payment_orders SET status = ? WHERE order_id = ? AND status = 'pending'`,
);
const updateOrderSession = db.prepare(`UPDATE payment_orders SET session_id = ? WHERE order_id = ?`);
// Atomic budget guard: the row moves only when the order is paid AND the new total
// still fits the paid budget. Zero rows changed => refuse (unpaid or over budget).
const consumeOrderBytes = db.prepare(`
  UPDATE payment_orders
     SET consumed_bytes = consumed_bytes + ?
   WHERE order_id = ? AND status = 'paid' AND consumed_bytes + ? <= priced_bytes
`);

export function createOrder(o: {
  orderId: string; gateway: string; pricedBytes: number; downloads: number; weeks: number;
  baseCents: number; extraCents: number; feeCents: number; amountCents: number;
  currency: string; gatewayRef?: string; ownerId?: string; expiresAt?: number;
}): void {
  insertOrder.run(
    o.orderId, o.gateway, o.pricedBytes, o.downloads, o.weeks, o.baseCents, o.extraCents,
    o.feeCents, o.amountCents, o.currency, o.gatewayRef ?? null, o.ownerId ?? null,
    o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
    new Date().toISOString(),
  );
}

function rowToOrder(r: any): PaymentOrderRow {
  return {
    orderId: r.order_id, gateway: r.gateway, status: r.status,
    pricedBytes: Number(r.priced_bytes), downloads: Number(r.downloads),
    weeks: Number(r.weeks),
    baseCents: Number(r.base_cents), extraCents: Number(r.extra_cents),
    feeCents: Number(r.fee_cents), amountCents: Number(r.amount_cents),
    currency: r.currency, gatewayRef: r.gateway_ref ?? undefined,
    ownerId: r.owner_id ?? undefined, email: r.email ?? undefined,
    consumedBytes: Number(r.consumed_bytes), sessionId: r.session_id ?? undefined,
    createdAt: Date.parse(r.created_at),
    paidAt: r.paid_at ? Date.parse(r.paid_at) : undefined,
    expiresAt: r.expires_at ? Date.parse(r.expires_at) : undefined,
  };
}

export function getOrder(orderId: string): PaymentOrderRow | undefined {
  const r = selectOrder.get(orderId) as any;
  return r ? rowToOrder(r) : undefined;
}

export function getOrderByGatewayRef(ref: string): PaymentOrderRow | undefined {
  const r = selectOrderByRef.get(ref) as any;
  return r ? rowToOrder(r) : undefined;
}

export const setOrderGatewayRef = (orderId: string, ref: string): void => {
  updateOrderRef.run(ref, orderId);
};

/** Mark paid (idempotent — a replayed webhook is a no-op). Returns true only on
 *  the pending→paid transition, so the caller acts exactly once. */
export function markOrderPaid(orderId: string, email?: string): boolean {
  const info = updateOrderPaid.run(new Date().toISOString(), email ?? null, orderId);
  return Number(info.changes) > 0;
}

export const setOrderStatus = (orderId: string, status: "expired" | "canceled"): void => {
  updateOrderStatus.run(status, orderId);
};

export const setOrderSession = (orderId: string, sessionId: string): void => {
  updateOrderSession.run(sessionId, orderId);
};

/** Reserve `delta` bytes against a paid order's budget, atomically. true = within
 *  budget (reserved); false = would exceed the budget OR the order is not paid. */
export function consumeOrderBudget(orderId: string, delta: number): boolean {
  const info = consumeOrderBytes.run(delta, orderId, delta);
  return Number(info.changes) > 0;
}

// ── download grants (one download = one grant, not one HTTP request) ──
//
// A resumed or many-connection download of a single file issues many range
// requests; counting them would burn many credits for one logical download. The
// unit is a GRANT: the first ungranted hit claims one credit and mints a grant, and
// later requests carrying that grant are the same download and cost nothing.

export interface GrantRow {
  grantId: string;
  transferId: string;
  issuedAt: number;
  expiresAt: number;
  bytesServed: number;
  completed: boolean;
}

const countGrantsStmt = db.prepare(`SELECT COUNT(*) AS n FROM download_grants WHERE transfer_id = ?`);
const insertGrant = db.prepare(
  `INSERT INTO download_grants (grant_id, transfer_id, issued_at, expires_at) VALUES (?, ?, ?, ?)`,
);
const selectGrant = db.prepare(`SELECT * FROM download_grants WHERE grant_id = ?`);
const addGrantBytes = db.prepare(`UPDATE download_grants SET bytes_served = bytes_served + ? WHERE grant_id = ?`);

export const countGrants = (transferId: string): number =>
  Number((countGrantsStmt.get(transferId) as { n: number }).n);

/** Claim one download against the allowance, atomically. Synchronous by design:
 *  DatabaseSync is in-process and this counts then inserts with nothing awaited
 *  between, so two concurrent recipients cannot both take the last credit. Returns
 *  the new grant id, or null when the allowance is exhausted. */
export function claimDownloadGrant(
  transferId: string, downloadsAllowed: number, ttlMs: number,
): string | null {
  if (countGrants(transferId) >= downloadsAllowed) return null;
  const grantId = randomUUID();
  const now = Date.now();
  insertGrant.run(grantId, transferId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return grantId;
}

export function getGrant(grantId: string): GrantRow | undefined {
  const r = selectGrant.get(grantId) as any;
  if (!r) return undefined;
  return {
    grantId: r.grant_id, transferId: r.transfer_id,
    issuedAt: Date.parse(r.issued_at), expiresAt: Date.parse(r.expires_at),
    bytesServed: Number(r.bytes_served), completed: !!r.completed,
  };
}

export const recordGrantBytes = (grantId: string, bytes: number): void => {
  addGrantBytes.run(bytes, grantId);
};
