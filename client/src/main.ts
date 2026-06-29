import { uploadFile } from "./uploader.js";

const input = document.querySelector<HTMLInputElement>("#file")!;
const logEl = document.querySelector<HTMLDivElement>("#log")!;
const log = (m: string) => { logEl.textContent = m; };
const gb = (n: number) => (n / 1e9).toFixed(2);

input.onchange = async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const { key, transferId } = await uploadFile(file, (p) =>
      log(`${p.phase}: ${gb(p.bytes)} / ${gb(p.total)} GB`));
    log(`uploaded ✓  ${key}\nwaiting for AI pipeline…`);

    // Live pipeline progress (B2 event → gateway → Genblaze → here).
    const es = new EventSource(`/api/progress/${transferId}`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      log(`${key}\npipeline: ${ev.type}${ev.step ? " · " + ev.step : ""}`);
      if (ev.type === "pipeline_complete") es.close();
    };
  } catch (err) {
    log("error: " + (err as Error).message);
  }
};
