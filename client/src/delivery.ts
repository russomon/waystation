// Recipient delivery view: preview + AI summary + provenance, with a working
// "Verify provenance" button that re-hashes the assets (SHA-256, Web Crypto)
// and checks them against the manifest. Reached at /?t=<transferId>.

import { gwGet } from "./config.js";
import { downloadVerified } from "./downloader.js";

interface Asset { key: string; url: string; mime: string; size: number; }
interface Transfer {
  transferId: string;
  original: Asset & { filename: string };
  blake3Root: string | null;
  verificationMode?: "range" | "root";
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

/** Duration as m:ss, or h:mm:ss past an hour. A 26 GB download runs for tens of
 *  minutes, so "1847s" is not a useful thing to show a person. */
const hms = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function renderDelivery(id: string, root: HTMLElement) {
  root.hidden = false;
  root.textContent = "Loading transfer…";
  let t: Transfer;
  try {
    t = await gwGet(`/transfers/${id}`);
  } catch {
    // Neutral response for missing, expired, or revoked capabilities — the
    // recipient link is a bearer capability and must not distinguish them.
    root.textContent = "Transfer not found or expired.";
    return;
  }
  const manifest = t.manifestUrl ? await fetch(t.manifestUrl).then((r) => r.json()).catch(() => null) : null;
  // Genblaze manifest (genblaze-core): run.steps[], assets with s3:// urls.
  const gbSteps: any[] = manifest?.run?.steps ?? [];
  const summary: string | undefined = gbSteps.find((s) => s.step_id === "summarize")?.metadata?.summary;
  const keyOf = (url: string) => url.replace(/^s3:\/\/[^/]+\//, "");
  const thumb = t.derivatives.find((d) => d.mime === "image/jpeg");
  const qcAsset = t.derivatives.find((d) => d.key.endsWith("qc_report.json"));
  const qc = qcAsset ? await fetch(qcAsset.url).then((r) => r.json()).catch(() => null) : null;

  root.textContent = "";
  const card = el(`<div class="deliv"></div>`);
  if (thumb) card.append(el(`<img class="thumb" src="${thumb.url}" alt="preview" />`));
  const h2 = el(`<h2></h2>`);
  h2.textContent = t.original.filename;
  card.append(h2);
  const verificationLabel = t.verificationMode === "root"
    ? "large transfer · BLAKE3 root recorded · verified-range unavailable"
    : "verified-range transfer";
  card.append(el(`<p class="meta">${fmt(t.original.size)} · ${verificationLabel}</p>`));
  card.append(el(summary
    ? `<p class="summary"></p>`
    : `<p class="summary muted">No AI summary — the sender didn't order one for this delivery.</p>`));
  if (summary) (card.querySelector(".summary") as HTMLElement).textContent = summary;

  // QC badge — canonical delivery disposition is deterministic-only. AI lane
  // observations are rendered separately and never counted as BLOCKERs.
  if (qc) {
    const cls = qc.status === "pass" ? "ok" : qc.status === "warn" ? "warnc" : "bad";
    const label = qc.status === "pass" ? "✓ QC passed" : qc.status === "warn" ? "⚠ QC warnings" : "✗ QC failed";
    const profileTag = qc.profile_label ? ` · ${qc.profile_label}` : "";
    const badge = el(`<details class="prov"><summary><span class="${cls}">${label}</span><span class="meta">${profileTag}</span></summary></details>`);
    const tiers = qc.tiers ?? {};
    if (tiers.BLOCKER || tiers.ISSUE || tiers.FYI) {
      const chips = el(`<p></p>`);
      for (const [tier, chipClass] of [["BLOCKER", "bad"], ["ISSUE", "warnc"], ["FYI", "mutedc"]]) {
        const count = Number(tiers[tier] ?? 0);
        if (!count) continue;
        const chip = el(`<span class="chip ${chipClass}"></span>`);
        chip.textContent = `${count} ${tier}`;
        chips.append(chip);
      }
      badge.append(chips);
    }
    const advisoryTiers = qc.advisory_tiers ?? {};
    if (advisoryTiers.ISSUE || advisoryTiers.FYI) {
      const advisory = el(`<p class="meta"></p>`);
      advisory.textContent = `AI advisory: ${Number(advisoryTiers.ISSUE ?? 0)} review · ${Number(advisoryTiers.FYI ?? 0)} FYI · no delivery authority`;
      badge.append(advisory);
    }
    const glyph = (s: string) => s === "pass" ? "✓" : s === "warn" ? "⚠" : s === "info" ? "ⓘ" : "✗";
    const addSection = (title: string, lines: string[]) => {
      if (!lines.length) return;
      const section = el(`<section class="qc-section"><h3></h3><p class="mono qc-lines"></p></section>`);
      (section.querySelector("h3") as HTMLElement).textContent = title;
      (section.querySelector("p") as HTMLElement).textContent = lines.join("\n");
      badge.append(section);
    };

    const coverage = qc.coverage;
    if (coverage) {
      addSection("Coverage accounting", [
        `${coverage.accounting_complete ? "COMPLETE" : "INCOMPLETE"}: ${coverage.assessed_risks}/${coverage.applicable_risks} applicable risks assessed; ${coverage.unresolved_risks} disclosed for review`,
        `Model dispositions: ${coverage.model_disposition_complete ? "complete" : "validator filled omitted risks"}`,
      ]);
    }
    const deterministic = (qc.deterministic?.checks ?? (qc.checks ?? []).filter((c: any) => c.source === "deterministic"));
    addSection("Deterministic instruments", deterministic.map((c: any) =>
      `${glyph(c.status)} ${c.tier ? `[${c.tier}] ` : ""}${c.name}${c.detail ? " - " + c.detail : ""}`));

    const triage = qc.ai_triage;
    if (triage) {
      const reasons = (triage.reasons ?? []).slice(0, 4).map((r: string) => `reason: ${r}`);
      addSection("Cost-aware AI triage", [
        `${String(triage.status ?? "unknown").toUpperCase()} · AI QC ${triage.run_ai_qc ? "run" : "skipped"} · Synthetic QC ${triage.run_synthetic_qc ? "run" : "skipped"} · Typography ${triage.run_typography ? "run" : "skipped"} · Critic ${triage.run_critic ? "run" : "skipped"}`,
        `synthetic likelihood: ${triage.synthetic_likelihood ?? "unknown"} · visible text: ${String(triage.visible_text ?? "unknown")}`,
        `priority timecodes: ${(triage.priority_timecodes ?? []).map((t: number) => `${Number(t).toFixed(2)}s`).join(", ") || "none"}`,
        ...reasons,
      ]);
    }

    const passes = qc.agentic?.passes ?? {};
    const finalPass = passes.critic?.status === "complete" ? passes.critic
      : passes.informed?.status === "complete" ? passes.informed : passes.independent;
    const findings = finalPass?.findings ?? [];
    const agentLines = findings.map((f: any) => {
      const times = (f.timecodes ?? []).map((t: number) => `${Number(t).toFixed(2)}s`).join(", ");
      return `${f.severity.toUpperCase()} [${f.confidence}] ${f.title}${times ? ` @ ${times}` : ""} - ${f.description}`;
    });
    if (!agentLines.length && qc.agentic)
      agentLines.push(`No reportable finding in sampled evidence. ${passes.critic?.summary ?? ""}`.trim());
    addSection("Agentic observations", agentLines);

    addSection("Residual human review", (qc.residual_human_review ?? []).map((r: any) =>
      `${r.status} ${r.label} - ${r.reason}`));

    const synthetic = qc.synthetic;
    if (synthetic) {
      const plan = synthetic.plan;
      const assertions = (plan?.assertions ?? []) as any[];
      const planLines = assertions.slice(0, 18).map((a: any) =>
        `${a.assertion_id} [${a.risk_id}] ${a.requirement} · ${a.evidence_strategy}`);
      if (assertions.length > 18) planLines.push(`… ${assertions.length - 18} additional assertion(s)`);
      if (planLines.length) {
        planLines.unshift(`${plan.version} · ${assertions.length} atomic assertion(s) · prompt ${plan.generation_prompt_available ? "available" : "redacted/unavailable"}`);
      }
      addSection("Generated-media QC blueprint", planLines);

      const generatedCoverage = synthetic.coverage;
      if (generatedCoverage) {
        const riskLines = (generatedCoverage.risks ?? []).map((r: any) =>
          `${r.status} ${r.label}`);
        riskLines.unshift(
          `${generatedCoverage.accounting_complete ? "COMPLETE" : "INCOMPLETE"}: ${generatedCoverage.assessed_risks}/${generatedCoverage.total_risks} dimensions assessed; ${generatedCoverage.suspected_risks} suspected`,
        );
        addSection("Generated-media coverage", riskLines);
      }

      const generatedFindings = (synthetic.findings ?? []).map((f: any) => {
        const evidence = (f.evidence_ids ?? []).join(", ");
        return `ISSUE [${f.confidence ?? "medium"}] ${f.risk_id}${evidence ? ` · ${evidence}` : ""} - ${f.detail}`;
      });
      if (!generatedFindings.length && synthetic.sampling)
        generatedFindings.push("No issue observed in sampled evidence; this is not full-timeline clearance.");
      addSection("Generated-media findings", generatedFindings);

      const sampling = synthetic.sampling;
      if (sampling) {
        addSection("Generated-media sampling audit", [
          `${sampling.coarse_frames ?? 0} coarse frame(s) · ${sampling.fine_frames ?? 0} jittered verification frame(s) · ${sampling.native_text_crops ?? 0} native text crop(s)`,
          `Candidate timecodes: ${(sampling.candidate_timecodes ?? []).map((t: number) => `${Number(t).toFixed(2)}s`).join(", ") || "none"}`,
          `Stable concerns: ${(sampling.stable_risks ?? []).join(", ") || "none"} · full-timeline clearance: no`,
        ]);
      }

      // AI Reliability Passport — raw dimensions only, never a composite
      // score. Reproducibility (blind jury) + proficiency (blind planted
      // defects, cited only on an EXACT configuration match).
      const typo = synthetic.typography;
      const passportLines: string[] = [];
      for (const f of (typo?.findings ?? []) as any[]) {
        const j = f.jury;
        if (!j) continue;
        passportLines.push(
          `${f.finding_id}: reproducibility ${String(j.verdict ?? "?").toUpperCase()}` +
          (j.juror_model ? ` · juror ${j.juror_model} (${j.juror_relation})` : " · no juror configured") +
          (j.review_priority === "raised" ? " · review priority RAISED" : ""));
      }
      const prof = typo?.proficiency;
      if (prof) {
        const cite = prof.citation ?? {};
        if (cite.state === "EXACT" && prof.primary) {
          const p = prof.primary;
          const w = p.sensitivity_wilson95 ?? [];
          passportLines.push(
            `Proficiency (EXACT config match): ${p.caught}/${p.n_plants} planted defects caught` +
            (w.length === 2 ? ` · Wilson95 [${w[0]}, ${w[1]}]` : "") +
            ` · clean-twin specificity ${p.true_negatives}/${p.n_twins}` +
            (p.provisional ? ` · PROVISIONAL · n=${p.n_plants}` : ""));
          passportLines.push(
            `Proficiency record: suite ${String(prof.suite_sha256 ?? "").slice(0, 12)}… · ${prof.execution_date ?? ""} · WORM-locked`);
        } else {
          const why = cite.reason ??
            (cite.mismatched_keys?.length ? `configuration drift: ${cite.mismatched_keys.join(", ")}` : "no record");
          passportLines.push(`Proficiency: UNCALIBRATED — ${why}`);
        }
      }
      addSection("AI reliability passport", passportLines);

      // Deterministic downstream handoff packets (no model involved) — a
      // machine-readable pointer set a human or later system can act on.
      const packets = synthetic.handoff_packets ?? [];
      if (packets.length) {
        const packetBtn = el(`<a class="btn ghost">Download handoff packets (${packets.length})</a>`) as HTMLAnchorElement;
        packetBtn.href = URL.createObjectURL(
          new Blob([JSON.stringify(packets, null, 2)], { type: "application/json" }));
        packetBtn.download = "handoff-packets.json";
        badge.append(packetBtn);
      }
    }

    const support = (qc.checks ?? []).filter((c: any) => c.source !== "deterministic" && c.source !== "agentic_ai");
    addSection("AI support checks", support.map((c: any) =>
      `${glyph(c.status)} ${c.tier ? `[${c.tier}] ` : ""}${c.name}${c.detail ? " - " + c.detail : ""}`));
    card.append(badge);
  }

  // ── Download original ────────────────────────────────────────────────────
  // The plain <a download> is the FALLBACK, not the primary path. Two reasons
  // it is not enough on its own:
  //   * `download` is specified to apply only to same-origin URLs. B2 is a
  //     different origin, so browsers ignore it and just navigate — and a
  //     `video/*` content type then opens the media player and buffers the
  //     object instead of saving it. The gateway now signs the original with a
  //     Content-Disposition override, which is what makes this fallback save.
  //   * Even then the browser picks the destination; it only prompts if the
  //     user has "ask where to save each file" enabled.
  //
  // Where the File System Access API exists we can do better: ask the user
  // where to put it, then pipe the response body straight into that file.
  // Nothing is buffered — bytes go network → disk, so a 26 GiB master costs
  // no more memory than a small one.
  const canPick = typeof (window as any).showSaveFilePicker === "function";
  if (canPick) {
    const dl = el(`<button class="btn">Download original…</button>`) as HTMLButtonElement;
    const prog = el(`<div class="dlprog" hidden>
      <div class="dlbar"><span></span></div>
      <div class="dlrow"><span class="dlbytes"></span><span class="dlrate"></span></div>
      <div class="dlrow"><span class="dltime"></span><span class="dlpct"></span></div>
    </div>`);
    const bar = prog.querySelector(".dlbar span") as HTMLElement;
    const elBytes = prog.querySelector(".dlbytes") as HTMLElement;
    const elRate = prog.querySelector(".dlrate") as HTMLElement;
    const elTime = prog.querySelector(".dltime") as HTMLElement;
    const elPct = prog.querySelector(".dlpct") as HTMLElement;

    dl.onclick = async () => {
      let handle: any;
      try {
        // Must be called directly from the click — a picker opened after an
        // await has lost the user activation and the browser refuses it.
        handle = await (window as any).showSaveFilePicker({ suggestedName: t.original.filename });
      } catch {
        return; // user cancelled the dialog — not an error
      }
      dl.disabled = true;
      dl.textContent = "Downloading…";
      prog.hidden = false;
      let writable: any;
      const total = t.original.size;
      const started = performance.now();
      let done = 0;
      // Rolling window over the last few seconds. An ETA computed from the
      // average-since-start reacts far too slowly to a rate change; one
      // computed from the last chunk is unreadably jittery. A short window is
      // the compromise that makes "remaining" worth showing at all.
      const window_: { t: number; b: number }[] = [{ t: started, b: 0 }];
      let painted = 0;

      const paint = (force = false) => {
        const now = performance.now();
        if (!force && now - painted < 250) return;   // ≤4 fps; repaint is not free
        painted = now;
        while (window_.length > 1 && now - window_[0].t > 5000) window_.shift();
        const span = (now - window_[0].t) / 1000;
        const rate = span > 0.5 ? (done - window_[0].b) / span : 0;   // bytes/s
        const pct = total ? done / total : 0;
        bar.style.width = `${(pct * 100).toFixed(1)}%`;
        elBytes.textContent = `${fmt(done)} of ${fmt(total)} · ${fmt(Math.max(0, total - done))} left`;
        elRate.textContent = rate > 0 ? `${fmt(rate)}/s` : "";
        elPct.textContent = `${(pct * 100).toFixed(1)}%`;
        const elapsed = (now - started) / 1000;
        const remain = rate > 0 ? (total - done) / rate : NaN;
        elTime.textContent =
          `elapsed ${hms(elapsed)}` + (Number.isFinite(remain) ? ` · remaining ~${hms(remain)}` : "");
      };

      try {
        const res = await fetch(t.original.url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        writable = await handle.createWritable();
        const reader = res.body.getReader();
        paint(true);
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          await writable.write(value);            // awaited → backpressure
          done += value.byteLength;
          window_.push({ t: performance.now(), b: done });
          paint();
        }
        await writable.close();
        paint(true);
        dl.textContent = "saved ✓";
        elTime.textContent = `done in ${hms((performance.now() - started) / 1000)}`;
        elRate.textContent = "";
      } catch (e) {
        // Abort so a partial file is not left looking complete.
        try { await writable?.abort(); } catch { /* nothing useful to do */ }
        dl.textContent = "✗ " + (e as Error).message;
        elTime.textContent = "download failed — the partial file was discarded";
      }
      dl.disabled = false;
    };
    card.append(dl, prog);
  } else {
    card.append(el(`<a class="btn" href="${t.original.url}" download="${t.original.filename}">Download original</a>`));
  }

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
  } else if (t.blake3Root) {
    card.append(el(`<p class="meta">Large-file mode: this transfer has a whole-file BLAKE3 root, but the range-verification sidecar was not generated.</p>`));
  }

  if (manifest) {
    const prov = el(`<details class="prov" open><summary>Provenance</summary></details>`);
    const compute = manifest?.run?.metadata?.compute;
    prov.append(el(`<p class="mono">Genblaze manifest v${manifest.schema_version} · canonical hash ${String(manifest.canonical_hash).slice(0, 20)}…${compute ? ` · processed @ ${compute}` : ""}</p>`));
    const inputAsset = gbSteps[0]?.inputs?.[0];
    if (inputAsset?.sha256)
      prov.append(el(`<p class="mono">original sha256: ${String(inputAsset.sha256).slice(0, 24)}…</p>`));
    const steps = gbSteps
      .map((s: any) => `· ${s.step_id} <span class="meta">(${s.provider}/${s.model})</span>` +
        (s.assets?.[0]?.url ? " → " + keyOf(s.assets[0].url).split("/").pop() : ""))
      .join("<br>");
    prov.append(el(`<p class="mono">${steps || "· (no steps)"}</p>`));
    const btn = el(`<button class="btn ghost">Verify provenance</button>`) as HTMLButtonElement;
    const out = el(`<div class="verify"></div>`);
    btn.onclick = () => verify(t, manifest, out, btn);
    prov.append(btn, out);
    card.append(prov);
  }

  // The billing ledger is deliberately NOT shown here. This page is opened by
  // whoever holds the recipient link — often the sender's own client — and what
  // the sender is charged is none of their business. /transfers/:id/usage is
  // now sender-only; the operator reads it with a session.
  root.append(card);
}

async function verify(t: Transfer, manifest: any, out: HTMLElement, btn: HTMLButtonElement) {
  btn.disabled = true;
  out.textContent = "Re-hashing assets…";
  const urlByKey = new Map<string, string>([
    [t.original.key, t.original.url],
    ...t.derivatives.map((d) => [d.key, d.url] as [string, string]),
  ]);
  // Walk the Genblaze run: the input asset once + every step's output assets.
  const keyOf = (url: string) => url.replace(/^s3:\/\/[^/]+\//, "");
  const gbSteps: any[] = manifest?.run?.steps ?? [];
  const inputAsset = gbSteps[0]?.inputs?.[0];
  const items: { key: string; sha256: string; name: string }[] = [
    ...(inputAsset?.sha256 ? [{ key: keyOf(inputAsset.url), sha256: inputAsset.sha256, name: "original" }] : []),
    ...gbSteps.flatMap((s: any) => (s.assets ?? [])
      .filter((a: any) => a.sha256)
      .map((a: any) => ({ key: keyOf(a.url), sha256: a.sha256, name: s.step_id }))),
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
