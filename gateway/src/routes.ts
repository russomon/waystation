import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  ADMIN_OWNER,
  authConfig,
  authEnabled,
  clearSessionCookie,
  generateAccessCode,
  globalLimiter,
  enforceOrigin,
  failureLocked,
  hasRecipientUnlock,
  hashAccessCode,
  IS_PRODUCTION,
  issueContinuation,
  issueSession,
  limiter,
  noteFailure,
  requireAdmin,
  requireSession,
  sessionIdOf,
  sessionOf,
  setRecipientUnlockCookie,
  setSessionCookie,
  getDownloadGrantCookie,
  setDownloadGrantCookie,
  verifyAccessCode,
  verifyContinuation,
} from "./auth.js";
import {
  activeAccessCodes,
  activeUploadCount,
  completedSince,
  accessCodeActive,
  accessCodeLabel,
  activeLabelExists,
  createAccessCode,
  listAccessCodes,
  revokeAccessCode,
  adminStats,
  touchAccessCode,
  completedSinceAll,
  capabilityRevoked,
  createUpload,
  getUpload,
  getUploadByKey,
  getUploadByTransferId,
  setUploadState,
  createOrder,
  getOrder,
  markOrderPaid,
  setOrderSession,
  consumeOrderBudget,
  claimDownloadGrant,
  getGrant,
  type UploadRow,
} from "./db.js";
import {
  ACCEPT_UPLOADS,
  ACTIVE_UPLOAD_WINDOW_MS,
  applyServicePolicy,
  MAX_ACTIVE_UPLOADS_PER_SESSION,
  MAX_DAILY_JOBS,
  MAX_JOBS_PER_SESSION,
  QC_MODE,
  SERVICE_KEYS,
  RECIPIENT_LINK_TTL_DAYS,
  validateFilename,
  validatePartNumbers,
  validateSidecarName,
  validateSize,
  verificationModeForSize,
} from "./limits.js";
import * as g from "./s3.js";
import { verifyB2Signature, parseB2Events, isOriginalMedia, transferIdFromKey } from "./events.js";
import { dispatchPipeline } from "./pipeline.js";
import { saveTransfer, getTransfer } from "./store.js";
import { meter, usageFor } from "./metering.js";
import * as sse from "./sse.js";
import { mayUseUpload } from "./ownership.js";
import { loadPublicApiOrigin, mediatedDownloadUrlFor } from "./publicOrigin.js";
import {
  quote,
  quoteAll,
  clampDownloads,
  clampWeeks,
  enforcedDownloads,
  linkExpiryDays,
  isGateway,
  INCLUDED_DOWNLOADS,
  MAX_DOWNLOADS,
  INCLUDED_WEEKS,
  MAX_WEEKS,
  type Gateway,
} from "./pricing.js";
import {
  createCheckout,
  parseStripeEvent,
  parseCoinbaseEvent,
  lookupPaid,
  gatewayEnabled,
  stripePublishableKey,
  type PaymentEvent,
} from "./payments.js";
import { emailEnabled, isEmail, sendLinkEmail } from "./email.js";

const env = process.env as Record<string, string>;
export const api = new Hono();

// How long a download grant stays valid — long enough to resume a large transfer
// over days. A request carrying a live grant is one download's continuation and
// never spends another credit.
const GRANT_TTL_DAYS = Number(env.WAYSTATION_DOWNLOAD_GRANT_TTL_DAYS ?? 7);
const GRANT_TTL_MS = GRANT_TTL_DAYS * 86_400_000;
const GRANT_TTL_SECONDS = GRANT_TTL_DAYS * 86_400;

// Life of the presigned storage URL the mediated route hands out. Kept short on
// purpose: once minted it cannot be recalled. A browser download that outlasts
// it renews through the mediated route (client/src/storageSource.ts), which is
// told this value as `expiresIn`. Overridable only so a proof can watch a URL
// expire in seconds rather than an hour.
const STORAGE_URL_TTL_SECONDS = Number(env.WAYSTATION_STORAGE_URL_TTL_SECONDS ?? 3600);

// ───────── sender session ─────────
// The access code is exchanged ONCE for a signed, short-lived, opaque cookie;
// the browser never stores the code. Rate limited hard because this is the only
// endpoint where a code can be guessed, and it is reachable before any session
// exists. Responses never distinguish "no code supplied" from "wrong code".
// Two limiters: 10/min per source address, and 60/min across the whole
// deployment. Admin-chosen codes can be short enough to say aloud, so the
// total guess rate anyone can achieve — from any number of addresses — must
// stay small. 60/min is ~86k attempts a day against an 8+ character code.
api.post("/session", enforceOrigin, limiter("session", 10, 60_000), globalLimiter("session", 60, 60_000), async (c) => {
  if (!authEnabled)
    return c.json({ ok: true, mode: "disabled", note: "authentication is off (development)" });
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const code = typeof body.code === "string" ? body.code : "";
  const who = code ? resolveAccessCode(code) : undefined;
  if (!who)
    return c.json({ error: "That access code was not accepted.", code: "bad_code" }, 401);
  if (!who.admin) touchAccessCode(who.ownerId);
  const { token, expiresAt } = issueSession(who);
  setSessionCookie(c, token);
  return c.json({ ok: true, expiresAt });
});

/** The environment code is the admin; every other code is a named sender row
 *  in access_codes. Each active row costs one scrypt (~50 ms) — that is bounded
 *  by however many codes the admin has issued, and the route's limiter, not by
 *  anything a caller controls. The failure response never says which kind of
 *  code was tried. */
function resolveAccessCode(code: string): { ownerId: string; admin: boolean } | undefined {
  // Exact match only. Codes are case-sensitive, chosen ones included — the
  // admin says "all lower-case" on the call rather than the gateway guessing.
  if (verifyAccessCode(code, authConfig.codeHash!)) return { ownerId: ADMIN_OWNER, admin: true };
  for (const row of activeAccessCodes())
    if (verifyAccessCode(code, row.codeHash)) return { ownerId: row.codeId, admin: false };
  return undefined;
}

/** Admin-chosen codes: 8–64 characters after trimming, case-sensitive, and
 *  not already in use by any active code (including the admin's own), because
 *  login takes the first match and a shared code would silently credit one
 *  client's transfers to another. Only the admin can reach this, and the
 *  admin issued every code, so the refusal tells them nothing they do not
 *  already know. */
const MIN_CUSTOM_CODE = 8, MAX_CUSTOM_CODE = 64;
function validateCustomCode(raw: unknown): { code: string } | { error: string; code: string; status: 400 | 409 } {
  if (typeof raw !== "string") return { error: "Code must be text.", code: "bad_code", status: 400 };
  const code = raw.trim();
  if (code.length < MIN_CUSTOM_CODE || code.length > MAX_CUSTOM_CODE)
    return { error: `A custom code must be ${MIN_CUSTOM_CODE}–${MAX_CUSTOM_CODE} characters.`, code: "bad_code", status: 400 };
  if (resolveAccessCode(code))
    return { error: "That code is already in use — choose another.", code: "code_in_use", status: 409 };
  return { code };
}

