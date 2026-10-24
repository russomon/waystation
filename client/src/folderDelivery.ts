// Recipient view of a FOLDER link: the folder up front with one "Download entire
// folder…" that rebuilds the tree on the recipient's disk (where the File System
// Access API allows writing into a directory), and the individual files behind a
// "Download individual files" disclosure, each saved straight from this page.
//
// Each file in the folder is an ordinary transfer, so every byte still moves
// through the same parallel, resumable, BLAKE3-verified path as a single-file
// download (saveToDisk in delivery.ts) — whether it is saved alone or as part of
// the folder. Browsers without a save dialog fall back to the plain mediated link.
//
// Paths come from the network. They are re-checked here (folders.ts pathProblem)
// before a single directory is created, so nothing can be written outside the
// folder the recipient picked.

import { GatewayError, gwGet } from "./config.js";
import { formatBytes } from "./format.js";
import { isJunk, pathProblem } from "./folders.js";
import { FOLDER_DOWNLOADS, get as idbGet, store } from "./idb.js";
import {
  clearDownloadResume, getDownloadResume, saveDownloadResume, usable, type DownloadResume,
} from "./downloadResume.js";
import { hms, isOutOfSpace, loadOutboard, saveToDisk, type Transfer } from "./delivery.js";

export interface FolderListing {
  kind: "folder";
  transferId: string;
  name: string;
  fileCount: number;
  totalBytes: number;
  downloadsAllowed: number | null;
  files: FolderFileEntry[];
}

type FolderFileEntry = { transferId: string; path: string; size: number; url: string; downloadsLeft: number | null };

/** Where a folder download is going and which files are already saved. Written
 *  only after a file's writable has closed, for the same reason as
 *  downloadResume.ts: nothing is on disk until close() commits it. */
interface FolderResume {
  folderId: string;
  /** The directory the recipient picked. */
  parent: FileSystemDirectoryHandle;
  /** The folder created inside it ("Name", "Name (2)"…), or "" when the picked
   *  directory was empty and the tree went straight into it. */
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

const leaf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const leftLabel = (n: number): string => `${n} download${n === 1 ? "" : "s"} left`;

// Chrome refuses to hand a site the whole of Desktop, Documents, Downloads or the
// home folder ("contains system files"), and always asks before a site may write
// into a folder. Neither dialog can be avoided, so say so before the click.
const FOLDER_HINT =
  "Your browser will ask where to save it. Choose or create a folder — Chrome doesn't allow " +
  "Desktop, Documents or Downloads themselves, only folders inside them — then click Allow " +
  "so the files can be written.";

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

/** True when the directory holds nothing but OS junk — typically a folder the
 *  recipient just made in the picker, which the tree can go straight into. */
async function isEmptyDir(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const name of (dir as any).keys() as AsyncIterable<string>) if (!isJunk(name)) return false;
  return true;
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
    "This browser can't save a whole folder at once. Open “Download individual files” below to " +
    "save them one by one, or open this link in Chrome or Edge to rebuild the folder in one step."));

  const files = document.createElement("details");
  files.className = "folder-files";
  const summary = document.createElement("summary");
  summary.textContent = "Download individual files";
  files.append(summary, tree(f, unsafe, files));
  card.append(files);
  root.append(card);
}

/** The file list, grouped under directory headings, with a download button per file. */
function tree(f: FolderListing, unsafe: Set<string>, details: HTMLDetailsElement): HTMLElement {
  const list = document.createElement("ul");
  list.className = "folder-tree";
  // Resume records for partly saved files, read once when the list first opens.
  // The save dialog must open with no await in front of it, so these have to be
  // in hand before the click.
  const priors = new Map<string, DownloadResume>();
  const onPrior = new Map<string, () => void>();
  details.addEventListener("toggle", () => {
    if (!details.open || onPrior.size === 0) return;
    const pending = [...onPrior];
    onPrior.clear();
    for (const [id, paint] of pending)
      getDownloadResume(id).then((r) => { if (r) { priors.set(id, r); paint(); } }).catch(() => {});
  });

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
    const left = text("span", "meta", file.downloadsLeft !== null ? ` · ${leftLabel(file.downloadsLeft)}` : "");
    const meta = text("span", "meta", formatBytes(file.size));
    meta.append(left);
    li.append(name, meta);
    if (unsafe.has(file.transferId)) {
      li.append(text("span", "meta bad", "name not allowed — skipped"));
    } else if (file.downloadsLeft === 0) {
      li.append(text("span", "meta", "limit reached"));
    } else {
      const used = () => {
        if (file.downloadsLeft === null) return;
        file.downloadsLeft = Math.max(0, file.downloadsLeft - 1);
        left.textContent = ` · ${leftLabel(file.downloadsLeft)}`;
      };
      if (typeof (window as any).showSaveFilePicker === "function") {
        onPrior.set(file.transferId, fileSaver(file, li, priors, used));
      } else {
        // No save dialog: the mediated link redirects to storage with an
        // attachment disposition, so the browser's own download starts at once.
        const a = document.createElement("a");
        a.className = "btn ghost small";
        a.href = file.url;
        a.download = leaf(file.path);
        a.textContent = "Download";
        a.onclick = used;
        li.append(a);
      }
    }
    list.append(li);
  }
  return list;
}

