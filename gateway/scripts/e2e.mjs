// End-to-end transfer + outboard test against a real S3 API (MinIO locally;
// identical flow against B2 — only endpoint + creds change). Exercises:
//   initiate → presigned multipart upload → ListParts resume → outboard
//   upload → complete → delivery endpoint → verified RANGE download → tamper
// using the SAME wasm (Blake3Outboard / verify_range) the browser uses.
//
// Prereqs: a gateway pointed at MinIO/B2 running, and the nodejs wasm built:
//   npm run build:wasm:node
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { S3Client, CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const require = createRequire(import.meta.url);
const wasm = require("../../crates/blake3-outboard/pkg-node/blake3_outboard.js");

const GATEWAY = process.env.GATEWAY ?? "http://localhost:8787";
const BUCKET = process.env.B2_BUCKET ?? "orbitxfer-test";
const SIZE = (Number(process.env.SIZE_MB ?? 40)) * (1 << 20);

const s3 = new S3Client({
  region: process.env.B2_REGION, endpoint: process.env.B2_S3_ENDPOINT,
  credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APP_KEY },
  forcePathStyle: process.env.B2_FORCE_PATH_STYLE === "true",
});
const api = (p, opts) => fetch(GATEWAY + p, opts).then((r) => r.json());
const jpost = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

// MinIO: creates it. B2: buckets are pre-created (S3 CreateBucket may be
// unsupported) — ignore and assume it exists.
try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch { /* exists / unsupported */ }

// 1. payload → content-address root + bao outboard (the browser does exactly this)
const data = randomBytes(SIZE);
const enc = new wasm.Blake3Outboard();
for (let o = 0; o < data.length; o += 1 << 20) enc.update(data.subarray(o, o + (1 << 20)));
const { root, outboard } = enc.finalize();
console.log(`payload ${(SIZE / 1e6).toFixed(0)} MB · root ${root.slice(0, 16)}… · outboard ${outboard.length} B`);

// 2. initiate + presigned multipart upload, with a resume in the middle
const init = await jpost("/api/uploads", { filename: "clip.bin", contentType: "application/octet-stream", size: SIZE });
console.log(`initiate: parts=${init.partCount} partSize=${(init.partSize / 1e6).toFixed(0)}MB`);
async function uploadPart(n) {
  const { urls } = await jpost("/api/uploads/parts", { key: init.key, uploadId: init.uploadId, partNumbers: [n] });
  const start = (n - 1) * init.partSize;
  const res = await fetch(urls[n], { method: "PUT", body: data.subarray(start, Math.min(start + init.partSize, SIZE)) });
  if (!res.ok) fail(`part ${n} → HTTP ${res.status}`);
}
const all = Array.from({ length: init.partCount }, (_, i) => i + 1);
const half = Math.max(1, Math.floor(all.length / 2));
for (const n of all.slice(0, half)) await uploadPart(n);
const listed = await api(`/api/uploads/parts?key=${encodeURIComponent(init.key)}&uploadId=${init.uploadId}`);
if (listed.length !== half) fail(`resume: ListParts expected ${half}, got ${listed.length}`);
console.log(`resume: ${listed.length} parts already stored`);
const have = new Set(listed.map((p) => p.partNumber));
for (const n of all.slice(half)) if (!have.has(n)) await uploadPart(n);

// 3. upload the outboard sidecar, then complete
const ob = await jpost("/api/uploads/outboard-url", { key: init.key });
if (!(await fetch(ob.url, { method: "PUT", body: outboard })).ok) fail("outboard PUT failed");
await jpost("/api/uploads/complete", { key: init.key, uploadId: init.uploadId, blake3Root: root });
console.log("complete: parts assembled (ListParts) + outboard stored");

// 4. delivery endpoint exposes root + outboard
const tid = init.key.split("/")[1];
const t = await api(`/api/transfers/${tid}`);
if (t.blake3Root !== root) fail(`delivery blake3Root mismatch: ${t.blake3Root}`);
if (!t.outboardUrl) fail("delivery missing outboardUrl");
console.log("delivery: original + blake3Root + outboardUrl present");

// 5. verified RANGE download (what the browser's verified-download does)
const ob2 = new Uint8Array(await fetch(t.outboardUrl).then((r) => r.arrayBuffer()));
const off = 4096, len = 4096;
const getUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: init.key }), { expiresIn: 600 });
const rangeBytes = new Uint8Array(await fetch(getUrl, { headers: { Range: `bytes=${off}-${off + len - 1}` } }).then((r) => r.arrayBuffer()));
if (!wasm.verify_range(ob2, root, BigInt(off), rangeBytes)) fail("verify_range rejected an authentic range");
const tampered = Uint8Array.from(rangeBytes); tampered[100] ^= 0xff;
if (wasm.verify_range(ob2, root, BigInt(off), tampered)) fail("verify_range ACCEPTED a tampered range");
console.log("verified range: authentic ✓  tampered rejected ✓");

console.log("\nPASS ✓  upload → resume → outboard → complete → delivery → verified range download");
