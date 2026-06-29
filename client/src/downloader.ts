// Verified download via the Cloudflare CDN / presigned URL.
// If the transfer has a bao outboard, fetch it once, then pull the object in
// chunk-aligned ranges and verify EACH range against the BLAKE3 root before
// accepting it — resumable + tamper-checked. Falls back to a plain fetch when
// no outboard/root is available.
//
// For the demo this accumulates into a Blob (fine for modest files). For huge
// originals, swap the Blob for the File System Access API writable stream so
// verified bytes flush straight to disk.
import { verifyRange } from "./blake3.js";

const RANGE = 4 << 20; // 4 MiB — a multiple of 1024, so every offset is chunk-aligned

async function fetchBytes(url: string, range?: string): Promise<Uint8Array> {
  const ab: ArrayBuffer = await fetch(url, range ? { headers: { Range: range } } : undefined)
    .then((r) => r.arrayBuffer());
  return new Uint8Array(ab);
}

export async function downloadVerified(
  transferId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ blob: Blob; verified: boolean }> {
  const t = await fetch(`/api/transfers/${transferId}`).then((r) => r.json());

  if (!t.outboardUrl || !t.blake3Root) {
    return { blob: new Blob([await fetchBytes(t.original.url)]), verified: false };
  }

  const outboard = await fetchBytes(t.outboardUrl);
  const total: number = t.original.size;
  const parts: BlobPart[] = [];
  for (let off = 0; off < total; off += RANGE) {
    const end = Math.min(off + RANGE, total);
    const buf = await fetchBytes(t.original.url, `bytes=${off}-${end - 1}`);
    if (!(await verifyRange(outboard, t.blake3Root, off, buf)))
      throw new Error(`integrity check failed at byte ${off}`);
    parts.push(buf);
    onProgress?.(end, total);
  }
  return { blob: new Blob(parts), verified: true };
}