api.post("/session/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// Whether the page should show its access panel. Deliberately minimal: it says
// only that a code is required and whether this browser already holds a valid
// session — both of which the UI must know to render at all, and neither of
// which helps an attacker. No mode names, versions, origins, or limits.
api.get("/session", (c) => {
  const s = sessionOf(c);
  // `who` is the label the admin gave this code (or "admin"), so the page can
  // say which code a browser is signed in as. A label is not a secret; the
  // code id is not returned. A revoked code reads as no session at all.
  const live = s && (s.admin || accessCodeActive(s.ownerId));
  return c.json({
    authRequired: authEnabled,
    hasSession: !!live,
    admin: !!live && s.admin,
    who: live ? (s.admin ? ADMIN_OWNER : accessCodeLabel(s.ownerId) ?? "") : undefined,
    // Resolved for THIS viewer: the admin sees QC live even in preview.
    qc: QC_MODE === "preview" && !(live && s.admin) ? "preview" : "live",
  });
});

// ───────── access-code administration ─────────
//
// Only the admin session reaches these; anyone else sees a neutral 404 from
// requireAdmin. The plaintext code appears exactly once — in the create
// response — and is never logged or stored.
const MAX_LABEL = 64;

api.get("/admin/codes", requireAdmin, limiter("admin", 30, 60_000), (c) =>
  c.json({ codes: listAccessCodes() }));

api.post("/admin/codes", requireAdmin, enforceOrigin, limiter("admin", 30, 60_000), async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL)
    return c.json({ error: `A label of 1–${MAX_LABEL} characters is required.`, code: "bad_label" }, 400);
  if (activeLabelExists(label))
    return c.json({ error: `"${label}" is already an active code — revoke it first, or choose another label.`, code: "label_in_use" }, 409);
  let code: string;
  if (typeof body.code === "string" && body.code.trim()) {
    const custom = validateCustomCode(body.code);
    if ("error" in custom) return c.json({ error: custom.error, code: custom.code }, custom.status);
    code = custom.code;
  } else {
    code = generateAccessCode();
  }
  const codeId = crypto.randomUUID();
  createAccessCode(codeId, label, hashAccessCode(code));
  return c.json({ codeId, label, code, custom: !!body.code });
});

api.post("/admin/codes/:id/revoke", requireAdmin, enforceOrigin, limiter("admin", 30, 60_000), (c) => {
  const revokedAt = revokeAccessCode(c.req.param("id"));
  if (!revokedAt) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, revokedAt });
});

// Read-only activity/usage aggregates for the admin dashboard. Windowed by
// ?window=24h|7d|all (default all); admin-only, like the code routes.
api.get("/admin/stats", requireAdmin, limiter("admin", 30, 60_000), (c) => {
  const w = c.req.query("window");
  const window = w === "24h" || w === "7d" ? w : "all";
  const sinceMs = window === "24h" ? Date.now() - 86_400_000 : window === "7d" ? Date.now() - 7 * 86_400_000 : 0;
  return c.json({ window, ...adminStats(new Date(sinceMs).toISOString()) });
});

// ───────── payments (pay-per-gig checkout) ─────────
//
// Public and unauthenticated: for a public sender, payment IS the authorization —
// no access code needed (docs/COMMERCIAL_DELIVERY_PLAN.md). `quote` is pure math;
// `checkout` prices the send, records a PENDING order, and hands back the
// provider's hosted payment URL; the provider's SIGNED webhook (or a direct-lookup
// fallback) confirms payment; and `/session` then mints a payment-backed upload
// session bound to the paid order. A browser's claim that it paid is never trusted.

const PAY_CURRENCY = "USD";

/** Base URL of the sender page, for the provider's success/cancel redirects. Set
 *  WAYSTATION_PUBLIC_BASE_URL in production (e.g. https://orbitolive.com/waystation/);
 *  the Origin fallback only fits local dev, where the page is served at the root. */
const publicBaseUrl = (c: Context): string => {
  const configured = (env.WAYSTATION_PUBLIC_BASE_URL || "").trim();
  if (configured) return configured;
  const origin = c.req.header("origin");
  return origin ? `${origin.replace(/\/$/, "")}/` : "http://localhost:5173/";
};

const returnUrls = (c: Context, orderId: string): { successUrl: string; cancelUrl: string } => {
  const mk = (flag: string): string => {
    const u = new URL(publicBaseUrl(c));
    u.searchParams.set("order", orderId);
    u.searchParams.set(flag, "1");
    return u.toString();
  };
  return { successUrl: mk("paid"), cancelUrl: mk("canceled") };
};

// Live price for both gateways. No side effects, no external calls; a disabled
// gateway is returned as null so the UI shows only what it can actually charge on.
api.post("/payments/quote", enforceOrigin, limiter("quote", 60, 60_000), async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const q = quoteAll(body.bytes, body.downloads, body.weeks);
  if ("error" in q) return c.json({ error: q.error, code: q.code }, q.status);
  return c.json({
    downloads: q.downloads,
    weeks: q.weeks,
    includedDownloads: INCLUDED_DOWNLOADS,
    maxDownloads: MAX_DOWNLOADS,
    includedWeeks: INCLUDED_WEEKS,
    maxWeeks: MAX_WEEKS,
    stripe: gatewayEnabled("stripe") ? q.stripe : null,
    coinbase: gatewayEnabled("coinbase") ? q.coinbase : null,
  });
});

// Create a checkout for one gateway. The size must be uploadable under this
// deployment's ceilings/verification policy — checked HERE too, so a sender never
// pays for a file the upload path would then refuse.
api.post("/payments/checkout", enforceOrigin, limiter("checkout", 20, 60_000), async (c) => {
  if (!ACCEPT_UPLOADS)
    return c.json({ error: "This deployment is not accepting new uploads right now.", code: "uploads_paused" }, 503);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (!isGateway(body.gateway))
    return c.json({ error: "gateway must be 'stripe' or 'coinbase'.", code: "bad_gateway" }, 400);
  if (!gatewayEnabled(body.gateway))
    return c.json({ error: "That payment method is not available.", code: "gateway_unavailable" }, 503);
  const sized = validateSize(body.bytes);
  if ("error" in sized) return c.json({ error: sized.error, code: sized.code }, sized.status);
  const verification = verificationModeForSize(sized.size);
  if ("error" in verification) return c.json({ error: verification.error, code: verification.code }, verification.status);

  const downloads = clampDownloads(body.downloads);
  const weeks = clampWeeks(body.weeks);
  const q = quote(sized.size, downloads, weeks, body.gateway);
  const orderId = crypto.randomUUID();
  const ownerId = `pay_${crypto.randomUUID()}`;

  let checkout;
  try {
    const { successUrl, cancelUrl } = returnUrls(c, orderId);
    checkout = await createCheckout({
      orderId, gateway: body.gateway, amountCents: q.amountCents,
      gb: q.gb, downloads, weeks, successUrl, cancelUrl,
    });
  } catch {
    return c.json({ error: "Could not start checkout. Please try again.", code: "checkout_failed" }, 502);
  }

  createOrder({
    orderId, gateway: body.gateway, pricedBytes: sized.size, downloads, weeks,
    baseCents: q.baseCents, extraCents: q.extraDownloadsCents + q.extraWeeksCents,
    feeCents: q.feeCents, amountCents: q.amountCents, currency: PAY_CURRENCY,
    gatewayRef: checkout.gatewayRef, ownerId, expiresAt: checkout.expiresAt,
  });
  return c.json({
    orderId, url: checkout.url, gateway: body.gateway,
    // The in-page Stripe Payment Element mounts against these. Publishable key is
    // public by design; the client confirms the payment without navigating away.
    clientSecret: checkout.clientSecret ?? null,
    publishableKey: body.gateway === "stripe" ? (stripePublishableKey() || null) : null,
    amountCents: q.amountCents, downloads, weeks, expiresAt: checkout.expiresAt ?? null,
  });
});

