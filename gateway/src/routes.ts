import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  authConfig,
  authEnabled,
  clearSessionCookie,
  enforceOrigin,
  issueSession,
  limiter,
  setSessionCookie,
  verifyAccessCode,
} from "./auth.js";
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
api.post("/uploads", async (c) => {
  const { filename, contentType, size } = await c.req.json();
  return c.json(await g.initiate(filename, contentType ?? "application/octet-stream", size));
});
api.post("/uploads/parts", async (c) => {
  const { key, uploadId, partNumbers } = await c.req.json();
  return c.json(await g.presignParts(key, uploadId, partNumbers));
});
api.get("/uploads/parts", async (c) =>
  c.json(await g.listParts(c.req.query("key")!, c.req.query("uploadId")!)));
api.post("/uploads/outboard-url", async (c) =>
  c.json({ url: await g.presignPut((await c.req.json()).key + ".obao") }));
// Sidecars uploaded alongside the master: captions (.srt/.vtt) ride into the
// caption QC; a source mezzanine (*.ref.mp4/.mov/.mxf) powers the reference
// SSIM/PSNR/VMAF lane. Neither triggers its own pipeline run (event filter).
api.post("/uploads/sidecar-url", async (c) => {
  const { key, filename } = await c.req.json(); // key = the master's object key
  if (!/(\.(srt|vtt)|\.ref\.(mp4|mov|mxf)|\.genblaze\.json)$/i.test(String(filename ?? "")))
    return c.json({ error: "only .srt/.vtt captions, .ref.* mezzanine, or .genblaze.json manifest sidecars" }, 400);
  const safe = String(filename).replace(/[^\w.\-]/g, "_");
  return c.json({ url: await g.presignPut(`transfers/${transferIdFromKey(key)}/${safe}`) });
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

api.post("/uploads/complete", async (c) => {
  const b = await c.req.json(); // { key, uploadId, blake3Root, options? }
  const { bytes } = await g.complete(b.key, b.uploadId);
  const transferId = transferIdFromKey(b.key);
  // Unknown and retired options (including legacy self_heal) never enter the
  // transfer store or dispatch payload.
  const options = sanitizeOptions(b.options as Record<string, boolean | string> | undefined);
  // Always record — the event path needs `options` even without a hash root.
  saveTransfer(transferId, { key: b.key, blake3Root: b.blake3Root, createdAt: Date.now(), options });
  // Billable event: the transfer itself, in GB delivered into the waystation.
  meter({ transferId, event: "transfer", units: Number((bytes / 1e9).toFixed(6)), unit: "gb", ref: b.key });
  // Dev only: no real B2 event source locally, so simulate the
  // object-created trigger right after assembly. Production leaves
  // DEV_TRIGGER_ON_COMPLETE unset and the real B2 Event Notification drives it.
  if (env.DEV_TRIGGER_ON_COMPLETE === "true") {
    if (anyServiceOn(options)) {
      sse.publish(transferId, { type: "pipeline_queued", key: b.key });
      void dispatchPipeline({ bucket: env.B2_BUCKET, key: b.key, transferId, options });
    } else {
      sse.publish(transferId, { type: "pipeline_skipped", reason: "transfer-only" });
    }
  }
  return c.json({ ok: true });
});

// ───────── download ─────────
api.get("/downloads", async (c) => c.json(g.downloadUrl(c.req.query("key")!)));

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
api.get("/transfers/:id/usage", (c) => c.json(usageFor(c.req.param("id"))));
