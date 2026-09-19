// Sender authentication for the hosted MVP.
//
// One high-entropy judge code exchanged ONCE for a short-lived, signed, opaque
// session cookie. The browser never stores the code itself — a code kept in
// localStorage/sessionStorage is readable by any XSS and replayable forever.
//
// The session is stateless: the signed cookie carries its own id and expiry, so
// there is no session table to keep. Uploads reference that session id for
// ownership (step 4). Rotating WAYSTATION_SESSION_SECRET therefore invalidates
// every live session at once, which is the documented panic button.
//
// The literal code `waystationQC` from early planning is RETIRED and must never
// be used — it was disclosed in plaintext. Only a slow hash of a freshly
// generated code is ever configured, and only on the VPS.
import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { accessCodeActive, getOrder } from "./db.js";

const env = process.env as Record<string, string | undefined>;

export const AUTH_MODE = (env.WAYSTATION_AUTH_MODE || "disabled").trim();
export const IS_PRODUCTION = env.NODE_ENV === "production";
const SESSION_TTL_SECONDS = Number(env.WAYSTATION_SESSION_TTL_SECONDS || 3600);
const RECIPIENT_TTL_SECONDS = Number(env.WAYSTATION_RECIPIENT_UNLOCK_TTL_SECONDS || 3600);
const COOKIE = "ws_session";

// ── scrypt: Node built-in, no native dependency to build in the container ──
// Format is self-describing so parameters can change without a flag day.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashAccessCode(code: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const dk = scryptSync(code.normalize("NFKC"), s, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${s.toString("base64")}$${dk.toString("base64")}`;
}

export function verifyAccessCode(code: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let derived: Buffer;
  const expected = Buffer.from(hashB64, "base64");
  try {
    derived = scryptSync(code.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Owner id carried by sessions opened with the environment access code. */
export const ADMIN_OWNER = "admin";

// ~103 bits of entropy in an unambiguous alphabet (no O/0/I/l), grouped so it
// can be dictated over a call without transcription errors. Shared by the
// operator script and the admin create route so every code has one shape.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateAccessCode(): string {
  const pick = (n: number) =>
    Array.from(randomBytes(n)).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return [pick(5), pick(5), pick(5), pick(5)].join("-");
}

/** Structural check for `scrypt$N$r$p$saltB64$hashB64`. Guards against a hash
 *  mangled by Docker Compose's `$` interpolation, which leaves a value that
 *  still *looks* like a scrypt hash to a prefix test. */
export function looksLikeScryptHash(value: string): boolean {
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  if (![n, r, p].every((x) => /^\d+$/.test(x) && Number(x) > 0)) return false;
  try {
    // A truncated or emptied base64 segment is the usual interpolation damage.
    return Buffer.from(salt, "base64").length >= 8 && Buffer.from(hash, "base64").length >= 16;
  } catch {
    return false;
  }
}

// ── configuration, validated at boot ──

export interface AuthConfig {
  mode: "disabled" | "access-code";
  codeHash?: string;
  sessionSecret?: string;
}

function loadConfig(): AuthConfig {
  if (AUTH_MODE === "disabled") {
    // Fail CLOSED: a production deployment must never silently run open.
    if (IS_PRODUCTION) {
      throw new Error(
        "WAYSTATION_AUTH_MODE=disabled is refused when NODE_ENV=production — " +
          "set access-code with WAYSTATION_ACCESS_CODE_HASH and WAYSTATION_SESSION_SECRET",
      );
    }
    return { mode: "disabled" };
  }
  if (AUTH_MODE !== "access-code") {
    throw new Error(`WAYSTATION_AUTH_MODE must be "disabled" or "access-code" (got "${AUTH_MODE}")`);
  }
  const codeHash = (env.WAYSTATION_ACCESS_CODE_HASH || "").trim();
  const sessionSecret = (env.WAYSTATION_SESSION_SECRET || "").trim();
  if (!codeHash)
    throw new Error("WAYSTATION_ACCESS_CODE_HASH missing — refusing to start");
  // Validate the STRUCTURE, not just the prefix. Docker Compose interpolates
  // `$` inside env_file values, so an unquoted hash arrives mangled — and
  // `scrypt$16384$8$1===` still starts with "scrypt$". A prefix-only check
  // would boot happily and then reject every correct code, which is a
  // miserable thing to debug. Fail loudly here instead, with the fix.
  if (!looksLikeScryptHash(codeHash))
    throw new Error(
      "WAYSTATION_ACCESS_CODE_HASH is not a well-formed scrypt hash — refusing to start. " +
        "If it was set via a Docker Compose env_file, quote it: " +
        "WAYSTATION_ACCESS_CODE_HASH='scrypt$...' (or escape each $ as $$). " +
        "Compose expands $NAME inside env_file values and silently corrupts it.",
    );
  if (sessionSecret.length < 32)
    throw new Error("WAYSTATION_SESSION_SECRET missing or too short (>=32 chars) — refusing to start");
  return { mode: "access-code", codeHash, sessionSecret };
}

export const authConfig: AuthConfig = loadConfig();
export const authEnabled = authConfig.mode === "access-code";

/** Boot line. Mode only — never the code, hash, token, or signing secret. */
export const authBanner = (): string =>
  `auth: ${authConfig.mode}${authEnabled ? ` (session ttl ${SESSION_TTL_SECONDS}s)` : " — DEVELOPMENT ONLY"}`;

// ── signed, opaque, short-lived session ──

const b64url = (b: Buffer): string => b.toString("base64url");

function sign(payload: string): string {
  return b64url(createHmac("sha256", authConfig.sessionSecret!).update(payload).digest());
}

export interface Session {
  sid: string;
  /** Who this session acts as: an access_codes.code_id, ADMIN_OWNER, or the fresh
   *  owner id minted for a paid order. */
  ownerId: string;
  admin: boolean;
  /** Present when this session was minted by a PAID order rather than an access
   *  code. It authorizes uploads against that order's budget — see requireSession
   *  and the /uploads initiate route. */
  orderId?: string;
}

export function issueSession(
  who: { ownerId: string; admin: boolean; orderId?: string },
  existingSid?: string,
): { token: string; sid: string; expiresAt: number } {
  const sid = existingSid ?? randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sid, exp: expiresAt, oid: who.ownerId, adm: who.admin,
        ...(who.orderId ? { ord: who.orderId } : {}),
      }),
    ),
  );
  return { token: `${payload}.${sign(payload)}`, sid, expiresAt };
}

