// One IndexedDB opener for both resume stores.
//
// Uploads and downloads each keep a resume record, in the same database. They
// MUST share this module: `indexedDB.open(name, version)` throws VersionError
// when the requested version is lower than the stored one, so a second module
// opening "waystation" at version 1 would start failing the moment anything
// else bumped it — and the failure would land on the upload path, which has
// nothing to do with the change that caused it.
//
// Every store is created if-missing on upgrade, so opening at the current
// version is safe whether the database is new, at v1 with only uploads, or
// already current.
const DB = "waystation";
const VERSION = 2;

export const UPLOADS = "uploads";
export const DOWNLOADS = "downloads";

export function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(UPLOADS)) d.createObjectStore(UPLOADS, { keyPath: "fp" });
      if (!d.objectStoreNames.contains(DOWNLOADS)) d.createObjectStore(DOWNLOADS, { keyPath: "transferId" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await db()).transaction(name, mode).objectStore(name);
}

export const get = async <T>(name: string, key: IDBValidKey): Promise<T | null> => {
  const s = await store(name, "readonly");
  return new Promise((res) => {
    const r = s.get(key);
    r.onsuccess = () => res((r.result as T) ?? null);
    r.onerror = () => res(null);
  });
};
