import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  authConfig,
  authEnabled,
  clearSessionCookie,
  enforceOrigin,
  hasRecipientUnlock,
  hashAccessCode,
  issueDownloadTicket,
  issueSession,
  limiter,
  requireSession,
  sessionIdOf,
  setRecipientUnlockCookie,
  setSessionCookie,
  verifyAccessCode,
  verifyDownloadTicket,
} from "./auth.js";
import {
  activeUploadCount,
  completedSince,
  completedSinceAll,
  capabilityRevoked,
  createUpload,
  getUpload,
  getUploadByKey,
  getUploadByTransferId,
  setUploadState,
  type UploadRow,
} from "./db.js";
import {
  ACCEPT_UPLOADS,
  applyServicePolicy,
  MAX_ACTIVE_UPLOADS_PER_SESSION,
  MAX_DAILY_JOBS,
  MAX_JOBS_PER_SESSION,
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

const env = process.env as Record<string, string>;
export const api = new Hono();

// ───────── sender session ─────────
// The access code is exchanged ONCE for a signed, short-lived, opaque cookie;
// the browser never stores the code. Rate limited hard because this is the only
// endpoint where a code can be guessed, and it is reachable before any session
// exists. Responses never distinguish "no code supplied" from "wrong code".
api.post("/session", enforceOrigin, limiter("session", 10, 60_000), async (c) => {
  if (!authEnabled)
    return c.json({ ok: true, mode: "disabled", note: "authentication is off (development)" });
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const code = typeof body.code === "string" ? body.code : "";
  if (!code || !verifyAccessCode(code, authConfig.codeHash!))
    return c.json({ error: "That access code was not accepted.", code: "bad_code" }, 401);
  const { token, expiresAt } = issueSession();
  setSessionCookie(c, token);
  return c.json({ ok: true, expiresAt });
});

api.post("/session/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// Whether the page should show its access panel. Deliberately minimal: it says
// only that a code is required and whether this browser already holds a valid
// session — both of which the UI must know to render at all, and neither of
// which helps an attacker. No mode names, versions, origins, or limits.
api.get("/session", (c) =>
  c.json({ authRequired: authEnabled, hasSession: sessionIdOf(c) !== null }));

// ───────── upload (control plane) ─────────
//
// Every route here requires a sender session AND verifies that the supplied key
// and multipart upload id belong to THAT session. Authentication alone is not
// enough: with a single shared beta code, any code-holder would otherwise be
// able to sign parts for, attach sidecars to, or complete somebody else's
// upload just by knowing its identifiers.

/** Resolve an upload the caller legitimately owns, or an error response.
 *  A neutral 404 is returned whether the upload does not exist OR belongs to a
 *  different session — never confirm the existence of another session's work. */
function ownUpload(c: Context, row: UploadRow | undefined) {
  if (!row || (authEnabled && row.sessionId !== sessionIdOf(c)))
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
  if (activeUploadCount(sid) >= MAX_ACTIVE_UPLOADS_PER_SESSION)
    return c.json(
      { error: `At most ${MAX_ACTIVE_UPLOADS_PER_SESSION} uploads may be in flight at once.`, code: "too_many_active" },
      429,
    );
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

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const name = validateFilename(body.filename);
  if ("error" in name) return c.json({ error: name.error, code: name.code }, name.status);
  const sized = validateSize(body.size);
  if ("error" in sized) return c.json({ error: sized.error, code: sized.code }, sized.status);
  const verification = verificationModeForSize(sized.size);
  if ("error" in verification) return c.json({ error: verification.error, code: verification.code }, verification.status);

  // contentType is INFORMATIONAL: recorded and forwarded, never trusted to
  // decide what work runs.
  const contentType =
    typeof body.contentType === "string" && body.contentType.length < 200
      ? body.contentType
      : "application/octet-stream";

  const out = await g.initiate(name.filename, contentType, sized.size);
  createUpload({
    objectKey: out.key, uploadId: out.uploadId, transferId: out.transferId,
    sessionId: sessionIdOf(c), filename: name.filename, contentType,
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
  // Always record — the event path needs `options` even without a hash root.
  // Recipient links are bearer capabilities, so they carry an expiry from the
  // moment they exist (RECIPIENT_LINK_TTL_DAYS=0 disables expiry).
  saveTransfer(transferId, {
    key: owned.row.objectKey,
    blake3Root: b.blake3Root,
    verificationMode: owned.row.verificationMode,
    createdAt: Date.now(),
    options,
    expiresAt: RECIPIENT_LINK_TTL_DAYS > 0
      ? Date.now() + RECIPIENT_LINK_TTL_DAYS * 86_400_000
      : undefined,
    passwordHash: recipientPassword ? hashAccessCode(recipientPassword) : undefined,
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

const recipientGate = (c: Context, id: string): Response | undefined => {
  const transfer = getTransfer(id);
  if (!transfer?.passwordHash) return undefined;
  const upload = getUploadByTransferId(id);
  const senderOwns = !!upload && upload.sessionId === sessionIdOf(c);
  if (senderOwns || hasRecipientUnlock(c, id)) return undefined;
  return c.json(
    { error: "Password required.", code: "recipient_password_required", passwordRequired: true },
    401,
  );
};

api.post("/transfers/:id/unlock", enforceOrigin, limiter("recipient-unlock", 10, 60_000), async (c) => {
  const id = c.req.param("id");
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  const transfer = getTransfer(id);
  if (!transfer) return c.json({ error: "not found" }, 404);
  if (!transfer.passwordHash) return c.json({ ok: true, passwordRequired: false });
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 1 || password.length > 128 || !verifyAccessCode(password, transfer.passwordHash))
    return c.json({ error: "That password was not accepted.", code: "bad_recipient_password" }, 401);
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

  // Either proof of authorization is accepted: a ticket in the query string, or
  // the recipient unlock cookie for a page that already unlocked in this
  // browser. recipientGate() returns a Response only when the transfer is
  // password-protected AND neither the sender nor an unlocked recipient is
  // asking, so an unprotected transfer needs no ticket at all.
  if (!verifyDownloadTicket(c.req.query("ticket"), id)) {
    const locked = recipientGate(c, id);
    if (locked) return locked;
  }

  // Resolved exactly as the delivery page resolves it — see
  // classifyTransferObjects. Reading the uploads table here instead would 404
  // on any transfer whose object outlived its upload row.
  const { original } = classifyTransferObjects(await g.listKeys(`transfers/${id}/`));
  if (!original || !belongsToTransfer(original.key, id)) return c.json({ error: "not found" }, 404);
  const key = original.key;

  // Egress metering. Honest about what it can and cannot see: because this is a
  // redirect, the gateway learns that a download STARTED but never how many
  // bytes actually moved — the transfer happens between the recipient and B2.
  //
  // So one event is recorded per transfer per hour, using an explicit
  // idempotency key. That collapses the many range requests of a single
  // resumed or parallel download into one line item instead of billing sixteen
  // times for one file, while still counting a genuine second download the next
  // day. It is an approximation, and it is replaced by the grant ledger in step
  // 3 of the commercial plan, which knows exactly when a download began and how
  // many bytes it was entitled to.
  if (original.size > 0) {
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    meter(
      { transferId: id, event: "egress", units: Number((original.size / 1e9).toFixed(6)), unit: "gb", ref: key },
      `egress:${id}:${hourBucket}`,
    );
  }

  return c.redirect(await g.presignGet(key, 3600, key.split("/").pop()), 302);
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

/** Absolute URL of the mediated download for this transfer, derived from the
 *  request that asked for it. Deriving beats configuring: there is no public
 *  base URL to set (GATEWAY_PUBLIC_URL is the worker-callback address and is
 *  deliberately empty in transfer-only mode), and appending to the incoming
 *  path preserves whatever prefix the deployment uses.
 *
 *  The ticket outlives the hour a presigned URL gets, because it does not carry
 *  its own authority — the route re-checks revocation and expiry on every use.
 *  It is still bounded as defence in depth: to the transfer's own expiry when
 *  one is set, else 30 days. */
const mediatedDownloadUrl = (c: Context, id: string, expiresAt?: number): string => {
  const u = new URL(c.req.url);
  u.search = "";
  u.pathname = `${u.pathname.replace(/\/$/, "")}/original`;
  u.searchParams.set("ticket", issueDownloadTicket(id, expiresAt ?? Date.now() + 30 * 86_400_000));
  return u.toString();
};

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
  return c.json({
    transferId: id,
    // The original is signed with a Content-Disposition override so browsers
    // SAVE it rather than opening it in the media player. Derivatives keep
    // inline disposition — the page renders the thumbnail and fetches the QC
    // JSON, neither of which should download.
    original: {
      key: orig.key,
      // MEDIATED, not presigned. The recipient never receives a storage URL for
      // the master — see GET /transfers/:id/original above. Built from the
      // incoming request so it needs no configured public base and stays
      // correct behind the tunnel, a vite proxy, or plain localhost.
      url: mediatedDownloadUrl(c, id, transfer?.expiresAt),
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
  const locked = recipientGate(c, id);
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
api.get("/transfers/:id/usage", requireSession, (c) => c.json(usageFor(c.req.param("id"))));
