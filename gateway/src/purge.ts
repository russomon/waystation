// Storage purge: permanently delete a transfer's objects once its link is dead.
//
// Expiry and revocation only stop the gateway from handing out access; the
// objects stayed in B2 indefinitely, with every old version kept by bucket
// versioning. This removes them — every version and delete marker under
// `transfers/<id>/` and `derivatives/<id>/` — a grace period after the link
// expired or was revoked, then records `purged_at` on the (retained) row so the
// ledger and admin stats still make sense.
//
// Deletion is irreversible, so the job is conservative on purpose:
//   * WAYSTATION_PURGE_MODE is off | dry-run | on, and defaults to dry-run: it
//     logs what it WOULD delete and deletes nothing until an operator says on.
//   * Only a transfer id shaped like the UUIDs the gateway mints is ever turned
//     into a prefix, so a malformed row can never become `transfers/` and take
//     the whole bucket with it.
//   * A transfer is marked purged only when every version was deleted; any
//     failure (a WORM-locked manifest, a network error) leaves it for the next
//     pass rather than claiming a purge that did not happen.
//
// Logs carry only the first 8 characters of a transfer id — ids are bearer
// capabilities (CLAUDE.md).
import { markPurged, purgeableTransfers } from "./db.js";
import { deleteVersion, listVersions } from "./s3.js";

const env = process.env as Record<string, string | undefined>;
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const PURGE_MODE = (["off", "dry-run", "on"] as const).find((m) => m === env.WAYSTATION_PURGE_MODE?.trim())
  ?? "dry-run";
export const PURGE_GRACE_DAYS = num(env.WAYSTATION_PURGE_GRACE_DAYS, 7);
const INTERVAL_MS = num(env.WAYSTATION_PURGE_INTERVAL_SECONDS, 3600) * 1000;
const BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const purgeBanner = (): string =>
  `purge: ${PURGE_MODE}${PURGE_MODE === "off" ? "" : ` (grace ${PURGE_GRACE_DAYS}d, every ${INTERVAL_MS / 1000}s)`}`;

const short = (id: string) => `${id.slice(0, 8)}…`;

let running = false;

/** One pass. Exported for the proof; the gateway runs it on a timer. */
export async function runPurge(): Promise<{ purged: number; wouldPurge: number; failed: number; skipped: number }> {
  const result = { purged: 0, wouldPurge: 0, failed: 0, skipped: 0 };
  if (PURGE_MODE === "off" || running) return result;
  running = true;
  try {
    for (const id of purgeableTransfers(PURGE_GRACE_DAYS * 86_400_000, BATCH)) {
      if (!UUID.test(id)) {
        console.warn(`purge: skipped a transfer whose id is not a UUID (${short(id)}) — never deleting by a non-UUID prefix`);
        result.skipped += 1;
        continue;
      }
      try {
        const versions = [
          ...(await listVersions(`transfers/${id}/`)),
          ...(await listVersions(`derivatives/${id}/`)),
        ];
        if (PURGE_MODE === "dry-run") {
          console.log(`purge: DRY RUN — would delete ${versions.length} object version(s) for ${short(id)}`);
          result.wouldPurge += 1;
          continue;
        }
        let failures = 0;
        for (const v of versions) {
          try { await deleteVersion(v); } catch { failures += 1; }
        }
        if (failures) {
          console.warn(`purge: ${short(id)} — ${failures} of ${versions.length} version(s) could not be deleted; will retry`);
          result.failed += 1;
          continue;
        }
        markPurged(id);
        console.log(`purge: ${short(id)} — deleted ${versions.length} object version(s)`);
        result.purged += 1;
      } catch (e) {
        console.warn(`purge: ${short(id)} — listing failed (${(e as Error).name}); will retry`);
        result.failed += 1;
      }
    }
  } finally {
    running = false;
  }
  return result;
}

/** Start the timer. The first pass runs shortly after boot rather than an
 *  interval later, so a restart never postpones overdue deletions by an hour. */
export function startPurgeLoop(): void {
  if (PURGE_MODE === "off") return;
  const tick = () => { void runPurge().catch((e) => console.warn(`purge: pass failed (${(e as Error).name})`)); };
  setTimeout(tick, Math.min(INTERVAL_MS, 60_000)).unref?.();
  setInterval(tick, INTERVAL_MS).unref?.();
}