// Mark an order paid from a VERIFIED event, once, after re-checking that the amount
// the provider collected covers what we priced and the currency matches. An
// underpayment is refused rather than silently honored — never authorize an upload
// a sender did not fully pay for.
function applyPaymentEvent(gateway: Gateway, ev: PaymentEvent): void {
  if (!ev.paid || !ev.orderId) return;
  const order = getOrder(ev.orderId);
  if (!order || order.gateway !== gateway) return;
  if (ev.amountCents !== undefined && ev.amountCents < order.amountCents) return;
  if (ev.currency && ev.currency !== order.currency) return;
  markOrderPaid(order.orderId, ev.email);
}

// Provider webhooks. Server-to-server: NO session, NO origin check, NO CORS. The
// raw body is read and the signature verified BEFORE parsing — mirroring
// POST /events/b2. A non-2xx makes the provider retry, so acknowledge fast.
api.post("/payments/stripe/webhook", async (c) => {
  const raw = await c.req.text();
  const ev = parseStripeEvent(raw, c.req.header("stripe-signature"));
  if (!ev) return c.text("bad signature", 400);
  applyPaymentEvent("stripe", ev);
  return c.json({ received: true });
});

api.post("/payments/coinbase/webhook", async (c) => {
  const raw = await c.req.text();
  const ev = parseCoinbaseEvent(raw, c.req.header("x-cc-webhook-signature"));
  if (!ev) return c.text("bad signature", 400);
  applyPaymentEvent("coinbase", ev);
  return c.json({ received: true });
});

// Claim the paid order and mint the payment-backed upload session. Called by the
// client on return from the redirect. If the webhook has not landed yet, fall back
// to a direct provider lookup so the sender is never stuck behind a race.
api.post("/payments/:orderId/session", enforceOrigin, limiter("pay-session", 30, 60_000), async (c) => {
  const orderId = c.req.param("orderId");
  let order = getOrder(orderId);
  if (!order) return c.json({ error: "Order not found.", code: "order_not_found" }, 404);
  if (order.status !== "paid" && order.gatewayRef) {
    const ev = await lookupPaid(order.gateway as Gateway, order.gatewayRef);
    if (ev.paid && (ev.amountCents === undefined || ev.amountCents >= order.amountCents)) {
      markOrderPaid(order.orderId, ev.email);
      order = getOrder(orderId)!;
    }
  }
  if (order.status !== "paid")
    return c.json({ status: order.status, authorized: false, code: "payment_pending" }, 402);

  // With sender auth disabled (development) there is no session secret to sign
  // with, and uploads are already permitted without a session — so report
  // authorized without minting one. Production runs access-code mode, where the
  // secret exists and the payment-backed session is what gates the upload.
  if (authEnabled) {
    const { token, sid } = issueSession({
      ownerId: order.ownerId ?? `pay_${order.orderId}`, admin: false, orderId: order.orderId,
    });
    setSessionCookie(c, token);
    setOrderSession(order.orderId, sid);
  }
  return c.json({ status: "paid", authorized: true, downloads: order.downloads, pricedBytes: order.pricedBytes });
});

// Status poll (no session mint) — the UI can check where an order stands.
api.get("/payments/:orderId", limiter("pay-status", 60, 60_000), (c) => {
  const order = getOrder(c.req.param("orderId"));
  if (!order) return c.json({ error: "Order not found.", code: "order_not_found" }, 404);
  return c.json({
    status: order.status, gateway: order.gateway, amountCents: order.amountCents,
    downloads: order.downloads, pricedBytes: order.pricedBytes, expiresAt: order.expiresAt ?? null,
  });
});

// ───────── email a completed transfer's link(s) ─────────
//
// The sender names recipients; the gateway builds the canonical link from the
// transfer id (never a client-supplied URL), verifies the transfer belongs to
// THIS session, caps recipients at the downloads the sender bought, and sends via
// Resend. The API key stays server-side; a browser's word is never trusted for
// who owns a transfer or how many people it may reach. A download password is
// never included — the note tells the recipient to expect it separately.
const COMPED_RECIPIENT_CAP = 25;
const MIN_RECIPIENT_PASSWORD = 4; // comped/admin transfers have no purchased count
api.post("/transfers/email", requireSession, enforceOrigin, limiter("email", 20, 60_000, true), async (c) => {
  if (!emailEnabled()) return c.json({ error: "Email delivery isn't configured.", code: "email_disabled" }, 503);
  const b = await c.req.json().catch(() => ({}) as Record<string, any>);
  const entries: { id: string; name: string }[] = Array.isArray(b.transfers)
    ? b.transfers
        .map((x: any) => ({ id: String(x?.id ?? "").trim(), name: String(x?.name ?? "your file").slice(0, 200) }))
        .filter((x: { id: string }) => x.id)
    : [];
  const to: string[] = Array.isArray(b.to)
    ? [...new Set((b.to as unknown[]).map((x) => String(x).trim().toLowerCase()).filter((s) => s.length > 0))]
    : [];
  const fromEmail = String(b.fromEmail ?? "").trim();
  const subjectRaw = typeof b.subject === "string" ? b.subject.trim().slice(0, 200) : "";
  const message = typeof b.message === "string" ? b.message.slice(0, 2000) : "";

  if (!entries.length) return c.json({ error: "No transfer to send.", code: "no_transfer" }, 400);
  if (!to.length) return c.json({ error: "Add at least one recipient.", code: "no_recipients" }, 400);
  if (!isEmail(fromEmail)) return c.json({ error: "Enter a valid email in “Your email”.", code: "bad_from" }, 400);
  const badTo = to.find((e) => !isEmail(e));
  if (badTo) return c.json({ error: `Not a valid email address: ${badTo}`, code: "bad_recipient" }, 400);

  const session = sessionOf(c);
  const base = new URL(publicBaseUrl(c));
  const links: { name: string; url: string }[] = [];
  let hasPassword = false;
  let cap = Infinity;
  for (const { id, name } of entries) {
    const t = getTransfer(id);
    if (!t) return c.json({ error: "That transfer no longer exists.", code: "transfer_gone" }, 404);
    const ownerOk = session?.admin || (!!session?.ownerId && t.ownerId === session.ownerId);
    if (!ownerOk) return c.json({ error: "That transfer isn’t yours to send.", code: "not_owner" }, 403);
    if (t.revoked) return c.json({ error: "That transfer has been revoked.", code: "revoked" }, 409);
    if (t.passwordHash) hasPassword = true;
    cap = Math.min(cap, t.downloadsAllowed ?? COMPED_RECIPIENT_CAP);
    const u = new URL(base.toString());
    u.searchParams.set("t", id);
    links.push({ name, url: u.toString() });
  }
  if (to.length > cap)
    return c.json({ error: `This transfer can be emailed to at most ${cap} recipient${cap === 1 ? "" : "s"}.`, code: "too_many_recipients", cap }, 400);

  const subject = subjectRaw || `${fromEmail} sent you ${links.length === 1 ? "a file" : "files"} via OrbiStation`;
  try {
    // BCC the sender so they keep a copy (and a durable record of the link).
    await sendLinkEmail({ to, bcc: [fromEmail], replyTo: fromEmail, subject, message, links, hasPassword });
  } catch {
    return c.json({ error: "Could not send the email. Try again, or copy the link and share it yourself.", code: "send_failed" }, 502);
  }
  return c.json({ ok: true, sent: to.length });
});

