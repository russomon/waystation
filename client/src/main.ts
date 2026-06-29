import { uploadFile } from "./uploader.js";
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
  const input = document.querySelector<HTMLInputElement>("#file")!;
  const logEl = document.querySelector<HTMLDivElement>("#log")!;
  const gb = (n: number) => (n / 1e9).toFixed(2);

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { transferId } = await uploadFile(file, (p) =>
        (logEl.textContent = `${p.phase}: ${gb(p.bytes)} / ${gb(p.total)} GB`));

      const link = `${location.origin}/?t=${transferId}`;
      logEl.innerHTML = `uploaded ✓ — share: <a href="${link}">${link}</a><br><span id="pipe">waiting for AI pipeline…</span>`;
      const pipe = document.querySelector<HTMLSpanElement>("#pipe")!;

      const es = new EventSource(`/api/progress/${transferId}`);
      es.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        pipe.textContent = `pipeline: ${ev.type}${ev.step ? " · " + ev.step : ""}`;
        if (ev.type === "pipeline_complete") { pipe.textContent = "pipeline ✓ — open the share link"; es.close(); }
      };
    } catch (err) {
      logEl.textContent = "error: " + (err as Error).message;
    }
  };
}
