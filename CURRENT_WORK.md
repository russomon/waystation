# Current Work

Repo: waystation
Updated: 2026-07-24 (AI Reliability Passport: blind jury + proficiency foundry)
Machine: Mac Studio
Mode: active — hackathon submission run (deadline 2026-08-03)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: `main`
- Active task: Backblaze Generative Media Hackathon submission. Waystation is a
  read-only QC reporter: deterministic instruments feed a three-pass agentic
  inspection, and an 18-risk registry prevents silent omissions.
- Immediate next action: run one representative generated clip plus its
  `.genblaze.json` through the expanded Synthetic QC lane against **real GMI**.
  Inspect the recipient page's blueprint, 14-dimension coverage, coarse/fine
  sampling audit, continuity findings, and typography tracks for useful,
  non-duplicative output. The integration is fully mock-proven, but these new
  structured prompts have not yet had a live-model calibration pass. Then
  update the demo shot list if needed and record the video.

## AI Reliability Passport (2026-07-24, latest)

The hackathon headline: **Waystation QCs the AI.** Every AI-derived typography
finding now carries an auditable passport — reproducibility from a BLIND
second-model jury (reducer replay + match_key, `qc/jury.py`;
`reproduced|contested|single_source`; contested STAYS suspected with raised
priority) and proficiency from blind planted-defect testing
(`qc/foundry.py` + `foundry_render.py` + `scripts/proficiency.sh`; clean twins
measure false positives; Wilson CIs labeled PROVISIONAL; WORM-locked manifest
citable only on EXACT config match, else UNCALIBRATED). Handoff packets
(deterministic, no model) replace the rejected regeneration-advice idea.
Findings gained structured identities (`finding_id`/`match_key`) in
`qc/generated.py`. Full rationale in DECISIONS 2026-07-24.

- Env: `GMI_JURY_MODEL` (opt-in, default empty; probed live — gpt-4o had no
  GMI capacity, so gemini-3.6-flash jurors are disclosed as same-family),
  `PROFICIENCY_MANIFEST_PATH` (published manifest copy for report citation),
  `WAYSTATION_COMMIT` (config binding in Docker, no .git in image).
- Proofs: `jury-proof.sh`, `proficiency-proof.sh`; `synthetic-qc-proof.sh`
  extended for passport fields. First live run: planted `ARRIVALS→4RRIVALS`
  caught by primary AND independently reproduced by the blind juror (which
  transcribed the glyph differently — the match_key design working as
  intended); clean twin passed both models.
- REMAINING (before recording): full live proficiency session (10 assets ×
  jury) → `--publish` the citable WORM manifest from a clean worktree; then
  wire `PROFICIENCY_MANIFEST_PATH` + `GMI_JURY_MODEL` for the demo run.

## Asset-specific generated-media QC (2026-07-24)

Five requested upgrades landed as one read-only subsystem:

1. **Asset-specific QC blueprint** (`pipeline/qc/generated.py`): a planning
   agent compiles the generation prompt, file context, and baseline risks into
   atomic assertions with scope, evidence strategy, and likely failure modes.
   Normalization is allowlisted and bounded; if the model omits a dimension or
   returns unusable JSON, deterministic baseline assertions fill the plan.
2. **Timeline scene-graph ledger**: ordered observations use stable keys for
   subjects, objects, backgrounds, text, and plan assertions. Pure reducers
   compare same-shot observations and raise timecoded ISSUE-level concerns for
   identity/attribute drift, object count/state changes, background changes,
   and blueprint contradictions.
3. **Hierarchical evidence**: up to 12 anchor/scene-boundary frames build the
   coarse ledger; its suspect timecodes receive bounded ±120 ms jittered dense
   verification. The report records candidate timecodes and only labels a risk
   stable when the same normalized finding recurs in both passes.
4. **Generated-media dimension registry**: a separate versioned 14-risk
   registry accounts for prompt elements, identity, background, permanence,
   anatomy, motion, flicker, physics, shadows/reflections, camera continuity,
   rendered text, spatial relationships, style, and imaging quality. Every
   dimension is `ASSESSED`, `SUSPECTED`, or `REVIEW_REQUIRED`; sampled evidence
   never clears the full timeline.
5. **Native-resolution typography**: model-located normalized text boxes are
   re-extracted without scaling, transcribed literally in a separate
   instruction-hardened pass, then compared by deterministic string tracking.
   Missing/unparseable transcription becomes review-required, never clean.

The recipient UI now renders the generated blueprint, risk coverage, findings,
and sampling audit. Each model stage degrades independently so one provider or
JSON failure does not erase the other generated QC evidence. The existing
artifact/anatomy/physics specialist and manifest-backed prompt-adherence score
remain and feed the new registry. `scripts/synthetic-qc-proof.sh` proves the
whole B2 → worker → report → metering contract with mock GMI, including prompt
redaction and the off toggle.

Validation after this change: gateway `tsc --noEmit`, production client build,
pipeline import, and **all 16 `scripts/*-proof.sh` green**. Docker, Photon,
MediaInfo, WORM Object Lock, compute routing, and synthetic/agentic proofs all
ran rather than being assumed. Real-GMI calibration of the five new structured
stages is still pending and explicitly not claimed.

## This session (2026-07-24)

Four landed changes, all committed + pushed, all proofs green:

1. **Perceive-then-compute hybrid QC lane** (`pipeline/qc/hybrid.py`, commit
   b39f86c). Pure module: the model PERCEIVES per-window (mouth openness,
   per-channel content); deterministic reducers OWN the decision (`align`,
   `compare_declared`, `persistence`). Two live instances feed `lip_sync` and
   `channel_assignment`; a hybrid WARN raises SUSPECTED, a hybrid PASS never
   CLEARs. Proven by `scripts/hybrid-proof.sh`.
