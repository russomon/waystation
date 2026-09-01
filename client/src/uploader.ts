// Parallel multipart upload straight to B2, resumable via ListParts.
//
// Two transports, deliberately kept apart: control calls go to the gateway
// through gwPost/gwGet (credentialed, session cookie); the part/sidecar PUTs go
// straight to Backblaze with a BARE fetch — no cookie, no gateway header. The
// master file never passes through the gateway or Cloudflare.
import { hashInWorker } from "./hashClient.js";
import { gwGet, gwPost } from "./config.js";
import { getResume, saveResume, markPart, clearResume, type ResumeState } from "./resumeStore.js";

const CONCURRENCY = 6;

export type IntegrityState = "preparing" | "hashing" | "finalizing" | "complete";
export type UploadState = "preparing" | "connecting" | "uploading" | "finalizing" | "complete";
export interface Progress {
  total: number;
  hashBytes: number;
  uploadedBytes: number;
  integrity: IntegrityState;
  upload: UploadState;
  message: string;
}
export interface ServiceOptions {
  qc_av: boolean; qc_captions: boolean; qc_ai: boolean; qc_synthetic: boolean;
  ai_interpretive: boolean;
  thumbnail: boolean; summarize: boolean;
  review_brief: string;
  profile: string;      // standard | broadcast/house XDCAM | netflix
  compute: string;      // "local" | "cloud" — where the waystation crunches
}
export interface SendExtras {
  captions?: File | null;
  genManifest?: File | null;  // source Genblaze manifest → prompt-adherence QC
  options?: ServiceOptions;
  recipientPassword?: string;
}

