// Verified download through the Cloudflare CDN.
// v0: stream the whole object and verify the BLAKE3 root (end-to-end integrity).
// v1: switch to ranged GETs + bao outboard `verify_range` for resumable,
//     per-range verified streaming (see the crate TODO).
import { blake3Ready } from "./blake3.js";

export async function downloadVerified(key: string, write: (chunk: Uint8Array) => Promise<void>) {
  const meta = await fetch(`/api/downloads?key=${encodeURIComponent(key)}`).then((r) => r.json());
  const H = await blake3Ready();
  const h = new H();

  const res = await fetch(meta.cdnUrl);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    await write(value);
  }
  if (h.finalize_hex() !== meta.blake3Root) throw new Error("integrity check failed");
}
