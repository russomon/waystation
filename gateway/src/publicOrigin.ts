// Trusted public API origin, for URLs the gateway hands back to browsers.
//
// The mediated-download link (`original.url`) is returned to recipients and the
// client fetches it. It used to be built from the incoming request, trusting
// X-Forwarded-Proto / X-Forwarded-Host (and the Host header itself) — all of
// which a client can set. A forged host would have put an attacker-chosen origin
// in a link the page then follows, e.g. to harvest the unlock cookie's target or
// to redirect a download. The origin now comes ONLY from configuration.
//
//   WAYSTATION_PUBLIC_API_ORIGIN   scheme + host (+ port) of the public API,
//                                  e.g. https://api.orbitolive.com
//
// This is deliberately a different setting from WAYSTATION_PUBLIC_BASE_URL,
// which is the website sender page used for payment success/cancel redirects.
//
// Rules (pure, unit-tested in gateway/test/publicOrigin.test.ts):
//   * https is required, except http on a loopback host (local development).
//   * origin only: no path, query, fragment or credentials.
//   * production: absent or invalid configuration REFUSES TO START.
//   * development: invalid configuration refuses to start; absent configuration
//     falls back to the request's own host ONLY when that host is loopback, and
//     always over http. Any other host with no configuration is refused at the
//     point of use — there is no fallback that trusts an arbitrary header.

/** Path under which the API app is mounted (server.ts: `app.route("/api", api)`). */
export const API_MOUNT = "/api";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.has(hostname.toLowerCase());

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: string };

/** Validate a configured API origin. Returns the normalized origin. */
export function parsePublicApiOrigin(raw: string | undefined): OriginResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "not set" };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: "not a valid absolute URL" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: "scheme must be https (or http on a loopback host)" };
  if (!u.hostname) return { ok: false, reason: "missing host" };
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname))
    return { ok: false, reason: "http is only allowed for a loopback host; use https" };
  if (u.username || u.password) return { ok: false, reason: "must not contain credentials" };
  if (u.search || u.hash) return { ok: false, reason: "must not contain a query or fragment" };
  if (u.pathname !== "/" && u.pathname !== "") return { ok: false, reason: "must be an origin only, without a path" };
  if (/[\s]/.test(text)) return { ok: false, reason: "must not contain whitespace" };
  return { ok: true, origin: u.origin };
}

export type PublicOriginConfig = { origin: string | null };

/** Resolve configuration at boot. Throws on anything that must not run. */
export function loadPublicApiOrigin(raw: string | undefined, production: boolean): PublicOriginConfig {
  const parsed = parsePublicApiOrigin(raw);
  if (parsed.ok) {
    if (production && !parsed.origin.startsWith("https://"))
      throw new Error("WAYSTATION_PUBLIC_API_ORIGIN must be an https origin when NODE_ENV=production.");
    return { origin: parsed.origin };
  }
  if ((raw ?? "").trim() || production)
    throw new Error(
      `WAYSTATION_PUBLIC_API_ORIGIN is ${(raw ?? "").trim() ? "invalid" : "required"} (${parsed.reason}). ` +
      "Set it to the public API origin, e.g. https://api.orbitolive.com — it is not derived from request headers.");
  return { origin: null };
}

/** Absolute mediated-download URL for a transfer, or null when no trusted origin
 *  exists. `requestHost` is consulted ONLY in the unconfigured development
 *  fallback and only if it is loopback; X-Forwarded-* are never read. */
export function mediatedDownloadUrlFor(
  cfg: PublicOriginConfig,
  requestUrl: string,
  transferId: string,
): string | null {
  let base: string | null = cfg.origin;
  if (!base) {
    let u: URL;
    try { u = new URL(requestUrl); } catch { return null; }
    if (!isLoopbackHost(u.hostname)) return null;
    base = `http://${u.host}`;
  }
  return `${base}${API_MOUNT}/transfers/${encodeURIComponent(transferId)}/original`;
}
