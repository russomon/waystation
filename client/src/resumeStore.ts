// Local resume record (survives reloads). The server (ListParts) remains the
// source of truth; this just remembers the uploadId + key so we can re-attach.
export interface ResumeState {
  fp: string; key: string; uploadId: string;
  partSize: number; partCount: number;
  done: Record<number, string>; // partNumber -> etag
}

const DB = "orbitxfer", STORE = "uploads";
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "fp" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(mode: IDBTransactionMode) {
  return (await db()).transaction(STORE, mode).objectStore(STORE);
}

export async function getResume(fp: string): Promise<ResumeState | null> {
  const s = await store("readonly");
  return new Promise((res) => { const r = s.get(fp); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });
}
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
