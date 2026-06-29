import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as g from "./s3.js";
import { verifyB2Signature, parseB2Events, isOriginalMedia, transferIdFromKey } from "./events.js";
import { dispatchPipeline } from "./pipeline.js";
import { saveTransfer, getTransfer } from "./store.js";
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
api.post("/uploads/complete", async (c) => {
  const b = await c.req.json(); // { key, uploadId, blake3Root }
  await g.complete(b.key, b.uploadId);
  if (b.blake3Root) saveTransfer(transferIdFromKey(b.key), { key: b.key, blake3Root: b.blake3Root, createdAt: Date.now() });
  // Dev only: no real B2 event source locally, so simulate the
  // object-created trigger right after assembly. Production leaves
  // DEV_TRIGGER_ON_COMPLETE unset and the real B2 Event Notification drives it.
  if (env.DEV_TRIGGER_ON_COMPLETE === "true") {
    const transferId = transferIdFromKey(b.key);
    sse.publish(transferId, { type: "pipeline_queued", key: b.key });
    void dispatchPipeline({ bucket: env.B2_BUCKET, key: b.key, transferId });
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
    sse.publish(transferId, { type: "pipeline_queued", key: e.objectName });
    void dispatchPipeline({ bucket: e.bucketName, key: e.objectName, transferId });
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
  return c.json({ ok: true });
});
