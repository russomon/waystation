// Recipient delivery view: preview + AI summary + provenance, with a working
// "Verify provenance" button that re-hashes the assets (SHA-256, Web Crypto)
// and checks them against the manifest. Reached at /?t=<transferId>.

import { downloadVerified } from "./downloader.js";

interface Asset { key: string; url: string; mime: string; size: number; }
interface Transfer {
  transferId: string;
  original: Asset & { filename: string };
  blake3Root: string | null;
  outboardUrl: string | null;
  manifestUrl: string | null;
  derivatives: Asset[];
}

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const fmt = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : (n / 1e3).toFixed(0) + " KB";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function renderDelivery(id: string, root: HTMLElement) {
  root.hidden = false;
  root.textContent = "Loading transfer…";
  const res = await fetch(`/api/transfers/${id}`);
  if (!res.ok) { root.textContent = "Transfer not found or expired."; return; }
  const t: Transfer = await res.json();
  const manifest = t.manifestUrl ? await fetch(t.manifestUrl).then((r) => r.json()).catch(() => null) : null;
  const summary: string | undefined = manifest?.steps?.find((s: any) => s.step === "summarize")?.text;
  const thumb = t.derivatives.find((d) => d.mime === "image/jpeg");

  root.textContent = "";
  const card = el(`<div class="deliv"></div>`);
  if (thumb) card.append(el(`<img class="thumb" src="${thumb.url}" alt="preview" />`));
  const h2 = el(`<h2></h2>`);
  h2.textContent = t.original.filename;
  card.append(h2);
  card.append(el(`<p class="meta">${fmt(t.original.size)} · verified transfer</p>`));
  card.append(el(summary
    ? `<p class="summary"></p>`
    : `<p class="summary muted">No AI summary yet — add a GMI Cloud key to enable transcribe / summarize.</p>`));
  if (summary) (card.querySelector(".summary") as HTMLElement).textContent = summary;

  card.append(el(`<a class="btn" href="${t.original.url}" download="${t.original.filename}">Download original</a>`));

  // Verified download — pulls the object in ranges and checks each against the
  // bao outboard before accepting it. Only offered when the outboard exists.
  if (t.outboardUrl && t.blake3Root) {
    const vbtn = el(`<button class="btn ghost">Download (verified)</button>`) as HTMLButtonElement;
    vbtn.onclick = async () => {
      vbtn.disabled = true;
      try {
        const { blob, verified } = await downloadVerified(t.transferId, (d, tot) => {
          vbtn.textContent = `verifying ${Math.floor((d / tot) * 100)}%`;
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = t.original.filename;
        a.click();
        URL.revokeObjectURL(a.href);
        vbtn.textContent = verified ? "downloaded ✓ (verified)" : "downloaded (unverified)";
      } catch (e) {
        vbtn.textContent = "✗ " + (e as Error).message;
      }
      vbtn.disabled = false;
    };
    card.append(vbtn);
  }

  if (manifest) {
    const prov = el(`<details class="prov" open><summary>Provenance</summary></details>`);
    prov.append(el(`<p class="mono">original sha256: ${String(manifest.input.sha256).slice(0, 24)}…</p>`));
    const steps = (manifest.steps ?? [])
      .map((s: any) => "· " + s.step + (s.key ? " → " + s.key.split("/").pop() : ""))
      .join("<br>");
    prov.append(el(`<p class="mono">${steps || "· (no steps)"}</p>`));
    const btn = el(`<button class="btn ghost">Verify provenance</button>`) as HTMLButtonElement;
    const out = el(`<div class="verify"></div>`);
    btn.onclick = () => verify(t, manifest, out, btn);
    prov.append(btn, out);
    card.append(prov);
  }
  root.append(card);
}

async function verify(t: Transfer, manifest: any, out: HTMLElement, btn: HTMLButtonElement) {
  btn.disabled = true;
  out.textContent = "Re-hashing assets…";
  const urlByKey = new Map<string, string>([
    [t.original.key, t.original.url],
    ...t.derivatives.map((d) => [d.key, d.url] as [string, string]),
  ]);
  const items: { key: string; sha256: string; name: string }[] = [
    { key: manifest.input.key, sha256: manifest.input.sha256, name: "original" },
    ...(manifest.steps ?? []).filter((s: any) => s.key && s.sha256)
      .map((s: any) => ({ key: s.key, sha256: s.sha256, name: s.step })),
  ];
  const checks: { name: string; ok: boolean }[] = [];
  for (const it of items) {
    const url = urlByKey.get(it.key);
    try {
      if (!url) throw new Error("no url");
      const bytes = await fetch(url).then((r) => r.arrayBuffer());
      checks.push({ name: it.name, ok: (await sha256Hex(bytes)) === it.sha256 });
    } catch {
      checks.push({ name: it.name, ok: false });
    }
  }
  const allOk = checks.every((c) => c.ok);
  out.innerHTML =
    checks.map((c) => `<div class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${c.name}</div>`).join("") +
    `<div class="${allOk ? "ok" : "bad"}"><b>${allOk ? "✓ Provenance verified" : "✗ Verification failed"}</b></div>`;
  btn.disabled = false;
}
