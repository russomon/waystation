//! BLAKE3 + bao for OrbitXfer Web, built with `wasm-pack build --target web`.
//!
//! - `Blake3Hasher`  — streaming root hash (content address / whole-file check).
//! - `Blake3Outboard` — streaming root **and** bao outboard, produced during
//!   upload. The outboard is a small sidecar (a few MB even for 100 GB).
//! - `verify_range`  — on download, verify an arbitrary (chunk-aligned) byte
//!   range of the plain object against the root, using the outboard. This is
//!   what makes downloads resumable AND tamper-checked without storing the
//!   bao-encoded data in B2 (we keep the plain object + a separate outboard).

use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use wasm_bindgen::prelude::*;

fn e2js<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

// ───────────────────── streaming root (whole-file) ─────────────────────
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
    pub fn update(&mut self, chunk: &[u8]) {
        self.inner.update(chunk);
    }
    pub fn finalize_hex(&self) -> String {
        self.inner.finalize().to_hex().to_string()
    }
}

impl Default for Blake3Hasher {
    fn default() -> Self { Self::new() }
}

// ───────────────────── streaming root + bao outboard ─────────────────────
#[wasm_bindgen]
pub struct Blake3Outboard {
    enc: bao::encode::Encoder<Cursor<Vec<u8>>>,
}

#[wasm_bindgen]
impl Blake3Outboard {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Blake3Outboard {
        Blake3Outboard { enc: bao::encode::Encoder::new_outboard(Cursor::new(Vec::new())) }
    }

    /// Feed the next chunk, in file order.
    pub fn update(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.enc.write_all(chunk).map_err(e2js)
    }

    /// Returns `{ root: hex string, outboard: Uint8Array }`.
    pub fn finalize(mut self) -> Result<JsValue, JsValue> {
        let hash = self.enc.finalize().map_err(e2js)?;
        let outboard = self.enc.into_inner().into_inner();
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"root".into(), &JsValue::from_str(&hash.to_hex().to_string()))
            .map_err(|_| JsValue::from_str("reflect set root"))?;
        js_sys::Reflect::set(&obj, &"outboard".into(), &js_sys::Uint8Array::from(outboard.as_slice()))
            .map_err(|_| JsValue::from_str("reflect set outboard"))?;
        Ok(obj.into())
    }
}

impl Default for Blake3Outboard {
    fn default() -> Self { Self::new() }
}

// A Read+Seek view over a single downloaded range, addressed by ABSOLUTE
// offset. The bao SliceExtractor seeks to the (chunk-aligned) slice start
// and reads forward; we map those absolute positions onto the range buffer.
struct RangeReader {
    data: Vec<u8>,
    base: u64,
    pos: u64,
}

impl RangeReader {
    fn new(data: Vec<u8>, base: u64) -> Self {
        RangeReader { data, base, pos: base }
    }
}

impl Read for RangeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pos < self.base {
            return Ok(0);
        }
        let rel = (self.pos - self.base) as usize;
        if rel >= self.data.len() {
            return Ok(0);
        }
        let n = std::cmp::min(buf.len(), self.data.len() - rel);
        buf[..n].copy_from_slice(&self.data[rel..rel + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RangeReader {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        self.pos = match from {
            SeekFrom::Start(p) => p,
            SeekFrom::Current(d) => (self.pos as i64 + d) as u64,
            SeekFrom::End(d) => ((self.base + self.data.len() as u64) as i64 + d) as u64,
        };
        Ok(self.pos)
    }
}

/// Verify that `data` (the plain bytes at absolute `slice_start`) is authentic
/// under `root_hex`, using `outboard`. `slice_start` must be chunk-aligned
/// (a multiple of 1024); `data.len()` likewise, except the final range, which
/// may end at EOF. Returns Ok(true) verified, Ok(false) tampered/mismatch.
#[wasm_bindgen]
pub fn verify_range(outboard: &[u8], root_hex: &str, slice_start: u64, data: &[u8]) -> Result<bool, JsValue> {
    let hash = blake3::Hash::from_hex(root_hex).map_err(e2js)?;
    let slice_len = data.len() as u64;
    if slice_len == 0 {
        return Ok(true);
    }
    let input = RangeReader::new(data.to_vec(), slice_start);
    let outboard_rd = Cursor::new(outboard.to_vec());
    let mut extractor = bao::encode::SliceExtractor::new_outboard(input, outboard_rd, slice_start, slice_len);
    let mut slice = Vec::new();
    extractor.read_to_end(&mut slice).map_err(e2js)?;

    let mut decoder = bao::decode::SliceDecoder::new(Cursor::new(slice), &hash, slice_start, slice_len);
    let mut out = Vec::new();
    match decoder.read_to_end(&mut out) {
        Ok(_) => Ok(out.as_slice() == data),
        Err(_) => Ok(false), // proof/hash mismatch → tampered
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(data: &[u8]) -> (String, Vec<u8>) {
        let mut enc = bao::encode::Encoder::new_outboard(Cursor::new(Vec::new()));
        enc.write_all(data).unwrap();
        let hash = enc.finalize().unwrap();
        (hash.to_hex().to_string(), enc.into_inner().into_inner())
    }

    #[test]
    fn outboard_root_matches_blake3() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let (root, _ob) = encode(&data);
        assert_eq!(root, blake3::hash(&data).to_hex().to_string());
    }

    #[test]
    fn verify_aligned_ranges_and_tamper() {
        let data: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let (root, ob) = encode(&data);

        // whole file
        assert!(verify_range(&ob, &root, 0, &data).unwrap());
        // chunk-aligned ranges
        assert!(verify_range(&ob, &root, 0, &data[0..4096]).unwrap());
        assert!(verify_range(&ob, &root, 4096, &data[4096..5000]).unwrap()); // final partial chunk
        assert!(verify_range(&ob, &root, 1024, &data[1024..3072]).unwrap());

        // tampered data must fail
        let mut bad = data.clone();
        bad[2000] ^= 0xff;
        assert!(!verify_range(&ob, &root, 0, &bad).unwrap());
        assert!(!verify_range(&ob, &root, 1024, &bad[1024..3072]).unwrap());

        // tampered outboard must fail too
        let mut bad_ob = ob.clone();
        let n = bad_ob.len();
        bad_ob[n - 1] ^= 0xff;
        assert!(!verify_range(&bad_ob, &root, 0, &data).unwrap());
    }
}
