// End-to-end transfer test against a real S3 API (MinIO locally; identical
// flow against Backblaze B2 — only endpoint + creds change).
// Exercises: initiate → presigned multipart upload → ListParts resume →
// complete → download → BLAKE3 verify. Exits non-zero on any failure.
import { randomBytes } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { S3Client, CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:8787";
const BUCKET = process.env.B2_BUCKET ?? "orbitxfer-test";
const SIZE = (Number(process.env.SIZE_MB ?? 40)) * (1 << 20);

const s3 = new S3Client({
  region: process.env.B2_REGION, endpoint: process.env.B2_S3_ENDPOINT,
  credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APP_KEY },
  forcePathStyle: process.env.B2_FORCE_PATH_STYLE === "true",
});
const api = (p, opts) => fetch(GATEWAY + p, opts).then((r) => r.json());
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

// 0. bucket
try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch (e) {
  if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(e.name))) throw e;
}

// 1. a test payload + its true content address
const data = randomBytes(SIZE);
const root = bytesToHex(blake3(data));
console.log(`payload: ${(SIZE / 1e6).toFixed(0)} MB  blake3=${root.slice(0, 16)}…`);

// 2. initiate
const init = await api("/api/uploads", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ filename: "clip.bin", contentType: "application/octet-stream", size: SIZE }),
});
console.log(`initiate: key=${init.key} parts=${init.partCount} partSize=${(init.partSize / 1e6).toFixed(0)}MB`);

async function uploadPart(n) {
  const { urls } = await api("/api/uploads/parts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: init.key, uploadId: init.uploadId, partNumbers: [n] }),
  });
  const start = (n - 1) * init.partSize;
  const slice = data.subarray(start, Math.min(start + init.partSize, SIZE));
  const res = await fetch(urls[n], { method: "PUT", body: slice });
  if (!res.ok) fail(`part ${n} PUT → HTTP ${res.status}`);
  // No ETag read — the gateway assembles from ListParts on complete.
}

// 3. upload the FIRST HALF, then simulate a crash → resume via ListParts
const all = Array.from({ length: init.partCount }, (_, i) => i + 1);
const half = Math.max(1, Math.floor(all.length / 2));
for (const n of all.slice(0, half)) await uploadPart(n);

const listed = await api(`/api/uploads/parts?key=${encodeURIComponent(init.key)}&uploadId=${init.uploadId}`);
console.log(`resume check: B2/MinIO reports ${listed.length} part(s) already stored`);
if (listed.length !== half) fail(`ListParts expected ${half}, got ${listed.length}`);

// 4. resume: upload the rest (skipping what's already there)
const have = new Set(listed.map((p) => p.partNumber));
for (const n of all.slice(half)) if (!have.has(n)) await uploadPart(n);

// 5. complete — gateway assembles from ListParts; we send only id + content hash
await api("/api/uploads/complete", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: init.key, uploadId: init.uploadId, blake3Root: root }),
});
console.log(`complete: gateway assembled ${all.length} parts into ${init.key}`);

// 6. download + verify
const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: init.key }), { expiresIn: 600 });
const dl = Buffer.from(await fetch(getUrl).then((r) => r.arrayBuffer()));
const dlRoot = bytesToHex(blake3(dl));
console.log(`download: ${(dl.length / 1e6).toFixed(0)} MB  blake3=${dlRoot.slice(0, 16)}…`);

if (dl.length !== SIZE) fail(`size mismatch: ${dl.length} vs ${SIZE}`);
if (dlRoot !== root) fail("BLAKE3 mismatch — bytes corrupted in transit");

console.log("\nPASS ✓  upload → resume(ListParts) → complete → download → BLAKE3 verify");