export async function uploadFile(file: File, extras: SendExtras, onProgress: (p: Progress) => void) {
  const fp = `${file.name}:${file.size}:${file.lastModified}`; // stable local resume key
  const progress: Progress = {
    total: file.size, hashBytes: 0, uploadedBytes: 0,
    integrity: "preparing", upload: "preparing", message: "Preparing secure transfer",
  };
  const emit = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    onProgress({ ...progress });
  };
  emit({});

  // 1. initiate, or re-attach to an in-flight upload
  let st = await getResume(fp);
  if (!st) {
    const r = await post("/uploads", {
      filename: file.name, contentType: file.type || "application/octet-stream", size: file.size,
    });
    st = {
      fp, key: r.key, uploadId: r.uploadId, partSize: r.partSize, partCount: r.partCount,
      verificationMode: r.verificationMode ?? "range",
      done: {},
    };
    await saveResume(st);
  }
  // Legacy resume records (written before verification modes existed) carry no
  // mode. Do NOT guess a default: the gateway is authoritative and BOTH guesses
  // are wrong in one direction. "range" rebuilds a multi-GiB bao outboard for a
  // huge file — that wedged a real 27 GiB upload, because finalize() is a
  // synchronous wasm allocation that blocks the main thread and stalls the parts
  // still in flight. "root" silently skips the sidecar for a small file, leaving
  // a transfer the gateway has recorded as range-verified but which has no
  // .obao, so the delivery page offers a verified download it cannot serve.
  //
  // Ask instead. /uploads/outboard-url answers 403 outboard_disabled when the
  // gateway selected root-only, so a single call settles it against the server's
  // own record. Only that specific refusal means "root"; anything else (404
  // ownership, 401 expiry, network) must surface rather than be misread.
  if (!st.verificationMode) {
    try {
      await post("/uploads/outboard-url", { key: st.key });
      st.verificationMode = "range";
    } catch (e) {
      if ((e as { code?: string })?.code !== "outboard_disabled") throw e;
      st.verificationMode = "root";
    }
    await saveResume(st);
  }

  // 2. reconcile with B2's truth (parts that survived a crash/reload)
  const server: { partNumber: number; etag: string }[] =
    await get(`/uploads/parts?key=${encodeURIComponent(st.key)}&uploadId=${st.uploadId}`);
  for (const p of server) st.done[p.partNumber] = p.etag;
  await saveResume(st);

  // 3. hash pass (content address) runs concurrently with uploads. Range mode
  // also builds the bao outboard. Root-only mode keeps memory flat for huge
  // files and records only the whole-file BLAKE3 root.
  emit({ integrity: "hashing", upload: "connecting", message: "Integrity check and upload are running together" });
  const hashing = hashInWorker(file, st.verificationMode, (event) => {
    if (event.type === "progress")
      emit({ hashBytes: event.bytes, integrity: "hashing" });
    else if (event.type === "finalizing")
      emit({ hashBytes: file.size, integrity: "finalizing", message: "Finalizing verification data while upload continues" });
    else
      emit({ hashBytes: file.size, integrity: "complete", message: "Integrity check complete; upload continues" });
  });

  // 4. upload only the missing parts, in parallel, capturing ETags
  const missing = range(1, st.partCount).filter((n) => !st!.done[n]);
  let uploaded = Object.keys(st.done).length * st.partSize;
  emit({ uploadedBytes: Math.min(uploaded, file.size) });
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
    emit({
      uploadedBytes: Math.min(uploaded, file.size),
      upload: "uploading",
      message: "Uploading directly to Backblaze B2",
    });
  });

  emit({ uploadedBytes: file.size, upload: "finalizing", message: "Upload bytes complete; finalizing integrity and multipart records" });

  const hashed = await hashing;
  const root = hashed.root;

  // 5. upload the bao outboard sidecar only when the gateway selected range
  // verification. Large root-only transfers deliberately skip this because the
  // current outboard implementation buffers the whole sidecar in browser memory.
  if (st.verificationMode === "range") {
    const outboard = hashed.outboard;
    if (!outboard) throw new Error("Integrity sidecar was not generated.");
    const ob = await post("/uploads/outboard-url", { key: st.key });
    const obRes = await fetch(ob.url, { method: "PUT", body: outboard });
    if (!obRes.ok) throw new Error(`outboard upload failed: HTTP ${obRes.status}`);
  }

  // 5b. sidecars — must land BEFORE complete so the pipeline's sidecar
  // discovery sees them when the object-created event fires
  if (extras.captions) {
    const sc = await post("/uploads/sidecar-url", { key: st.key, filename: extras.captions.name });
    if (sc.error) throw new Error(sc.error);
    const scRes = await fetch(sc.url, { method: "PUT", body: extras.captions });
    if (!scRes.ok) throw new Error(`caption upload failed: HTTP ${scRes.status}`);
  }
  if (extras.genManifest) {
    // fixed name: the worker discovers the generation record by this suffix
    const gm = await post("/uploads/sidecar-url", { key: st.key, filename: "source.genblaze.json" });
    if (gm.error) throw new Error(gm.error);
    const gmRes = await fetch(gm.url, { method: "PUT", body: extras.genManifest });
    if (!gmRes.ok) throw new Error(`genblaze manifest upload failed: HTTP ${gmRes.status}`);
  }

  // 6. complete — gateway assembles from ListParts; we send the id + content
  //    hash + the sender's service selections (all-off = plain transfer)
  await post("/uploads/complete", {
    key: st.key, uploadId: st.uploadId, blake3Root: root, options: extras.options,
    recipientPassword: extras.recipientPassword || undefined,
  });
  await clearResume(fp);

  const transferId = st.key.split("/")[1];
  emit({
    hashBytes: file.size, uploadedBytes: file.size,
    integrity: "complete", upload: "complete", message: "Transfer complete",
  });
  return { key: st.key, transferId, blake3Root: root };
}

function range(a: number, b: number) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
  }));
}
// Gateway control-plane calls (credentialed, status-aware). Backblaze PUTs
// above use a bare fetch and must never route through these.
const post = gwPost;
const get = gwGet;
