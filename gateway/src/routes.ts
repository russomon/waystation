import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as g from "./s3.js";
import { verifyB2Signature, parseB2Events, isOriginalMedia, transferIdFromKey } from "./events.js";
import { dispatchPipeline } from "./pipeline.js";
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
  const b = await c.req.json();
  await g.complete(b);
  // TODO: persist transfer metadata (blake3Root, recipients, expiry) → store.ts
  return c.json({ ok: true });
});

// ───────── download ─────────
api.get("/downloads", async (c) => c.json(g.downloadUrl(c.req.query("key")!)));

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
