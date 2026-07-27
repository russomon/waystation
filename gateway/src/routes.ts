import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  authConfig,
  authEnabled,
  clearSessionCookie,
  enforceOrigin,
  issueSession,
  limiter,
  requireSession,
  sessionIdOf,
  setSessionCookie,
  verifyAccessCode,
} from "./auth.js";
import {
  activeUploadCount,
  completedSince,
  completedSinceAll,
  capabilityRevoked,
  createUpload,
  getUpload,
  getUploadByKey,
  setUploadState,
  type UploadRow,
} from "./db.js";
import {
  ACCEPT_UPLOADS,
  applyServicePolicy,
  MAX_ACTIVE_UPLOADS_PER_SESSION,
  MAX_DAILY_JOBS,
  MAX_JOBS_PER_SESSION,
  RECIPIENT_LINK_TTL_DAYS,
  validateFilename,
  validatePartNumbers,
  validateSidecarName,
  validateSize,
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
  });
  return c.json(out);
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
  return c.json({ url: await g.presignPut(`${owned.row.objectKey}.obao`) });
});

// Sidecars uploaded alongside the master: captions (.srt/.vtt) ride into the
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
// qc_synthetic is OPT-IN (worker defaults it off), so it only counts as
// "a service is on" when explicitly true.
const SERVICE_KEYS = ["qc_av", "qc_captions", "qc_ai", "thumbnail", "summarize"];
const anyServiceOn = (o?: Record<string, boolean | string>) =>
  !o || SERVICE_KEYS.some((k) => o[k] !== false) || o["qc_synthetic"] === true;
const OPTION_KEYS = new Set([...SERVICE_KEYS, "qc_synthetic", "profile", "compute"]);
const sanitizeOptions = (o?: Record<string, boolean | string>) => o
  ? Object.fromEntries(Object.entries(o).filter(([key]) => OPTION_KEYS.has(key)))
  : undefined;

api.post("/uploads/complete", requireSession, enforceOrigin, async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, any>);
  const owned = ownedByPair(c, b.key, b.uploadId);
  if ("fail" in owned) return owned.fail;
  // Idempotent: a retried completion must not re-assemble on B2 or re-meter
  // the transfer. The first call wins; later calls acknowledge without work.
  if (owned.row.state === "complete")
    return c.json({ ok: true, alreadyComplete: true });

  const { bytes } = await g.complete(owned.row.objectKey, owned.row.uploadId);
  setUploadState(owned.row.objectKey, owned.row.uploadId, "complete");
  const transferId = owned.row.transferId;
  // Unknown and retired options (including legacy self_heal) never enter the
  // transfer store or dispatch payload.
  const requested = sanitizeOptions(b.options as Record<string, boolean | string> | undefined);
  // Service allowlist: a disabled service is forced OFF in the stored options,
  // not merely hidden in the UI — the API is authoritative. Applied before the
  // record is written so the policy survives a restart and the B2 event path
  // sees the same decision.
  const { options, disabled } = applyServicePolicy(requested);
  // Always record — the event path needs `options` even without a hash root.
  // Recipient links are bearer capabilities, so they carry an expiry from the
  // moment they exist (RECIPIENT_LINK_TTL_DAYS=0 disables expiry).
  saveTransfer(transferId, {
    key: owned.row.objectKey,
    blake3Root: b.blake3Root,
    createdAt: Date.now(),
    options,
    expiresAt: RECIPIENT_LINK_TTL_DAYS > 0
      ? Date.now() + RECIPIENT_LINK_TTL_DAYS * 86_400_000
      : undefined,
  });
  // Report the skip honestly rather than silently dropping a requested service.
  if (disabled.length)
    sse.publish(transferId, {
      type: "services_disabled",
      services: disabled,
      reason: "disabled by deployment policy",
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

api.get("/transfers/:id/download", async (c) => {
  const id = c.req.param("id");
  const key = c.req.query("key") ?? "";
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  // Reject traversal before the prefix test, so "transfers/<id>/../../other"
  // cannot satisfy startsWith and then resolve elsewhere.
  if (!key || key.includes("..") || !belongsToTransfer(key, id))
    return c.json({ error: "not found" }, 404);
  return c.json(g.downloadUrl(key));
});

// ───────── delivery page data ─────────
// Assembles a transfer from storage: the original + the pipeline's
// derivatives + manifest, each as a presigned URL the recipient can fetch.
// (Store-free: discovered by prefix. Production would add a record for
// recipients/expiry/access — see store.ts TODO.)
const mimeOf = (k: string) =>
  k.endsWith(".jpg") || k.endsWith(".jpeg") ? "image/jpeg"
  : k.endsWith(".vtt") ? "text/vtt"
  : k.endsWith(".txt") ? "text/plain"
  : k.endsWith(".json") ? "application/json"
  : k.endsWith(".mp4") ? "video/mp4"
  : "application/octet-stream";

api.get("/transfers/:id", async (c) => {
  const id = c.req.param("id");
  // Expired or revoked capabilities are indistinguishable from unknown ones:
  // a recipient link must never reveal that it once existed.
  if (capabilityRevoked(id)) return c.json({ error: "not found" }, 404);
  const all = await g.listKeys(`transfers/${id}/`);
  // The master is whatever ISN'T a sidecar — captions (.srt/.vtt), the bao
  // outboard, and reference mezzanines ride along under the same prefix and
  // can sort ahead of the master alphabetically.
  const SIDECAR_RE = /\.(obao|srt|vtt)$|\.ref\.[^./]+$/i;
  const originals = all.filter((o) => !SIDECAR_RE.test(o.key));
  if (originals.length === 0) return c.json({ error: "not found" }, 404);
  const orig = originals[0];
  const outboard = all.find((o) => o.key.endsWith(".obao"));
  const derivs = await g.listKeys(`derivatives/${id}/`);
  const sign = async (k: string, size: number) => ({ key: k, url: await g.presignGet(k), mime: mimeOf(k), size });

  const manifest = derivs.find((d) => d.key.endsWith("manifest.json"));
  return c.json({
    transferId: id,
    original: { ...(await sign(orig.key, orig.size)), filename: orig.key.split("/").pop() },
    // verified-range download material (present once an upload went through
    // `complete`, which records the root and the .obao sidecar lands).
    blake3Root: getTransfer(id)?.blake3Root ?? null,
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