// ───────── upload (control plane) ─────────
//
// Every route here requires a sender session AND verifies that the supplied key
// and multipart upload id belong to THAT session. Authentication alone is not
// enough: with a single shared beta code, any code-holder would otherwise be
// able to sign parts for, attach sidecars to, or complete somebody else's
// upload just by knowing its identifiers.

/** Resolve an upload the caller legitimately owns, or an error response.
 *  Ownership is the server-recorded owner compared with the owner in the
 *  caller's signed session (ownership.ts), so a sender who logs back in after
 *  their session lapsed can resume. A neutral 404 is returned whether the upload
 *  does not exist OR belongs to someone else — never confirm the existence of
 *  another owner's work. */
function ownUpload(c: Context, row: UploadRow | undefined) {
  const s = sessionOf(c);
  if (!row || (authEnabled && !mayUseUpload(row, s, { now: Date.now(), recoveryWindowMs: ACTIVE_UPLOAD_WINDOW_MS })))
    return { fail: c.json({ error: "Upload not found.", code: "not_found" }, 404) };
  return { row };
}

const ownedByPair = (c: Context, key: unknown, uploadId: unknown) =>
  typeof key === "string" && typeof uploadId === "string" && key && uploadId
    ? ownUpload(c, getUpload(key, uploadId))
    : { fail: c.json({ error: "key and uploadId are required.", code: "bad_request" }, 400) };

const ownedByKey = (c: Context, key: unknown) =>
  typeof key === "string" && key
    ? ownUpload(c, getUploadByKey(key))
    : { fail: c.json({ error: "key is required.", code: "bad_request" }, 400) };

api.post("/uploads", requireSession, enforceOrigin, limiter("initiate", 30, 60_000), async (c) => {
  // Cost controls run BEFORE anything is created on the object store, so a
  // refused request leaves no remote multipart state to clean up and incurs
  // no spend. Rate limiting bounds requests; these bound exposure.
  if (!ACCEPT_UPLOADS)
    return c.json(
      { error: "This deployment is not accepting new uploads right now.", code: "uploads_paused" },
      503,
    );
  const sid = sessionIdOf(c) ?? "anonymous";
  const activeSince = new Date(Date.now() - ACTIVE_UPLOAD_WINDOW_MS).toISOString();
  if (activeUploadCount(sid, activeSince) >= MAX_ACTIVE_UPLOADS_PER_SESSION)
    return c.json(
      { error: `At most ${MAX_ACTIVE_UPLOADS_PER_SESSION} uploads may be in flight at once.`, code: "too_many_active" },
      429,
    );
  // A paid session is bounded by its prepaid byte budget, not by the QC-era job
  // caps (those existed to cap GMI spend when every completed upload fired the
  // pipeline). Comped and access-code sessions still hit the caps.
  const orderId = sessionOf(c)?.orderId;
  if (!orderId) {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    if (completedSince(sid, dayAgo) >= MAX_JOBS_PER_SESSION)
      return c.json(
        { error: "Daily job limit reached for this session.", code: "session_quota" },
        429,
      );
    if (completedSinceAll(dayAgo) >= MAX_DAILY_JOBS)
      return c.json(
        { error: "This deployment has reached its daily job ceiling.", code: "daily_quota" },
        429,
      );
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  // Which tab the sender is on. In preview only the admin may start a QC
  // upload; refused here, before B2 has a multipart to clean up.
  const mode = body.mode === undefined ? "transfer" : body.mode;
  if (mode !== "transfer" && mode !== "qc")
    return c.json({ error: "mode must be transfer or qc.", code: "bad_request" }, 400);
  if (mode === "qc" && QC_MODE === "preview" && !sessionOf(c)?.admin)
    return c.json({ error: "QC uploads aren't open yet — use Transfer.", code: "qc_preview" }, 403);
  const name = validateFilename(body.filename);
  if ("error" in name) return c.json({ error: name.error, code: name.code }, name.status);
  const sized = validateSize(body.size);
  if ("error" in sized) return c.json({ error: sized.error, code: sized.code }, sized.status);
  const verification = verificationModeForSize(sized.size);
  if ("error" in verification) return c.json({ error: verification.error, code: verification.code }, verification.status);

  // Reserve the declared size against the paid order's budget — atomically and
  // BEFORE any B2 multipart exists, so a refused request leaves no remote state.
  // The multipart plan is sized from the declared size, so charging it here bounds
  // what can actually land in the bucket. A batch draws down one shared budget.
  if (orderId && !consumeOrderBudget(orderId, sized.size))
    return c.json(
      { error: "This exceeds the data you paid for. Start a new checkout for the additional files.", code: "insufficient_paid_budget" },
      402,
    );

  // contentType is INFORMATIONAL: recorded and forwarded, never trusted to
  // decide what work runs.
  const contentType =
    typeof body.contentType === "string" && body.contentType.length < 200
      ? body.contentType
      : "application/octet-stream";

  const out = await g.initiate(name.filename, contentType, sized.size);
  createUpload({
    objectKey: out.key, uploadId: out.uploadId, transferId: out.transferId,
    sessionId: sessionIdOf(c), ownerId: sessionOf(c)?.ownerId ?? null,
    filename: name.filename, contentType,
    declaredSize: sized.size, partSize: out.partSize, partCount: out.partCount,
    verificationMode: verification.verificationMode,
  });
  return c.json({ ...out, verificationMode: verification.verificationMode });
});

api.post("/uploads/parts", requireSession, enforceOrigin, limiter("sign", 600, 60_000, true), async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const owned = ownedByPair(c, body.key, body.uploadId);
  if ("fail" in owned) return owned.fail;
  const parts = validatePartNumbers(body.partNumbers, owned.row.partCount ?? 10_000);
  if ("error" in parts) return c.json({ error: parts.error, code: parts.code }, parts.status);
  return c.json(await g.presignParts(owned.row.objectKey, owned.row.uploadId, parts.partNumbers));
});

