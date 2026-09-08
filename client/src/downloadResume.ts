// Resume record for an in-progress download.
//
// A download is fetched as independent byte ranges, and planRanges() is
// deterministic — the same object always yields the same ranges — so resuming
// needs nothing more than remembering which ranges finished and reopening the
// same file. No hashing, no protocol: Range requests plus bookkeeping.
//
// The File System Access handle is stored alongside. Handles are
// structured-cloneable, so IndexedDB can hold one across sessions; the browser
// still gates re-use behind a permission prompt, which is why `usable()` must
// run from a user gesture.
import { DOWNLOADS, get as idbGet, store } from "./idb.js";

/** ⚠ Only ever written AFTER a successful writable.close(). A
 *  FileSystemWritableFileStream commits nothing until close, so a record saved
 *  mid-download would describe bytes the file never received. */
export interface DownloadResume {
  transferId: string;
  /** Identity guard. If the object's size changed it is not the same bytes, so
   *  the recorded ranges are meaningless and the download restarts. Transfer
   *  ids are per-upload, so id + size is a strong pair without an ETag. */
  size: number;
  filename: string;
  handle: FileSystemFileHandle;
  /** START offsets of completed ranges, matching planRanges(). */
  done: number[];
  updatedAt: number;
}

export const getDownloadResume = (transferId: string): Promise<DownloadResume | null> =>
  idbGet<DownloadResume>(DOWNLOADS, transferId);

export async function saveDownloadResume(r: DownloadResume): Promise<void> {
  (await store(DOWNLOADS, "readwrite")).put({ ...r, updatedAt: Date.now() });
}

export async function clearDownloadResume(transferId: string): Promise<void> {
  (await store(DOWNLOADS, "readwrite")).delete(transferId);
}

/** Can this handle still be written to? Re-granting permission needs user
 *  activation, so call this from the click handler and nowhere else. */
export async function usable(handle: any): Promise<boolean> {
  try {
    const opts = { mode: "readwrite" as const };
    if ((await handle.queryPermission?.(opts)) === "granted") return true;
    return (await handle.requestPermission?.(opts)) === "granted";
  } catch {
    return false;   // handle revoked, file deleted, or an engine without the API
  }
}
