// Recipient delivery view: preview + AI summary + provenance, with a working
// "Verify provenance" button that re-hashes the assets (SHA-256, Web Crypto)
// and checks them against the manifest. Reached at /?t=<transferId>.

import { Eye, EyeOff, LockKeyhole, createElement as createIcon } from "lucide";
import { GatewayError, gwGet, gwPost } from "./config.js";
import { downloadVerified } from "./downloader.js";
import { formatBytes } from "./format.js";
import { planRanges } from "./ranges.js";
import {
  clearDownloadResume, getDownloadResume, saveDownloadResume, usable,
  type DownloadResume,
} from "./downloadResume.js";
import { pool } from "./uploader.js";

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
// One formatter for the whole product — see format.ts.
const fmt = formatBytes;

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

// ───────── parallel ranged download ─────────
//
// B2 throttles per CONNECTION, not per client. Measured 2026-09-07 from a
// wired 10Gbase-T Mac against a real 28 GB object in the production bucket,
// using this module's own chunk size over multi-gigabyte samples:
//
//     1 worker    23.2 MB/s   (186 Mb/s)
//     6 workers   76.7 MB/s   (613 Mb/s)
//    12 workers   91.1 MB/s   (729 Mb/s)   ← chosen
//
// Twelve beat six in both interleaved passes and lands near the 800 Mb/s line
// rate, so six was leaving real headroom unused. Past twelve is untested.
//
// ⚠ Measure over GIGABYTES, not megabytes. Two earlier attempts here reported
// a 1.3x gain and a 435 Mb/s ceiling; both used ~50-200 MB samples, where TCP
// slow-start dominates and every connection is still ramping when the test
// ends. Anything under ~1 GB per configuration measures ramp-up, not capacity.
const DOWNLOAD_CONCURRENCY = 12;

const PARALLEL_MIN_BYTES = 32 << 20;

/** Stream one response body to disk at an advancing position.
 *  `write` is serialized by the caller — see the mutex in saveToDisk. */
async function drain(
  body: ReadableStream<Uint8Array>,
  at: number,
  write: (position: number, data: Uint8Array) => Promise<void>,
  onBytes: (n: number) => void,
): Promise<void> {
  const reader = body.getReader();
  let position = at;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    await write(position, value);          // awaited → backpressure
    position += value.byteLength;
    onBytes(value.byteLength);
  }
}

/** Ask the gateway where storage actually is, and fetch the bytes from there.
 *
 *  Script MUST NOT fetch the mediated url itself. It answers with a redirect to
 *  another origin, and the Fetch spec requires the browser to send
 *  `Origin: null` on a cross-origin redirected request — which B2 answers with
 *  403. Both hosts have correct CORS and it still fails, because `null` is not
 *  any host's configured origin. Allowing `null` at the bucket would let any
 *  sandboxed context read the object, so the fix is on this side: request JSON,
 *  then go to storage directly, where the origin is intact and a preflight is
 *  permitted.
 *
 *  The redirect is still the right shape for a top-level `<a href>` navigation
 *  (not a CORS request) and for curl or aria2c (no CORS at all). */
async function resolveStorageUrl(url: string): Promise<string> {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "format=json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.url) throw new Error("gateway returned no storage url");
  return body.url as string;
}

/** Download `url` into an open FileSystemWritableFileStream, in parallel where
 *  storage supports it. Nothing is buffered: every byte goes network → disk, so
 *  a 26 GiB master costs no more memory than a small one.
 *
 *  `onProgress` receives the TOTAL bytes written so far, not a delta, because a
 *  fallback restarts from zero and the caller must be able to follow it down. */
