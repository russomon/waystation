import { Check, Copy, Eye, EyeOff, createElement as createIcon } from "lucide";
import {
  createSession, endSession, FORCED_COMPUTE, GatewayError, gwEventSource, gwGet, recipientLink,
  paymentQuote, startCheckout, claimPaymentSession,
} from "./config.js";
import { copyText } from "./clipboard.js";
import { appendUniqueFiles, fileIdentity } from "./fileQueue.js";
import { formatBytes, formatUsd } from "./format.js";
import { uploadFile, type Progress, type ServiceOptions } from "./uploader.js";
import { renderDelivery } from "./delivery.js";
import { mountAdmin } from "./admin.js";

const tid = new URLSearchParams(location.search).get("t");
const deliveryEl = document.querySelector<HTMLDivElement>("#delivery")!;
const senderEl = document.querySelector<HTMLDivElement>("#sender")!;
const gateEl = document.querySelector<HTMLDivElement>("#gate")!;

/** Reveal the sender UI, or the access panel when the gateway wants a code.
 *  The recipient view never calls this — a delivery link must open without a
 *  sender session. */
async function openSender(): Promise<void> {
  let status: { authRequired?: boolean; hasSession?: boolean; admin?: boolean; who?: string; qc?: string } = {};
  try {
    status = await gwGet("/session");
  } catch {
    // Gateway unreachable: show the sender UI and let the first real call
    // report the failure, rather than trapping the user behind a code box.
    senderEl.hidden = false;
    revealSender(false, undefined, undefined, false);
    return;
  }
  // Payment authorizes the public: a visitor with no session is NOT sent to the
  // access-code gate — they see the sender and pay per transfer. A code or admin
  // session (or auth-disabled dev) is "comped" and uploads for free.
  const comped = !status.authRequired || status.hasSession === true;
  revealSender(status.admin === true, status.who, status.qc, comped);
}

/** Whether this viewer may start a QC upload. Resolved by the gateway per
 *  session (the admin stays live in preview), so it is re-read after login. */
let qcPreview = false;
const setQcPreview = (qc: unknown): void => {
  qcPreview = qc === "preview";
  document.dispatchEvent(new Event("qc-mode-changed"));
};

function revealSender(admin: boolean, who: string | undefined, qc: string | undefined, comped: boolean): void {
  gateEl.hidden = true;
  senderEl.hidden = false;
  setQcPreview(qc);
  const whoami = document.querySelector<HTMLElement>("#whoami")!;
  if (who) {
    document.querySelector<HTMLElement>("#whoLabel")!.textContent = who;
    whoami.hidden = false;
    document.querySelector<HTMLButtonElement>("#signOut")!.onclick = async () => {
      await endSession().catch(() => {});
      whoami.hidden = true;
      document.querySelector<HTMLDetailsElement>("#admin")!.hidden = true;
      void openSender();   // return to the public, pay-per-use sender — not the gate
    };
  } else {
    whoami.hidden = true;
  }
  if (admin) mountAdmin(document.querySelector<HTMLDetailsElement>("#admin")!);
  // Tell the sender-view logic whether this session uploads for free (comped) or
  // must pay per transfer. The listener is registered synchronously in the sender
  // block below; this fires after the awaited /session call, so it is caught.
  document.dispatchEvent(new CustomEvent("sender-auth", { detail: { comped } }));
}

/** The access panel. Also the landing place when a session is revoked
 *  mid-use, so it binds its own handlers every time it is shown. */
