// Local resume record (survives reloads). The server (ListParts) remains the
// source of truth; this just remembers the uploadId + key so we can re-attach.
export interface ResumeState {
  fp: string; key: string; uploadId: string;
  partSize: number; partCount: number;
  verificationMode: "range" | "root";
  done: Record<number, string>; // partNumber -> etag
}

import { UPLOADS, get as idbGet, store as idbStore } from "./idb.js";

const store = (mode: IDBTransactionMode) => idbStore(UPLOADS, mode);

export const getResume = (fp: string): Promise<ResumeState | null> =>
  idbGet<ResumeState>(UPLOADS, fp);
export async function saveResume(st: ResumeState): Promise<void> {
  (await store("readwrite")).put(st);
}
export async function markPart(fp: string, n: number, etag: string): Promise<void> {
  const st = await getResume(fp);
  if (!st) return;
  st.done[n] = etag;
  await saveResume(st);
}
export async function clearResume(fp: string): Promise<void> {
  (await store("readwrite")).delete(fp);
}
