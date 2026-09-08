// Byte formatting for anything a person reads.
//
// DECIMAL — 1 MB = 1,000,000 bytes — for three reasons:
//
//   1. macOS Finder has reported decimal since 10.6, so a recipient comparing
//      the delivery page against Finder should see the same number.
//   2. Backblaze bills in decimal GB. Once transfers are charged per gigabyte,
//      the UI, the invoice and the storage bill must mean the same gigabyte.
//   3. "GiB" reads as jargon to a media client.
//
// This lives in one module because the sender and the recipient page had
// SEPARATE formatters and drifted: the sender divided by 1024 and labelled GiB
// while the recipient divided by 1e9 and labelled GB, so one 26 GiB master read
// as "26.00 GiB" to the sender and "27.92 GB" to the recipient — 7% apart, on
// two screens of one product.
//
// ⚠ Operator-facing surfaces stay BINARY and must not use this: the boot banner
// (`max=350.0GiB verifiedRangeMax=16.0GiB`), `gateway/src/limits.ts`,
// `docs/DEPLOY.md`, the 16 MiB uploader part floor, the 5 GiB single-PUT cap.
// Those are genuine powers of two, and relabelling them would make the docs lie.
// Never relabel without recomputing — "GiB" to "GB" over a division by 1024 is a
// number 7% wrong wearing a correct-looking label.
const UNITS = ["kB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)} B`;
  let value = n / 1000;
  let unit: string = UNITS[0];
  for (let i = 1; i < UNITS.length && value >= 1000; i += 1) {
    value /= 1000;
    unit = UNITS[i];
  }
  // Two decimals up to 100, one above: "7.52 GB", "28.05 GB", "512.0 MB".
  // Two matters at this scale — the difference between 28.0 and 28.05 GB is
  // 50 MB, and a recipient checking against Finder expects to see it.
  return `${value >= 100 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}