export const refreshSession = (s: Session): { token: string; sid: string; expiresAt: number } =>
  issueSession({ ownerId: s.ownerId, admin: s.admin, orderId: s.orderId }, s.sid);

/** Returns the session, or null when absent, tampered, expired — or issued
 *  before sessions carried an owner (`oid`), which forces one re-login after
 *  that change rather than treating an ownerless cookie as anybody. */
export function readSessionToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expectedMac = Buffer.from(sign(payload));
  const givenMac = Buffer.from(mac);
  if (expectedMac.length !== givenMac.length || !timingSafeEqual(expectedMac, givenMac)) return null;
  try {
    const { sid, exp, oid, adm, ord } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof sid !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    if (typeof oid !== "string" || !oid) return null;
    return { sid, ownerId: oid, admin: adm === true, orderId: typeof ord === "string" && ord ? ord : undefined };
  } catch {
    return null;
  }
}

/** Session id only, for the many call sites that need just ownership. */
export const readSession = (token: string | undefined): string | null =>
  readSessionToken(token)?.sid ?? null;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    // orbitolive.com -> api.orbitolive.com is cross-ORIGIN but same-SITE, so a
    // Strict cookie is still delivered on these subdomain fetches. Do not
    // "fix" this to None: that would permit genuine cross-site sends.
    sameSite: "Strict",
    // Secure is mandatory in production. Only explicit HTTP localhost dev may
    // omit it, because a Secure cookie is never stored over plain http.
    secure: IS_PRODUCTION,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export const clearSessionCookie = (c: Context): void => {
  deleteCookie(c, COOKIE, { path: "/", secure: IS_PRODUCTION, sameSite: "Strict" });
};

const DEV_SESSION: Session = { sid: "dev-session", ownerId: ADMIN_OWNER, admin: true };

export const sessionOf = (c: Context): Session | null =>
  authEnabled ? readSessionToken(getCookie(c, COOKIE)) : DEV_SESSION;

