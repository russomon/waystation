// Parallel multipart upload straight to B2, resumable via ListParts.
import { hashFile } from "./blake3.js";
import { getResume, saveResume, markPart, clearResume, type ResumeState } from "./resumeStore.js";

const API = "/api";
const CONCURRENCY = 6;

export interface Progress { bytes: number; total: number; phase: string; }

export async function uploadFile(file: File, onProgress: (p: Progress) => void) {
  const fp = `${file.name}:${file.size}:${file.lastModified}`; // stable local resume key

  // 1. initiate, or re-attach to an in-flight upload
  let st = await getResume(fp);
  if (!st) {
    const r = await post("/uploads", {
      filename: file.name, contentType: file.type || "application/octet-stream", size: file.size,
    });
    st = { fp, key: r.key, uploadId: r.uploadId, partSize: r.partSize, partCount: r.partCount, done: {} };
    await saveResume(st);
  }

  // 2. reconcile with B2's truth (parts that survived a crash/reload)
  const server: { partNumber: number; etag: string }[] =
    await get(`/uploads/parts?key=${encodeURIComponent(st.key)}&uploadId=${st.uploadId}`);
  for (const p of server) st.done[p.partNumber] = p.etag;
  await saveResume(st);

  // 3. hash pass (content address) runs concurrently with uploads
  const hashing = hashFile(file, (b) => onProgress({ bytes: b, total: file.size, phase: "hashing" }));

  // 4. upload only the missing parts, in parallel, capturing ETags
  const missing = range(1, st.partCount).filter((n) => !st!.done[n]);
  let uploaded = Object.keys(st.done).length * st.partSize;
  await pool(missing, CONCURRENCY, async (n) => {
    const { urls } = await post("/uploads/parts", { key: st!.key, uploadId: st!.uploadId, partNumbers: [n] });
    const start = (n - 1) * st!.partSize;
    const blob = file.slice(start, Math.min(start + st!.partSize, file.size));
    const res = await fetch(urls[n], { method: "PUT", body: blob });
    if (!res.ok) throw new Error(`part ${n}: HTTP ${res.status}`);
    // No need to read the ETag — the gateway assembles from ListParts.
    st!.done[n] = "1";
    await markPart(fp, n, "1");
    uploaded += blob.size;
    onProgress({ bytes: Math.min(uploaded, file.size), total: file.size, phase: "uploading" });
  });

  const { root, outboard } = await hashing;

  // 5. upload the bao outboard sidecar (enables verified range/resumable download)
  const ob = await post("/uploads/outboard-url", { key: st.key });
  const obRes = await fetch(ob.url, { method: "PUT", body: outboard });
  if (!obRes.ok) throw new Error(`outboard upload failed: HTTP ${obRes.status}`);

  // 6. complete — gateway assembles from ListParts; we send the id + content hash
  await post("/uploads/complete", { key: st.key, uploadId: st.uploadId, blake3Root: root });
  await clearResume(fp);

  const transferId = st.key.split("/")[1];
  onProgress({ bytes: file.size, total: file.size, phase: "complete" });
  return { key: st.key, transferId, blake3Root: root };
}

function range(a: number, b: number) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  }));
}
const post = (p: string, b: unknown) =>
  fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p: string) => fetch(API + p).then((r) => r.json());
