// Billing-ready metering ledger. Every billable event — transfer bytes, AI
// pipeline steps, QC passes — is recorded here, keyed by transfer, each entry
// traceable back to the provenance manifest (provenance-backed billing: you
// can PROVE every line item ran, on that file, at that time).
//
// Durable and IDEMPOTENT as of the hosted MVP. Previously an in-memory array
// with an optional JSONL append and no idempotency key, so a retried worker
// callback double-counted usage and a restart erased the ledger entirely.
// Storage is now SQLite (db.ts) with the idempotency key as the primary key;
// a replayed callback is a no-op. The entry shape still maps 1:1 onto a
// usage-billing provider's meter event (Stripe/Lago) — Track B swaps the local
// write for a POST to the billing meter.
import { appendFileSync } from "node:fs";
import { recordMeter, usageFor as dbUsageFor, type MeterEvent } from "./db.js";

export type { MeterEvent };

const FILE = process.env.METERING_FILE;

/** `idempotencyKey` is optional: when the caller can supply a stable id it wins,
 *  otherwise db.ts derives one from the event's own content. */
export function meter(e: Omit<MeterEvent, "ts">, idempotencyKey?: string): void {
  recordMeter(e, idempotencyKey);
  if (FILE) {
    const entry: MeterEvent = { ...e, ts: new Date().toISOString() };
    try { appendFileSync(FILE, JSON.stringify(entry) + "\n"); } catch { /* best-effort */ }
  }
}

export const usageFor = dbUsageFor;
