// Transfer registry — durable as of the hosted MVP.
//
// This was an in-memory Map whose own comment said "Lost on restart". Because
// `options: undefined` means "all services on" by contract, losing the record
// did not merely forget a transfer: on the next B2 event it silently promoted a
// TRANSFER-ONLY job to full AI QC, and billed for it. State now lives in SQLite
// (db.ts) on a persistent volume. The exported API is unchanged, so callers did
// not have to move — and `undefined` options still mean exactly what they did.
export type { TransferRow as TransferMeta } from "./db.js";
export { saveTransfer, getTransfer } from "./db.js";
