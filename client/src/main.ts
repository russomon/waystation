import { createSession, FORCED_COMPUTE, GatewayError, gwEventSource, gwGet, recipientLink } from "./config.js";
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
  const fname = $("#fname");
  const capname = $("#capname");
  const sendBtn = $<HTMLButtonElement>("#send");
  const logEl = $("#log");
  const servicesEl = $("#services");
  const transferOnly = $<HTMLInputElement>("#transferOnly");
  const interpretive = $<HTMLInputElement>("#opt_ai_interpretive");
  const reviewBrief = $<HTMLTextAreaElement>("#review_brief");
  const reviewBriefRow = $("#reviewBriefRow");
  const gb = (n: number) => (n / 1e9).toFixed(2);

  fileIn.onchange = () => {
    const f = fileIn.files?.[0];
    fname.textContent = f ? `${f.name} · ${gb(f.size)} GB` : "video or audio — click to choose";
    fileIn.closest(".pick")!.classList.toggle("has-file", !!f);
    sendBtn.disabled = !f;
  };
  capIn.onchange = () => {
    const f = capIn.files?.[0];
    capname.textContent = f ? f.name : "SRT, VTT, SCC, MCC, or RCWT";
    capIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };
  const genIn = $<HTMLInputElement>("#genfile");
  const genname = $("#genname");
  genIn.onchange = () => {
    const f = genIn.files?.[0];
    genname.textContent = f ? f.name : ".json — the generation record; enables prompt-adherence QC";
    genIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };

  // "Transfer only" greys out and overrides the individual services.
  transferOnly.onchange = () => servicesEl.classList.toggle("off", transferOnly.checked);
  interpretive.onchange = () => { reviewBriefRow.hidden = !interpretive.checked; };

  // All-cloud deployments pin the compute target and hide the selector: the
  // gateway and worker share one host, so there is no second machine to route
  // to and a visible toggle would imply a choice that does not exist. The
  // gateway enforces this independently — hiding a control is never the
  // enforcement.
  if (FORCED_COMPUTE) {
    const row = $<HTMLInputElement>("#opt_cloud").closest("label");
    if (row) (row as HTMLElement).hidden = true;
  }

  const currentOptions = (): ServiceOptions => {
    const profile = $<HTMLSelectElement>("#profile").value;
    const val = (id: string) => $<HTMLInputElement>("#" + id).checked;
    const compute = FORCED_COMPUTE || (val("opt_cloud") ? "cloud" : "local");
    if (transferOnly.checked)
      return { qc_av: false, qc_captions: false, qc_ai: false, qc_synthetic: false,
               ai_interpretive: false,
               thumbnail: false, summarize: false, review_brief: "", profile, compute };
    return {
      qc_av: val("opt_qc_av"),
      qc_captions: val("opt_qc_captions"),
      qc_ai: val("opt_qc_ai"),
      qc_synthetic: val("opt_qc_synthetic"),
      ai_interpretive: val("opt_ai_interpretive"),
      thumbnail: val("opt_thumbnail"),
      summarize: val("opt_summarize"),
      review_brief: interpretive.checked ? reviewBrief.value.trim().slice(0, 2000) : "",
      profile,
      compute,
    };
  };

  sendBtn.onclick = async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    sendBtn.disabled = true;
    try {
      const options = currentOptions(); // snapshot — ignore toggles mid-upload
      const { transferId } = await uploadFile(
        file,
        { captions: capIn.files?.[0] ?? null, genManifest: genIn.files?.[0] ?? null, options },
        (p) => (logEl.textContent = `${p.phase}: ${gb(p.bytes)} / ${gb(p.total)} GB`),
      );

      // Built from the current URL so the deployed subpath (/waystation/) is
      // preserved — location.origin alone yields a dead link when hosted there.
      const link = recipientLink(transferId);
      logEl.innerHTML =
        `uploaded ✓ — share: <a href="${link}">${link}</a><br><span id="pipe">waiting for the waystation…</span>`;
      const pipe = document.querySelector<HTMLSpanElement>("#pipe")!;

      // All services off: the gateway skips the pipeline during `complete`,
      // before we could subscribe — no stream to wait on, say so directly.
      // (Only the service booleans count — `profile` is a string, always truthy.)
      const services = [options.qc_av, options.qc_captions, options.qc_ai,
                        options.qc_synthetic, options.ai_interpretive,
                        options.thumbnail, options.summarize];
      if (!services.some(Boolean)) {
        pipe.textContent = "transfer only — no waystation services";
        sendBtn.disabled = false;
        return;
      }

      const es = gwEventSource(`/progress/${transferId}`);
      let where = "";  // compute label from pipeline_started ("local", "cloud-docker", …)
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === "pipeline_skipped") { pipe.textContent = "transfer only — no waystation services"; es.close(); return; }
        if (ev.type === "pipeline_started" && ev.compute) {
          const fallback = ev.compute_request_honored === false
            ? ` (requested ${ev.requested_compute ?? "another worker"}; fallback)`
            : "";
          where = ` @ ${ev.compute}${fallback}`;
        }
        const stage = ev.stage ? " · " + String(ev.stage).replaceAll("_", " ") : "";
        pipe.textContent = `waystation${where}: ${ev.type}${ev.step ? " · " + ev.step : ""}${stage}`;
        if (ev.type === "pipeline_complete") { pipe.textContent = `waystation${where} ✓ — open the share link`; es.close(); }
      };
    } catch (err) {
      logEl.textContent = "error: " + (err as Error).message;
    }
    sendBtn.disabled = false;
  };
}
