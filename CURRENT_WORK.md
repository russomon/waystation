# Current Work

Repo: waystation
Updated: 2026-07-23 (detection-coverage upgrades)
Machine: Mac Studio
Mode: active — hackathon submission run (deadline 2026-08-03)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: `main`
- Active task: Backblaze Generative Media Hackathon submission. Waystation is a
  read-only QC reporter: deterministic instruments feed a three-pass agentic
  inspection, and an 18-risk registry prevents silent omissions. Detection
  coverage was widened on 2026-07-23 (five upgrades, see below).
- Immediate next action: capture one report against real GMI (now with the
  wider evidence), then record the demo video (`docs/demo-script.md`) and
  re-paste the Devpost sections.

## Detection-coverage upgrades (2026-07-23)

Five changes that widen what the lanes and the agentic reporter can see —
each asserted by `scripts/coverage-proof.sh` (ffmpeg + venv only, no cloud):

1. **Tiled signal analysis** — legal range, PSE flash risk, and chroma
   legality now tile short windows across the WHOLE timeline instead of the
   first 60 s; idet cadence samples several offsets too. A flash at minute 45
   is no longer invisible (`SIGNAL_TILE_*` env vars bound total analyzed time).
2. **Blind-pass audio** — the independent agentic sweep now receives audio
   windows (start/mid/end + silence-flagged points), not only frames, so the
   "inspect sound" charter has evidence to inspect.
3. **Scene + anomaly frame selection** — blind frames land on scene-change
   boundaries and deterministic anomaly timecodes (black/freeze/silence) plus
   anchors, instead of blind even spacing; a shot list is emitted.
4. **Duration-scaled, higher-res evidence** — initial frame budget scales with
   runtime (floor `AI_QC_FRAMES=8`, ceiling `AI_QC_FRAMES_MAX=40`), and
   evidence resolution rose to `AI_QC_FRAME_SCALE=1024` px (was 640).
5. **Lip-sync proxy** — new deterministic instrument: container A/V start
   offset + audio-energy vs visual-motion envelope cross-correlation. It moves
   the `lip_sync` registry risk off a permanent REVIEW_REQUIRED to SUSPECTED
   when a real offset is measured; a clean proxy still does not CLEAR it
   (honest — a global proxy is not certified lip sync).

## Measured lip-sync via SyncNet (2026-07-23)

- We probed whether the multimodal model could perceptually judge lip sync.
  It CANNOT: on a controlled talking-face stimulus it gave unstable,
  confidently-wrong verdicts (a gross 1.7 s offset called "in_sync / high").
  So the AI lane is deliberately NOT used for sync (DECISIONS.md).
- Instead SyncNet (joonson/syncnet_python) is integrated as an optional
  analyzer (`qc/avsync.py`, `scripts/fetch-syncnet.sh`, env `SYNCNET_DIR` /
  `SYNCNET_PYTHON`) — Photon pattern: real measured offset when installed,
  honest FYI when absent, wired into the `lip_sync` risk. Parser verified
  against SyncNet's source output strings; `scripts/avsync-proof.sh` proves
  the honest-absence contract and that the model can no longer clear lip_sync.
- Coverage hardening (`qc/agentic.py build_coverage`): instruments now always
  win over model dispositions (the model only fills a genuine gap, never
  softens a deterministic finding or overrides a full-scope clear), and
  `lip_sync` is flagged `model_unreliable` so the VLM can never CLEAR/CONFIRM
  it. Verified green by agentic-qc / ai-qc proofs.
- PENDING: the end-to-end SyncNet torch run. `fetch-syncnet.sh` clones the
  repo + downloads weights; the upstream is CURRENT (2026-04-17 "modernize-code"
  commit: torch 2.5.1, PySceneDetect 0.6.7.1, Python 3.10 + S3FD), so standing
  up the venv is bounded, not dependency archaeology (earlier "~8-year-old"
  notes were wrong). Not a blocker — until then the analyzer reports an honest
  FYI.

## Hybrid QC lane — perceive-then-compute (2026-07-23)

