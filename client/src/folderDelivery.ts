// Recipient view of a FOLDER link: the whole tree up front, a download button on
// every file, and — where the File System Access API allows writing into a
// directory — one "Download folder…" that rebuilds the tree on the recipient's
// disk.
//
// Each file in the folder is an ordinary transfer, so every byte still moves
// through the same parallel, resumable, BLAKE3-verified path as a single-file
// download (saveToDisk in delivery.ts). A single file's button simply opens that
// file's own page, which the folder's unlock already covers.
//
// Paths come from the network. They are re-checked here (folders.ts pathProblem)
// before a single directory is created, so nothing can be written outside the
// folder the recipient picked.

import { GatewayError, gwGet } from "./config.js";
import { formatBytes } from "./format.js";
import { pathProblem } from "./folders.js";
import { FOLDER_DOWNLOADS, get as idbGet, store } from "./idb.js";
import {
  clearDownloadResume, getDownloadResume, saveDownloadResume, usable,
} from "./downloadResume.js";
import { hms, isOutOfSpace, loadOutboard, saveToDisk, type Transfer } from "./delivery.js";

export interface FolderListing {
  kind: "folder";
  transferId: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  downloadsAllowed: number | null;
  files: { transferId: string; path: string; size: number; url: string; downloadsLeft: number | null }[];
}

/** Where a folder download is going and which files are already saved. Written
 *  only after a file's writable has closed, for the same reason as
 *  downloadResume.ts: nothing is on disk until close() commits it. */
interface FolderResume {
  folderId: string;
  /** The directory the recipient picked; the folder itself is created inside it. */
  parent: FileSystemDirectoryHandle;
  /** The name actually used for the folder (may be "Name (2)"). */
  dirName: string;
  done: string[];
}

const getFolderResume = (id: string) => idbGet<FolderResume>(FOLDER_DOWNLOADS, id);
const saveFolderResume = async (r: FolderResume) => (await store(FOLDER_DOWNLOADS, "readwrite")).put(r);
const clearFolderResume = async (id: string) => (await store(FOLDER_DOWNLOADS, "readwrite")).delete(id);

const text = (tag: string, cls: string, content = ""): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = content;
  return n;
};

/** Characters Windows (and some other file systems) refuse in a name. Used only
 *  when the browser has already rejected the name as given. */
