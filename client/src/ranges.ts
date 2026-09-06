// Byte-range planning for parallel downloads.
//
// Its own module, with no DOM imports, for two reasons: this is pure
// arithmetic that has nothing to do with rendering a delivery page, and it is
// the part most worth testing directly — scripts/parallel-download-proof.sh
// imports it under plain Node.

/** Split a file into the byte ranges the download workers will request.
 *
 *  This is the arithmetic most likely to be quietly wrong. An HTTP Range end is
 *  INCLUSIVE, so an off-by-one here silently drops or duplicates a byte per
 *  chunk and writes a corrupt file that still looks complete — the worst kind
 *  of bug for a delivery tool, because nothing reports an error.
 *
 *  The 16 MiB floor matches the uploader's part floor; the divisor keeps a
 *  26 GiB master to a few hundred requests rather than sixteen hundred. */
export const planRanges = (total: number): { start: number; end: number }[] => {
  const size = Math.max(16 << 20, Math.ceil(total / 400));
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < total; start += size)
    out.push({ start, end: Math.min(start + size, total) - 1 });
  return out;
};
