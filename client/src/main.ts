import { gwEventSource, recipientLink } from "./config.js";
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
  const genIn = $<HTMLInputElement>("#genfile");
  const genname = $("#genname");
  genIn.onchange = () => {
    const f = genIn.files?.[0];
    genname.textContent = f ? f.name : ".json — the generation record; enables prompt-adherence QC";
    genIn.closest(".pick")!.classList.toggle("has-file", !!f);
  };

  // "Transfer only" greys out and overrides the individual services.
  transferOnly.onchange = () => servicesEl.classList.toggle("off", transferOnly.checked);

  const currentOptions = (): ServiceOptions => {
    const profile = $<HTMLSelectElement>("#profile").value;
    const val = (id: string) => $<HTMLInputElement>("#" + id).checked;
    const compute = val("opt_cloud") ? "cloud" : "local";
    if (transferOnly.checked)
      return { qc_av: false, qc_captions: false, qc_ai: false, qc_synthetic: false,
               thumbnail: false, summarize: false, profile, compute };
    return {
      qc_av: val("opt_qc_av"),
      qc_captions: val("opt_qc_captions"),
      qc_ai: val("opt_qc_ai"),
      qc_synthetic: val("opt_qc_synthetic"),
      thumbnail: val("opt_thumbnail"),
      summarize: val("opt_summarize"),
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
                        options.qc_synthetic, options.thumbnail, options.summarize];
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
        if (ev.type === "pipeline_started" && ev.compute) where = ` @ ${ev.compute}`;
        pipe.textContent = `waystation${where}: ${ev.type}${ev.step ? " · " + ev.step : ""}`;
        if (ev.type === "pipeline_complete") { pipe.textContent = `waystation${where} ✓ — open the share link`; es.close(); }
      };
    } catch (err) {
      logEl.textContent = "error: " + (err as Error).message;
    }
    sendBtn.disabled = false;
  };
}
