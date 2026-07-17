import { uploadFile, type ServiceOptions } from "./uploader.js";
import { renderDelivery } from "./delivery.js";

const tid = new URLSearchParams(location.search).get("t");
const deliveryEl = document.querySelector<HTMLDivElement>("#delivery")!;
const senderEl = document.querySelector<HTMLDivElement>("#sender")!;

if (tid) {
  // ── recipient view ──
  senderEl.hidden = true;
  renderDelivery(tid, deliveryEl);
} else {
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
  const gb = (n: number) => (n / 1e9).toFixed(2);

  fileIn.onchange = () => {
    const f = fileIn.files?.[0];
    fname.textContent = f ? `${f.name} · ${gb(f.size)} GB` : "video or audio — click to choose";
    fileIn.closest(".pick")!.classList.toggle("has-file", !!f);
    sendBtn.disabled = !f;
  };
  capIn.onchange = () => {
    const f = capIn.files?.[0];
    capname.textContent = f ? f.name : ".srt or .vtt — rides along for caption QC";
    capIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };

  // "Transfer only" greys out and overrides the individual services.
  transferOnly.onchange = () => servicesEl.classList.toggle("off", transferOnly.checked);

  const currentOptions = (): ServiceOptions => {
    if (transferOnly.checked)
      return { qc_av: false, qc_captions: false, qc_ai: false, thumbnail: false, summarize: false };
    const val = (id: string) => $<HTMLInputElement>("#" + id).checked;
    return {
      qc_av: val("opt_qc_av"),
      qc_captions: val("opt_qc_captions"),
      qc_ai: val("opt_qc_ai"),
      thumbnail: val("opt_thumbnail"),
      summarize: val("opt_summarize"),
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
        { captions: capIn.files?.[0] ?? null, options },
        (p) => (logEl.textContent = `${p.phase}: ${gb(p.bytes)} / ${gb(p.total)} GB`),
      );

      const link = `${location.origin}/?t=${transferId}`;
      logEl.innerHTML =
        `uploaded ✓ — share: <a href="${link}">${link}</a><br><span id="pipe">waiting for the waystation…</span>`;
      const pipe = document.querySelector<HTMLSpanElement>("#pipe")!;

      // All services off: the gateway skips the pipeline during `complete`,
      // before we could subscribe — no stream to wait on, say so directly.
      if (!Object.values(options).some(Boolean)) {
        pipe.textContent = "transfer only — no waystation services";
        sendBtn.disabled = false;
        return;
      }

      const es = new EventSource(`/api/progress/${transferId}`);
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === "pipeline_skipped") { pipe.textContent = "transfer only — no waystation services"; es.close(); return; }
        pipe.textContent = `waystation: ${ev.type}${ev.step ? " · " + ev.step : ""}`;
        if (ev.type === "pipeline_complete") { pipe.textContent = "waystation ✓ — open the share link"; es.close(); }
      };
    } catch (err) {
      logEl.textContent = "error: " + (err as Error).message;
    }
    sendBtn.disabled = false;
  };
}