export const sessionIdOf = (c: Context): string | null => sessionOf(c)?.sid ?? null;

// ── transfer-scoped recipient unlock ──

const recipientCookie = (transferId: string): string =>
  `ws_r_${transferId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 64)}`;

function recipientSign(payload: string): string {
  // Production always has the session secret because open auth is refused.
  // Local proof/dev may intentionally disable sender auth; the pipeline secret
  // keeps recipient tokens signed there without adding another required knob.
  const secret = authConfig.sessionSecret || env.PIPELINE_SHARED_SECRET || "waystation-local-recipient-token-secret";
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function setRecipientUnlockCookie(c: Context, transferId: string): number {
  const expiresAt = Date.now() + RECIPIENT_TTL_SECONDS * 1000;
  const payload = b64url(Buffer.from(JSON.stringify({ tid: transferId, exp: expiresAt })));
  setCookie(c, recipientCookie(transferId), `${payload}.${recipientSign(payload)}`, {
    httpOnly: true,
    sameSite: "Strict",
    secure: IS_PRODUCTION,
    path: "/api",
    maxAge: RECIPIENT_TTL_SECONDS,
  });
  return expiresAt;
}

/** Shared verification for every transfer-scoped bearer token this module mints
 *  — the unlock cookie and the download ticket below. Both carry the same
 *  `{tid, exp}` payload under the same HMAC, so they must not drift apart. */
function verifyRecipientToken(token: string | undefined, transferId: string): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = Buffer.from(recipientSign(payload));
  const supplied = Buffer.from(mac);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    return decoded?.tid === transferId && typeof decoded?.exp === "number" && Date.now() <= decoded.exp;
  } catch {
    return false;
  }
}

export const hasRecipientUnlock = (c: Context, transferId: string): boolean =>
  verifyRecipientToken(getCookie(c, recipientCookie(transferId)), transferId);

// ── download-grant cookie (one download's continuation) ──
//
// The grant id itself is the bearer token — a random UUID looked up in
// download_grants and scoped to one transfer. It rides in a Strict, HttpOnly,
// transfer-scoped cookie so a browser resuming or parallel-ranging a download is
// recognised as the SAME download and does not spend another credit. Non-browser
// tools pass it back as ?grant=… instead.
const grantCookieName = (transferId: string): string =>
  `ws_g_${transferId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 64)}`;

export const getDownloadGrantCookie = (c: Context, transferId: string): string | undefined =>
  getCookie(c, grantCookieName(transferId));

export function setDownloadGrantCookie(
  c: Context, transferId: string, grantId: string, ttlSeconds: number,
): void {
  setCookie(c, grantCookieName(transferId), grantId, {
    httpOnly: true,
    sameSite: "Strict",
    secure: IS_PRODUCTION,
    path: "/api",
    maxAge: ttlSeconds,
  });
}

// ── download tickets ──
//
// A ticket authorizes one transfer's original for whoever holds it — but unlike
// a presigned storage URL it is NOT self-sufficient. It names the transfer and
// nothing else; the gateway re-checks revocation and expiry (and, later,
// download credits) on every single use. That is the entire point. A presigned
// URL cannot be recalled once minted, so a short life is the only bound
// available to it. A ticket can be long-lived precisely because the gateway
// stays in the loop and can refuse at any moment.
//
// It rides in the query string rather than a cookie for two reasons:
//
//   1. The request carrying it is redirected cross-origin to object storage. A
//      *credentialed* fetch that follows a redirect requires the FINAL response
//      to send Access-Control-Allow-Credentials, which B2 does not — so a
//      cookie-authenticated download would fail CORS the moment it redirected.
//   2. Non-browser clients (curl, aria2c) can then use the same link, which is
//      what makes multi-connection downloading possible without handing anyone
//      a raw storage URL.
export const issueDownloadTicket = (transferId: string, expiresAt: number): string => {
  const payload = b64url(Buffer.from(JSON.stringify({ tid: transferId, exp: expiresAt })));
  return `${payload}.${recipientSign(payload)}`;
};

export const verifyDownloadTicket = (ticket: string | undefined, transferId: string): boolean =>
  verifyRecipientToken(ticket, transferId);

