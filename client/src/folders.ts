// Folder transfers, browser side: turning a picked or dropped directory into one
// queue item, and checking folder paths before they touch either the gateway or
// the recipient's disk.
//
// The path rules mirror gateway/src/folders.ts, which is authoritative. The
// sender checks them so a bad name is reported before anything uploads; the
// delivery page checks them again before it creates a single directory,
// because paths from the network must never be trusted to stay inside the
// folder the recipient chose.

export const MAX_FOLDER_DEPTH = 32;
const MAX_SEGMENT = 200;
const MAX_PATH = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Operating-system bookkeeping that is never part of what the sender meant to send. */
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
export const isJunk = (name: string): boolean => JUNK.has(name.toLowerCase());

/** Why a relative path is unsafe, or undefined when it is fine. */
export function pathProblem(path: string): string | undefined {
  if (!path || path.length > MAX_PATH || path.startsWith("/")) return "invalid path";
  const segments = path.split("/");
  if (segments.length > MAX_FOLDER_DEPTH) return `nested more than ${MAX_FOLDER_DEPTH} levels deep`;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes("..")) return "invalid path segment";
    if (seg.includes("\\") || CONTROL.test(seg)) return "illegal characters";
    if (seg.length > MAX_SEGMENT) return "a name is too long";
    if (seg !== seg.trim()) return "a name starts or ends with a space";
  }
  return undefined;
}

export interface FolderFile { file: File; path: string }

/** A whole directory in the send queue. It carries name/size/lastModified so the
 *  queue's identity and totals treat it like a file; `folderId` and `done` let a
 *  paused folder resume where it stopped instead of starting a new one. */
export interface FolderItem {
  kind: "folder";
  name: string;
  size: number;
  lastModified: number;
  files: FolderFile[];
  /** Files left out on purpose (empty files, OS bookkeeping), for the queue note. */
  skipped: number;
  folderId?: string;
  done: Set<string>;
}

export type QueueItem = File | FolderItem;
export const isFolder = (item: QueueItem): item is FolderItem => (item as FolderItem).kind === "folder";

/** Build folder items from (root-relative path, File) pairs, one per top-level
 *  directory. Throws with a readable message when a path cannot be sent. */
export function buildFolders(entries: { path: string; file: File }[]): FolderItem[] {
  const byRoot = new Map<string, FolderItem>();
  for (const { path, file } of entries) {
    const normalized = path.normalize("NFKC");
    const slash = normalized.indexOf("/");
    if (slash < 0) continue; // not inside a directory
    const root = normalized.slice(0, slash);
    const rel = normalized.slice(slash + 1);
    let item = byRoot.get(root);
    if (!item) {
      item = { kind: "folder", name: root, size: 0, lastModified: 0, files: [], skipped: 0, done: new Set() };
      byRoot.set(root, item);
    }
    const base = rel.split("/").pop() ?? rel;
    if (isJunk(base) || file.size === 0) { item.skipped += 1; continue; }
    const problem = pathProblem(rel) ?? pathProblem(root);
    if (problem) throw new Error(`“${root}/${rel}” can't be sent: ${problem}.`);
    item.files.push({ file, path: rel });
    item.size += file.size;
    item.lastModified = Math.max(item.lastModified, file.lastModified);
  }
  for (const item of byRoot.values()) {
    item.files.sort((a, b) => a.path.localeCompare(b.path));
    const seen = new Set<string>();
    for (const f of item.files) {
      const k = f.path.toLowerCase();
      if (seen.has(k)) throw new Error(`“${item.name}/${f.path}” appears twice (names are compared ignoring case).`);
      seen.add(k);
    }
  }
  return [...byRoot.values()].filter((f) => f.files.length > 0);
}

/** `<input webkitdirectory>` hands back Files whose webkitRelativePath starts
 *  with the chosen directory's name. */
export const foldersFromInput = (files: FileList): FolderItem[] =>
  buildFolders(Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name })));

/** A drop may mix directories and loose files. The DataTransfer is only readable
 *  during the event, so the entries are captured synchronously by the caller
 *  (webkitGetAsEntry) and walked here afterwards. */
export async function walkDropped(entries: FileSystemEntry[]): Promise<{ folders: FolderItem[]; files: File[] }> {
  const files: File[] = [];
  const nested: { path: string; file: File }[] = [];
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const readAll = async (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
    const reader = dir.createReader();
    const out: FileSystemEntry[] = [];
    // readEntries returns at most ~100 entries per call; keep reading until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) return out;
      out.push(...batch);
    }
  };
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) nested.push({ path: prefix + entry.name, file: await fileOf(entry as FileSystemFileEntry) });
    else if (entry.isDirectory)
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, `${prefix}${entry.name}/`);
  };
  for (const entry of entries) {
    if (entry.isFile) files.push(await fileOf(entry as FileSystemFileEntry));
    else await walk(entry, "");
  }
  return { folders: buildFolders(nested), files };
}
