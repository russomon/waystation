import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as g from "./s3.js";
import { verifyB2Signature, parseB2Events, isOriginalMedia, transferIdFromKey } from "./events.js";
import { dispatchPipeline } from "./pipeline.js";
import { saveTransfer, getTransfer } from "./store.js";
import { meter, usageFor } from "./metering.js";
import * as sse from "./sse.js";

const env = process.env as Record<string, string>;
export const api = new Hono();

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
// Caption sidecar (.srt/.vtt) uploaded alongside the master. Rides into the
// caption QC; never triggers its own pipeline run (event filter excludes it).
api.post("/uploads/sidecar-url", async (c) => {
  const { key, filename } = await c.req.json(); // key = the master's object key
  if (!/\.(srt|vtt)$/i.test(String(filename ?? "")))
    return c.json({ error: "only .srt/.vtt sidecars" }, 400);
  const safe = String(filename).replace(/[^\w.\-]/g, "_");
  return c.json({ url: await g.presignPut(`transfers/${transferIdFromKey(key)}/${safe}`) });
});
// undefined options = everything on; explicit all-false = plain transfer.
const anyServiceOn = (o?: Record<string, boolean>) => !o || Object.values(o).some(Boolean);

api.post("/uploads/complete", async (c) => {
  const b = await c.req.json(); // { key, uploadId, blake3Root, options? }
  const { bytes } = await g.complete(b.key, b.uploadId);
  const transferId = transferIdFromKey(b.key);
  const options = b.options as Record<string, boolean> | undefined;
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
  const originals = all.filter((o) => !o.key.endsWith(".obao"));
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
