// Backblaze B2 Event Notification webhook handling.
// B2 POSTs here when an object is created; we verify its HMAC signature,
// parse the event(s), and decide which ones are *original media* worth
// running the Genblaze pipeline on.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface B2Event { eventType: string; objectName: string; bucketName: string; }

// B2 signs the raw body: header `X-Bz-Event-Notification-Signature: v1=<hex>`.
export function verifyB2Signature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseB2Events(body: unknown): B2Event[] {
  const events = (body as { events?: unknown[] })?.events ?? [];
  return events.map((e) => {
    const ev = e as Record<string, string>;
    return { eventType: ev.eventType, objectName: ev.objectName, bucketName: ev.bucketName };
  });
}

// Only the user's uploaded original should trigger the pipeline. Skip the
// `.obao` outboard sidecar, and skip anything the pipeline itself writes
// (under `derivatives/`) — otherwise the pipeline's own writes re-trigger it.
export function isOriginalMedia(key: string): boolean {
  if (!key.startsWith("transfers/")) return false;
  if (key.endsWith(".obao")) return false;
  if (key.includes("/derivatives/")) return false;
  return true;
}

export const transferIdFromKey = (key: string): string => key.split("/")[1] ?? "";