// GET is protected too — it reveals which parts of an upload have landed.
api.get("/uploads/parts", requireSession, async (c) => {
  const owned = ownedByPair(c, c.req.query("key"), c.req.query("uploadId"));
  if ("fail" in owned) return owned.fail;
  return c.json(await g.listParts(owned.row.objectKey, owned.row.uploadId));
});

api.post("/uploads/outboard-url", requireSession, enforceOrigin, limiter("sign", 600, 60_000, true), async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const owned = ownedByKey(c, body.key);
  if ("fail" in owned) return owned.fail;
  if (owned.row.verificationMode !== "range")
    return c.json(
      { error: "This upload uses root-only verification and does not accept a bao outboard.", code: "outboard_disabled" },
      403,
    );
  return c.json({ url: await g.presignPut(`${owned.row.objectKey}.obao`) });
});

// Sidecars uploaded alongside the master: supported caption transports ride into the
// caption QC; a source mezzanine (*.ref.mp4/.mov/.mxf) powers the reference
// SSIM/PSNR/VMAF lane. Neither triggers its own pipeline run (event filter).
// The name is allowlisted — an arbitrary filename here would be a write
// primitive into the transfer prefix — and the destination is derived from the
// OWNED row, never from caller-supplied text.
api.post("/uploads/sidecar-url", requireSession, enforceOrigin, limiter("sign", 600, 60_000, true), async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const owned = ownedByKey(c, body.key);
  if ("fail" in owned) return owned.fail;
  const name = validateSidecarName(body.filename);
  if ("error" in name) return c.json({ error: name.error, code: name.code }, name.status);
  const safe = name.filename.replace(/[^\w.\-]/g, "_");
  return c.json({ url: await g.presignPut(`transfers/${owned.row.transferId}/${safe}`) });
});
// Transfer-only detection looks ONLY at the boolean service flags. Options
// also carries non-service keys (QC profile and compute target) that must not
// count as "a service is on". undefined options = everything on.
// Default-ON services: a missing key means "on" (matches the worker).
// qc_synthetic and ai_interpretive are OPT-IN (worker defaults them off), so they only count as
// "a service is on" when explicitly true.
const anyServiceOn = (o?: Record<string, boolean | string>) =>
  !o || SERVICE_KEYS.some((k) => o[k] !== false) || o["qc_synthetic"] === true
  || o["ai_interpretive"] === true;
const OPTION_KEYS = new Set([
  ...SERVICE_KEYS, "qc_synthetic", "ai_interpretive", "profile", "compute", "review_brief",
]);
const BOOLEAN_OPTIONS = new Set([...SERVICE_KEYS, "qc_synthetic", "ai_interpretive"]);
const sanitizeOptions = (o?: Record<string, unknown>): Record<string, boolean | string> | undefined => {
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const clean: Record<string, boolean | string> = {};
  for (const [key, value] of Object.entries(o)) {
    if (!OPTION_KEYS.has(key)) continue;
    if (BOOLEAN_OPTIONS.has(key)) {
      if (typeof value === "boolean") clean[key] = value;
    } else if (key === "review_brief") {
      if (typeof value === "string") clean[key] = value.trim().slice(0, 2000);
    } else if (typeof value === "string") {
      clean[key] = value.slice(0, 120);
    }
  }
  return clean;
};

api.post("/uploads/complete", requireSession, enforceOrigin, async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, any>);
  const owned = ownedByPair(c, b.key, b.uploadId);
  if ("fail" in owned) return owned.fail;
  if (b.recipientPassword !== undefined && typeof b.recipientPassword !== "string")
    return c.json({ error: "Password must be text.", code: "bad_password" }, 400);
  if (typeof b.recipientPassword === "string" && b.recipientPassword.length > 128)
    return c.json({ error: "Password must be 128 characters or fewer.", code: "bad_password" }, 400);
  // New transfers only: a password, when set, is at least MIN_RECIPIENT_PASSWORD
  // characters. Existing transfers keep whatever they were created with — unlock
  // deliberately does not apply this, or older links would stop opening.
  if (typeof b.recipientPassword === "string" && b.recipientPassword.length > 0
      && b.recipientPassword.length < MIN_RECIPIENT_PASSWORD)
    return c.json(
      { error: `Password must be at least ${MIN_RECIPIENT_PASSWORD} characters.`, code: "bad_password" }, 400);
  const recipientPassword = typeof b.recipientPassword === "string" && b.recipientPassword.length > 0
    ? b.recipientPassword
    : undefined;
  // Idempotent: a retried completion must not re-assemble on B2 or re-meter
  // the transfer. The first call wins; later calls acknowledge without work.
  if (owned.row.state === "complete")
    return c.json({ ok: true, alreadyComplete: true });

  const { bytes } = await g.complete(owned.row.objectKey, owned.row.uploadId);
  setUploadState(owned.row.objectKey, owned.row.uploadId, "complete");
  const transferId = owned.row.transferId;
  // Unknown and retired options (including legacy self_heal) never enter the
  // transfer store or dispatch payload.
  const requested = sanitizeOptions(b.options as Record<string, unknown> | undefined);
  // Service allowlist: a disabled service is forced OFF in the stored options,
  // not merely hidden in the UI — the API is authoritative. Applied before the
  // record is written so the policy survives a restart and the B2 event path
  // sees the same decision.
  const { options, disabled } = applyServicePolicy(requested, bytes);
  // Paid links carry what the sender paid for; the ORDER is the source of truth,
  // so a client cannot inflate either value by sending a larger number here.
  //   * downloads_allowed = chosen + the hidden bonus download (enforcedDownloads);
  //     the sender only ever saw/paid for the chosen count.
  //   * expiry = the weeks they bought, as weeks*7 + 1 day.
  // Comped/admin transfers leave downloads unset (NULL = unlimited) and keep the
  // deployment-wide default expiry — the pre-feature behaviour.
  const payOrder = sessionOf(c)?.orderId ? getOrder(sessionOf(c)!.orderId!) : undefined;
  const downloadsAllowed = payOrder ? enforcedDownloads(payOrder.downloads) : undefined;
  const expiresAt = payOrder
    ? Date.now() + linkExpiryDays(payOrder.weeks) * 86_400_000
    : RECIPIENT_LINK_TTL_DAYS > 0
      ? Date.now() + RECIPIENT_LINK_TTL_DAYS * 86_400_000
      : undefined;
  // Always record — the event path needs `options` even without a hash root.
  saveTransfer(transferId, {
    key: owned.row.objectKey,
    blake3Root: b.blake3Root,
    verificationMode: owned.row.verificationMode,
    createdAt: Date.now(),
    options,
    expiresAt,
    passwordHash: recipientPassword ? hashAccessCode(recipientPassword) : undefined,
    ownerId: owned.row.ownerId ?? undefined,
    downloadsAllowed,
  });
  // Report the skip honestly rather than silently dropping a requested service.
  if (disabled.length)
    sse.publish(transferId, {
      type: "services_disabled",
      services: disabled,
      reason: "disabled by deployment policy or size limit",
    });
  // Billable event: the transfer itself, in GB delivered into the waystation.
  meter({ transferId, event: "transfer", units: Number((bytes / 1e9).toFixed(6)), unit: "gb", ref: owned.row.objectKey });
  // Dev only: no real B2 event source locally, so simulate the
  // object-created trigger right after assembly. Production leaves
  // DEV_TRIGGER_ON_COMPLETE unset and the real B2 Event Notification drives it.
  if (env.DEV_TRIGGER_ON_COMPLETE === "true") {
    if (anyServiceOn(options)) {
      sse.publish(transferId, { type: "pipeline_queued", key: owned.row.objectKey });
      void dispatchPipeline({ bucket: env.B2_BUCKET, key: owned.row.objectKey, transferId, options });
    } else {
      sse.publish(transferId, { type: "pipeline_skipped", reason: "transfer-only" });
    }
  }
  return c.json({ ok: true });
});