/** One file's Download button: a save dialog, then the verified, resumable
 *  download with its progress under the row. Returns the repaint to call once
 *  a resume record for this file turns up. */
function fileSaver(
  file: FolderFileEntry, li: HTMLElement, priors: Map<string, DownloadResume>, used: () => void,
): () => void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost small";
  btn.textContent = "Download";
  const prog = document.createElement("div");
  prog.className = "fileprog";
  prog.hidden = true;
  prog.innerHTML = `<div class="dlbar"><span></span></div><div class="dlrow"><span class="dlbytes"></span><span class="dlpct"></span></div>`;
  const bar = prog.querySelector(".dlbar span") as HTMLElement;
  const elBytes = prog.querySelector(".dlbytes") as HTMLElement;
  const elPct = prog.querySelector(".dlpct") as HTMLElement;
  li.append(btn, prog);

  let controller: AbortController | null = null;
  const resumeLabel = () => {
    if (!priors.has(file.transferId) || controller) return;
    btn.textContent = "Resume";
    prog.hidden = false;
    elBytes.textContent = "partly saved — click Resume to carry on";
    elPct.textContent = "";
  };

  btn.onclick = async () => {
    if (controller) {
      btn.disabled = true;
      btn.textContent = "Pausing…";
      controller.abort();
      return;
    }
    let handle: FileSystemFileHandle;
    let committed: number[] = [];
    const prior = priors.get(file.transferId);
    if (prior) {
      // No dialog on resume, so awaiting here is safe.
      if (!(prior.size === file.size && (await usable(prior.handle)))) {
        priors.delete(file.transferId);
        await clearDownloadResume(file.transferId).catch(() => {});
        btn.textContent = "Download";
        prog.hidden = false;
        elBytes.textContent = "couldn't reopen the partly saved file — click Download to start again";
        elPct.textContent = "";
        return;
      }
      handle = prior.handle;
      committed = [...prior.done];
    } else {
      try {
        // Directly from the click: a dialog opened after an await has lost the
        // user activation and the browser refuses it.
        handle = await (window as any).showSaveFilePicker({ suggestedName: leaf(file.path) });
      } catch {
        return; // cancelled
      }
    }
    const resuming = committed.length > 0;
    controller = new AbortController();
    const signal = controller.signal;
    btn.textContent = "Pause";
    prog.hidden = false;
    let painted = 0;
    const paint = (n: number, force = false) => {
      const t = performance.now();
      if (!force && t - painted < 250) return;
      painted = t;
      const pct = file.size ? n / file.size : 1;
      bar.style.width = `${(pct * 100).toFixed(1)}%`;
      elBytes.textContent = `${formatBytes(n)} of ${formatBytes(file.size)}`;
      elPct.textContent = `${(pct * 100).toFixed(1)}%`;
    };
    paint(0, true);
    const started = performance.now();
    let counted = resuming;   // a resume rides on the grant the first start took
    try {
      const how = await saveToHandle(file, handle, committed, signal, (n) => {
        if (!counted) { counted = true; used(); }
        paint(n);
      });
      if (!counted) used();
      priors.delete(file.transferId);
      paint(file.size, true);
      elBytes.textContent = `saved ✓ in ${hms((performance.now() - started) / 1000)}${how}`;
      elPct.textContent = "";
      btn.textContent = "Download again";
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "downloads_exhausted") {
        btn.remove();
        prog.hidden = true;
        li.append(text("span", "meta", "limit reached"));
        controller = null;
        return;
      }
      const r = await getDownloadResume(file.transferId).catch(() => null);
      if (r) priors.set(file.transferId, r);
      else priors.delete(file.transferId);
      const paused = signal.aborted;
      btn.textContent = priors.has(file.transferId) ? "Resume" : "Download";
      elPct.textContent = "";
      elBytes.textContent = isOutOfSpace(e)
        ? "the destination disk is full — free some space, then click Resume"
        : code === "recipient_password_required"
          ? "reload this page and enter the password again to carry on"
          : paused
            ? (priors.has(file.transferId) ? "paused — the file is INCOMPLETE until you resume" : "paused before anything was saved")
            : `stopped: ${(e as Error)?.message ?? "download failed"}`;
    }
    controller = null;
    btn.disabled = false;
  };
  return resumeLabel;
}

