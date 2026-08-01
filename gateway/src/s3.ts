// Control-plane S3 helpers against Backblaze B2. The gateway never touches
// file bytes — it only mints presigned URLs and runs multipart bookkeeping.
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand,
  GetObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomUUID } from "node:crypto";

const env = process.env as Record<string, string>;
const BUCKET = env.B2_BUCKET;

export const s3 = new S3Client({
  region: env.B2_REGION,
  endpoint: env.B2_S3_ENDPOINT,
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY },
  // B2 works virtual-hosted (default). MinIO / on-prem need path-style — set
  // B2_FORCE_PATH_STYLE=true for those.
  forcePathStyle: env.B2_FORCE_PATH_STYLE === "true",
});

export interface PartRecord { partNumber: number; etag: string; size: number; }

// 16 MB floor, scaled so even a 100 GB file stays under the 10k-part cap.
export function planParts(size: number) {
  const MB = 1 << 20;
  const partSize = Math.max(16 * MB, Math.ceil(size / 9000 / MB) * MB);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

export async function initiate(filename: string, contentType: string, size: number) {
  const transferId = randomUUID();
  const safe = filename.replace(/[^\w.\-]/g, "_");
  const key = `transfers/${transferId}/${safe}`;
  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET, Key: key, ContentType: contentType,
  }));
  const { partSize, partCount } = planParts(size);
  return { transferId, key, uploadId: UploadId!, partSize, partCount };
}

export async function presignParts(key: string, uploadId: string, partNumbers: number[]) {
  const urls: Record<number, string> = {};
  await Promise.all(partNumbers.map(async (n) => {
    urls[n] = await getSignedUrl(
      s3, new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: n }),
      { expiresIn: 3600 });
  }));
  return { urls };
}

// Resume truth: which parts has B2 already stored? Paginated — a 100 GB
// upload has thousands of parts, well past the 1000-per-page limit.
export async function listParts(key: string, uploadId: string): Promise<PartRecord[]> {
  const out: PartRecord[] = [];
  let marker: string | undefined;
  do {
    const r = await s3.send(new ListPartsCommand({
      Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker,
    }));
    for (const p of r.Parts ?? [])
      out.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size! });
    marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
  } while (marker);
  return out;
}

// Assemble from the part list B2 itself holds (ListParts) — so the browser
// never needs to read part ETags. That removes the cross-origin
// Expose-Headers requirement entirely; the server is the source of truth.
export async function complete(key: string, uploadId: string): Promise<{ parts: number; bytes: number }> {
  const parts = await listParts(key, uploadId);
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET, Key: key, UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
    },
  }));
  return { parts: parts.length, bytes: parts.reduce((s, p) => s + p.size, 0) };
}

export const abort = (key: string, uploadId: string) =>
  s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));

export const presignPut = (key: string) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });

// Presigned direct GET (works in dev/MinIO and against B2). Used for the
// delivery page's small assets; the big original can switch to the CDN URL
// below in production.
//
// `downloadAs` forces a download instead of inline rendering. This matters more
// than it looks: the delivery page's "Download original" is an <a download>
// pointing at THIS url, and the `download` attribute is specified to apply only
// to same-origin URLs — B2 is a different origin, so browsers silently ignore
// it and simply navigate. B2 then answers `Content-Type: video/quicktime` with
// no disposition, and the browser opens its media player and starts buffering
// the object instead of saving it. On a 26 GiB master that reads as a hung
// download eating memory.
//
// ResponseContentDisposition is a standard presigned-GET response override, so
// the header is signed into the URL and B2 returns it verbatim.
export const presignGet = (key: string, ttlSec = 3600, downloadAs?: string) =>
  getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      // Quote the filename and strip quotes/newlines: the value lands in a
      // response header, so an unescaped one would break parsing.
      ...(downloadAs
        ? { ResponseContentDisposition: `attachment; filename="${downloadAs.replace(/["\r\n]/g, "_")}"` }
        : {}),
    }),
    { expiresIn: ttlSec },
  );

export async function listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// Download = Cloudflare CDN URL + short-lived HMAC token the Worker verifies.
export function downloadUrl(key: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac("sha256", env.CDN_TOKEN_SECRET).update(`${key}:${exp}`).digest("base64url");
  const q = `exp=${exp}&sig=${sig}`;
  return {
    cdnUrl: `${env.CDN_BASE}/${key}?${q}`,
    outboardUrl: `${env.CDN_BASE}/${key}.obao?${q}`,
    expiresAt: exp * 1000,
  };
}
