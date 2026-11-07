import { test } from "node:test";
import assert from "node:assert/strict";

// In-memory database (db.ts falls back to ":memory:" when the path is unset).
delete process.env.WAYSTATION_DB_PATH;
const { db, adminExtras, adminBySender, adminTransferPage } = await import("../src/db.js");

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const code = (id: string, label: string) =>
  db.prepare(`INSERT INTO access_codes (code_id, label, code_hash, created_at) VALUES (?, ?, 'h', ?)`)
    .run(id, label, iso(-30 * DAY));
const transfer = (o: {
  id: string; owner: string | null; at: number; exp?: number | null; revoked?: number;
  parent?: string; kind?: string; name?: string; state?: string; allowed?: number | null;
}) =>
  db.prepare(`INSERT INTO transfers (transfer_id, object_key, created_at, expires_at, revoked, owner_id,
                                      parent_id, kind, display_name, state, downloads_allowed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.id, `k/${o.id}`, iso(o.at), o.exp == null ? null : iso(o.exp), o.revoked ?? 0, o.owner,
      o.parent ?? null, o.kind ?? "file", o.name ?? null, o.state ?? "created", o.allowed ?? null);
const upload = (id: string, filename: string, o: { owner?: string; at: number; state: string; size?: number; parent?: string }) =>
  db.prepare(`INSERT INTO uploads (object_key, upload_id, transfer_id, filename, declared_size, state, created_at, owner_id, parent_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`k/${id}`, `u-${id}`, id, filename, o.size ?? 1000, o.state, iso(o.at), o.owner ?? null, o.parent ?? null);
const meter = (id: string, gb: number) =>
  db.prepare(`INSERT INTO meter_events (idempotency_key, transfer_id, event, units, unit, ts) VALUES (?, ?, 'transfer', ?, 'gb', ?)`)
    .run(`m-${id}`, id, gb, iso(0));
const grant = (n: number, tid: string) =>
  db.prepare(`INSERT INTO download_grants (grant_id, transfer_id, issued_at, expires_at) VALUES (?, ?, ?, ?)`)
    .run(`g-${tid}-${n}`, tid, iso(0), iso(DAY));

// ── fixture ──
code("c_val", "Val's Code");
code("c_bob", "Bob");

// Val: two small files; one has 2 downloads. Bob: one 3 GB file, link expiring in 1 day.
transfer({ id: "t1", owner: "c_val", at: -2 * 3_600_000, exp: 6 * DAY, allowed: 3 });
upload("t1", "promo-cut.mov", { owner: "c_val", at: -2 * 3_600_000, state: "complete" });
meter("t1", 0.004);
grant(1, "t1"); grant(2, "t1");

transfer({ id: "t2", owner: "c_val", at: -3_600_000, exp: 6 * DAY });
upload("t2", "poster.png", { owner: "c_val", at: -3_600_000, state: "complete" });
meter("t2", 0.001);

transfer({ id: "t3", owner: "c_bob", at: -2 * DAY, exp: 1 * DAY });
upload("t3", "master.mxf", { owner: "c_bob", at: -2 * DAY, state: "complete" });
meter("t3", 3);

// Admin: an expired link and a revoked one.
transfer({ id: "t4", owner: "admin", at: -20 * DAY, exp: -1 * DAY });
upload("t4", "old.zip", { owner: "admin", at: -20 * DAY, state: "complete" });
meter("t4", 1);
transfer({ id: "t5", owner: "admin", at: -4 * DAY, exp: 5 * DAY, revoked: 1 });
upload("t5", "oops.zip", { owner: "admin", at: -4 * DAY, state: "complete" });

// A folder of two files (4 + 1 GB) owned by Bob, with downloads on its members.
transfer({ id: "f1", owner: "c_bob", at: -DAY, exp: 7 * DAY, kind: "folder", name: "Reel Folder", state: "ready" });
transfer({ id: "f1a", owner: "c_bob", at: -DAY, exp: 7 * DAY, parent: "f1" });
transfer({ id: "f1b", owner: "c_bob", at: -DAY, exp: 7 * DAY, parent: "f1" });
upload("f1a", "a.mov", { owner: "c_bob", at: -DAY, state: "complete", parent: "f1" });
upload("f1b", "b.mov", { owner: "c_bob", at: -DAY, state: "complete", parent: "f1" });
meter("f1a", 4); meter("f1b", 1);
grant(1, "f1a"); grant(1, "f1b");

// A folder still uploading.
transfer({ id: "f2", owner: "c_val", at: -600_000, kind: "folder", name: "Half Folder", state: "uploading" });

// Unfinished uploads: Val's 30 h old (outside the 24 h slot window), Bob's 1 h old.
upload("x1", "stuck-big.mov", { owner: "c_val", at: -30 * 3_600_000, state: "active", size: 9_000_000_000 });
upload("x2", "midway.mov", { owner: "c_bob", at: -3_600_000, state: "active" });

test("folder members roll up into one row; members are not listed", () => {
  const { rows, total } = adminTransferPage(new Date(0).toISOString(), "all", 50, 0);
  assert.equal(total, 7); // t1 t2 t3 t4 t5 f1 f2
  assert.ok(!rows.some((r) => r.transferId === "f1a" || r.transferId === "f1b"));
  const f1 = rows.find((r) => r.transferId === "f1")!;
  assert.equal(f1.kind, "folder");
  assert.equal(f1.name, "Reel Folder");
  assert.equal(f1.gb, 5);
  assert.equal(f1.downloadsUsed, 2);
  assert.equal(f1.owner, "Bob");
});

test("files show their filename, sender label, size and downloads", () => {
  const { rows } = adminTransferPage(new Date(0).toISOString(), "all", 50, 0);
  const t1 = rows.find((r) => r.transferId === "t1")!;
  assert.equal(t1.name, "promo-cut.mov");
  assert.equal(t1.owner, "Val's Code");
  assert.equal(t1.gb, 0.004);
  assert.equal(t1.downloadsUsed, 2);
  assert.equal(t1.downloadsAllowed, 3);
  assert.equal(rows.find((r) => r.transferId === "t4")!.owner, "admin");
});

test("status filters agree with the derived status and with each other", () => {
  const since = new Date(0).toISOString();
  const ids = (f: Parameters<typeof adminTransferPage>[1]) =>
    adminTransferPage(since, f, 50, 0).rows.map((r) => r.transferId).sort();
  assert.deepEqual(ids("revoked"), ["t5"]);
  assert.deepEqual(ids("expired"), ["t4"]);
  assert.deepEqual(ids("expiring"), ["t3"]);
  assert.deepEqual(ids("uploading"), ["f2"]);
  assert.deepEqual(ids("active"), ["f1", "t1", "t2", "t3"]);
  for (const f of ["all", "active", "expiring", "expired", "revoked", "uploading"] as const)
    for (const r of adminTransferPage(since, f, 50, 0).rows)
      if (f !== "all" && !(f === "active" && r.status === "expiring")) assert.equal(r.status, f, `${f}/${r.transferId}`);
});

test("paging is stable and total is the full filtered count", () => {
  const since = new Date(0).toISOString();
  const p1 = adminTransferPage(since, "all", 3, 0);
  const p2 = adminTransferPage(since, "all", 3, 3);
  const p3 = adminTransferPage(since, "all", 3, 6);
  assert.equal(p1.total, 7);
  assert.equal(p1.rows.length + p2.rows.length + p3.rows.length, 7);
  const all = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.transferId);
  assert.equal(new Set(all).size, 7);
  assert.deepEqual(adminTransferPage(since, "all", 3, 100).rows, []);
});

