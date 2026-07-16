// Billing-ready metering ledger. Every billable event — transfer bytes, AI
// pipeline steps, QC passes — is recorded here, keyed by transfer, each entry
// traceable back to the provenance manifest (provenance-backed billing: you
// can PROVE every line item ran, on that file, at that time).
//
// In-memory, with optional JSONL append when METERING_FILE is set. The entry
// shape maps 1:1 onto a usage-billing provider's meter event (Stripe/Lago) —
// production swaps the file append for a POST to the billing meter.
import { appendFileSync } from "node:fs";

export interface MeterEvent {
  transferId: string;
  event: string;   // "transfer" | "thumbnail" | "summarize" | "qc" | ...
  units: number;
  unit: string;    // "gb" | "run" | "minutes"
  ts: string;
  ref?: string;    // object key / manifest step this entry is provable against
}

const ledger: MeterEvent[] = [];
const FILE = process.env.METERING_FILE;

export function meter(e: Omit<MeterEvent, "ts">): void {
  const entry: MeterEvent = { ...e, ts: new Date().toISOString() };
  ledger.push(entry);
  if (FILE) {
    try { appendFileSync(FILE, JSON.stringify(entry) + "\n"); } catch { /* best-effort */ }
  }
}

export function usageFor(transferId: string): {
  events: MeterEvent[];
  totals: Record<string, { units: number; unit: string }>;
} {
  const events = ledger.filter((e) => e.transferId === transferId);
  const totals: Record<string, { units: number; unit: string }> = {};
  for (const e of events) {
    const t = (totals[e.event] ??= { units: 0, unit: e.unit });
    t.units = Number((t.units + e.units).toFixed(6));
  }
  return { events, totals };
}