- A reusable framework (`pipeline/qc/hybrid.py`, pure — no GMI/subprocess
  import) built on a principle proven this session: the multimodal model is
  reliable at PERCEPTION (per-window descriptors) but confabulates when asked to
  JUDGE timing/consistency, so every hybrid check pairs an AI perception step
  (run by the worker) with a DETERMINISTIC reducer that owns the decision —
  `align` (cross-correlation offset), `compare_declared` (perceived vs declared
  layout), `persistence` (tag consistency).
- Two instances ship, wired through `worker.run_hybrid_qc` inside `run_ai_qc`
  and metered as `qc_hybrid` (frames) / `qc_hybrid_audio` (seconds):
  1. **Perceptual lip-sync** — per-frame mouth-openness perception cross-
     correlated with the audio-energy envelope at the same rate. On a ground-
     truthed talking-face probe it recovered a +833 ms offset exactly and, on a
     gross/aliased case, honestly ABSTAINS (the hardened `align` requires a
     peak-margin over the runner-up) instead of the confident-wrong number the
     raw kernel gave. Feeds `lip_sync`.
  2. **Audio channel semantics** — splits each channel of a multichannel master
     and asks the model to classify dialogue/music/effects/silence per channel,
     then `compare_declared` flags layout violations (e.g. dialogue on the LFE).
     On a probe the model labelled all four channels correctly and the reducer
     flagged the planted LFE-dialogue. Feeds `channel_assignment`.
- Coverage (`qc/agentic.py build_coverage`) now treats `source in
  {deterministic, hybrid}` as instruments: a hybrid WARN raises SUSPECTED, but
  a hybrid PASS never CLEARs (both risks are `partial`/`model_unreliable` — AI
  perception can flag, never certify). Proven by `scripts/hybrid-proof.sh`
  (ffmpeg + venv, no cloud) and exercised live (mock GMI) in `ai-qc-proof`
  (`qc_hybrid` appears in the metering).
- REMAINING: validate the lip-sync instance on a REAL-face clip (the cartoon
  proved the mechanism only). Logo/watermark persistence and shot continuity
  are now easy follow-on `HybridCheck` specs (see NEXT_STEPS).

## What Exists And Is Proven

The suite now contains thirteen one-command proof scripts, including the new
agentic contract proof and the MediaInfo proof (see
`SHARED_CODING_WORKFLOW.md` for the table):

- Verified resumable transfer to B2 (BLAKE3 + bao outboard range verification).
- Reactive pipeline: HMAC-signed `b2:ObjectCreated` → gateway → worker → SSE.
- Deterministic QC engine (`pipeline/qc/`): structural, video, audio, text —
  BS.1770-4 loudness/true-peak, EBU-R103 legal range (amplitude + area policy),
  PSE flash risk, mattes, cadence/pulldown, timecode continuity, reference
  SSIM/PSNR/VMAF-as-MOS, Netflix Photon for IMF.
- Netflix strict profile with BLOCKER / ISSUE / FYI tiers.
- Read-only agentic QC (GMI Cloud, `google/gemini-3.5-flash`): independent
  inspection, one bounded allowlisted evidence-request round,
  instrument-informed reconciliation, and an independent critic. The charter
  explicitly covers human-detectable picture, audio, sync, text, editorial,
  localization, and generated-media risks; prompt/media text is untrusted.
- Mandatory 18-risk coverage accounting with separate QC verdict and coverage
  completeness. Every risk is assessed, marked not applicable, or disclosed
  as review-required/unverified/blocked. The retired legacy `self_heal` option
  creates no check, derivative, meter, or manifest step.
- AI support checks remain: ASR caption accuracy (WER), targeted escalation of
  flagged timecodes, language, compliance, and caption proofreading.
- Synthetic QC lane for generative media: generation artifacts, temporal
  coherence, and **prompt adherence** scored against the recorded prompt in an
  uploaded `.genblaze.json` generation manifest.
- Real Genblaze manifests (`genblaze-core` 0.3.6, schema v1.5), SDK-verified,
  written under B2 Object Lock COMPLIANCE (proven immutable on real B2).