function folderDownloader(f: FolderListing, unsafe: Set<string>): HTMLElement {
  const wrap = document.createElement("div");
  const dl = document.createElement("button");
  dl.className = "btn";
  dl.textContent = "Download entire folder…";
  const hint = text("p", "meta folder-hint", FOLDER_HINT);
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
  wrap.append(dl, hint, prog);

  const wanted = f.files.filter((x) => !unsafe.has(x.transferId));
  const total = wanted.reduce((n, x) => n + x.size, 0);
  const sizeOf = new Map(wanted.map((x) => [x.transferId, x.size]));
  const resumeLabel = (got: number) =>
    `Resume entire folder download — ${formatBytes(got)} of ${formatBytes(total)} saved`;

  // Read BEFORE the click, as in delivery.ts: the directory picker must open
  // with no await in front of it or the browser refuses it.
  let prior: FolderResume | null = null;
  getFolderResume(f.transferId).then((r) => {
    prior = r;
    if (r?.done.length) dl.textContent = resumeLabel(r.done.reduce((n, id) => n + (sizeOf.get(id) ?? 0), 0));
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
        // Cancelled, or Chrome's "Allow this site to edit files?" was declined —
        // both arrive as AbortError, so the hint covers either.
        hint.textContent = `Nothing was saved. ${FOLDER_HINT}`;
        return;
      }
      hint.textContent = FOLDER_HINT;
      const dirName = (await isEmptyDir(parent).catch(() => false)) ? "" : await freshName(parent, f.name);
      state = { folderId: f.transferId, parent, dirName, done: [] };
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
      const top = state.dirName ? await childDir(state.parent, state.dirName, renamed) : state.parent;
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
      elTime.textContent = `saved to “${state.dirName || state.parent.name}” in ${hms((performance.now() - started) / 1000)}` +
        (notes ? ` · ${notes}` : "");
      return;
    }
    prior = state;
    const paused = (stopped as Error)?.name === "AbortError" || dl.textContent === "Pausing…";
    dl.textContent = resumeLabel(saved);
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

/** One file into its place in the tree, resuming a partial file only when the
 *  record describes THIS file on disk: a record left by saving the same file on
 *  its own, somewhere else, would otherwise mark ranges done that were never
 *  written here. */
async function saveOne(
  file: FolderFileEntry,
  top: FileSystemDirectoryHandle,
  renamed: string[],
  signal: AbortSignal,
  onBytes: (n: number) => void,
): Promise<void> {
  const segs = file.path.split("/");
  let dir = top;
  for (const seg of segs.slice(0, -1)) dir = await childDir(dir, seg, renamed);
  // getFileHandle(create) on an existing file opens it without truncating.
  const handle = await childFile(dir, segs[segs.length - 1], renamed);
  const prior = await getDownloadResume(file.transferId).catch(() => null);
  const same = !!prior && prior.size === file.size &&
    (await (prior.handle as any).isSameEntry(handle).catch(() => false));
  await saveToHandle(file, handle, same ? [...prior!.done] : [], signal, onBytes);
}

/** The verified, ranged download of one member into `handle`, skipping the
 *  ranges in `committed`. Same commit rule as delivery.ts: ranges are recorded
 *  only after close() has made them durable. Returns a note on verification. */
async function saveToHandle(
  file: FolderFileEntry,
  handle: FileSystemFileHandle,
  committed: number[],
  signal: AbortSignal,
  onBytes: (n: number) => void,
): Promise<string> {
  let t: Transfer;
  try {
    t = await gwGet(`/transfers/${file.transferId}`);
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new Error(`could not reach ${file.path}`);
  }
  const resuming = committed.length > 0;
  if (!resuming)
    await saveDownloadResume({
      transferId: file.transferId, size: t.original.size, filename: t.original.filename,
      handle, done: [], updatedAt: Date.now(),
    }).catch(() => {});

  let verify: { outboard: Uint8Array; root: string } | undefined;
  let note = "";
  if (t.outboardUrl && t.blake3Root) {
    const ob = await loadOutboard(t.outboardUrl);
    if ("outboard" in ob) verify = { outboard: ob.outboard, root: t.blake3Root };
    else note = ob.skip;
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
  return verify ? " · verified against BLAKE3" : note ? ` · not range-verified (${note})` : "";
}