2. **Measured lip-sync in the worker image** (`pipeline/Dockerfile`, commit
   102d7ee). Opt-in `INSTALL_SYNCNET=1 docker compose build worker` — micromamba
   Python 3.10 + pip CPU torch 2.5.1 + weights. Proven end-to-end on SyncNet's
   `data/example.avi`: **+120 ms, confidence 8.3** → `lip_sync: SUSPECTED`. Also
   fixed a latent cwd bug in `qc/avsync.py` (see DECISIONS 2026-07-23). Sizes:
   base 1.31 GB, SyncNet 2.95 GB. SyncNet is CPU-only; it never calls GMI.
3. **Demo shot list brought current** (`docs/demo-script.md`, commit b5fff53) —
   the master is faceless + stereo, so measured lip-sync, hybrid lip-sync, and
   hybrid channel-semantics are silent on it BY DESIGN; an opt-in real-face beat
   was added rather than claiming them over that master.
4. **Only instruments reject** (`pipeline/qc/agentic.py`, commits 17e85aa →
   2557d3f → d518873). Three LIVE real-GMI captures of `demo-master.mp4` exposed
   the model restating measured instrument failures as its OWN blockers (6
   BLOCKERs for 3 defects). Fix: `checks_from_findings` caps EVERY agentic
   finding at ISSUE — only instruments reject. Verdict stays `fail` on the real
   instrument findings; final tiers a stable {BLOCKER 3}. See DECISIONS
   2026-07-24.

Validated at handoff: `gateway tsc --noEmit`, `client build`, `worker` import,
and all 16 `scripts/*-proof.sh` — green.

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
- MEASURED LIP-SYNC IS NOW PROVEN END-TO-END (2026-07-23). Running the built
  image against SyncNet's own `data/example.avi` (a real talking face):
  `AV offset: 3` frames @25fps (**+120 ms**), `Min dist: 6.589`,
  `Confidence: 8.323`. `qc/avsync.py` parsed that into
  `avsync_offset — warn / ISSUE: "measured A/V offset +120 ms (+3 @25fps,
  confidence 8.3) — lip sync out of tolerance"`, and `build_coverage` escalated
  `lip_sync` to **SUSPECTED / ASSESSED**. Image sizes: base worker 1.31 GB,
  SyncNet worker 2.95 GB. The base image still returns the honest FYI, verified
  by running the same wrapper in it.
- SyncNet now ships in the WORKER IMAGE (2026-07-23): `pipeline/Dockerfile`
  takes an opt-in `INSTALL_SYNCNET=1` build arg — micromamba supplies a
  self-contained Python 3.10 (independent of the image's 3.13) and pip supplies
  CPU torch 2.5.1, plus the cloned repo and weights. Run it with
  `INSTALL_SYNCNET=1 docker compose build worker`. CPU-only, no GPU. The default
  image is unchanged and still reports the honest FYI. Notes: the pytorch CONDA
  channel is x86_64-only (upstream's `environment-cpu.yml` will not solve on
  arm64), so the env is pip-built and works on both arches; and SyncNet never
  imports torchaudio/torchvision, so neither is installed.
- Also fixed a latent bug this exposed: `qc/avsync.py` invoked SyncNet by
  relative script name with relative model/S3FD-weight paths while
  `qc/util.py:run` never set a cwd — so the invocation could only ever have
  worked in its absent-tool branch. `run` gained `cwd=`; avsync passes
  `cwd=SYNCNET_DIR`. The upstream is CURRENT (2026-04-17 "modernize-code":
  torch 2.5.1, PySceneDetect 0.6.7.1, Python 3.10 + S3FD) — earlier
  "~8-year-old" notes were wrong.

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

The suite now contains sixteen one-command proof scripts, including the new
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
- The three-pass agentic reporter is integration-proven against a mock GMI
  endpoint AND captured live against real GMI three times on 2026-07-24
  (`demo-master.mp4`, Netflix strict): all three passes, prompt hash, coverage
  accounting, and residual review render cleanly. Coverage counts vary per run
  (5/13 → 7/13 assessed) — normal model variance; read them off the screen on
  the take, do not memorize a rehearsal number. Retained reports live in the
  session scratchpad only (not in the repo).
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

- Safe stopping point: yes after this change is committed and pushed. Validation
  at this handoff: gateway `tsc --noEmit`, production client build, `worker`
  import, and all 16 `scripts/*-proof.sh` green.
- Exact next step: run a representative generated clip plus `.genblaze.json`
  through real GMI and inspect the new structured report in the recipient UI.
  Do not record the final demo until that model-calibration pass is satisfactory.
  Then bring the stack up with `scripts/live-event-run.sh`, run
  `scripts/b2-register-events.sh` for the fresh tunnel, record per
  `docs/demo-script.md`, and re-paste `docs/devpost-about.md` into Devpost.
- Two things to carry into the recording: (1) the demo master is faceless +
  stereo, so measured lip-sync / hybrid lip-sync / hybrid channel-semantics are
  silent on it by design — either run the optional real-face beat or narrate the
  honest disclosure (see the demo script + recording notes); (2) do NOT narrate
  the agentic ISSUE-level restatements as the AI "independently corroborating"
  the instruments — the informed pass was handed the dossier (DECISIONS
  2026-07-24).
- Next engineering item when code resumes (not a blocker): export SyncNet's full
  measurement (per-window offset trajectory → drift characterization) into the
  agentic dossier — specified in `NEXT_STEPS.md` under "Soon".
- Who should pick this up next: current Waystation maintainer, on any machine.