// ───────── download (transfer-scoped) ─────────
//
// This replaces a generic `GET /downloads?key=<anything>` that handed an
// unvalidated key straight to the CDN token signer — a signing oracle for ANY
// object in the bucket, reachable with no session. The key must now belong to
// the transfer named in the path, so a capability grants access to that
// delivery and nothing else.
const belongsToTransfer = (key: string, id: string): boolean =>
  key.startsWith(`transfers/${id}/`) || key.startsWith(`derivatives/${id}/`);

// The password gate. A protected transfer opens only to a browser that has
// unlocked it — the sender's own session is NOT a key. Senders test their links
// before forwarding them, and a sender who is waved through sees a page that
// never asks for the password they just set, then reports the feature broken.
// Making the sender enter it is the only rehearsal of what the recipient sees.
//
// The one place the sender session still counts is the progress stream; see
// progressGate below.
//
// The unlock cookie is the ONLY proof accepted, and every request it authorizes
// slides it forward, so a browser that keeps downloading (renewing its storage
// URL every hour) stays unlocked, while a copied link is useless anywhere else.
const recipientGate = (c: Context, id: string): Response | undefined => {
  const transfer = getTransfer(id);
  if (!transfer?.passwordHash) return undefined;
  if (hasRecipientUnlock(c, id)) {
    setRecipientUnlockCookie(c, id);
    return undefined;
  }
  return c.json(
    { error: "Password required.", code: "recipient_password_required", passwordRequired: true },
    401,
  );
};

// The progress stream is the SEND page's view of QC, opened under the sender's
// session the moment the upload completes. The sender sets the password there;
// nothing ever asks them to enter it, so this route must keep recognising the
// originating session or a protected QC transfer would show its own sender
// "waiting for OrbiStation services" forever. Transfer-only deployments never
// open the stream, which is exactly why this exemption stays explicit here
// rather than being inherited by the delivery routes above.
const progressGate = (c: Context, id: string): Response | undefined => {
  const upload = getUploadByTransferId(id);
  if (upload && upload.sessionId === sessionIdOf(c)) return undefined;
  return recipientGate(c, id);
};

// Three bounds on guessing, because a download password may be as short as four
// characters: 10/min per source address, 60/min across the whole deployment (a
// distributed guesser), and UNLOCK_FAILURE_LIMIT wrong answers per transfer per
// UNLOCK_FAILURE_WINDOW_MS no matter where they come from. A locked link says so
// honestly — the recipient can wait — and the lock is checked BEFORE the scrypt,
// so a locked-out guesser cannot even spend the gateway's CPU.
const UNLOCK_FAILURE_LIMIT = 20;
const UNLOCK_FAILURE_WINDOW_MS = 60 * 60_000;
api.post("/transfers/:id/unlock", enforceOrigin, limiter("recipient-unlock", 10, 60_000),
  globalLimiter("recipient-unlock", 60, 60_000), async (c) => {
  const id = c.req.param("id");
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  const transfer = getTransfer(id);
  if (!transfer) return c.json({ error: "not found" }, 404);
  if (!transfer.passwordHash) return c.json({ ok: true, passwordRequired: false });
  const failKey = `unlock:${id}`;
  if (failureLocked(failKey, UNLOCK_FAILURE_LIMIT))
    return c.json(
      { error: "Too many wrong passwords for this link. Try again in an hour.", code: "unlock_locked" }, 429);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 1 || password.length > 128 || !verifyAccessCode(password, transfer.passwordHash)) {
    noteFailure(failKey, UNLOCK_FAILURE_WINDOW_MS);
    return c.json({ error: "That password was not accepted.", code: "bad_recipient_password" }, 401);
  }
  const expiresAt = setRecipientUnlockCookie(c, id);
  return c.json({ ok: true, passwordRequired: true, expiresAt });
});

api.get("/transfers/:id/download", async (c) => {
  const id = c.req.param("id");
  const key = c.req.query("key") ?? "";
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  const locked = recipientGate(c, id);
  if (locked) return locked;
  // Reject traversal before the prefix test, so "transfers/<id>/../../other"
  // cannot satisfy startsWith and then resolve elsewhere.
  if (!key || key.includes("..") || !belongsToTransfer(key, id))
    return c.json({ error: "not found" }, 404);
  // These are CDN-Worker URLs. The MVP does not deploy that Worker — the
  // delivery page serves presigned B2 URLs from GET /transfers/:id instead —
  // so without CDN config this would hand back "undefined/transfers/...".
  // Say so rather than emit a broken link.
  if (!env.CDN_BASE || !env.CDN_TOKEN_SECRET)
    return c.json(
      { error: "CDN delivery is not configured on this deployment.", code: "cdn_unconfigured" },
      501,
    );
  return c.json(g.downloadUrl(key));
});

