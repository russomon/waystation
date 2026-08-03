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
const GiB = 1024 ** 3;

/** Hard ceiling checked BEFORE a multipart upload is initiated on B2, so an
 *  oversized claim never creates remote state or reserves any spend. */
export const MAX_UPLOAD_BYTES = num(env.MAX_UPLOAD_BYTES, 2 * GiB); // 2 GiB default
export const VERIFIED_RANGE_MAX_BYTES = num(env.VERIFIED_RANGE_MAX_BYTES, 16 * GiB);
export const MAX_QC_BYTES = num(env.MAX_QC_BYTES, 100 * GiB);
export const MAX_FILENAME_LENGTH = 200;
export const MAX_PART_NUMBERS_PER_REQUEST = 64;

export interface Invalid {
  error: string;
  code: string;
  /** 400 malformed · 403 refused by deployment policy · 413 over the size ceiling */
  status: 400 | 403 | 413;
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
export const SIDECAR_PATTERN = /(\.(srt|vtt|scc|mcc|rcwt)|\.ref\.(mp4|mov|mxf)|\.genblaze\.json)$/i;
const REFERENCE_SIDECAR = /\.ref\.(mp4|mov|mxf)$/i;

export function validateSidecarName(raw: unknown): Invalid | { filename: string } {
  const base = validateFilename(raw);
  if ("error" in base) return base;
  if (!SIDECAR_PATTERN.test(base.filename))
    return {
      error: "Only .srt/.vtt/.scc/.mcc/.rcwt captions, .ref.* mezzanine, or .genblaze.json manifest sidecars are accepted.",
      code: "bad_sidecar",
      status: 400,
    };
  // A .ref.* mezzanine is what switches on reference SSIM/PSNR/VMAF, by far the
  // most expensive lane (~1x content duration). Refusing the sidecar is how the
  // lane is disabled — a dispatch-boundary control that never touches QC code.
  if (!ALLOW_EXPENSIVE_REFERENCE_QC && REFERENCE_SIDECAR.test(base.filename))
    return {
      error: "Reference QC (SSIM/PSNR/VMAF) is disabled on this deployment.",
      code: "reference_qc_disabled",
      status: 403,
    };
  return base;
}

// ── cost controls ──
//
// Rate limiting is not a financial control: it bounds requests per minute, not
// spend. These are hard ceilings and switches, all enforced BEFORE any
// multipart upload is created or any pipeline is dispatched, and all entirely
// outside the QC engine. Post-probe reservation refinement and mid-pipeline
// reconciliation are deliberately NOT here — they would require gateway <->
// worker <-> pipeline coordination and would reach into submission-proven QC
// behavior. Those belong to the commercial track.
const flag = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === "" ? dflt : v === "true" || v === "1";

export const ALLOW_ROOT_ONLY_UPLOADS = flag(env.ALLOW_ROOT_ONLY_UPLOADS, false);
export type VerificationMode = "range" | "root";

/** Master kill switch: stop new financial exposure without taking the service
 *  down. Existing recipient links keep working. */
export const ACCEPT_UPLOADS = flag(env.WAYSTATION_ACCEPT_UPLOADS, true);
export const MAX_ACTIVE_UPLOADS_PER_SESSION = num(env.MAX_ACTIVE_UPLOADS_PER_SESSION, 3);
export const MAX_JOBS_PER_SESSION = num(env.MAX_JOBS_PER_SESSION, 20);
export const MAX_DAILY_JOBS = num(env.MAX_DAILY_JOBS, 200);

/** Service allowlist. A disabled service is forced off in the stored options,
 *  never merely hidden in the UI — the API is authoritative. */
export const ALLOW_AI_QC = flag(env.ALLOW_AI_QC, true);
export const ALLOW_SYNTHETIC_QC = flag(env.ALLOW_SYNTHETIC_QC, true);
// Defaults PERMISSIVE, like WAYSTATION_AUTH_MODE and the in-memory database:
// development and the proof suite must keep exercising the proven reference
// SSIM/PSNR/VMAF lane (netflix-qc-proof uploads a .ref mezzanine and asserts a
// VMAF/MOS result). The hosted deployment turns it OFF explicitly in
// docker-compose.prod.yml, where the cost actually matters.
export const ALLOW_EXPENSIVE_REFERENCE_QC = flag(env.ALLOW_EXPENSIVE_REFERENCE_QC, true);
// Dedicated Genblaze/GMI interpretive runs are paid and explicitly opt-in.
export const ALLOW_AI_INTERPRETIVE = flag(env.ALLOW_AI_INTERPRETIVE, false);

/** Lifetime of a recipient capability link, in days. 0 disables expiry.
 *  A bearer link that never expires can only be taken back by revocation. */
export const RECIPIENT_LINK_TTL_DAYS = Number(env.RECIPIENT_LINK_TTL_DAYS ?? 14);

/** Pin every job to one compute target. The hosted MVP is all-cloud — gateway
 *  and worker share a host — so there is no second machine to route to. The
 *  client also hides its selector, but hiding a control is not enforcement: a
 *  crafted request could still ask for the other target, so the API decides.
 *  Empty (the default) preserves the existing dual-worker routing untouched
 *  for post-hackathon use. */
export const FORCE_COMPUTE = (env.WAYSTATION_FORCE_COMPUTE || "").trim();

export const SERVICE_KEYS = ["qc_av", "qc_captions", "qc_ai", "thumbnail", "summarize"] as const;
export const OPT_IN_SERVICE_KEYS = ["qc_synthetic", "ai_interpretive"] as const;
export const PIPELINE_SERVICE_KEYS = [...SERVICE_KEYS, ...OPT_IN_SERVICE_KEYS] as const;

export function verificationModeForSize(size: number): Invalid | { verificationMode: VerificationMode } {
  if (size <= VERIFIED_RANGE_MAX_BYTES) return { verificationMode: "range" };
  if (ALLOW_ROOT_ONLY_UPLOADS) return { verificationMode: "root" };
  return {
    error:
      `Files above ${(VERIFIED_RANGE_MAX_BYTES / GiB).toFixed(1)} GiB require root-only large-file mode, ` +
      "which is disabled on this deployment.",
    code: "root_only_disabled",
    status: 413,
  };
}

export interface PolicyResult {
  options?: Record<string, boolean | string>;
  disabled: string[];
}

/** Force disallowed services off.
 *
 *  Subtlety that matters: by the existing contract, UNDEFINED options mean
 *  "every service on". So when a service is disallowed we must MATERIALIZE an
 *  options object carrying the explicit false — leaving it undefined would run
 *  the very service the operator switched off. When everything is permitted the
 *  value is passed through untouched, preserving the contract exactly. */
export function applyServicePolicy(options?: Record<string, boolean | string>, sizeBytes?: number): PolicyResult {
  const forced: Record<string, boolean | string> = {};
  if (!ALLOW_AI_QC) forced.qc_ai = false;
  if (!ALLOW_SYNTHETIC_QC) forced.qc_synthetic = false;
  if (!ALLOW_AI_INTERPRETIVE) forced.ai_interpretive = false;
  // The explicit interpretive workflow now contains the independent sweep,
  // adaptive evidence, critic, caption/speech and hybrid grounding formerly
  // reached through legacy AI QC. Never bill both lanes for the same transfer.
  if (ALLOW_AI_INTERPRETIVE && options?.ai_interpretive === true && options?.qc_ai === true)
    forced.qc_ai = false;
  if (FORCE_COMPUTE) forced.compute = FORCE_COMPUTE;
  if (sizeBytes !== undefined && sizeBytes > MAX_QC_BYTES) {
    for (const k of PIPELINE_SERVICE_KEYS) forced[k] = false;
  }
  if (!Object.keys(forced).length) return { options, disabled: [] };

  const merged = { ...(options ?? {}), ...forced };
  // Report only SERVICES the sender actually asked for and lost. `compute` is a
  // pinned routing target, not a disabled service — listing it here would emit
  // a misleading "services_disabled" event.
  const disabled = Object.keys(forced).filter(
    (k) => k !== "compute" && (k === "ai_interpretive" || k === "qc_synthetic"
      ? options?.[k] === true
      : options === undefined || options[k] !== false),
  );
  return { options: merged, disabled };
}

export const policyBanner = (): string =>
  `limits: uploads=${ACCEPT_UPLOADS ? "accepting" : "PAUSED"} ` +
  `max=${(MAX_UPLOAD_BYTES / GiB).toFixed(1)}GiB ` +
  `verifiedRangeMax=${(VERIFIED_RANGE_MAX_BYTES / GiB).toFixed(1)}GiB ` +
  `rootOnly=${ALLOW_ROOT_ONLY_UPLOADS} maxQC=${(MAX_QC_BYTES / GiB).toFixed(1)}GiB ` +
  `active/session=${MAX_ACTIVE_UPLOADS_PER_SESSION} jobs/session=${MAX_JOBS_PER_SESSION} ` +
  `jobs/day=${MAX_DAILY_JOBS} ai=${ALLOW_AI_QC} synthetic=${ALLOW_SYNTHETIC_QC} ` +
  `interpretive=${ALLOW_AI_INTERPRETIVE} ` +
  `referenceQC=${ALLOW_EXPENSIVE_REFERENCE_QC} ` +
  `linkTTL=${RECIPIENT_LINK_TTL_DAYS || "never"}d` +
  (FORCE_COMPUTE ? ` compute=PINNED:${FORCE_COMPUTE}` : "");
