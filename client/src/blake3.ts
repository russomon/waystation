// BLAKE3 + bao over the wasm module (built from crates/blake3-outboard).
// Upload computes the content-address root AND a bao outboard; download uses
// the outboard to verify arbitrary byte ranges.
import init, { Blake3Hasher, Blake3Outboard, verify_range } from "../../crates/blake3-outboard/pkg/blake3_outboard.js";

let ready: Promise<unknown> | null = null;
async function loadWasm(): Promise<void> {
  ready ??= init();
  await ready;
}

// Single in-order streaming pass → { root, outboard }.
export async function hashFile(
  file: File,
  onProgress?: (done: number) => void,
  chunk = 16 << 20,
  onFinalizing?: () => void,
): Promise<{ root: string; outboard: Uint8Array }> {
  await loadWasm();
  const ob = new Blake3Outboard();
  for (let off = 0; off < file.size; off += chunk) {
    ob.update(new Uint8Array(await file.slice(off, off + chunk).arrayBuffer()));
    onProgress?.(Math.min(off + chunk, file.size));
  }
  onFinalizing?.();
  return ob.finalize() as { root: string; outboard: Uint8Array };
}

// Constant-memory whole-file root only. Used for very large transfers where
// the current bao outboard implementation would exceed browser/wasm memory.
export async function hashFileRootOnly(
  file: File,
  onProgress?: (done: number) => void,
  chunk = 16 << 20,
  onFinalizing?: () => void,
): Promise<{ root: string }> {
  await loadWasm();
  const hasher = new Blake3Hasher();
  for (let off = 0; off < file.size; off += chunk) {
    hasher.update(new Uint8Array(await file.slice(off, off + chunk).arrayBuffer()));
    onProgress?.(Math.min(off + chunk, file.size));
  }
  onFinalizing?.();
  return { root: hasher.finalize_hex() };
}

// Verify one chunk-aligned range of the plain object against the root.
// `sliceStart` must be a multiple of 1024 (the bao chunk size).
export async function verifyRange(
  outboard: Uint8Array,
  root: string,
  sliceStart: number,
  data: Uint8Array,
): Promise<boolean> {
  await loadWasm();
  return verify_range(outboard, root, BigInt(sliceStart), data); // u64 → BigInt
}
