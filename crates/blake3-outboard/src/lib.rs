//! Streaming BLAKE3 for the browser, built with `wasm-pack build --target web`.
//!
//! v0 (shipped): incremental root hash — low memory, works on 100 GB files,
//! gives end-to-end content integrity (the recipient re-hashes and compares).
//!
//! v1 (next): produce a bao OUTBOARD alongside the root so the downloader can
//! verify arbitrary byte *ranges* (resumable, tamper-checked streaming).
//! iroh/OrbitXfer already use `bao-tree`; expose:
//!     pub fn make_outboard(...) -> Box<[u8]>
//!     pub fn verify_range(outboard: &[u8], root: &str, offset: u64, data: &[u8]) -> bool
//! and have `finalize` return both the root and the outboard buffer.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Blake3Hasher {
    inner: blake3::Hasher,
}

#[wasm_bindgen]
impl Blake3Hasher {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Blake3Hasher {
        Blake3Hasher { inner: blake3::Hasher::new() }
    }

    /// Feed the next chunk (called in file order).
    pub fn update(&mut self, chunk: &[u8]) {
        self.inner.update(chunk);
    }

    /// 64-char hex content address.
    pub fn finalize_hex(&self) -> String {
        self.inner.finalize().to_hex().to_string()
    }
}

impl Default for Blake3Hasher {
    fn default() -> Self { Self::new() }
}