test("window excludes older transfers", () => {
  const since = iso(-DAY * 3);
  const { rows } = adminTransferPage(since, "all", 50, 0);
  assert.ok(!rows.some((r) => r.transferId === "t4" || r.transferId === "t5"));
});

test("per-sender totals count a folder once and sum its members' GB", () => {
  const s = Object.fromEntries(adminBySender(new Date(0).toISOString()).map((r) => [r.owner, r]));
  assert.equal(s["Val's Code"].transfers, 3); // t1 t2 f2
  assert.ok(Math.abs(s["Val's Code"].gb - 0.005) < 1e-9);
  assert.equal(s["Val's Code"].downloads, 2);
  assert.equal(s["Bob"].transfers, 2); // t3 f1
  assert.equal(s["Bob"].gb, 8);
  assert.equal(s["Bob"].downloads, 2);
  assert.equal(s["admin"].transfers, 2);
});

test("link lifecycle counts and unfinished uploads", () => {
  const x = adminExtras(24 * 3_600_000);
  assert.equal(x.links.revoked, 1);
  assert.equal(x.links.expired, 1);
  assert.equal(x.links.expiringSoon, 1);
  assert.deepEqual(x.unfinished.map((u) => u.name), ["stuck-big.mov", "midway.mov"]); // oldest first
  assert.equal(x.unfinished[0].holdsSlot, false);
  assert.equal(x.unfinished[1].holdsSlot, true);
  assert.equal(x.unfinished[0].owner, "Val's Code");
});

test("daily series is 30 zero-filled UTC days ending today, and sums to recent activity", () => {
  const { daily } = adminExtras(24 * 3_600_000);
  assert.equal(daily.length, 30);
  assert.equal(daily[29].day, new Date().toISOString().slice(0, 10));
  const total = daily.reduce((a, d) => a + d.transfers, 0);
  assert.equal(total, 7); // every fixture transfer is within 30 days; folder counts once
});
