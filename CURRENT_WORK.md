# Current Work

Repo: waystation
Updated: 2026-07-23 (agentic QC reporter handoff)
Machine: Mac Studio
Mode: paused — clean handoff; hackathon submission run (deadline 2026-08-03)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: `main`
- Active task: Backblaze Generative Media Hackathon submission. Waystation is
  now a read-only QC reporter: deterministic instruments feed a three-pass
  agentic inspection, and an 18-risk registry prevents silent omissions.
- Immediate next action: capture one report against real GMI, then record the
  demo video (`docs/demo-script.md`) and re-paste the Devpost sections.

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