function showGate(message = ""): void {
  senderEl.hidden = true;
  gateEl.hidden = false;
  const input = document.querySelector<HTMLInputElement>("#accessCode")!;
  const go = document.querySelector<HTMLButtonElement>("#gateGo")!;
  const msg = document.querySelector<HTMLElement>("#gateMsg")!;
  msg.textContent = message;
  go.disabled = false;
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
      // Which panel to show depends on which code was accepted; ask rather
      // than assume, because the login response deliberately says nothing.
      const after = await gwGet("/session").catch(() => ({}));
      revealSender(after?.admin === true, after?.who, after?.qc, true);
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
  const recipientPassword = $<HTMLInputElement>("#recipientPassword");
  const togglePassword = $<HTMLButtonElement>("#togglePassword");
  // Pay-per-gig UI.
  const payPanel = $("#payPanel");
  const downloadsSelect = $<HTMLSelectElement>("#downloadsAllowed");
  const weeksSelect = $<HTMLSelectElement>("#weeksAllowed");
  const payTotal = $("#payTotal");
  const payCard = $<HTMLButtonElement>("#payCard");
  const payCrypto = $<HTMLButtonElement>("#payCrypto");
  const payMsg = $("#payMsg");
  const paidNote = $("#paidNote");
  const signInRow = $("#signInRow");
  const signInBtn = $<HTMLButtonElement>("#signIn");
  type SenderMode = "transfer" | "qc";
  let mode: SenderMode = "transfer";
  let queuedFiles: File[] = [];
  let sending = false;
  let comped = false;   // access-code / admin / dev session → uploads are free
  let paid = false;     // authorized to upload: comped, or a claimed paid order
  let quoteToken = 0;   // guards against out-of-order price responses
  let lastQuoteKey = ""; // skip re-quoting when nothing priced-relevant changed

  const icon = (node: any, label?: string): SVGElement => createIcon(node, {
    width: "18", height: "18", "stroke-width": "1.8",
    ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
  });

  const paintPasswordIcon = (): void => {
    togglePassword.replaceChildren(icon(recipientPassword.type === "password" ? Eye : EyeOff));
    togglePassword.title = recipientPassword.type === "password" ? "Show password" : "Hide password";
    togglePassword.setAttribute("aria-label", togglePassword.title);
  };
  togglePassword.onclick = () => {
    recipientPassword.type = recipientPassword.type === "password" ? "text" : "password";
    paintPasswordIcon();
    recipientPassword.focus();
  };
  paintPasswordIcon();

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
    const available = mode === "qc" && queuedFiles.length === 1 && !sending && !qcPreview;
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
    // While sending, the button is the pause control and must stay enabled.
    // A paused batch is not a fresh one. "Send file" after pausing reads as
    // "start over", which is exactly the doubt the pause button exists to remove.
    const resuming = queuedFiles.some((f) => pausedFiles.has(f));
    sendBtn.textContent = sending
      ? "Pause"
      : resuming
        ? "Resume send"
        : count > 1 ? `Send ${count} files` : "Send file";
    const previewLocked = mode === "qc" && qcPreview && !sending;
    if (previewLocked) queueNote.textContent = count
      ? "QC uploads aren't open yet. Switch to Transfer to send these files."
      : "QC uploads aren't open yet.";
    sendBtn.disabled = !sending && count === 0;
    if (previewLocked) sendBtn.disabled = true; // never while sending: previewLocked requires !sending
    fileIn.disabled = sending || previewLocked;
    pickMaster.classList.toggle("disabled", sending || previewLocked);
    modeTransfer.disabled = sending;
    modeQc.disabled = sending;
    recipientPassword.disabled = sending;
    togglePassword.disabled = sending;
    // Payment gate: an unpaid public sender cannot send until a payment clears.
    // "Payment required" replaces the label so the greyed-out reason is obvious.
    const paymentRequired = mode === "transfer" && !paid && !comped && !sending;
    if (paymentRequired) {
      sendBtn.disabled = true;
      if (count > 0) sendBtn.textContent = "Payment required";
    }
    downloadsSelect.disabled = sending;
    weeksSelect.disabled = sending;
    void updatePayPanel();
    refreshSidecars();
  };

  // ── payment (pay-per-gig) ──
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Price the queued batch for both gateways and render the pay panel. Shown only
   *  to an unpaid public sender in Transfer mode with files queued. Cheap to call
   *  from renderQueue: it re-quotes only when the total size or download count
   *  actually changed, and ignores a stale response a newer one superseded. */
  async function updatePayPanel(): Promise<void> {
    const totalBytes = queuedFiles.reduce((sum, f) => sum + f.size, 0);
    const show = mode === "transfer" && !paid && !comped && totalBytes > 0 && !sending;
    payPanel.hidden = !show;
    if (!show) { lastQuoteKey = ""; return; }
    const downloads = Number(downloadsSelect.value) || 2;
    const weeks = Number(weeksSelect.value) || 1;
    const key = `${totalBytes}:${downloads}:${weeks}`;
    if (key === lastQuoteKey) return;
    lastQuoteKey = key;
    const token = ++quoteToken;
    payCard.disabled = true;
    payCrypto.disabled = true;
    payTotal.textContent = "Calculating price…";
    try {
      const q = await paymentQuote(totalBytes, downloads, weeks);
      if (token !== quoteToken) return; // a newer request superseded this one
      const parts: string[] = [];
      if (q.stripe) parts.push(`Card ${formatUsd(q.stripe.amountCents)}`);
      if (q.coinbase) parts.push(`Crypto ${formatUsd(q.coinbase.amountCents)}`);
      payTotal.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = parts.join(" · ") || "Payment unavailable";
      payTotal.append(strong, document.createTextNode(
        ` — ${formatBytes(totalBytes)}, ${downloads} download${downloads === 1 ? "" : "s"}, ${weeks}-week link`));
      payCard.disabled = !q.stripe;
      payCrypto.disabled = !q.coinbase;
    } catch (e) {
      if (token !== quoteToken) return;
      lastQuoteKey = ""; // let the next call retry
      payTotal.textContent = e instanceof GatewayError ? e.message : "Could not fetch the price.";
    }
  }

  async function beginCheckout(gateway: "stripe" | "coinbase"): Promise<void> {
    const totalBytes = queuedFiles.reduce((sum, f) => sum + f.size, 0);
    if (!totalBytes) return;
    const downloads = Number(downloadsSelect.value) || 2;
    const weeks = Number(weeksSelect.value) || 1;
    payCard.disabled = true;
    payCrypto.disabled = true;
    payMsg.textContent = "Starting secure checkout…";
    try {
      const res = await startCheckout(gateway, totalBytes, downloads, weeks);
      // File objects do NOT survive the redirect. Remember what to re-select so
      // the return screen can name the exact files — a convenience, not a gate:
      // the gateway holds the upload to the paid byte budget regardless.
      try {
        sessionStorage.setItem(`ws_pay_${res.orderId}`, JSON.stringify({
          files: queuedFiles.map((f) => ({ name: f.name, size: f.size })),
          downloads, weeks, totalBytes,
        }));
      } catch { /* private windows block storage; the descriptor is optional */ }
      location.assign(res.url);
    } catch (e) {
      payMsg.textContent = e instanceof GatewayError ? e.message : "Could not start checkout. Please try again.";
      payCard.disabled = false;
      payCrypto.disabled = false;
    }
  }

  payCard.onclick = () => void beginCheckout("stripe");
  payCrypto.onclick = () => void beginCheckout("coinbase");
  downloadsSelect.onchange = () => void updatePayPanel();
  weeksSelect.onchange = () => void updatePayPanel();
  signInBtn.onclick = () => showGate();

  // Learn from revealSender whether this session pays or is comped, then repaint.
  document.addEventListener("sender-auth", (event) => {
    comped = (event as CustomEvent<{ comped: boolean }>).detail?.comped === true;
    paid = comped;                 // comped sessions are already authorized
    signInRow.hidden = comped;     // offer the code sign-in only to public senders
    renderQueue();
  });

  /** On return from a provider redirect (?order=…&paid=1 / &canceled=1): claim the
   *  paid order for an upload session, then ask the sender to re-select the files
   *  they paid for (File handles cannot cross a navigation). */
  async function handlePaymentReturn(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const orderId = params.get("order");
    if (!orderId) return;
    const returnedPaid = params.get("paid") === "1";
    const returnedCanceled = params.get("canceled") === "1";
    // Scrub the query so a refresh does not re-run this.
    const clean = new URL(location.href);
    clean.search = "";
    history.replaceState(null, "", clean.toString());

    if (returnedCanceled) {
      paidNote.hidden = false;
      paidNote.textContent = "Payment canceled. Choose a file and try again when you're ready.";
      return;
    }
    if (!returnedPaid) return;

    paidNote.hidden = false;
    paidNote.textContent = "Confirming your payment…";
    // The server does a direct provider lookup when its webhook hasn't landed yet;
    // a brief retry covers the gap on a slow confirmation.
    let session: Awaited<ReturnType<typeof claimPaymentSession>> | null = null;
    for (let attempt = 0; attempt < 4 && !session; attempt += 1) {
      try {
        session = await claimPaymentSession(orderId);
      } catch (e) {
        if (e instanceof GatewayError && e.status === 402) { await sleep(1500); continue; }
        paidNote.textContent = e instanceof GatewayError ? e.message : "We couldn't confirm the payment.";
        return;
      }
    }
    if (!session?.authorized) {
      paidNote.textContent = "Payment is still processing — refresh in a moment to continue your upload.";
      return;
    }

    paid = true;
    signInRow.hidden = true;
    payPanel.hidden = true;
    let expect: { files?: { name: string; size: number }[] } | null = null;
    try {
      const raw = sessionStorage.getItem(`ws_pay_${orderId}`);
      if (raw) expect = JSON.parse(raw);
    } catch { /* ignore */ }
    const names = expect?.files?.length
      ? " " + expect.files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(", ")
      : "";
    const plural = (expect?.files?.length ?? 1) === 1 ? "" : "s";
    paidNote.textContent =
      `✓ Payment received — this link allows ${session.downloads ?? 2} downloads. ` +
      `Re-select your file${plural} to start the upload:${names}`;
    renderQueue();
  }

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

  const qcPreviewNote = $("#qcPreviewNote");
  const setMode = (next: SenderMode): void => {
    if (sending) return;
    mode = next;
    const transfer = next === "transfer";
    modeTransfer.setAttribute("aria-selected", String(transfer));
    modeQc.setAttribute("aria-selected", String(!transfer));
    senderPanel.setAttribute("aria-labelledby", transfer ? "modeTransfer" : "modeQc");
    qcOptions.hidden = transfer;
    // Preview: the whole QC panel is on show and every control in it is off.
    // The gateway refuses a QC initiate from a client anyway; this is the
    // same rule made visible, so nobody discovers it by trying.
    const preview = !transfer && qcPreview;
    qcPreviewNote.hidden = !preview;
    qcOptions.classList.toggle("preview", preview);
    for (const el of qcOptions.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button"))
      el.disabled = preview;
    senderTag.textContent = transfer
      ? "Send large files securely and share them."
      : "Send mastered media with deterministic and AI-assisted QC.";
    pickTitle.textContent = transfer ? "Choose or drop files" : "Choose or drop master files";
    fname.textContent = transfer
      ? "Select multiple files, add them one at a time, or drag them here"
      : "Select one or more video or audio masters, or drag them here";
    renderQueue();
  };
  document.addEventListener("qc-mode-changed", () => setMode(mode));
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

  const resultRow = (file: File): {
    row: HTMLDivElement;
    status: HTMLSpanElement;
    updateProgress: (progress: Progress) => void;
  } => {
    const row = document.createElement("div");
    row.className = "batch-result";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "Queued";
    const tracks = document.createElement("div");
    tracks.className = "progress-tracks";
    const makeTrack = (label: string) => {
      const wrap = document.createElement("div");
      wrap.className = "progress-track";
      const head = document.createElement("div");
      head.className = "progress-head";
      const title = document.createElement("span");
      title.textContent = label;
      const value = document.createElement("span");
      head.append(title, value);
      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("span");
      bar.append(fill);
      wrap.append(head, bar);
      tracks.append(wrap);
      return { value, fill };
    };
    const integrity = makeTrack("Integrity check");
    const upload = makeTrack("Upload");
    const updateProgress = (progress: Progress) => {
      const hashPct = progress.total ? Math.min(100, (progress.hashBytes / progress.total) * 100) : 0;
      const uploadPct = progress.total ? Math.min(100, (progress.uploadedBytes / progress.total) * 100) : 0;
      integrity.fill.style.width = `${hashPct.toFixed(1)}%`;
      upload.fill.style.width = `${uploadPct.toFixed(1)}%`;
      integrity.value.textContent = progress.integrity === "complete"
        ? "Complete"
        : progress.integrity === "finalizing"
          ? "Finalizing verification data"
          : `${formatBytes(progress.hashBytes)} / ${formatBytes(progress.total)}`;
      upload.value.textContent = progress.upload === "complete"
        ? "Complete"
        : progress.upload === "connecting"
          ? "Connecting to Backblaze B2"
          : progress.upload === "finalizing"
            ? "Finalizing multipart upload"
            : `${formatBytes(progress.uploadedBytes)} / ${formatBytes(progress.total)}`;
      status.textContent = progress.message;
    };
    row.append(name, tracks, status);
    logEl.append(row);
    return { row, status, updateProgress };
  };

  const appendShareLink = (row: HTMLDivElement, link: string): void => {
    const wrap = document.createElement("div");
    wrap.className = "share-link";
    const anchor = document.createElement("a");
    anchor.href = link;
    anchor.textContent = link;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "icon-button";
    copyButton.title = "Copy share link";
    copyButton.setAttribute("aria-label", "Copy share link");
    copyButton.append(icon(Copy));
    const copied = document.createElement("span");
    copied.className = "copy-status";
    copied.setAttribute("aria-live", "polite");
    copyButton.onclick = async () => {
      try {
        await copyText(link);
        copyButton.replaceChildren(icon(Check));
        copied.textContent = "Copied to clipboard";
        window.setTimeout(() => {
          copyButton.replaceChildren(icon(Copy));
          copied.textContent = "";
        }, 2500);
      } catch {
        copied.textContent = "Could not copy. Select the link to copy it manually.";
      }
    };
    wrap.append(anchor, copyButton, copied);
    row.append(wrap);
  };

  // The send button becomes Pause while a batch runs, mirroring the delivery
  // page. Uploads were ALREADY resumable — resumeStore remembers the uploadId
  // and B2's ListParts is the source of truth for which parts landed — so the
  // only thing missing was a way to stop cleanly and come back.
  let sendAbort: AbortController | null = null;
  // Files a paused batch left behind, held by identity so that removing them
  // or queueing different ones returns the button to "Send file".
  let pausedFiles = new Set<File>();

  sendBtn.onclick = async () => {
    if (sendAbort) {                     // running → this click means "pause"
      sendBtn.disabled = true;
      sendBtn.textContent = "Pausing…";
      sendAbort.abort();
      return;
    }
    if (!queuedFiles.length || sending) return;
    sending = true;
    sendAbort = new AbortController();
    const files = [...queuedFiles];
    const selectedMode = mode;
    const options = currentOptions(selectedMode); // snapshot — ignore toggles mid-batch
    const singleQcMaster = selectedMode === "qc" && files.length === 1;
    const captions = singleQcMaster ? capIn.files?.[0] ?? null : null;
    const genManifest = singleQcMaster ? genIn.files?.[0] ?? null : null;
    const password = recipientPassword.value;
    const failed: File[] = [];
    const paused: File[] = [];
    logEl.replaceChildren();
    renderQueue();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const { row, status, updateProgress } = resultRow(file);
      try {
        const { transferId } = await uploadFile(
          file,
          { mode: selectedMode, captions, genManifest, options, recipientPassword: password },
          updateProgress,
          sendAbort.signal,
        );

        const link = recipientLink(transferId);
        appendShareLink(row, link);

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
        if (sendAbort?.signal.aborted) {
          // Paused, not failed. Parts already accepted by B2 stay accepted and
          // the next attempt re-attaches through ListParts, so this file and
          // every file after it go back on the queue untouched.
          paused.push(file, ...files.slice(index + 1));
          status.textContent = "Paused · click Send to resume from here";
          break;
        }
        failed.push(file);
        status.classList.add("bad");
        status.textContent = "Error · " + (err as Error).message;
        if (err instanceof GatewayError && err.code === "session_revoked") {
          // Nothing after this file can succeed either; keep it all queued
          // and send the user back to the access panel.
          failed.push(...files.slice(index + 1));
          showGate("This access code has been revoked.");
          break;
        }
      }
    }

    const summary = document.createElement("p");
    summary.className = "batch-summary";
    const sent = files.length - failed.length - paused.length;
    summary.textContent = paused.length
      ? `${sent} sent · ${paused.length} paused — click Send to resume`
      : failed.length
        ? `${sent} sent · ${failed.length} ready to retry`
        : `${sent} ${sent === 1 ? "file" : "files"} sent`;
    logEl.append(summary);
    queuedFiles = [...paused, ...failed];
    pausedFiles = new Set(paused);
    if (failed.length === 0 && paused.length === 0) {
      recipientPassword.value = "";
      recipientPassword.type = "password";
      paintPasswordIcon();
    }
    sending = false;
    sendAbort = null;
    sendBtn.disabled = false;
    renderQueue();
  };

  setMode("transfer");
  void handlePaymentReturn();
}
