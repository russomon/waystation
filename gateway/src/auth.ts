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

const env = process.env as Record<string, string | undefined>;

export const AUTH_MODE = (env.WAYSTATION_AUTH_MODE || "disabled").trim();
export const IS_PRODUCTION = env.NODE_ENV === "production";
const SESSION_TTL_SECONDS = Number(env.WAYSTATION_SESSION_TTL_SECONDS || 3600);
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
  if (!codeHash || !codeHash.startsWith("scrypt$"))
    throw new Error("WAYSTATION_ACCESS_CODE_HASH missing or not a scrypt hash — refusing to start");
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

export function issueSession(): { token: string; sid: string; expiresAt: number } {
  const sid = randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = b64url(Buffer.from(JSON.stringify({ sid, exp: expiresAt })));
  return { token: `${payload}.${sign(payload)}`, sid, expiresAt };
}

/** Returns the session id, or null when absent, tampered, or expired. */
export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expectedMac = Buffer.from(sign(payload));
  const givenMac = Buffer.from(mac);
  if (expectedMac.length !== givenMac.length || !timingSafeEqual(expectedMac, givenMac)) return null;
  try {
    const { sid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof sid !== "string" || typeof exp !== "number" || Date.now() > exp) return null;
    return sid;
  } catch {
    return null;
  }
}

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

export const sessionIdOf = (c: Context): string | null =>
  authEnabled ? readSession(getCookie(c, COOKIE)) : "dev-session";

/** Gate for expensive / state-changing sender routes. Registered AFTER the CORS
 *  middleware so an OPTIONS preflight is answered by cors() and never reaches
 *  this — a 401 on preflight would stop the browser sending the real request. */
export const requireSession: MiddlewareHandler = async (c: Context, next: Next) => {
  if (!authEnabled) return next();
  const sid = sessionIdOf(c);
  if (!sid)
    return c.json({ error: "Session required or expired.", code: "session_required" }, 401);
  c.set("sessionId", sid);
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

export const limiter =
  (name: string, limit: number, windowMs: number, bySession = false): MiddlewareHandler =>
  async (c: Context, next: Next) => {
    const who = bySession ? sessionIdOf(c) || clientKey(c) : clientKey(c);
    if (!rateLimit(`${name}:${who}`, limit, windowMs))
      return c.json({ error: "Too many requests — slow down.", code: "rate_limited" }, 429);
    return next();
  };