// ───────── mediated download ─────────
//
// The stable link. Everything above hands the recipient a presigned storage URL
// directly, which is a bearer token: invisible and unrecallable. Once minted it
// cannot be revoked, cannot be counted, and cannot be metered — the only bound
// available is its one-hour life, which is why that life must stay short.
//
// This route inverts that. The link the recipient holds points HERE, never at
// storage, and it does not expire on its own. On every request the gateway
// re-checks revocation and expiry, records the egress, and only then mints a
// short-lived presigned URL and redirects to it. Authorization is live rather
// than frozen at signing time, so a revoked transfer stops downloading on the
// next request instead of within the hour.
//
// It is also the seam the rest of the commercial plan hangs on: download
// credits and per-account attribution both need a request the gateway actually
// sees. See docs/COMMERCIAL_DELIVERY_PLAN.md.
//
// A 302 is used rather than proxying the bytes on purpose — the gateway must
// never touch file data. It stays a control plane; storage still serves.
api.get("/transfers/:id/original", async (c) => {
  const id = c.req.param("id");
  // Revoked AND expired both land here: capabilityRevoked() covers each, and an
  // unknown id is answered identically so a link never reveals it once existed.
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);

  // A password-protected transfer needs the unlock cookie, and nothing else is
  // accepted: the link on its own must never be enough, or copying it out of
  // the page would bypass the password (see auth.ts, "no download tickets").
  // An unprotected transfer's id is itself the capability, as on every route.
  const locked = recipientGate(c, id);
  if (locked) return locked;

  // Resolved exactly as the delivery page resolves it — see
  // classifyTransferObjects. Reading the uploads table here instead would 404
  // on any transfer whose object outlived its upload row.
  const { original } = classifyTransferObjects(await g.listKeys(`transfers/${id}/`));
  if (!original || !belongsToTransfer(original.key, id)) return c.json({ error: "not found" }, 404);
  const key = original.key;

  // Download allowance. NULL = unlimited (comped/admin/pre-feature transfers) — no
  // check. A finite allowance is enforced by GRANTS: a request carrying a live
  // grant for this transfer is one download's continuation (a resume, or the many
  // range requests of a parallel download) and never re-consumes; the first
  // ungranted hit either claims one credit or is refused when they are all spent.
  //
  // `continuing` records that this request is provably part of a download that
  // was already metered — a live grant, or for an unlimited transfer a signed
  // continuation token — so the egress below is not recorded a second time.
  let grant: string | undefined;
  let continuation: string | undefined;
  let continuing = false;
  const transfer = getTransfer(id);
  const allowed = transfer?.downloadsAllowed;
  if (typeof allowed === "number") {
    const presented = c.req.query("grant") || getDownloadGrantCookie(c, id);
    const held = presented ? getGrant(presented) : undefined;
    if (held && held.transferId === id && Date.now() <= held.expiresAt) {
      grant = presented!;
      continuing = true;
    } else {
      const claimed = claimDownloadGrant(id, allowed, GRANT_TTL_MS);
      if (!claimed)
        return c.json({ error: "This link has reached its download limit.", code: "downloads_exhausted" }, 403);
      setDownloadGrantCookie(c, id, claimed, GRANT_TTL_SECONDS);
      grant = claimed;
    }
  } else {
    const presented = c.req.query("cont");
    continuing = verifyContinuation(presented, id);
    continuation = continuing ? presented : issueContinuation(id, Date.now() + GRANT_TTL_MS);
  }

  // Egress metering. Honest about what it can and cannot see: because this is a
  // redirect, the gateway learns that a download STARTED but never how many
  // bytes actually moved — the transfer happens between the recipient and B2.
  //
  // A request that proves it continues an already-metered download (see
  // `continuing` above) records nothing: a browser renewing its storage URL
  // every hour of a long download is still one download.
  //
  // Otherwise one event is recorded per download. A newly claimed grant IS one
  // download, so it keys the event exactly. Without a grant (an unlimited
  // transfer's first request, or curl/aria2c, which carry no continuation) the
  // gateway cannot tell one download's connections apart from separate
  // downloads, so it falls back to one event per transfer per hour. That
  // collapses the many range requests of a parallel download into one line
  // item while still counting a genuine second download the next day.
  if (original.size > 0 && !continuing) {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    meter(
      { transferId: id, event: "egress", units: Number((original.size / 1e9).toFixed(6)), unit: "gb", ref: key },
      grant ? `egress:grant:${grant}` : `egress:${id}:${hourBucket}`,
    );
  }

  const storage = await g.presignGet(key, STORAGE_URL_TTL_SECONDS, key.split("/").pop());

  // Two shapes, one gate. Everything above — revocation, expiry, the password,
  // scope, metering — has already run either way.
  //
  // `?format=json` exists because **a browser cannot fetch() this route**. When
  // a CORS request is redirected to a different origin the spec requires the
  // browser to send `Origin: null` on the redirected request, and B2 answers a
  // null origin with 403. Correct CORS on both hosts does not help; the null
  // origin is not any host's configured origin, and adding `null` to the
  // bucket's allow-list would let *any* sandboxed context read the object,
  // which is far worse than the problem it solves.
  //
  // So script asks for JSON and fetches storage itself. The redirect stays for
  // the contexts where it genuinely works — a top-level `<a href>` navigation
  // is not a CORS request at all, and curl/aria2c have no CORS to satisfy —
  // which is what makes this a stable link for multi-connection tools.
  //
  // `expiresIn` is RELATIVE, not a timestamp, so a recipient whose clock is
  // wrong still renews on time; `continuation` is presented back on renewal.
  if (c.req.query("format") === "json")
    return c.json({ url: storage, grant, continuation, expiresIn: STORAGE_URL_TTL_SECONDS });
  return c.redirect(storage, 302);
});

// ───────── delivery page data ─────────
// Assembles a transfer from storage: the original + the pipeline's
// derivatives + manifest, each as a presigned URL the recipient can fetch.
// (Store-free: discovered by prefix. Production would add a record for
// recipients/expiry/access — see store.ts TODO.)
// What counts as "the master" for a transfer, in ONE place. Caption transports,
// the bao outboard, reference mezzanines and the generation manifest all ride
// along under the same prefix and can sort ahead of it alphabetically.
//
// Deliberately store-free: discovered by listing the prefix, never by reading
// the uploads table. The delivery path has always worked this way, and it must
// keep working for a transfer whose object exists in storage but whose upload
// row does not — which is exactly what scripts/delivery-proof.sh exercises.
const SIDECAR_RE = /\.(obao|srt|vtt|scc|mcc|rcwt)$|\.ref\.[^./]+$|\.genblaze\.json$/i;
const classifyTransferObjects = (all: { key: string; size: number }[]) => ({
  original: all.filter((o) => !SIDECAR_RE.test(o.key))[0],
  outboard: all.find((o) => o.key.endsWith(".obao")),
});

/** Absolute URL of the mediated download for this transfer. The origin is the
 *  configured WAYSTATION_PUBLIC_API_ORIGIN (see publicOrigin.ts): it is never
 *  derived from Host or X-Forwarded-* because a client controls those. Behind the
 *  tunnel the process sees plain http to `gateway:8787`, which is why the scheme
 *  cannot be read from the connection either — an http:// link on an https page
 *  is blocked as mixed content with no CORS error to chase.
 *
 *  It carries NO credential. For a protected transfer the unlock cookie of the
 *  browser that entered the password is what authorizes it. Returns null only in
 *  an unconfigured non-loopback development setup; the caller refuses then. */