const osSafe = (name: string): string =>
  name.replace(/[<>:"|?*\\]/g, "_").replace(/[. ]+$/, (m) => "_".repeat(m.length)) || "_";

async function childDir(dir: FileSystemDirectoryHandle, name: string, renamed: string[]): Promise<FileSystemDirectoryHandle> {
  try {
    return await dir.getDirectoryHandle(name, { create: true });
  } catch (e) {
    if ((e as Error).name !== "TypeError") throw e;
    renamed.push(name);
    return dir.getDirectoryHandle(osSafe(name), { create: true });
  }
}

async function childFile(dir: FileSystemDirectoryHandle, name: string, renamed: string[]): Promise<FileSystemFileHandle> {
  try {
    return await dir.getFileHandle(name, { create: true });
  } catch (e) {
    if ((e as Error).name !== "TypeError") throw e;
    renamed.push(name);
    return dir.getFileHandle(osSafe(name), { create: true });
  }
}

/** "Name", or "Name (2)", "Name (3)"… — never write into a folder that was
 *  already there, which could silently mix two deliveries. */
async function freshName(parent: FileSystemDirectoryHandle, name: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    try {
      await parent.getDirectoryHandle(candidate);
    } catch {
      return candidate; // NotFoundError: free to use
    }
  }
  throw new Error("Could not find a free folder name in that location.");
}

export function renderFolder(f: FolderListing, root: HTMLElement): void {
  root.textContent = "";
  const card = document.createElement("div");
  card.className = "deliv folder-deliv";
  card.append(
    text("h1", "", `📁 ${f.name}`),
    text("p", "meta", `${f.fileCount} file${f.fileCount === 1 ? "" : "s"} · ${formatBytes(f.totalBytes)}` +
      (f.downloadsAllowed !== null ? ` · each file can be downloaded ${f.downloadsAllowed} times` : "")),
  );

  // Paths that fail the client-side check are shown but never written.
  const unsafe = new Set(f.files.filter((x) => pathProblem(x.path)).map((x) => x.transferId));

  const canWriteFolders = typeof (window as any).showDirectoryPicker === "function";
  if (canWriteFolders) card.append(folderDownloader(f, unsafe));
  else card.append(text("p", "meta",
    "This browser can't save a whole folder at once. Download the files one by one below, " +
    "or open this link in Chrome or Edge to rebuild the folder in one step."));

  card.append(tree(f, unsafe));
  root.append(card);
}

/** The file list, grouped under directory headings, with a download link per file. */
function tree(f: FolderListing, unsafe: Set<string>): HTMLElement {
  const list = document.createElement("ul");
  list.className = "folder-tree";
  let lastDirs: string[] = [];
  for (const file of f.files) {
    const segs = file.path.split("/");
    const dirs = segs.slice(0, -1);
    // Headings for each directory level that differs from the previous file's.
    let common = 0;
    while (common < dirs.length && common < lastDirs.length && dirs[common] === lastDirs[common]) common++;
    for (let d = common; d < dirs.length; d++) {
      const li = text("li", "folder-dir", `📁 ${dirs[d]}`);
      li.style.paddingLeft = `${d * 1.1}rem`;
      list.append(li);
    }
    lastDirs = dirs;

    const li = document.createElement("li");
    li.className = "folder-file";
    li.style.paddingLeft = `${dirs.length * 1.1}rem`;
    const name = text("span", "folder-name", segs[segs.length - 1]);
    name.title = file.path;
    const meta = text("span", "meta", formatBytes(file.size) +
      (file.downloadsLeft !== null ? ` · ${file.downloadsLeft} download${file.downloadsLeft === 1 ? "" : "s"} left` : ""));
    li.append(name, meta);
    if (unsafe.has(file.transferId)) {
      li.append(text("span", "meta bad", "name not allowed — skipped"));
    } else if (file.downloadsLeft === 0) {
      li.append(text("span", "meta", "limit reached"));
    } else {
      // The file's own page: verified, resumable, and a save dialog where the
      // browser has one; the plain mediated link otherwise.
      const a = document.createElement("a");
      a.className = "btn ghost small";
      a.href = `?t=${encodeURIComponent(file.transferId)}`;
      a.textContent = "Download";
      li.append(a);
    }
    list.append(li);
  }
  return list;
}

function folderDownloader(f: FolderListing, unsafe: Set<string>): HTMLElement {
  const wrap = document.createElement("div");
  const dl = document.createElement("button");
  dl.className = "btn";
  dl.textContent = "Download folder…";
  const prog = document.createElement("div");
  prog.className = "dlprog";
  prog.hidden = true;
  prog.innerHTML = `<div class="dlbar"><span></span></div>
    <div class="dlrow"><span class="dlbytes"></span><span class="dlrate"></span></div>
    <div class="dlrow"><span class="dltime"></span><span class="dlpct"></span></div>`;
  const bar = prog.querySelector(".dlbar span") as HTMLElement;
  const elBytes = prog.querySelector(".dlbytes") as HTMLElement;
  const elRate = prog.querySelector(".dlrate") as HTMLElement;
  const elTime = prog.querySelector(".dltime") as HTMLElement;
  const elPct = prog.querySelector(".dlpct") as HTMLElement;
  wrap.append(dl, prog);

  const wanted = f.files.filter((x) => !unsafe.has(x.transferId));
  const total = wanted.reduce((n, x) => n + x.size, 0);
  const sizeOf = new Map(wanted.map((x) => [x.transferId, x.size]));

  // Read BEFORE the click, as in delivery.ts: the directory picker must open
  // with no await in front of it or the browser refuses it.
  let prior: FolderResume | null = null;
  getFolderResume(f.transferId).then((r) => {
    prior = r;
    if (r?.done.length) {
      const got = r.done.reduce((n, id) => n + (sizeOf.get(id) ?? 0), 0);
      dl.textContent = `Resume folder download — ${formatBytes(got)} of ${formatBytes(total)} saved`;
    }
  }).catch(() => {});

  let controller: AbortController | null = null;

  dl.onclick = async () => {
    if (controller) {
      dl.disabled = true;
      dl.textContent = "Pausing…";
      controller.abort();
      return;
    }
    let state: FolderResume;
    if (prior && (await usable(prior.parent))) {
      state = prior;
    } else {
      let parent: FileSystemDirectoryHandle;
      try {
        parent = await (window as any).showDirectoryPicker({ mode: "readwrite", id: "orbistation-folder" });
      } catch {
        return; // cancelled
      }
      state = { folderId: f.transferId, parent, dirName: await freshName(parent, f.name), done: [] };
      for (const x of wanted) await clearDownloadResume(x.transferId).catch(() => {});
      await saveFolderResume(state).catch(() => {});
    }
    controller = new AbortController();
    const signal = controller.signal;
    dl.textContent = "Pause";
    prog.hidden = false;

    const renamed: string[] = [];
    const failures: string[] = [];
    const started = performance.now();
    let saved = state.done.reduce((n, id) => n + (sizeOf.get(id) ?? 0), 0);
    const startBytes = saved;
    let current = 0;
    let painted = 0;
    const paint = (force = false) => {
      const t = performance.now();
      if (!force && t - painted < 250) return;   // ≤4 fps, as in delivery.ts
      painted = t;
      const now = saved + current;
      const pct = total ? now / total : 1;
      bar.style.width = `${(pct * 100).toFixed(1)}%`;
      elBytes.textContent = `${formatBytes(now)} of ${formatBytes(total)} · ${formatBytes(Math.max(0, total - now))} left`;
      elPct.textContent = `${(pct * 100).toFixed(1)}%`;
      const secs = (t - started) / 1000;
      const rate = secs > 1 ? (now - startBytes) / secs : 0;
      elRate.textContent = rate > 0 ? `${formatBytes(rate)}/s` : "";
    };
    let stopped: unknown = null;
    try {
      const top = await childDir(state.parent, state.dirName, renamed);
      for (const [i, file] of wanted.entries()) {
        if (state.done.includes(file.transferId)) continue;
        if (file.downloadsLeft === 0) { failures.push(`${file.path} (download limit reached)`); continue; }
        elTime.textContent = `file ${i + 1} of ${wanted.length} · ${file.path}`;
        current = 0;
        paint(true);
        try {
          await saveOne(file, top, renamed, signal, (n) => { current = n; paint(); });
        } catch (e) {
          if (signal.aborted) throw e;
          if ((e as { code?: string })?.code === "downloads_exhausted") {
            failures.push(`${file.path} (download limit reached)`);
            continue;
          }
          throw e;
        }
        saved += file.size;
        current = 0;
        state.done.push(file.transferId);
        await saveFolderResume(state).catch(() => {});
        paint(true);
      }
    } catch (e) {
      stopped = e;
    }
    controller = null;
    dl.disabled = false;
    elRate.textContent = "";
    const notes = [
      renamed.length ? `${renamed.length} name${renamed.length === 1 ? " was" : "s were"} changed to suit this computer` : "",
      failures.length ? `not saved: ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "…" : ""}` : "",
    ].filter(Boolean).join(" · ");
    if (!stopped) {
      await clearFolderResume(f.transferId).catch(() => {});
      prior = null;
      dl.textContent = failures.length ? "Saved, with gaps" : "saved ✓";
      elTime.textContent = `saved to “${state.dirName}” in ${hms((performance.now() - started) / 1000)}` +
        (notes ? ` · ${notes}` : "");
      return;
    }
    prior = state;
    const paused = (stopped as Error)?.name === "AbortError" || dl.textContent === "Pausing…";
    dl.textContent = `Resume folder download — ${formatBytes(saved)} of ${formatBytes(total)} saved`;
    elTime.textContent = isOutOfSpace(stopped)
      ? "the destination disk is full — free some space, then click Resume"
      : (stopped as { code?: string })?.code === "recipient_password_required"
        ? "reload this page and enter the password again to resume"
        : paused
          ? "paused — the folder is INCOMPLETE until you resume"
          : `stopped: ${(stopped as Error)?.message ?? "download failed"} — click Resume to carry on`;
    if (notes) elTime.textContent += ` · ${notes}`;
  };
  return wrap;
}

/** One file into its place in the tree, resuming a partial file when there is
 *  a record of one. Same commit rule as delivery.ts: record ranges only after
 *  close() has made them durable. */
async function saveOne(
  file: FolderListing["files"][number],
  top: FileSystemDirectoryHandle,
  renamed: string[],
  signal: AbortSignal,
  onBytes: (n: number) => void,
): Promise<void> {
  let t: Transfer;
  try {
    t = await gwGet(`/transfers/${file.transferId}`);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new Error(`could not reach ${file.path}`);
  }
  const segs = file.path.split("/");
  let dir = top;
  for (const seg of segs.slice(0, -1)) dir = await childDir(dir, seg, renamed);

  const prior = await getDownloadResume(file.transferId).catch(() => null);
  const resuming = !!prior && prior.size === t.original.size;
  // Re-derived from the folder every time rather than taken from the record:
  // the directory's permission is what the recipient re-granted on Resume.
  // getFileHandle(create) on an existing file opens it without truncating.
  const handle = await childFile(dir, segs[segs.length - 1], renamed);
  const committed: number[] = resuming ? [...prior!.done] : [];
  if (!resuming)
    await saveDownloadResume({
      transferId: file.transferId, size: t.original.size, filename: t.original.filename,
      handle, done: [], updatedAt: Date.now(),
    }).catch(() => {});

  let verify: { outboard: Uint8Array; root: string } | undefined;
  if (t.outboardUrl && t.blake3Root) {
    const ob = await loadOutboard(t.outboardUrl);
    if ("outboard" in ob) verify = { outboard: ob.outboard, root: t.blake3Root };
  }
  const writable: any = await (handle as any).createWritable({ keepExistingData: resuming });
  try {
    await saveToDisk(t.original.url, t.original.size, writable, onBytes,
      { skip: new Set(committed), completed: committed }, signal, verify);
    await writable.close();
    await clearDownloadResume(file.transferId).catch(() => {});
  } catch (e) {
    let durable = false;
    try {
      if (committed.length) { await writable.close(); durable = true; }
      else await writable.abort();
    } catch { durable = false; }
    if (durable)
      await saveDownloadResume({
        transferId: file.transferId, size: t.original.size, filename: t.original.filename,
        handle, done: committed, updatedAt: Date.now(),
      }).catch(() => {});
    else await clearDownloadResume(file.transferId).catch(() => {});
    throw e;
  }
}
