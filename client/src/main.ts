import { createSession, FORCED_COMPUTE, GatewayError, gwEventSource, gwGet, recipientLink } from "./config.js";
import { appendUniqueFiles, fileIdentity } from "./fileQueue.js";
import { uploadFile, type ServiceOptions } from "./uploader.js";
import { renderDelivery } from "./delivery.js";

const tid = new URLSearchParams(location.search).get("t");
const deliveryEl = document.querySelector<HTMLDivElement>("#delivery")!;
const senderEl = document.querySelector<HTMLDivElement>("#sender")!;
const gateEl = document.querySelector<HTMLDivElement>("#gate")!;

/** Reveal the sender UI, or the access panel when the gateway wants a code.
 *  The recipient view never calls this — a delivery link must open without a
 *  sender session. */
async function openSender(): Promise<void> {
  let status: { authRequired?: boolean; hasSession?: boolean } = {};
  try {
    status = await gwGet("/session");
  } catch {
    // Gateway unreachable: show the sender UI and let the first real call
    // report the failure, rather than trapping the user behind a code box.
    senderEl.hidden = false;
    return;
  }
  if (!status.authRequired || status.hasSession) {
    senderEl.hidden = false;
    return;
  }

  gateEl.hidden = false;
  const input = document.querySelector<HTMLInputElement>("#accessCode")!;
  const go = document.querySelector<HTMLButtonElement>("#gateGo")!;
  const msg = document.querySelector<HTMLElement>("#gateMsg")!;
  const submit = async () => {
    const code = input.value.trim();
    if (!code) { msg.textContent = "Enter the access code from your invitation."; return; }
    go.disabled = true;
    msg.textContent = "Checking…";
    try {
      await createSession(code);
      // The code itself is never retained — the gateway set an HttpOnly cookie
      // this page cannot read, which is the whole point.
      input.value = "";
      gateEl.hidden = true;
      senderEl.hidden = false;
    } catch (e) {
      msg.textContent =
        e instanceof GatewayError ? e.message : "Could not reach the waystation.";
      go.disabled = false;
      input.select();
    }
  };
  go.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") void submit(); };
  input.focus();
}

