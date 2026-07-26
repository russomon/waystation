// Input validation for the upload control plane.
//
// Everything the browser sends is untrusted: the declared size, the filename,
// the content type, the part numbers, and the service selections. None of it is
// authoritative — it is a claim to be bounded before it reaches B2 or the
// pipeline. Content type in particular is INFORMATIONAL only; it is stored and
// forwarded but never used to decide what work runs.
const env = process.env as Record<string, string | undefined>;

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Hard ceiling checked BEFORE a multipart upload is initiated on B2, so an
 *  oversized claim never creates remote state or reserves any spend. */
export const MAX_UPLOAD_BYTES = num(env.MAX_UPLOAD_BYTES, 2 * 1024 ** 3); // 2 GiB default
export const MAX_FILENAME_LENGTH = 200;
export const MAX_PART_NUMBERS_PER_REQUEST = 64;

export interface Invalid {
  error: string;
  code: string;
  status: 400 | 413;
}

export function validateFilename(raw: unknown): Invalid | { filename: string } {
  if (typeof raw !== "string" || !raw.trim())
    return { error: "A filename is required.", code: "bad_filename", status: 400 };
  // Normalize first so visually identical Unicode cannot smuggle a different
  // byte sequence past the checks below.
  const filename = raw.normalize("NFKC").trim();
  if (filename.length > MAX_FILENAME_LENGTH)
    return { error: `Filename exceeds ${MAX_FILENAME_LENGTH} characters.`, code: "bad_filename", status: 400 };
  // Reject traversal and separators outright rather than sanitizing silently:
  // s3.initiate() also replaces unsafe characters, but a request that looks
  // like an escape attempt should fail loudly instead of being rewritten.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..") ||
      /[\u0000-\u001f\u007f]/.test(filename))
    return { error: "Filename contains illegal characters.", code: "bad_filename", status: 400 };
  return { filename };
}

export function validateSize(raw: unknown): Invalid | { size: number } {
  const size = Number(raw);
  if (!Number.isFinite(size) || !Number.isInteger(size) || size <= 0)
    return { error: "A positive, finite file size is required.", code: "bad_size", status: 400 };
  if (size > MAX_UPLOAD_BYTES)
    return {
      error: `That file is larger than the ${(MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(1)} GiB limit for this deployment.`,
      code: "too_large",
      status: 413,
    };
  return { size };
}

export function validatePartNumbers(raw: unknown, partCount: number): Invalid | { partNumbers: number[] } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "partNumbers must be a non-empty array.", code: "bad_parts", status: 400 };
  if (raw.length > MAX_PART_NUMBERS_PER_REQUEST)
    return { error: `At most ${MAX_PART_NUMBERS_PER_REQUEST} part numbers per request.`, code: "bad_parts", status: 400 };
  const partNumbers: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > partCount)
      return { error: `Part number out of range (1..${partCount}).`, code: "bad_parts", status: 400 };
    partNumbers.push(n);
  }
  return { partNumbers: [...new Set(partNumbers)] };
}

/** Sidecars that may ride alongside a master. Anything else is refused — an
 *  arbitrary filename here would be a write primitive into the transfer prefix. */
export const SIDECAR_PATTERN = /(\.(srt|vtt)|\.ref\.(mp4|mov|mxf)|\.genblaze\.json)$/i;

export function validateSidecarName(raw: unknown): Invalid | { filename: string } {
  const base = validateFilename(raw);
  if ("error" in base) return base;
  if (!SIDECAR_PATTERN.test(base.filename))
    return {
      error: "Only .srt/.vtt captions, .ref.* mezzanine, or .genblaze.json manifest sidecars are accepted.",
      code: "bad_sidecar",
      status: 400,
    };
  return base;
}
