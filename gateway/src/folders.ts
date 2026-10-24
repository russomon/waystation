// Folder transfers: one link for a whole directory tree.
//
// A folder is a PARENT transfer row (kind = 'folder') with no storage object of
// its own. Every file in it is an ordinary member transfer, uploaded through the
// same multipart routes and stored under its own `transfers/<id>/` prefix, so
// verification, resume, mediated download and purge all work unchanged. The
// parent holds what the recipient link means: password, expiry, revocation and
// the per-file download allowance (ADR-042).
//
// Paths are the one genuinely new input, and they end up as directory names on
// the RECIPIENT's disk, so they are validated here once, strictly, and refused
// rather than rewritten. The delivery page re-checks them before it creates
// anything (client/src/folderPaths.ts) — defence in depth, not a substitute.
import { MAX_FILENAME_LENGTH, MAX_UPLOAD_BYTES, type Invalid } from "./limits.js";

const env = process.env as Record<string, string | undefined>;
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const MAX_FOLDER_FILES = num(env.MAX_FOLDER_FILES, 1000);
export const MAX_FOLDER_DEPTH = 32;
export const MAX_RELATIVE_PATH_LENGTH = 1024;
/** Whole-folder ceiling. Defaults to the single-file ceiling times the file cap,
 *  i.e. effectively bounded by the per-file limit and a paid order's budget. */
export const MAX_FOLDER_BYTES = num(env.MAX_FOLDER_BYTES, MAX_UPLOAD_BYTES * MAX_FOLDER_FILES);

const CONTROL = /[\u0000-\u001f\u007f]/;

/** One path segment: the same rules as a single file's name (limits.ts
 *  validateFilename), plus no `.`/`..`/empty segment. */
function segmentError(seg: string): string | undefined {
  if (!seg) return "empty path segment";
  if (seg === "." || seg === "..") return "relative path segment";
  if (seg.includes("..")) return "illegal characters";
  if (seg.includes("\\") || CONTROL.test(seg)) return "illegal characters";
  if (seg.length > MAX_FILENAME_LENGTH) return "segment too long";
  if (seg !== seg.trim()) return "leading or trailing whitespace";
  return undefined;
}

/** A path relative to the folder root, `/`-separated, e.g. `Reel 1/audio/mix.wav`.
 *  NFKC-normalized first, as validateFilename does, so visually identical Unicode
 *  cannot smuggle a different byte sequence past the checks. */
export function validateRelativePath(raw: unknown): Invalid | { path: string; segments: string[] } {
  if (typeof raw !== "string" || !raw.trim())
    return { error: "A file path is required.", code: "bad_path", status: 400 };
  const path = raw.normalize("NFKC");
  if (path.length > MAX_RELATIVE_PATH_LENGTH)
    return { error: `File path exceeds ${MAX_RELATIVE_PATH_LENGTH} characters.`, code: "bad_path", status: 400 };
  if (path.startsWith("/"))
    return { error: "File paths must be relative to the folder.", code: "bad_path", status: 400 };
  const segments = path.split("/");
  if (segments.length > MAX_FOLDER_DEPTH)
    return { error: `Folders may be nested at most ${MAX_FOLDER_DEPTH} levels deep.`, code: "bad_path", status: 400 };
  for (const seg of segments) {
    const why = segmentError(seg);
    if (why) return { error: `File path “${path.slice(0, 120)}” is not allowed (${why}).`, code: "bad_path", status: 400 };
  }
  return { path, segments };
}

/** The folder's own name — a single segment. */
export function validateFolderName(raw: unknown): Invalid | { name: string } {
  if (typeof raw !== "string" || !raw.trim())
    return { error: "A folder name is required.", code: "bad_folder_name", status: 400 };
  const name = raw.normalize("NFKC").trim();
  const why = name.includes("/") ? "illegal characters" : segmentError(name);
  if (why) return { error: `Folder name is not allowed (${why}).`, code: "bad_folder_name", status: 400 };
  return { name };
}

export interface FolderEntry { path: string; size: number }

/** Validate the whole manifest the sender declares up front. Duplicates are
 *  compared case-insensitively because the recipient's disk may be (macOS and
 *  Windows defaults are), and two declared files would then collide. A file and
 *  a directory may not share a path either. */
export function validateFolderManifest(raw: unknown):
  Invalid | { files: FolderEntry[]; totalBytes: number } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "A folder must contain at least one file.", code: "empty_folder", status: 400 };
  if (raw.length > MAX_FOLDER_FILES)
    return { error: `A folder may contain at most ${MAX_FOLDER_FILES} files.`, code: "too_many_files", status: 413 };
  const files: FolderEntry[] = [];
  const seen = new Set<string>();
  const dirs = new Set<string>();
  let totalBytes = 0;
  for (const item of raw) {
    const p = validateRelativePath((item as { path?: unknown })?.path);
    if ("error" in p) return p;
    const size = Number((item as { size?: unknown })?.size);
    if (!Number.isInteger(size) || size <= 0)
      return { error: `“${p.path.slice(0, 120)}” needs a positive size; empty files cannot be sent.`, code: "bad_size", status: 400 };
    if (size > MAX_UPLOAD_BYTES)
      return {
        error: `“${p.path.slice(0, 120)}” is larger than the ${(MAX_UPLOAD_BYTES / 1024 ** 3).toFixed(1)} GiB limit for this deployment.`,
        code: "too_large", status: 413,
      };
    const key = p.path.toLowerCase();
    if (seen.has(key) || dirs.has(key))
      return { error: `“${p.path.slice(0, 120)}” appears twice (names are compared ignoring case).`, code: "duplicate_path", status: 400 };
    seen.add(key);
    for (let i = 1; i < p.segments.length; i++) dirs.add(p.segments.slice(0, i).join("/").toLowerCase());
    totalBytes += size;
    files.push({ path: p.path, size });
  }
  for (const d of dirs)
    if (seen.has(d))
      return { error: `“${d.slice(0, 120)}” is both a file and a folder.`, code: "duplicate_path", status: 400 };
  if (totalBytes > MAX_FOLDER_BYTES)
    return { error: "That folder is larger than this deployment allows.", code: "too_large", status: 413 };
  return { files, totalBytes };
}