if (tid) {
  // ── recipient view ── (bypasses the access panel entirely)
  senderEl.hidden = true;
  renderDelivery(tid, deliveryEl);
} else {
  void openSender();
  // ── sender view ──
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
  const fileIn = $<HTMLInputElement>("#file");
  const capIn = $<HTMLInputElement>("#capfile");
  const genIn = $<HTMLInputElement>("#genfile");
  const pickMaster = $("#pickMaster");
  const pickTitle = $("#pickTitle");
  const fname = $("#fname");
  const capname = $("#capname");
  const genname = $("#genname");
  const queueEl = $<HTMLUListElement>("#fileQueue");
  const queueNote = $("#queueNote");
  const sendBtn = $<HTMLButtonElement>("#send");
  const logEl = $("#log");
  const qcOptions = $("#qcOptions");
  const modeTransfer = $<HTMLButtonElement>("#modeTransfer");
  const modeQc = $<HTMLButtonElement>("#modeQc");
  const senderPanel = $("#senderPanel");
  const senderTag = $("#senderTag");
  const pickCaps = $("#pickCaps");
  const pickGen = $("#pickGen");
  const interpretive = $<HTMLInputElement>("#opt_ai_interpretive");
  const reviewBrief = $<HTMLTextAreaElement>("#review_brief");
  const reviewBriefRow = $("#reviewBriefRow");
  type SenderMode = "transfer" | "qc";
  let mode: SenderMode = "transfer";
  let queuedFiles: File[] = [];
  let sending = false;

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = n / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && value >= 1024; i += 1) {
      value /= 1024;
      unit = units[i];
    }
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
  };
  capIn.onchange = () => {
    const f = capIn.files?.[0];
    capname.textContent = f ? f.name : "SRT, VTT, SCC, MCC, or RCWT";
    capIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };
  genIn.onchange = () => {
    const f = genIn.files?.[0];
    genname.textContent = f ? f.name : ".json — the generation record; enables prompt-adherence QC";
    genIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };

  interpretive.onchange = () => { reviewBriefRow.hidden = !interpretive.checked; };
  reviewBriefRow.hidden = !interpretive.checked;

  // Keep the selected route visible. Hosted deployments may enforce one route;
  // disabling the control communicates that policy without hiding provenance.
  if (FORCED_COMPUTE) {
    const cloud = $<HTMLInputElement>("#opt_cloud");
    cloud.checked = FORCED_COMPUTE === "cloud";
    cloud.disabled = true;
    cloud.closest("label")?.setAttribute("title", `This deployment requires ${FORCED_COMPUTE} compute`);
  }

  const currentOptions = (selectedMode: SenderMode): ServiceOptions => {
    const profile = $<HTMLSelectElement>("#profile").value;
    const val = (id: string) => $<HTMLInputElement>("#" + id).checked;
    const compute = FORCED_COMPUTE || (val("opt_cloud") ? "cloud" : "local");
    if (selectedMode === "transfer")
      return { qc_av: false, qc_captions: false, qc_ai: false, qc_synthetic: false,
               ai_interpretive: false,
               thumbnail: false, summarize: false, review_brief: "", profile, compute };
    return {
      qc_av: val("opt_qc_av"),
      qc_captions: val("opt_qc_captions"),
      // Legacy AI QC remains API-compatible for old clients, but the sender
      // uses the consolidated explicit interpretive workflow exclusively.
      qc_ai: false,
      qc_synthetic: val("opt_qc_synthetic"),
      ai_interpretive: val("opt_ai_interpretive"),
      thumbnail: val("opt_thumbnail"),
      summarize: val("opt_summarize"),
      review_brief: interpretive.checked ? reviewBrief.value.trim().slice(0, 2000) : "",
      profile,
      compute,
    };
  };

  const serviceRequested = (options: ServiceOptions): boolean =>
    [options.qc_av, options.qc_captions, options.qc_synthetic,
      options.ai_interpretive, options.thumbnail, options.summarize].some(Boolean);

  const refreshSidecars = (): void => {
    const available = mode === "qc" && queuedFiles.length === 1 && !sending;
    capIn.disabled = !available;
    genIn.disabled = !available;
    pickCaps.classList.toggle("disabled", !available);
    pickGen.classList.toggle("disabled", !available);
    if (queuedFiles.length > 1 && (capIn.files?.length || genIn.files?.length)) {
      capIn.value = "";
      genIn.value = "";
      capname.textContent = "SRT, VTT, SCC, MCC, or RCWT";
      genname.textContent = ".json — the generation record; enables prompt-adherence QC";
      pickCaps.classList.remove("has-file");
      pickGen.classList.remove("has-file");
    }
  };

  const renderQueue = (): void => {
    queueEl.replaceChildren();
    queueEl.hidden = queuedFiles.length === 0;
    pickMaster.classList.toggle("has-file", queuedFiles.length > 0);
    for (const file of queuedFiles) {
      const item = document.createElement("li");
      const details = document.createElement("div");
      details.className = "queue-file";
      const name = document.createElement("strong");
      name.textContent = file.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(file.size);
      details.append(name, size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-file";
      remove.textContent = "×";
      remove.title = `Remove ${file.name}`;
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.disabled = sending;
      remove.onclick = () => {
        queuedFiles = queuedFiles.filter((candidate) => fileIdentity(candidate) !== fileIdentity(file));
        renderQueue();
      };
      item.append(details, remove);
      queueEl.append(item);
    }

    const count = queuedFiles.length;
    if (mode === "qc" && count > 1)
      queueNote.textContent = `${count} masters queued. Captions and manifests are available for single-master QC only.`;
    else if (count > 0)
      queueNote.textContent = `${count} ${count === 1 ? "file" : "files"} ready · ${formatBytes(queuedFiles.reduce((sum, file) => sum + file.size, 0))} total`;
    else
      queueNote.textContent = "";
    sendBtn.textContent = count > 1 ? `Send ${count} files` : "Send file";
    sendBtn.disabled = sending || count === 0;
    fileIn.disabled = sending;
    pickMaster.classList.toggle("disabled", sending);
    modeTransfer.disabled = sending;
    modeQc.disabled = sending;
    refreshSidecars();
  };

  const addFiles = (incoming: FileList | File[]): void => {
    if (sending) return;
    queuedFiles = appendUniqueFiles(queuedFiles, Array.from(incoming));
    fileIn.value = "";
    renderQueue();
  };

  fileIn.onchange = () => {
    if (fileIn.files) addFiles(fileIn.files);
  };
  pickMaster.addEventListener("dragenter", (event) => {
    event.preventDefault();
    if (!sending) pickMaster.classList.add("dragging");
  });
  pickMaster.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = sending ? "none" : "copy";
  });
  pickMaster.addEventListener("dragleave", (event) => {
    if (!pickMaster.contains(event.relatedTarget as Node | null)) pickMaster.classList.remove("dragging");
  });
  pickMaster.addEventListener("drop", (event) => {
    event.preventDefault();
    pickMaster.classList.remove("dragging");
    if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
  });

  const setMode = (next: SenderMode): void => {
    if (sending) return;
    mode = next;
    const transfer = next === "transfer";
    modeTransfer.setAttribute("aria-selected", String(transfer));
    modeQc.setAttribute("aria-selected", String(!transfer));
    senderPanel.setAttribute("aria-labelledby", transfer ? "modeTransfer" : "modeQc");
    qcOptions.hidden = transfer;
    senderTag.textContent = transfer
      ? "Send large files securely and share them."
      : "Send mastered media with deterministic and AI-assisted QC.";
    pickTitle.textContent = transfer ? "Choose or drop files" : "Choose or drop master files";
    fname.textContent = transfer
      ? "Select multiple files, add them one at a time, or drag them here"
      : "Select one or more video or audio masters, or drag them here";
    renderQueue();
  };
  modeTransfer.onclick = () => setMode("transfer");
  modeQc.onclick = () => setMode("qc");
  for (const tab of [modeTransfer, modeQc]) {
    tab.onkeydown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const target = mode === "transfer" ? modeQc : modeTransfer;
      setMode(mode === "transfer" ? "qc" : "transfer");
      target.focus();
    };
  }

  const resultRow = (file: File): { row: HTMLDivElement; status: HTMLSpanElement } => {
    const row = document.createElement("div");
    row.className = "batch-result";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "Queued";
    row.append(name, status);
    logEl.append(row);
    return { row, status };
  };

  sendBtn.onclick = async () => {
    if (!queuedFiles.length || sending) return;
    sending = true;
    const files = [...queuedFiles];
    const selectedMode = mode;
    const options = currentOptions(selectedMode); // snapshot — ignore toggles mid-batch
    const singleQcMaster = selectedMode === "qc" && files.length === 1;
    const captions = singleQcMaster ? capIn.files?.[0] ?? null : null;
    const genManifest = singleQcMaster ? genIn.files?.[0] ?? null : null;
    const failed: File[] = [];
    logEl.replaceChildren();
    renderQueue();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const { row, status } = resultRow(file);
      try {
        const { transferId } = await uploadFile(
          file,
          { captions, genManifest, options },
          (progress) => {
            status.textContent = `${progress.phase} · ${formatBytes(progress.bytes)} / ${formatBytes(progress.total)}`;
          },
        );

        const link = recipientLink(transferId);
        const share = document.createElement("a");
        share.href = link;
        share.textContent = "Open share link";
        share.target = "_blank";
        share.rel = "noopener";
        row.append(document.createElement("br"), share);

        if (!serviceRequested(options)) {
          status.textContent = "Uploaded · ready to share · no QC requested";
          continue;
        }

        status.textContent = "Uploaded · waiting for Waystation services";
        const es = gwEventSource(`/progress/${transferId}`);
        let where = "";
        es.onmessage = (event) => {
          const ev = JSON.parse(event.data);
          if (ev.type === "pipeline_skipped") {
            status.textContent = "Uploaded · services skipped by deployment policy";
            es.close();
            return;
          }
          if (ev.type === "pipeline_started" && ev.compute) {
            const fallback = ev.compute_request_honored === false
              ? ` (requested ${ev.requested_compute ?? "another worker"}; fallback)`
              : "";
            where = ` @ ${ev.compute}${fallback}`;
          }
          const stage = ev.stage ? " · " + String(ev.stage).replaceAll("_", " ") : "";
          status.textContent = `Waystation${where}: ${ev.type}${ev.step ? " · " + ev.step : ""}${stage}`;
          if (ev.type === "pipeline_complete") {
            status.textContent = `Waystation${where} complete · open the share link`;
            es.close();
          }
        };
      } catch (err) {
        failed.push(file);
        status.classList.add("bad");
        status.textContent = "Error · " + (err as Error).message;
      }
    }

    const summary = document.createElement("p");
    summary.className = "batch-summary";
    const sent = files.length - failed.length;
    summary.textContent = failed.length
      ? `${sent} sent · ${failed.length} ready to retry`
      : `${sent} ${sent === 1 ? "file" : "files"} sent`;
    logEl.append(summary);
    queuedFiles = failed;
    sending = false;
    renderQueue();
  };

  setMode("transfer");
}
