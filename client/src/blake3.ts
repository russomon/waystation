// Streaming BLAKE3 over the wasm module (built from crates/blake3-outboard).
// v0 ships the content-addressing root hash; the bao outboard for verified
// *range* download plugs into the same module (see the crate's TODO).
import init, { Blake3Hasher } from "../../crates/blake3-outboard/pkg/blake3_outboard.js";

let ready: Promise<unknown> | null = null;
export async function blake3Ready(): Promise<typeof Blake3Hasher> {
  ready ??= init();
  await ready;
  return Blake3Hasher;
}

export async function hashFile(
  file: File,
  onProgress?: (done: number) => void,
  chunk = 16 << 20,
): Promise<{ root: string }> {
  const H = await blake3Ready();
  const h = new H();
  for (let off = 0; off < file.size; off += chunk) {
    h.update(new Uint8Array(await file.slice(off, off + chunk).arrayBuffer()));
    onProgress?.(Math.min(off + chunk, file.size));
  }
  return { root: h.finalize_hex() };
}