async function saveToDisk(
  url: string,
  total: number,
  writable: any,
  onProgress: (bytesSoFar: number) => void,
  resume?: { skip: Set<number>; completed: number[] },
  signal?: AbortSignal,
): Promise<void> {
  // A FileSystemWritableFileStream is a WritableStream: overlapping write()
  // calls fight over the same locked writer. Serialize them through a promise
  // chain. Ordering does not matter because each write carries its own absolute
  // position, and at most DOWNLOAD_CONCURRENCY writes are ever queued since
  // every worker awaits its own before reading more.
  let chain: Promise<void> = Promise.resolve();
  const write = (position: number, data: Uint8Array): Promise<void> => {
    chain = chain.then(() => writable.write({ type: "write", position, data }));
    return chain;
  };

  const all = planRanges(total);
  const skip = resume?.skip ?? new Set<number>();
  const already = all.filter((r) => skip.has(r.start))
                     .reduce((n, r) => n + (r.end - r.start + 1), 0);
  let done = already;
  onProgress(done);
  const count = (n: number) => { done += n; onProgress(done); };

  // The single-stream path rewrites from byte zero, so it cannot honour a
  // partial file — any resume progress is void once it runs.
  const single = async (): Promise<void> => {
    done = 0; onProgress(0);
    const res = await fetch(src, { signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await drain(res.body, 0, write, count);
  };

  // Resolve once. Every byte below comes from `src`, never from the mediated
  // url — see resolveStorageUrl. If resolution fails we still try the url as
  // given: a deployment that serves storage directly needs no resolution.
  let src = url;
  try { src = await resolveStorageUrl(url); } catch { /* fall through to url */ }

  if (total < PARALLEL_MIN_BYTES) return single();

  try {
    const probe = await fetch(src, { headers: { Range: "bytes=0-0" }, signal });
    await probe.body?.cancel();
    if (probe.status !== 206) return single();

    const todo = all.filter((r) => !skip.has(r.start));
    await pool(todo, DOWNLOAD_CONCURRENCY, async ({ start, end }) => {
      const res = await fetch(src, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (!res.ok || !res.body) throw new Error(`range ${start}-${end}: HTTP ${res.status}`);
      await drain(res.body, start, write, count);
      // Collected in MEMORY only. A range that has drained is in the writable's
      // swap file, not on disk — FileSystemWritableFileStream commits nothing
      // until close(). Persisting here would claim durability that does not
      // exist, and an unclean exit would leave a resume record describing bytes
      // the file never received. The caller persists this list, and only after
      // a close() that succeeded.
      resume?.completed.push(start);
    });
  } catch (e) {
    // A deliberate pause is not a fault. Falling back here would restart the
    // whole download from byte zero and silently undo exactly what the user
    // just chose to keep — the opposite of what they asked for.
    if (signal?.aborted) throw e;
    console.warn("parallel download failed, falling back to a single stream:", e);
    await single();
  }
}

/** True when a write failed because the destination volume is full.
 *
 *  Free space cannot be checked beforehand: `navigator.storage.estimate()`
 *  reports the ORIGIN's quota, not the volume behind a File System Access
 *  handle, so it says nothing useful about an external drive or another
 *  partition. A confident wrong prediction is worse than none — so this reports
 *  the fact at the moment it becomes one. */
const isOutOfSpace = (e: unknown): boolean => {
  const err = e as { name?: string; message?: string };
  return String(err?.name ?? "") === "QuotaExceededError"
    || /no space|not enough space|disk full|insufficient|quota/.test(String(err?.message ?? "").toLowerCase());
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const icon = (node: any): SVGElement => createIcon(node, {
  width: "18", height: "18", "stroke-width": "1.8", "aria-hidden": "true",
});

function renderUnlock(id: string, root: HTMLElement): void {
  root.textContent = "";
  const card = el(`<section class="card unlock-card"></section>`);
  const lock = document.createElement("div");
  lock.className = "unlock-icon";
  lock.append(icon(LockKeyhole));
  const heading = el(`<h1>Protected transfer</h1>`);
  const copy = el(`<p class="tag">Enter the password supplied by the sender to view and download this transfer.</p>`);
  const wrap = el(`<div class="password-wrap"></div>`);
  const input = document.createElement("input");
  input.type = "password";
  input.maxLength = 128;
  input.autocomplete = "current-password";
  input.placeholder = "Transfer password";
  input.setAttribute("aria-label", "Transfer password");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-button";
  const paint = () => {
    toggle.replaceChildren(icon(input.type === "password" ? Eye : EyeOff));
    toggle.title = input.type === "password" ? "Show password" : "Hide password";
    toggle.setAttribute("aria-label", toggle.title);
  };
  toggle.onclick = () => {
    input.type = input.type === "password" ? "text" : "password";
    paint();
    input.focus();
  };
  paint();
  wrap.append(input, toggle);
  const message = el(`<p class="field-help" aria-live="polite"></p>`);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "btn";
  submit.textContent = "Unlock transfer";
  const unlock = async () => {
    if (input.value.length < 1) {
      message.textContent = "Enter the transfer password.";
      return;
    }
    submit.disabled = true;
    message.textContent = "Checking password…";
    try {
      await gwPost(`/transfers/${id}/unlock`, { password: input.value });
      input.value = "";
      await renderDelivery(id, root);
    } catch (error) {
      message.textContent = error instanceof GatewayError
        ? error.message
        : "The transfer could not be unlocked.";
      submit.disabled = false;
      input.select();
    }
  };
  submit.onclick = unlock;
  input.onkeydown = (event) => { if (event.key === "Enter") void unlock(); };
  card.append(lock, heading, copy, wrap, message, submit);
  root.append(card);
  input.focus();
}

export async function renderDelivery(id: string, root: HTMLElement) {
  root.hidden = false;
  root.textContent = "Loading transfer…";
  let t: Transfer;
  try {
    t = await gwGet(`/transfers/${id}`);
  } catch (error) {
    if (error instanceof GatewayError && error.code === "recipient_password_required") {
      renderUnlock(id, root);
      return;
    }
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
  const thumb = t.derivatives.find((d) => d.key.endsWith("/thumb.jpg"))
    ?? t.derivatives.find((d) => d.mime === "image/jpeg");
  const thumbSelectionAsset = t.derivatives.find((d) => d.key.endsWith("thumbnail_selection.json"));
  const thumbSelection = thumbSelectionAsset
    ? await fetch(thumbSelectionAsset.url).then((r) => r.json()).catch(() => null)
    : null;
  const qcAsset = t.derivatives.find((d) => d.key.endsWith("qc_report.json"));
  const qc = qcAsset ? await fetch(qcAsset.url).then((r) => r.json()).catch(() => null) : null;
  const aiAsset = t.derivatives.find((d) => d.key.endsWith("ai_interpretive.json"));
  const aiRun = aiAsset ? await fetch(aiAsset.url).then((r) => r.json()).catch(() => null) : null;
  const aiManifestAsset = aiAsset ? gbSteps.flatMap((step) => step.assets ?? [])
    .find((asset: any) => keyOf(asset.url ?? "") === aiAsset.key) : null;

  root.textContent = "";
  const card = el(`<div class="deliv"></div>`);
  if (thumb) card.append(el(`<img class="thumb" src="${thumb.url}" alt="preview" />`));
  if (thumbSelection) {
    const selectionStatus = el(`<p class="meta"></p>`);
    selectionStatus.textContent = thumbSelection.selection_method === "gmi_ai"
      ? `AI-selected preview · ${thumbSelection.model} · ${Number(thumbSelection.selected_time_seconds).toFixed(1)}s`
      : thumbSelection.selection_method === "interpretive_reuse"
        ? `AI-selected preview · reused interpretive evidence · ${thumbSelection.model} · ${Number(thumbSelection.selected_time_seconds).toFixed(1)}s · no additional AI call`
        : `Preview fallback · ${thumbSelection.reason}`;
    card.append(selectionStatus);
  }
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

  // Deterministic instrument status remains intact. The separate dual-key
  // disposition below combines it with the versioned AI interpretive gate.
  if (qc) {
    const disposition = qc.delivery_disposition;
    const cls = disposition === "READY" ? "ok" : disposition === "HOLD" ? "warnc" :
      disposition === "REJECT" ? "bad" : qc.status === "pass" ? "ok" : qc.status === "warn" ? "warnc" : "bad";
    const label = disposition === "READY" ? "✓ Delivery ready" : disposition === "HOLD" ? "⚠ Delivery hold" :
      disposition === "REJECT" ? "✗ Delivery rejected" : qc.status === "pass" ? "✓ QC passed" :
      qc.status === "warn" ? "⚠ QC warnings" : "✗ QC failed";
    const profileTag = qc.profile_label ? ` · ${qc.profile_label}` : "";
    const badge = el(`<details class="prov"><summary><span class="${cls}">${label}</span><span class="meta">${profileTag}</span></summary></details>`);
    if (disposition) {
      const gates = qc.delivery_decision ?? {};
      const detail = el(`<p class="meta"></p>`);
      detail.textContent = `Deterministic QC ${qc.status ?? "not_checked"} · deterministic gate ${gates.deterministic_gate?.disposition ?? "HOLD"} · AI gate ${gates.ai_interpretive_gate?.disposition ?? "HOLD"}`;
      badge.append(detail);
    }
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

  // Explicit Genblaze/GMI analysis remains separate from instrument checks.
  // Raw model text has no direct authority; the policy reducer may hold or
  // reject only when the configured authority mode and evidence rules allow.
  if (aiRun) {
    const panel = el(`<section class="ai-run"><h3>AI Interpretive Analysis</h3></section>`);
    const runMeta = el(`<p class="meta"></p>`);
    const route = aiRun.compute_route ?? {};
    const routeText = route.actual
      ? ` · orchestration ${route.actual}${route.request_honored === false ? ` (requested ${route.requested}; fallback)` : ""}`
      : "";
    runMeta.textContent = `Genblaze run ${aiRun.run_id ?? "unknown"} · ${aiRun.state ?? "not_checked"} · authority ${aiRun.authority_mode ?? "shadow"}${routeText} · inference GMI Cloud`;
    panel.append(runMeta);

    const decision = aiRun.delivery_decision ?? {};
    const disposition = String(decision.disposition ?? "HOLD");
    const decisionClass = disposition === "READY" ? "ok" : disposition === "HOLD" ? "warnc" : "bad";
    const decisionBox = el(`<div class="observation"><strong class="${decisionClass}"></strong><p></p><p class="meta"></p></div>`);
    (decisionBox.querySelector("strong") as HTMLElement).textContent = `Delivery ${disposition}`;
    (decisionBox.querySelector("p") as HTMLElement).textContent = (decision.reasons ?? []).join(" · ") || "No decision reason was recorded.";
    const deterministicGate = decision.deterministic_gate?.disposition ?? "HOLD";
    const aiGate = decision.ai_interpretive_gate?.disposition ?? "HOLD";
    const proposed = decision.ai_interpretive_gate?.proposed_disposition ?? "HOLD";
    const qualified = decision.qualified_ai_findings ?? [];
    const independentSources = Math.max(0, ...qualified.map((item: any) =>
      Number(item.independent_sources?.length ?? 0)));
    (decisionBox.querySelector("p.meta") as HTMLElement).textContent =
      `deterministic gate ${deterministicGate} · AI gate ${aiGate} · proposed ${proposed} · ` +
      `independent sources ${independentSources} · raw model output has no direct authority`;
    panel.append(decisionBox);

    const timeline = el(`<div class="timeline"></div>`);
    for (const stage of (aiRun.timeline ?? [])) {
      const name = el(`<span></span>`);
      name.textContent = String(stage.name ?? "stage").replaceAll("_", " ");
      const state = el(`<span class="mono"></span>`);
      const provider = stage.provider ? ` · ${stage.provider}/${stage.model ?? ""}` : "";
      const role = stage.review_role ? ` · ${stage.review_role}` : "";
      const response = stage.response_format_mode
        ? ` · ${stage.response_format_mode} · schema ${stage.response_validation ?? "not_checked"}`
        : "";
      state.textContent = `${stage.outcome ?? "not_checked"} · ${Number(stage.duration_ms ?? 0)} ms${provider}${role}${response}`;
      timeline.append(name, state);
    }
    panel.append(timeline);

    const observations = aiRun.interpretive_observations ?? aiRun.advisory_observations ?? [];
    if (!observations.length) {
      const empty = el(`<p class="meta"></p>`);
      empty.textContent = "No structured observation was produced. This run remains not checked, not passed.";
      panel.append(empty);
    }
    for (const observation of observations) {
      const item = el(`<div class="observation"><strong></strong><p></p><p class="meta"></p></div>`);
      (item.querySelector("strong") as HTMLElement).textContent = observation.issue_description ?? "Review observation";
      (item.querySelector("p") as HTMLElement).textContent = observation.context || observation.review_question || "Human review requested.";
      const evidence = (observation.evidence_ids ?? []).join(", ") || "no accepted citation";
      const intent = observation.intent_state ?? "unknown";
      const transcriptions = (observation.evidence_transcriptions ?? [])
        .map((entry: any) => `${entry.evidence_id}="${entry.text}"`).join(" → ");
      (item.querySelector("p.meta") as HTMLElement).textContent =
        `${observation.risk_id ?? "unclassified"} · ${observation.finding_state ?? "not_checked"}/${observation.severity ?? "review"} · ` +
        `intent ${intent} · confidence ${Number(observation.confidence ?? 0).toFixed(2)} · evidence ${evidence} · ` +
        `${observation.uncertainty ?? "uncertainty not supplied"}` +
        (transcriptions ? ` · text ${transcriptions}` : "");
      panel.append(item);
    }

    const urlByKey = new Map(t.derivatives.map((d) => [d.key, d.url] as [string, string]));
    const frames = (aiRun.evidence ?? []).filter((item: any) => item.type === "frame").slice(0, 4);
    if (frames.length) {
      const gallery = el(`<div class="ai-evidence"></div>`);
      for (const frame of frames) {
        const image = document.createElement("img");
        image.src = urlByKey.get(frame.key) ?? "";
        image.alt = `${frame.evidence_id} at ${Number(frame.time_seconds ?? 0).toFixed(2)} seconds`;
        image.title = `${frame.evidence_id} · ${String(frame.sha256 ?? "").slice(0, 16)}…`;
        gallery.append(image);
      }
      panel.append(gallery);
    }
    const provenance = el(`<p class="mono"></p>`);
    const reviewContext = aiRun.review_context ?? {};
    const brief = reviewContext.provided
      ? ` · review brief ${reviewContext.characters ?? 0} chars sha256 ${String(reviewContext.sha256 ?? "").slice(0, 20)}…`
      : " · no review brief";
    provenance.textContent = `result sha256 ${String(aiManifestAsset?.sha256 ?? "unavailable")} · packet schema ${aiRun.prompt_packet?.schema_version ?? "unknown"} · schema sha256 ${String(aiRun.prompt_packet?.schema_sha256 ?? "").slice(0, 20)}…${brief}`;
    panel.append(provenance);
    card.append(panel);
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

    // Loaded HERE, not in the click handler, and deliberately. showSaveFilePicker
    // must be reached with no preceding await or the browser has lost the user
    // activation and refuses to open it — so the resume record has to be in hand
    // before the click, not fetched during it.
    let prior: DownloadResume | null = null;
    getDownloadResume(t.transferId)
      .then((r) => {
        // A size mismatch means these are not the same bytes; the recorded
        // ranges would be meaningless.
        prior = r && r.size === t.original.size ? r : null;
        if (prior) {
          const got = planRanges(t.original.size)
            .filter((x) => prior!.done.includes(x.start))
            .reduce((n, x) => n + (x.end - x.start + 1), 0);
          dl.textContent = `Resume download — ${fmt(got)} of ${fmt(t.original.size)} already saved`;
        }
      })
      .catch(() => { /* no resume record is the normal case */ });

    // While a download runs, this same button pauses it. A separate control
    // would be tidier DOM but worse UX: the thing you want to stop is the thing
    // you just clicked.
    let controller: AbortController | null = null;

    dl.onclick = async () => {
      if (controller) {            // running → this click means "pause"
        dl.disabled = true;
        dl.textContent = "Pausing…";
        controller.abort();
        return;                    // the catch below finishes the bookkeeping
      }
      let handle: any;
      let resuming = false;
      if (prior && (await usable(prior.handle))) {
        handle = prior.handle;
        resuming = true;
      } else {
        try {
          // Must be called directly from the click — a picker opened after an
          // await has lost the user activation and the browser refuses it. The
          // await above only runs when resuming, where no picker is needed.
          handle = await (window as any).showSaveFilePicker({ suggestedName: t.original.filename });
        } catch {
          return; // user cancelled the dialog — not an error
        }
        await clearDownloadResume(t.transferId).catch(() => {});
        await saveDownloadResume({
          transferId: t.transferId, size: t.original.size,
          filename: t.original.filename, handle, done: [], updatedAt: Date.now(),
        }).catch(() => {});
      }
      controller = new AbortController();
      dl.textContent = "Pause";    // stays enabled: it is now the pause control
      prog.hidden = false;
      let writable: any;
      // Ranges believed to be on disk. Seeded from the prior record, appended
      // as ranges drain, and persisted ONLY after a successful close().
      const committed: number[] = resuming ? [...prior!.done] : [];
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
        // keepExistingData is REQUIRED when resuming: createWritable() truncates
        // the file by default, which would silently discard everything already
        // downloaded and make "resume" a slower way to start over.
        writable = await handle.createWritable({ keepExistingData: resuming });
        paint(true);
        await saveToDisk(t.original.url, total, writable, (n) => {
          done = n;
          window_.push({ t: performance.now(), b: done });
          paint();
        }, { skip: new Set(committed), completed: committed }, controller.signal);
        await writable.close();
        await clearDownloadResume(t.transferId).catch(() => {});
        paint(true);
        dl.textContent = "saved ✓";
        elTime.textContent = `done in ${hms((performance.now() - started) / 1000)}`;
        elRate.textContent = "";
      } catch (e) {
        // Previously this aborted, discarding the partial file so it could not
        // be mistaken for a complete one. Now that ranges are recorded as they
        // land, that partial file is worth keeping — throwing away 7 GB because
        // a laptop slept is the worse failure. Close to flush what arrived, keep
        // the resume record, and say plainly that it is incomplete.
        // CLOSE FIRST, then record. close() is what commits the swap file to
        // disk; a record written before it would describe bytes that never
        // arrived, and resume would skip ranges the file does not contain —
        // producing a correctly-sized file full of holes that opens as garbage.
        let durable = false;
        try {
          if (committed.length) { await writable?.close(); durable = true; }
          else await writable?.abort();
        } catch { durable = false; }   // nothing committed; the record must not claim otherwise
        const salvageable = durable && committed.length > 0;
        const paused = controller?.signal.aborted === true;
        const noSpace = isOutOfSpace(e);
        if (salvageable) {
          await saveDownloadResume({
            transferId: t.transferId, size: total, filename: t.original.filename,
            handle, done: committed, updatedAt: Date.now(),
          }).catch(() => {});
          const got = planRanges(total)
            .filter((x) => committed.includes(x.start))
            .reduce((n, x) => n + (x.end - x.start + 1), 0);
          const pct = ((got / total) * 100).toFixed(1);
          dl.textContent = `Resume download — ${fmt(got)} of ${fmt(total)} already saved`;
          elTime.textContent = noSpace
            ? `ran out of space on the destination disk at ${pct}% — free some up, ` +
              "then click Resume; what downloaded is kept"
            : paused
              ? `paused at ${pct}% — the file is INCOMPLETE until you resume`
              : `stopped at ${pct}% — the file is INCOMPLETE; click to carry on from here`;
        } else {
          await clearDownloadResume(t.transferId).catch(() => {});
          dl.textContent = paused ? "Download original…" : "✗ " + (e as Error).message;
          elTime.textContent = noSpace
            ? "the destination disk is full — free space and start again"
            : paused
              ? "paused before anything was saved — nothing to resume"
              : "download failed — the partial file was discarded";
        }
        prior = salvageable ? await getDownloadResume(t.transferId).catch(() => null) : null;
      }
      controller = null;
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
    const requestedCompute = manifest?.run?.metadata?.requested_compute;
    const computeFallback = manifest?.run?.metadata?.compute_request_honored === false
      ? ` (requested ${requestedCompute}; fallback)` : "";
    prov.append(el(`<p class="mono">Genblaze manifest v${manifest.schema_version} · canonical hash ${String(manifest.canonical_hash).slice(0, 20)}…${compute ? ` · processed @ ${compute}${computeFallback}` : ""}</p>`));
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