- Metering ledger; hybrid local/Docker compute routing recorded in provenance.
- Containerized deployment (`docker compose up`) with Photon baked in.
- Optional MediaInfo structural cross-check: missing tool is reported as an
  explicit FYI; when present, MXF OP1a, AS-11/UK DPP visibility, HDR metadata,
  and Dolby audio metadata caveats feed the same BLOCKER / ISSUE / FYI report.

## Notes

- Live verification against real B2 + real GMI is complete for the prior QC
  engine, AI lanes, WORM manifests, AND Backblaze firing the event
  notifications. On 2026-07-19 an object uploaded directly to B2 (gateway
  never contacted, dev trigger off) caused B2 to fire `b2:ObjectCreated`,
  which drove the full pipeline — proving the reactive loop with genuine B2
  events, not a manually-fired webhook. Every link is now proven live.
- The new three-pass agentic reporter is fully integration-proven against a
  mock OpenAI-compatible GMI endpoint. Run one representative master against
  real GMI before recording to capture final model-output/UI evidence.
- Event Notifications are registered per-tunnel: a cloudflared quick-tunnel
  URL is ephemeral, so after starting `scripts/live-event-run.sh`, run
  `scripts/b2-register-events.sh` to (re)point the B2 rule at the current
  tunnel. A rule left pointing at a dead tunnel is harmless (events just do
  not deliver) but should be re-registered before a demo.
- The pipeline venv is Python 3.13 and was REBUILT on 2026-07-19 after the
  directory rename: venvs bake absolute-path shebangs into console scripts
  (e.g. uvicorn), so `.venv` must be recreated (not moved) when the checkout
  path changes. `.venv/bin/python` is a symlink and kept working, which
  masked the break until a console script was run. On this handoff, **all 13
  proof scripts were run green** on the rebuilt venv, including Docker,
  Photon, MediaInfo, Object Lock, and the new agentic integration.
- `.env` holds real B2 + GMI credentials, is gitignored, and the full history
  has been scanned clean. The B2 application key was rotated on 2026-07-18
  after an accidental exposure in a terminal transcript; both prior keys were
  deleted. The current key is bucket-scoped to `OrBucket` without
  `listBuckets`.
- `MANIFEST_LOCK_DAYS=1` is set, so manifests written against real B2 are
  WORM-locked for 24h. Demo with `scripts/worm-demo.sh <transferId>`.
- Photon jars live in `vendor/photon` (gitignored); recreate with
  `bash scripts/fetch-photon.sh`.
- MediaInfo is baked into the Docker worker. On host-run workers it remains
  optional: install it on demo/review machines if you want the extra MXF OP1a
  / AS-11 / HDR metadata cross-checks; otherwise the report carries an
  explicit FYI that the analyzer was skipped.
- The local checkout is at `/Users/Shared/Orbit/Code/waystation`, matching the
  repo name (renamed from `orbitxfer-web` on 2026-07-19). Gitignored assets
  that do NOT come from a clone and must be rebuilt on a fresh machine:
  `.env` (per `SETUP.md`), `vendor/photon` (`scripts/fetch-photon.sh`),
  `pipeline/.venv` (Python 3.13), `node_modules`, and the wasm `pkg/` output.

## Handoff

- Safe stopping point: yes. The agentic reporter contract, adaptive evidence,
  no-repair runtime/UI, expanded delivery report, and proof updates are in the
  current handoff. Validation: all 13 `scripts/*-proof.sh` capability proofs
  green; gateway `tsc --noEmit`, production client build, Python compile/import,
  and `git diff --check` green. The Docker worker image also passed with
  ffmpeg, MediaInfo, Java, and Photon present.
- Risks or open questions: real-GMI output for the new charter should be
  captured before the demo; no implementation blocker is known. When
  recording, bring the stack up with `scripts/live-event-run.sh` then
  `scripts/b2-register-events.sh` — the quick-tunnel URL is fresh each run, so
  the rule must be re-registered.
- Who should pick this up next: current Waystation maintainer, on any machine.
