# Current Work

Repo: waystation
Updated: 2026-07-19 (session-end handoff)
Machine: Mac Studio
Mode: paused — clean handoff; hackathon submission run (deadline 2026-08-03)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: `main`
- Active task: Backblaze Generative Media Hackathon submission. The product is
  feature-complete and proven end to end, including — as of 2026-07-19 —
  Backblaze firing the event notifications itself. What remains is purely
  presentational: the demo video and Devpost copy.
- Immediate next action: record the demo video (`docs/demo-script.md`) and
  re-paste the updated Devpost sections. Nothing technical is blocked.

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

- Live verification against real B2 + real GMI is complete for the QC engine,
  self-heal, AI lanes, WORM manifests, AND Backblaze firing the event
  notifications. On 2026-07-19 an object uploaded directly to B2 (gateway
  never contacted, dev trigger off) caused B2 to fire `b2:ObjectCreated`,
  which drove the full pipeline — proving the reactive loop with genuine B2
  events, not a manually-fired webhook. Every link is now proven live.
- Event Notifications are registered per-tunnel: a cloudflared quick-tunnel
  URL is ephemeral, so after starting `scripts/live-event-run.sh`, run
  `scripts/b2-register-events.sh` to (re)point the B2 rule at the current
  tunnel. A rule left pointing at a dead tunnel is harmless (events just do
  not deliver) but should be re-registered before a demo.
- The pipeline venv is Python 3.13 and was REBUILT on 2026-07-19 after the
  directory rename: venvs bake absolute-path shebangs into console scripts
  (e.g. uvicorn), so `.venv` must be recreated (not moved) when the checkout
  path changes. `.venv/bin/python` is a symlink and kept working, which
  masked the break until a console script was run. **All 11 proof scripts
  were re-run green on the rebuilt venv at session end** (including the
  uvicorn-dependent `delivery-proof` and `phase2-loop-proof` that had hung
  before the rebuild), so the environment is confirmed good.
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

- Safe stopping point: yes. `main` is green, all 11 proofs pass on the
  rebuilt venv, no stack processes or tunnels are running, and the B2
  notification rule was cleared (so nothing points at a dead tunnel).
- Risks or open questions: none technical. Remaining work is presentational
  (demo video + Devpost copy). When recording, bring the stack up with
  `scripts/live-event-run.sh` then `scripts/b2-register-events.sh` — the
  quick-tunnel URL is fresh each run, so the rule must be re-registered.
- Who should pick this up next: current Waystation maintainer, on any machine.
