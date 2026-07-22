# Current Work

Repo: waystation
Updated: 2026-07-19
Machine: Mac Studio
Mode: active — hackathon submission run (deadline 2026-08-03)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: `main`
- Active task: Backblaze Generative Media Hackathon submission. The product is
  feature-complete and proven; what remains is external (Backblaze feature
  enablement) and presentational (demo video, Devpost copy).
- Immediate next action: when Backblaze enables Event Notifications on the
  account, run `bash scripts/live-event-run.sh` then
  `bash scripts/b2-register-events.sh` and verify a B2-fired webhook drives
  the pipeline end to end. Everything else in that chain is already proven.

## What Exists And Is Proven

Eleven one-command proof scripts, all passing (see
`SHARED_CODING_WORKFLOW.md` for the table):

- Verified resumable transfer to B2 (BLAKE3 + bao outboard range verification).
- Reactive pipeline: HMAC-signed `b2:ObjectCreated` → gateway → worker → SSE.
- Deterministic QC engine (`pipeline/qc/`): structural, video, audio, text —
  BS.1770-4 loudness/true-peak, EBU-R103 legal range (amplitude + area policy),
  PSE flash risk, mattes, cadence/pulldown, timecode continuity, reference
  SSIM/PSNR/VMAF-as-MOS, Netflix Photon for IMF.
- Netflix strict profile with BLOCKER / ISSUE / FYI tiers.
- Self-healing: two-pass loudnorm + video legalizer, re-measured after the fix.
- AI QC lane (GMI Cloud, `google/gemini-3.5-flash`): vision review, ASR-based
  caption accuracy (WER), targeted escalation of flagged timecodes, language
  and compliance checks.
- Prompt-native "Category A" upgrades: slate reading + delivery cross-check,
  burned-text/QR/rating-card reading, perceptual severity, no-reference MOS,
  caption proofreading.
- Synthetic QC lane for generative media: generation artifacts, temporal
  coherence, and **prompt adherence** scored against the recorded prompt in an
  uploaded `.genblaze.json` generation manifest.
- Real Genblaze manifests (`genblaze-core` 0.3.6, schema v1.5), SDK-verified,
  written under B2 Object Lock COMPLIANCE (proven immutable on real B2).
- Metering ledger; hybrid local/Docker compute routing recorded in provenance.
- Containerized deployment (`docker compose up`) with Photon baked in.

## Notes

- Live verification against real B2 + real GMI has been done for the QC
  engine, self-heal, AI lanes, and WORM manifests. The only unproven link is
  Backblaze firing the webhook itself (account feature pending).
- `.env` holds real B2 + GMI credentials, is gitignored, and the full history
  has been scanned clean. The B2 application key was rotated on 2026-07-18
  after an accidental exposure in a terminal transcript; both prior keys were
  deleted. The current key is bucket-scoped to `OrBucket` without
  `listBuckets`.
- `MANIFEST_LOCK_DAYS=1` is set, so manifests written against real B2 are
  WORM-locked for 24h. Demo with `scripts/worm-demo.sh <transferId>`.
- Photon jars live in `vendor/photon` (gitignored); recreate with
  `bash scripts/fetch-photon.sh`.
- The local checkout is at `/Users/Shared/Orbit/Code/waystation`, matching the
  repo name (renamed from `orbitxfer-web` on 2026-07-19). Gitignored assets
  that do NOT come from a clone and must be rebuilt on a fresh machine:
  `.env` (per `SETUP.md`), `vendor/photon` (`scripts/fetch-photon.sh`),
  `pipeline/.venv` (Python 3.13), `node_modules`, and the wasm `pkg/` output.

## Handoff

- Safe stopping point: yes. `main` is green, all proofs pass, nothing is
  half-migrated.
- Risks or open questions: Backblaze Event Notifications enablement is an
  external dependency with no ETA beyond "≤1 day" as of 2026-07-17. The demo
  video has a documented Plan B (`docs/demo-script.md`) that fires the same
  signed webhook payload manually if enablement has not landed by recording
  time.
- Who should pick this up next: current Waystation maintainer, on any machine.
