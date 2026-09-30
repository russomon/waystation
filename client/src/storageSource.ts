// The storage URL a download reads from, renewed before it expires.
//
// Its own module, with no DOM imports, for the same reason as ranges.ts: this
// is the logic most worth testing directly — scripts/storage-renewal-proof.sh
// drives it under plain Node against a real gateway and MinIO.
//
// Why it exists: the mediated route hands out a presigned storage URL that
// lives for an hour (routes.ts, STORAGE_URL_TTL_SECONDS) and cannot be recalled.
// Storage checks that expiry when a request STARTS, so a range already in flight
// finishes — but a parallel download starts new ranges for as long as it runs,
// and every one started after the hour is refused. Before this, a download that
// outlasted the hour stopped and waited for the recipient to click Resume.
//
// Two defences, because neither is enough alone:
//   * PROACTIVE — renew shortly before the URL expires, so ranges never see a
//     refusal on a machine that stays awake.
//   * REACTIVE — a range refused with 401/403 renews and retries once, which
//     covers a laptop that slept straight past the expiry.
// Renewal is single-flight: twelve workers refused at the same moment share one
// trip to the gateway rather than making twelve.
//
// Every renewal goes back through the mediated route, so it re-checks
// revocation and expiry: a transfer revoked mid-download now stops at the next
// renewal instead of running to the end. It never spends another download
// credit — a paid download presents its grant cookie, an unlimited one the
// `continuation` token — and never re-meters egress (see routes.ts).

/** Renew this long before the URL expires. Covers the request-start latency and
 *  a modest clock stall; ranges that start before expiry finish regardless. */
export const RENEW_MARGIN_MS = 5 * 60_000;

export interface Resolved {
  url: string;
  /** Seconds the URL is valid for, measured from when the gateway answered.
   *  Relative on purpose, so a recipient with a wrong clock still renews on time. */
  expiresIn?: number;
  continuation?: string;
}

/** Ask the gateway where storage actually is.
 *
 *  Script MUST NOT fetch the mediated url itself. It answers with a redirect to
 *  another origin, and the Fetch spec requires the browser to send
 *  `Origin: null` on a cross-origin redirected request — which B2 answers with
 *  403. Both hosts have correct CORS and it still fails, because `null` is not
 *  any host's configured origin. Allowing `null` at the bucket would let any
 *  sandboxed context read the object, so the fix is on this side: request JSON,
 *  then go to storage directly, where the origin is intact and a preflight is
 *  permitted.
 *
 *  The redirect is still the right shape for a top-level `<a href>` navigation
 *  (not a CORS request) and for curl or aria2c (no CORS at all). */
export async function resolveStorageUrl(url: string, continuation?: string): Promise<Resolved> {
  // Credentialed, unlike the storage fetches: this hits the gateway's mediated
  // /original route, which for a paid link claims one download credit and sets
  // an HttpOnly, transfer-scoped grant cookie. Sending that cookie back (it is
  // same-site to the gateway, so a Strict cookie is delivered) is what makes a
  // resumed, reloaded or renewed download reuse the SAME credit instead of
  // spending another. This is JSON, not the 302, so the cross-origin-redirect
  // CORS problem does not apply here.
  const u = new URL(url, globalThis.location?.href);
  u.searchParams.set("format", "json");
  if (continuation) u.searchParams.set("cont", continuation);
  const res = await fetch(u.toString(), { credentials: "include" });
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body?.code === "downloads_exhausted")
      throw Object.assign(new Error(body.error || "This link has reached its download limit."), { code: "downloads_exhausted" });
    throw new Error(`HTTP ${res.status}`);
  }
  // A revoked or expired transfer answers 404 — say what that means here.
  if (res.status === 404) throw new Error("this transfer is no longer available");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.url) throw new Error("gateway returned no storage url");
  return {
    url: body.url as string,
    expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : undefined,
    continuation: typeof body.continuation === "string" ? body.continuation : undefined,
  };
}

export interface StorageSource {
  /** The URL to start a request with, renewed first if it is about to expire. */
  current(): Promise<string>;
  /** Called after `stale` was refused. Renews unless another caller already
   *  replaced it, and returns the URL to retry with. */
  renew(stale: string): Promise<string>;
}

/** Resolve `mediated` once and keep the resulting storage URL fresh.
 *
 *  If the first resolution fails for any reason but a spent download limit, the
 *  mediated url is used as given — a deployment that serves storage directly
 *  needs no resolution — and is never proactively renewed, since there is no
 *  expiry to renew against. */
export async function openStorageSource(
  mediated: string,
  opts: { marginMs?: number; resolve?: typeof resolveStorageUrl } = {},
): Promise<StorageSource> {
  const margin = opts.marginMs ?? RENEW_MARGIN_MS;
  const resolve = opts.resolve ?? resolveStorageUrl;
  let url = mediated;
  let expiresAt = Infinity;
  let continuation: string | undefined;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (!inflight)
      inflight = (async () => {
        const asked = Date.now();
        const r = await resolve(mediated, continuation);
        url = r.url;
        continuation = r.continuation ?? continuation;
        // Measured from when we ASKED, so the time the request took counts
        // against the URL rather than being silently added to its life.
        expiresAt = r.expiresIn ? asked + r.expiresIn * 1000 : Infinity;
      })().finally(() => { inflight = null; });
    return inflight;
  };

  try {
    await refresh();
  } catch (e) {
    // A spent download limit is terminal — surface it rather than falling through
    // to a raw fetch of the mediated url, which would only 403 again less clearly.
    if ((e as { code?: string })?.code === "downloads_exhausted") throw e;
  }

  return {
    async current() {
      if (Date.now() >= expiresAt - margin) await refresh();
      return url;
    },
    async renew(stale) {
      if (url === stale) await refresh();
      return url;
    },
  };
}

/** GET from storage, renewing and retrying ONCE if storage refuses the URL.
 *  Anything else — including a refusal that survives renewal — is returned to
 *  the caller unchanged. */
export async function fetchFromStorage(
  source: StorageSource, init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const url = await source.current();
  const res = await fetch(url, init);
  if (res.status !== 401 && res.status !== 403) return res;
  await res.body?.cancel();
  return fetch(await source.renew(url), init);
}