const publicApi = loadPublicApiOrigin(env.WAYSTATION_PUBLIC_API_ORIGIN, IS_PRODUCTION);
const mediatedDownloadUrl = (c: Context, id: string): string | null =>
  mediatedDownloadUrlFor(publicApi, c.req.url, id);

const mimeOf = (k: string) =>
  k.endsWith(".jpg") || k.endsWith(".jpeg") ? "image/jpeg"
  : k.endsWith(".vtt") ? "text/vtt"
  : /\.(srt|scc|mcc)$/i.test(k) ? "text/plain"
  : k.endsWith(".txt") ? "text/plain"
  : k.endsWith(".json") ? "application/json"
  : k.endsWith(".mp4") ? "video/mp4"
  : "application/octet-stream";

api.get("/transfers/:id", async (c) => {
  const id = c.req.param("id");
  // Expired or revoked capabilities are indistinguishable from unknown ones:
  // a recipient link must never reveal that it once existed.
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  const locked = recipientGate(c, id);
  if (locked) return locked;
  // Same classification the mediated download route uses — one definition of
  // what "the master" is, so the two can never disagree about which object a
  // download serves.
  const { original: orig, outboard } = classifyTransferObjects(
    await g.listKeys(`transfers/${id}/`));
  if (!orig) return c.json({ error: "not found" }, 404);
  const derivs = await g.listKeys(`derivatives/${id}/`);
  const sign = async (k: string, size: number) => ({ key: k, url: await g.presignGet(k), mime: mimeOf(k), size });

  const manifest = derivs.find((d) => d.key.endsWith("manifest.json"));
  const transfer = getTransfer(id);
  // Refuse rather than guess: with no trusted API origin (development on a
  // non-loopback host with WAYSTATION_PUBLIC_API_ORIGIN unset) there is no safe
  // link to hand out, and falling back to request headers is exactly the bug.
  const mediatedUrl = mediatedDownloadUrl(c, id);
  if (!mediatedUrl)
    return c.json({ error: "Download links are not configured on this server.", code: "public_origin_unconfigured" }, 503);
  return c.json({
    transferId: id,
    // The original is signed with a Content-Disposition override so browsers
    // SAVE it rather than opening it in the media player. Derivatives keep
    // inline disposition — the page renders the thumbnail and fetches the QC
    // JSON, neither of which should download.
    original: {
      key: orig.key,
      // MEDIATED, not presigned. The recipient never receives a storage URL for
      // the master — see GET /transfers/:id/original above. The origin is
      // configuration, never a request header (publicOrigin.ts).
      url: mediatedUrl,
      mime: mimeOf(orig.key),
      size: orig.size,
      filename: orig.key.split("/").pop(),
    },
    // verified-range download material (present once an upload went through
    // `complete`, which records the root and the .obao sidecar lands).
    blake3Root: transfer?.blake3Root ?? null,
    verificationMode: transfer?.verificationMode ?? (outboard ? "range" : "root"),
    outboardUrl: outboard ? await g.presignGet(outboard.key) : null,
    manifestUrl: manifest ? await g.presignGet(manifest.key) : null,
    derivatives: await Promise.all(
      derivs.filter((d) => !d.key.endsWith("manifest.json")).map((d) => sign(d.key, d.size))),
  });
});

// ───────── B2 Event Notification → Genblaze pipeline ─────────
api.post("/events/b2", async (c) => {
  const raw = await c.req.text();
  if (!verifyB2Signature(raw, c.req.header("X-Bz-Event-Notification-Signature"), env.B2_EVENT_SIGNING_SECRET))
    return c.text("bad signature", 401);

  for (const e of parseB2Events(JSON.parse(raw))) {
    if (!e.eventType.startsWith("b2:ObjectCreated") || !isOriginalMedia(e.objectName)) continue;
    const transferId = transferIdFromKey(e.objectName);
    const options = getTransfer(transferId)?.options;
    if (!anyServiceOn(options)) {
      sse.publish(transferId, { type: "pipeline_skipped", reason: "transfer-only" });
      continue;
    }
    sse.publish(transferId, { type: "pipeline_queued", key: e.objectName });
    void dispatchPipeline({ bucket: e.bucketName, key: e.objectName, transferId, options });
  }
  return c.text("ok"); // ack fast; B2 retries on non-2xx
});

// ───────── progress stream (sender + recipient subscribe) ─────────
api.get("/progress/:transferId", (c) => {
  const id = c.req.param("transferId");
  const locked = progressGate(c, id);
  if (locked) return locked;
  return streamSSE(c, async (stream) => {
    let alive = true;
    const unsub = sse.subscribe(id, (ev) => stream.writeSSE({ data: JSON.stringify(ev) }));
    stream.onAbort(() => { alive = false; unsub(); });
    await stream.writeSSE({ data: JSON.stringify({ type: "subscribed", transferId: id }) });
    while (alive) { await stream.sleep(15000); if (alive) await stream.writeSSE({ data: "", event: "ping" }); }
  });
});

// ───────── internal: pipeline worker posts progress here ─────────
api.post("/internal/progress", async (c) => {
  if (c.req.header("authorization") !== `Bearer ${env.PIPELINE_SHARED_SECRET}`)
    return c.text("forbidden", 403);
  const { transferId, ...event } = await c.req.json();
  sse.publish(transferId, event);
  // Metering: the WORKER decides billability — any event carrying a
  // `billable` block is a billable unit of work (a run, minutes, …).
  if (event.billable && typeof event.billable.units === "number") {
    meter({
      transferId,
      event: event.step ?? event.type,
      units: event.billable.units,
      unit: event.billable.unit ?? "run",
      ref: event.key,
    });
  }
  return c.json({ ok: true });
});

// ───────── usage ledger (billing-ready; feeds Stripe/Lago meters later) ─────────
// SENDER-ONLY. This is the internal billing ledger; it was previously readable
// by anyone holding a recipient link, and the delivery page rendered it. A
// recipient is a third party — often the customer's own client — and has no
// business seeing what the sender is charged.
//
// Scoped to the transfer's OWNER (or the admin). A session alone is not enough:
// any sender could otherwise read another sender's ledger by knowing its id.
// The same neutral 404 answers "not yours" and "does not exist".
api.get("/transfers/:id/usage", requireSession, (c) => {
  const id = c.req.param("id");
  const session = sessionOf(c);
  const owner = getTransfer(id)?.ownerId;
  const mine = !authEnabled || session?.admin || (!!owner && owner === session?.ownerId);
  if (!mine) return c.json({ error: "not found" }, 404);
  return c.json(usageFor(id));
});