/** Gate for expensive / state-changing sender routes. Registered AFTER the CORS
 *  middleware so an OPTIONS preflight is answered by cors() and never reaches
 *  this — a 401 on preflight would stop the browser sending the real request. */
export const requireSession: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!authEnabled) return next();
  const s = sessionOf(c);
  if (!s)
    return c.json({ error: "Session required or expired.", code: "session_required" }, 401);
  if (s.orderId) {
    // Payment-backed session: authorized by its PAID order, not an access code.
    // The per-initiate budget guard (consumeOrderBudget) is what bounds how much
    // may be uploaded; here we only require the order to still be paid, so an
    // in-flight upload whose budget is already reserved can always finish.
    const order = getOrder(s.orderId);
    if (!order || order.status !== "paid") {
      clearSessionCookie(c);
      return c.json({ error: "Payment session is no longer valid.", code: "session_unpaid" }, 401);
    }
  } else if (!s.admin && !accessCodeActive(s.ownerId)) {
    // Revocation is live: a named code is re-checked on every credentialed call
    // (in-process SQLite, microseconds), so revoking it cuts the holder off at
    // their next request rather than when the cookie happens to expire. The
    // environment code has no row and cannot be revoked here — rotate it.
    clearSessionCookie(c);
    return c.json({ error: "This access code has been revoked.", code: "session_revoked" }, 401);
  }
  c.set("sessionId", s.sid);
  c.set("ownerId", s.ownerId);
  const { token } = refreshSession(s);
  setSessionCookie(c, token);
  return next();
};

/** Admin-only routes. A signed-in sender who is not the admin gets the same
 *  neutral 404 an unknown path would — never confirm the routes exist. */
export const requireAdmin: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!authEnabled) return next();
  const s = sessionOf(c);
  if (!s) return c.json({ error: "Session required or expired.", code: "session_required" }, 401);
  if (!s.admin) return c.json({ error: "not found" }, 404);
  c.set("sessionId", s.sid);
  c.set("ownerId", s.ownerId);
  const { token } = refreshSession(s);
  setSessionCookie(c, token);
  return next();
};

// ── allowed browser origins (exact; never "*" with credentials) ──

export const allowedOrigins: string[] = (
  env.WAYSTATION_ALLOWED_ORIGINS ||
  (IS_PRODUCTION
    ? "https://orbitolive.com,https://www.orbitolive.com"
    : "https://orbitolive.com,https://www.orbitolive.com,http://localhost:5173,http://localhost:4173")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Origin check for state-changing sender requests. A same-origin or non-browser
 *  caller may omit Origin entirely; only a PRESENT and unlisted origin is
 *  rejected, so server-to-server callers and the proof suite still work. */
export const enforceOrigin: MiddlewareHandler = async (c: Context, next: Next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedOrigins.includes(origin))
    return c.json({ error: "Origin not allowed.", code: "bad_origin" }, 403);
  return next();
};

// ── rate limiting ──
//
// Fixed-window, in memory. Adequate for the single-instance MVP; Track B moves
// it to shared durable state when more than one gateway runs. The client IP is
// taken from CF-Connecting-IP, trusted ONLY because the gateway has no public
// port and every request must arrive through the Cloudflare Tunnel.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export const clientKey = (c: Context): string =>
  c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";

/** One bucket for everyone, regardless of source address. The per-client
 *  limiter bounds one attacker; this bounds a distributed one. Sized for
 *  humans: a whole deployment's senders do not log in 60 times a minute. */
export const globalLimiter =
  (name: string, limit: number, windowMs: number): MiddlewareHandler =>
  async (c: Context, next: Next) => {
    if (!rateLimit(`${name}:*`, limit, windowMs))
      return c.json({ error: "Too many sign-in attempts right now — try again in a minute.", code: "rate_limited" }, 429);
    return next();
  };

export const limiter =
  (name: string, limit: number, windowMs: number, bySession = false): MiddlewareHandler =>
  async (c: Context, next: Next) => {
    const who = bySession ? sessionIdOf(c) || clientKey(c) : clientKey(c);
    if (!rateLimit(`${name}:${who}`, limit, windowMs))
      return c.json({ error: "Too many requests — slow down.", code: "rate_limited" }, 429);
    return next();
  };
