# Current Work

Repo: waystation
Updated: 2026-08-03 (credentialed consolidated judge run reviewed and hardened; production unchanged)
Machine: Mac Studio
Mode: active — hackathon submission run (deadline 2026-08-03 17:00 EDT)

Use this file for the active handoff state that should survive machine
switches and chat history gaps.

## Focus

- Current branch: **`codex/hosted-waystation-mvp`** (waystation). OrbitWebsite
  `codex/waystation-mvp` **has been merged and published** — `main` is at
  `d432d2c` and Cloudflare Pages serves the pinned release live.
- Active task: Track A of
  `/Users/Shared/Orbit/Code/WAYSTATION_HOSTED_MVP_AND_COMMERCIAL_PLATFORM.md` —
  a judge-accessible hosted MVP at `orbitolive.com/waystation/` talking to
  `api.orbitolive.com/api/`. Track B (commercial) is NOT started.
- **The hosted MVP is deployed, published and rehearsed. 14/14 production
  checks passed on 2026-07-28** — see the rehearsal record in `docs/DEPLOY.md`.
  Deployed commit `578d37cd7e8ab4403e3fcd8e377f4a43fd8c8a01`; transfer
  `d292c10b…`; end-to-end ~3 m 36 s. Local proof
  suite green at that commit (19 discovered, 19 passed).
- **Deployed now:** gateway remains on its prior image/source, portal remains
  pinned at `ab15668`, and the worker runs source commit `ecfcc01` in image
  `sha256:753b834f…`. The worker-only deployment record below distinguishes
  host source, image contents, and running-container evidence.
- The rehearsal used a deliberately cheap fixture (10 s, 640×360). It is the
  **infrastructure rehearsal asset, not the demo asset** — see NEXT_STEPS.md for
  the showcase-asset spec.

## Sender AI consolidation and local cloud routing — 2026-08-03

- Credentialed transfer `4fb573b0-6ae9-4c44-bc0e-40cb3197c71c` ran on
  `cloud-docker-local` with the cloud request honored. Planning, parallel
  visual/audio review, independent jury, and synthesis all completed on their
  first attempts: five metered GMI calls, an SDK-verifiable manifest, four
  stored evidence objects, and zero legacy AI-QC calls.
- Thumbnail selection reused interpretive evidence at 12.747s with zero added
  GMI calls. The recipient UI now labels this as successful AI selection rather
  than the former generic fallback text.
- The run exposed a real fail-closed gap: deterministic QC found 17 caption cues
  past EOF and 0% speech overlap, while synthesis claimed a caption match from
  an unrelated 3.12s audio sample. Run schema `1.8` now attaches only
  temporally overlapping cues to each audio window and suppresses caption
  semantic/text clearance without an aligned cue plus transcription.
- The same run left temporal continuity `not_checked` because the planner did
  not request sequential evidence. Required temporal coverage now reserves one
  bounded frame sequence before generic anchors, even when the planner omits it.
- The judge launcher pins the proven Gemini 3.6 Flash text model for the
  optional summary; the prior GPT-4o-mini default produced no summary step on
  this run. This requires one post-restart credentialed confirmation.

- Cloud compute remains visible and is checked by default. `scripts/dev-up.sh`
  starts both the host worker on `:8000` and the current tool-complete Docker
  worker on `:8001` by default, and registers both with the gateway. Checked
  routes to Docker; unchecked routes to host. The compute proof builds current
  source and verifies distinct process/provenance labels.
- The sender no longer exposes legacy **AI QC**. **AI Interpretive Analysis**
  owns independent review, adaptive evidence planning, critic/jury, synthesis,
  bounded caption context, deterministic audio signal grounding, and
  chronological frame-sequence evidence. Old API clients remain compatible;
  the gateway suppresses legacy AI QC when both services are requested.
- The prompt-context label is now **Creative and delivery context (optional)**.
  The API field remains `review_brief` for compatibility and stays bounded,
  hash-disclosed, and untrusted.
- Preview thumbnail prefers a clean, model-cited frame already retained by the
  interpretive run. That path records `interpretive_reuse`, performs no
  duplicate extraction, and adds zero model calls. Standalone bounded selection
  remains the honest fallback when no reusable frame exists.
- Source schemas are interpretive run `1.8`, packet `1.2`, prompt `1.7`, planner
  `1.2`, and authority policy `1.2.0`. Focused mock orchestration and full local
  gateway-worker-MinIO proofs cover the consolidated behavior.
- Production was not accessed, rebuilt, restarted, or changed. Source defaults
  for paid explicit runs remain off and authority remains `shadow`.

## Judge-facing AI reliability pass — 2026-08-03

- Run schema v1.6 adds a compact malformed-output repair attempt, complete
  per-attempt usage accounting, Gemini-compatible local validation, and honest
  requested-versus-actual compute provenance. Nullable planner fields are now
  actually optional on the provider wire. Still-only temporal judgments are
  normalized to `not_checked`; isolated frames cannot prove or clear a freeze.
- `scripts/judge-calibration-up.sh` starts the local stack with authority
  `shadow`, three frames maximum, a 6,144-token specialist ceiling,
  `google/gemini-3.5-flash` visual/audio, and
  `google/gemini-3.6-flash` planner/jury/synthesis. It makes no model call until
  the sender explicitly submits an AI Interpretive transfer.
- Credentialed planted transfer `e69de091-4e7c-48d8-a2a4-d35ec1c6fe8d`
  completed all four active GMI stages on their first responses. Both model
  identities transcribed `TICKETS`, `TICKETS`, `TICKET5`; synthesis emitted a
  confirmed/reject typography finding, the shadow reducer proposed `REJECT`,
  and the canonical Genblaze manifest verified.
- Matching clean transfer `164e64c6-c4c4-4d4b-9b1c-7bcbb219fc2b` used the
  same four calls and transcribed `TICKETS` in all three frames. Typography was
  `no_concern`, no finding qualified, and the manifest verified. The clean
  fixture has no audio or captions, so its overall AI proposal correctly
  remains HOLD for incomplete risk coverage; it is a typography-specificity
  proof, not a universal READY proof.
- Production was not accessed or changed. This source still requires a
  separate deployment decision and a representative audio/caption showcase
  run before the judge recording.

## Dual-key AI delivery authority first pass — 2026-08-02

### Provider structured-output completion hardening

- Credentialed local transfer `8fe07b2e-673b-4bf6-86bf-5bc624a2d39d`
  proved run schema v1.4 and response-schema hashes reached the report, but it
  made zero successful model calls. Gemini rejected the strict OpenAI
  JSON-schema envelope with HTTP 400; the configured GPT-4o-mini planner and
  GPT-4o jury both returned temporary-overload HTTP 429. The fallback evidence
  still captured `TICKETS`, `TICKET5`, `TICKET5`. No review brief was submitted.
- Run schema v1.5 is provider-aware: Gemini receives supported JSON-object
  mode, then the response must pass the same strict Pydantic schema locally
  before sanitization. Other compatible endpoints receive strict provider
  JSON-schema mode plus the same local validation. HTTP 429/server/timeout
  failures receive two bounded, provenance-visible attempts by default.
- Credentialed local transfer `70148a7a-1340-4420-9b8a-28a183ebc410`
  ran on local compute in shadow and produced an SDK-verified Genblaze v1.5
  manifest. Evidence selection was correct: frames at 1.5s, 3.0s, and 4.5s
  showed `TICKETS`, `TICKET5`, and `TICKET5`. The planner completed with
  `finish_reason=stop`, but visual analysis consumed 4,092 of 4,096 output
  tokens and ended `length` without a complete JSON object. Synthesis therefore
  did not run and the AI gate correctly remained `not_checked`/HOLD. The run
  had no review brief, audio, captions, or configured jury.
- The installed `genblaze-gmicloud` 0.3.4 adapter supports Pydantic
  `response_format`, but Waystation had only requested JSON in prompt prose.
  Run schema v1.5 now uses provider-supported structured output plus strict,
  bounded local schemas for planner and all observation stages. The existing
  allowlist/sanitizer remains a second, independent boundary;
  malformed/truncated responses still fail closed.
- Each stage and the public prompt packet record the response-schema version
  and SHA-256. Focused SDK-boundary, truncation, authority, full local
  gateway-worker-MinIO, and rebuilt Docker proofs pass with zero cloud spend.
  The live GMI catalog confirmed `google/gemini-3.5-flash`,
  `openai/gpt-4o-mini`, and `openai/gpt-4o` are currently available.
- **Production was not accessed or changed.** The post-fix planted/clean-twin
  credentialed calibration pair remains the immediate release gate.

### Evidence and authority calibration hardening

- Credentialed local transfer `92a6ca73-28b7-4f17-b795-b0404ea511ed`
  completed with a verified canonical manifest and preserved three visual
  evidence frames. The planted source mutation was `TICKETS` to `TICKET5` at
  3.08s; captured frames at 1.5s, 3.0s, and 4.5s contained both exact forms.
  The model instead described a possible freeze, marked typography
  `no_concern`, and synthesis repeated that specialist claim. This is useful
  live-provider evidence of a false diagnosis, not a successful defect catch.
- Interpretive run schema v1.5 and prompt v1.4 now order frame evidence by
  source time, require per-frame exact text transcription/comparison, separate
  text mutation from freeze, and force ambiguous intent or contradictory
  transcription results to HOLD/not_checked. A sender may provide a bounded
  optional review brief (expected text/editorial intent); only its length and
  SHA-256 are published directly, although model observations may restate
  relevant context.
- Authority policy v1.1.0 no longer counts synthesis restating a specialist as
  corroboration. An enforceable AI rejection requires two distinct configured
  provider/model identities, separate synthesis agreement, allowlisted
  evidence, reject severity, and confirmed-defect intent. Distinct model IDs
  are an auditable source boundary, not proof of independent training weights.
  A separately configured jury stage supplies the second blind review; when it
  is unset the stage is explicitly `not_configured`, costs zero, and the result
  cannot qualify for AI rejection.
- Focused authority/orchestration proofs and the full local
  gateway-worker-MinIO loop pass with zero cloud spend. The loop proves the
  review-brief API bound, public hash-only metadata, explicit absent-jury state,
  B2-compatible artifact hashes, and SDK manifest verification. A post-fix
  credentialed planted/clean-twin pair remains required in shadow mode.
- **Production was not accessed or changed.** Explicit interpretation and AI
  shadow remain disabled in production; this source pass made no paid GMI call.

### Credentialed shadow run and completion hardening

- Local transfer `70d34759-a2e4-4e35-ae88-ec9c479ab840` completed with a
  canonical Genblaze manifest (`verify_hash() == true`) and an AI-selected
  thumbnail at 2.625s from `google/gemini-3.5-flash` (confidence 0.90, selected
  frame hash verified). The explicit run made four model calls: visual returned
  six valid observations and audio returned three. This proves provider,
  evidence, storage, sanitizer, and recipient paths.
- It did **not** validate the complete AI gate. Planner and synthesis both
  ended `finish_reason=length`; planner used the deterministic bounded fallback
  and synthesis produced no complete JSON. Interpretive state correctly stayed
  `not_checked`, AI proposed HOLD in shadow, and deterministic WARN also held
  the delivery for silence and missing captions.
- The audio specialist's concern about a truncated opening syllable was a
  sampling artifact: its six-second WAV began at source time 2.0s. Source schema
  `waystation-ai-interpretive-run/1.2` now labels every audio extraction edge,
  instructs models not to treat sample edges as source edits, and
  deterministically changes an interior boundary-only concern to `not_checked`.
- Planner prompt v1.1 asks only for bounded evidence placement; Waystation adds
  all policy risks deterministically. Interpretive prompt v1.3 gives synthesis
  compact detached inputs, enforces one unique result for every required risk,
  and records prompt/output character counts, expected/observed/missing risks,
  token limits, truncation, and finish reason. Planner and synthesis have
  separate bounded 4,096/6,144 output ceilings.
- Focused adversarial/boundary proofs, the four-call explicit loop, authority,
  shadow, triage, thumbnail, delivery/toggle, legacy AI, Synthetic, Netflix,
  broadcast, captions, audio map, Phase 2, deep-package, calibration, QCTools,
  TypeScript/Python/Compose checks, and a rebuilt Docker full loop pass. No paid
  call was made for this correction and production was not accessed or changed.

- The explicit run now follows the intended QC architecture: deterministic
  tools produce immutable grounding; a configurable GMI planner creates a
  bounded, risk-targeted review plan; specialist visual/audio stages run in
  parallel; synthesis resolves the structured observations; a separate
  versioned reducer combines deterministic and AI gates into READY/HOLD/REJECT.
- Raw model text still has no direct authority and cannot alter or clear
  deterministic measurements. AI authority is real but constrained: `shadow`
  records a proposed decision, `hold` can stop release, and `enforce` can reject
  only allowlisted categories with stored evidence, confidence, and cross-stage
  corroboration. Missing category coverage is HOLD, never READY. There is no
  composite score.
- Policy `waystation_ai_interpretive_authority` v1.1.0 makes visible image,
  typography, and audible defects enforceable. Temporal continuity, lip sync,
  caption semantics, editorial/creative intent, and aesthetics are HOLD-only
  in this first pass because the current bounded still/audio evidence is not a
  native full-video review.
- The recipient report displays the dual-key disposition and both gates while
  retaining the original deterministic status/tiers. Genblaze provenance now
  includes the planner, provider/model attempts, hashes, usage, policy identity,
  and the B2 evidence/result artifacts.
- Focused pure/orchestration proofs and the full local gateway-worker-MinIO loop
  pass. The loop proves four metered mock-GMI calls, stored evidence hashes,
  manifest verification, and the shadow-mode rejection proposal without
  mutating deterministic checks.
- Validation also passes for Python compile/import, gateway TypeScript build,
  client production build, production Compose expansion with placeholder
  secrets, browser checks at 1280 px and 390 px, the shipped Docker worker/full
  container loop, and the existing authority/shadow/triage/agentic/Standard/
  Netflix/AI/Synthetic/Phase 2/deep-package regressions.
- **Production was not accessed or changed.** Paid-run gates remain false and
  `AI_INTERPRETIVE_AUTHORITY_MODE=shadow` in production Compose. Source must be
  reviewed and live-provider calibrated before any separate deployment decision.
- Local-launch security correction: `scripts/dev-up.sh` previously combined
  incompatible parameter expansions and printed the configured GMI credential
  after its status label. The banner now reports only `set`/`unset`. Any key
  exposed by the old banner must be revoked and replaced before paid testing.
  Its signal trap also now exits after one `Ctrl-C` instead of leaving an
  orphaned infinite wait loop; a real start/stop proved all four ports close.
- First credentialed local explicit run (`16761b80…`) reached GMI and stored
  three JPEG evidence objects plus one WAV in MinIO, but it did **not** validate
  interpretive QC. The planner model returned 429; both Gemini specialist calls
  reached 2,396 output tokens against a 2,400 cap and produced no parseable
  structured observations; synthesis therefore skipped. Final manifest writing
  then failed because the production `.env` requested Object Lock on a local
  MinIO bucket created without it. Source now gives each specialist only its
  evidence-backed risk lane, requests compact JSON, raises the bounded output
  ceiling to 4,096, records `finish_reason`, and forces
  `MANIFEST_LOCK_DAYS=0` only in `scripts/dev-up.sh`. A second credentialed run
  is required. Production was not accessed or changed.
- Preview thumbnailing is now AI-selected in source. FFmpeg extracts a bounded
  set of real source frames from distributed timeline anchors, with scene-cut
  enrichment capped to short assets; GMI
  chooses one allowlisted candidate. `thumbnail_selection.json` retains source
  and candidate hashes, timecodes, prompt/model/usage, finish reason, selected
  frame, and whether a deterministic fallback was required. The selector never
  generates or alters imagery. It adds one GMI call when thumbnailing is
  selected and a key is configured. Focused and full delivery/toggle/explicit
  loops pass. This source change is not deployed.

## Hackathon AI Interpretive run — 2026-08-02

- Source now has a dedicated sender-selected **AI Interpretive Analysis** mode,
  separate from disabled shadow evaluation and from legacy AI QC/Synthetic QC.
  It uses the installed `genblaze_gmicloud.chat` boundary for configured GMI
  calls and Genblaze Core run/step builders for an explicit stage ledger.
- Stages expose intake, detached deterministic grounding, bounded B2 evidence
  selection, concurrent visual/audio GMI analysis, synthesis, and artifact
  storage. Primary/fallback attempts, timing, provider/model, token usage,
  prompt/input hashes, evidence SHA-256, and billable events are retained.
- Hostile model fields and unsupported evidence citations are discarded into a
  fresh observation namespace. The run cannot mutate canonical deterministic
  checks/status/tiers. This original advisory-only boundary is superseded by
  the dual-key first pass above; the deployed runtime remains unchanged.
- The recipient page renders the Genblaze run ID, timeline, observations,
  uncertainty, accepted evidence, and selected B2 frames beside the separate
  deterministic result. The existing canonical manifest embeds the stage run
  and covers the AI result/evidence derivatives.
- The network-free orchestration proof passes, and the full local explicit loop
  previously passed: browser-style multipart through the gateway, three metered
  mock-GMI calls, three B2 evidence objects, recipient API result shape, and an
  SDK-verified canonical manifest. That loop caught and fixed a metering
  idempotency collision by giving every paid stage its own event identity.
- Authority/shadow/triage/agentic/AI/synthetic/broadcast/QCTools/Phase 2/
  caption/audio/deep-package/Standard/Netflix/delivery regressions pass, as do
  Python compile, gateway/client builds, production Compose validation, the
  rebuilt Docker tool/module proof, and the signed-event gateway-worker-MinIO
  loop.
- One local-only, tiny-image call reached real GMI
  `google/gemini-3.5-flash` through the installed SDK (1,396 input / 216 output
  tokens). The deliberately low 220-token cap ended with
  `finish_reason=length`; no valid JSON observation was produced, and the
  sanitizer correctly returned no advisory result. This proves the credential
  and provider boundary, not a complete explicit run. A post-hardening bounded
  known-good/known-bad release-candidate run is still required before recording.
- **Production was not accessed or changed.** Production remains worker policy
  v1.1.0 with `AI_INTERPRETIVE_SHADOW=false`; source and production compose
  default `ALLOW_AI_INTERPRETIVE=false` and
  `AI_INTERPRETIVE_RUN_ENABLED=false`. A post-hardening credentialed GMI
  known-good/known-bad run is still pending. See
  `docs/AI_INTERPRETIVE_RUN.md`.

## Deployment reconciliation — 2026-08-01

At reconciliation baseline `c94cffb`, the branch contains three commits after
the deployed gateway commit: the published client change `ab15668` and two
documentation-only commits (`ecb0ee2`, `c94cffb`). That **looks** like drift by
commit count and is not. Verified by content:

| Comparison | Result |
|---|---|
| `gateway/` `7291c80..c94cffb` | **0 files changed** |
| `pipeline/` `7291c80..c94cffb` | **0 files changed** |
| `crates/` `7291c80..c94cffb` | **0 files changed** |
| `client/` `ab15668..c94cffb` | **0 files changed** (and `ab15668` is what is published) |

At that baseline, **production matches the branch's runtime source exactly for
every file that runs.** Nothing needs reconciling in git. Later changes must be
checked by content again; this statement deliberately does not call a mutable
branch tip a deployment identifier.

**Historical gap, resolved 2026-08-02:** the worker IMAGE was stale even though
the source was present. `e89da62` (cost-aware AI triage) is an ancestor of
`7291c80`, but the old container had never been rebuilt after it landed:

| | |
|---|---|
| gateway image built | 2026-08-01T02:28Z — current |
| **worker image built** | **2026-07-28T03:25Z — 4 days stale** |
| `qc_ai_triage` in **running** worker | **0** occurrences |
| `qc_ai_triage` in source at deployed `HEAD` | 3 occurrences |

A worker-only rebuild from source commit `ecfcc01` resolved this gap; exact
runtime evidence is recorded below. The historical measurements remain here to
show why host `HEAD` alone was insufficient.

Useful distinction to carry forward: **"the VPS is at commit X" says nothing
about what is running.** Check image build times and grep the running container,
as above, rather than trusting `git rev-parse` on the host.

## Phase 1 deterministic-tool installation — 2026-08-01

- `pipeline/Dockerfile` now builds only QCTools' headless `qcli` from pinned
  official revision `29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2` and installs pinned
  Debian `mediaconch=25.04-2`. Image labels, environment, binary output, and the
  report's `tool_provenance` retain version/source evidence. No QCTools or
  MediaConch GUI application is installed.
- At that commit this step was **plumbing only**. The milestones below now
  activate a bounded MediaConch metadata-policy adapter and bounded advisory
  QCTools evidence extraction for one versioned broadcast baseline.
- Validated locally: gateway typecheck, client production build, worker
  compile/import, both Compose configs, shell syntax, missing/present adapter
  proof, and a real Docker worker build with exact qcli/MediaConch versions,
  actual qcli report generation, and no-GUI assertions
  (`scripts/archive-tools-{proof,docker-proof}.sh`). The deterministic QC,
  coverage, MediaInfo, agentic-authority, triage, and full containerized-loop
  proofs also pass.
- **Deployed 2026-08-02** as part of the worker-only reconciliation recorded
  below. The running image exposes the exact pinned CLI versions and labels.
- The no-universal-parity boundary remains: QCTools threshold calibration and
  any wider customer/network policy packs require real corpus fixtures.

## Deterministic QC milestone 1, steps 1-3 — 2026-08-02

- Added versioned policy pack
  `pipeline/policies/us_broadcast_xdcam_hd_422_v1.json` and sender profile
  `us_broadcast_xdcam_hd_422_v1`. It is explicitly a Waystation U.S. broadcast
  MXF OP1a / XDCAM HD 4:2:2 house baseline, not universal network compliance.
  Assumptions and override behavior are documented in
  `docs/US_BROADCAST_BASELINE.md`.
- Active hard deterministic checks: full decode and stream presence; MXF/OP1a;
  MPEG-2 4:2:2 profile; exact rational frame rate; raster; TFF/interlace; bit
  depth/chroma/bitrate; bounded GOP and timestamp continuity; duration
  agreement; PCM track/layout/sample rate/bit depth; full-program loudness and
  true peak; timecode/material UMID; captions; black head/tail. MediaConch 25.04
  supplies an independent MAXML metadata fact set to a pure versioned reducer.
- Programme black, freeze runs, silence runs, and legal-range evidence are
  active advisories only. At this milestone QCTools was FYI/not checked; the
  next milestone supersedes that state. Missing tools or
  measurements cannot become a pass. Every baseline finding carries separate
  expectation, observation, evidence/time range, tool provenance, policy hash,
  and decision authority; no AI pass or composite score was added.
- Proof library: `scripts/broadcast-qc-proof.sh` constructs a real passing MXF
  and failing MP4 plus good/bad pure fixtures for timing/GOP, signal segments,
  loudness/peak, captions, overrides, and evidence shape.
  `scripts/broadcast-qc-docker-proof.sh` builds the worker and proves pinned
  MediaConch 25.04 passes 16/16 metadata assertions on the good MXF and fails
  15/16 on the bad MP4.
- This milestone was source-only when committed; it is now included in the
  worker-only production deployment recorded below.
- Next milestone: bounded QCTools report extraction/reducers and real
  customer/network acceptance-fixture calibration. Do not broaden hard policy
  authority before those proofs exist.

## Deterministic QC milestone 2, steps 4-9 — 2026-08-02

- Policy pack `us_broadcast_xdcam_hd_422_baseline` is now v1.1.0. It adds
  square-pixel/16:9 aspect, declared `tv`/`bt709` range/matrix, multi-window
  timestamp/GOP coverage, and A/V programme-start alignment. It remains a
  documented house baseline, not universal U.S. network parity.
- Timeline findings now carry bounded event lists with start/end/duration,
  expected threshold, observed count, truncation state, policy hash, tool
  provenance, and explicit authority. Intended head/tail black is excluded
  from programme-black events. Programme black, freeze/repeated-frame runs,
  silence, legal-range, and QCTools measurements remain advisory by default;
  only an explicit policy override can promote a calibrated timeline rule.
- QCTools `qcli` now analyzes at most three eight-second excerpts across the
  programme, reduces a validated signalstats allowlist, and retains raw gzip
  XML SHA-256/size/time-range plus exact binary/source provenance. Missing,
  failed, timed-out, or malformed analysis is `not_checked`, never pass.
- A versioned prompt compiler emits only unresolved deterministic targets with
  relevant evidence/time ranges and at most two requested still/audio assets.
  The AI Interpretive Pass is opt-in shadow mode, one bounded GMI call, with
  model/prompt/input provenance and uncertainty. Its findings live outside the
  canonical delivery checks and cannot alter deterministic status or tiers.
  Production compose explicitly sets `AI_INTERPRETIVE_SHADOW=false`, so the
  worker rebuild does not enable this new spend path.
- Focused local and Docker proofs cover good/bad timeline events, advanced
  metadata, policy overrides, QCTools present/missing/malformed behavior,
  packet minimization, and advisory shadow normalization. Full regression and
  production deployment evidence is recorded below.

## Worker-only production deployment — 2026-08-02

- Source commit `ecfcc01` was pushed before deployment. The VPS checkout at
  `/home/waystation/waystation` was fast-forwarded to that commit and remained
  clean. Scratch preflight passed on `/dev/vdb1` (ext4) at
  `/mnt/waystation-scratch`, with 390 G free; `/` remained on `/dev/vda2` at
  13% used.
- Built worker image `sha256:753b834fbac52381f7a2e6a24795efb42615d7f21fab283d006eb9a583afd9e9`
  at `2026-08-02T20:18:54Z`. Image and running-container proofs report QCTools
  `qcli 1.4+29bc627` at revision
  `29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2`, MediaConch CLI `25.04`
  (package `25.04-2`), policy `1.1.0`, and the triage/prompt/shadow modules.
- Recreated only `worker` with `docker compose -f docker-compose.prod.yml up
  -d --no-deps worker`. Worker container changed from `5e290b8…` to
  `6ad83c4…` and became healthy. Gateway `aa3cf13…` and cloudflared `4abd68d…`
  container IDs did not change.
- Both `http://127.0.0.1:8000/healthz` inside the worker and
  `https://api.orbitolive.com/healthz` returned `{"ok":true}`. Running mounts
  remain `/mnt/waystation-scratch/waystation:/scratch` and
  `/mnt/waystation-scratch/waystation/tmp:/tmp`.
- Cost-aware `qc_ai_triage` routing is now present for **future uploads**. No
  upload or historical replay command was run during deployment; startup logs
  contained only server startup and health probes. `AI_INTERPRETIVE_SHADOW` is
  explicitly `false`, so the new interpretive shadow path creates no production
  model spend and cannot alter deterministic delivery outcomes.

## Deterministic-authority and conformance source milestone — 2026-08-02

- Source policy `us_broadcast_xdcam_hd_422_baseline` is now v1.3.0. This is a
  source-only milestone; production remains on the previously recorded worker
  image/policy v1.1.0 and `AI_INTERPRETIVE_SHADOW=false`.
- Canonical `status` and `tiers` now derive only from deterministic checks.
  Agentic, support, hybrid, triage, synthetic, and shadow observations are
  centrally capped at advisory authority and counted separately under
  `advisory_status` / `advisory_tiers`. The former Netflix model-censorship
  escalation to BLOCKER was removed.
- The Netflix PSE path is now an explicit bounded YDIF candidate heuristic,
  cites ITU-R BT.1702-3 (11/2023) only as guidance, and cannot block. A missing
  measurement is FYI / `not_checked`; full compliance analysis is deferred.
- AI Interpretive Shadow receives deep-copied bounded packets and emits fresh
  `advisory_observations` outside canonical checks. Adversarial mutation proofs
  show packets, checks, status, tiers, and delivery outcome remain unchanged.
- Calibration schema/helper v2 enforces unique asset hashes and independent
  source groups, training/holdout separation, content/codec/cadence/audio-layout
  strata, Wilson 95% false-positive/false-negative bounds, and asymmetric 5% /
  10% limits. It never promotes a policy automatically.
- SCC, MCC, and RCWT sidecars are accepted and bounded-demuxed when FFmpeg
  supports them. Reports expose transport/decode/continuity evidence and
  explicit service/CEA-708/SMPTE-436 `not_checked` limits. SRT/VTT behavior is
  preserved. Policy v1.3 also enforces its declared one-track stereo map;
  language/title/role/index fields are checked only when explicitly declared.
- Focused authority/shadow/calibration/caption/audio-map proofs passed, along
  with Phase 2, broadcast, QCTools, coverage, archive-tool, MediaInfo,
  triage/agentic/AI/synthetic/Netflix/Standard, hybrid, jury, proficiency,
  AV-sync, Photon, and toggle regressions. Python compile, policy/schema JSON,
  gateway/client builds, and development/production Compose validation passed.
  A local Docker worker build proved policy v1.3.0 and the pinned tools; the
  complete containerized gateway-worker-MinIO event/delivery loop wrote and
  SDK-verified its manifest. No production host/container was accessed.

## Phase 3-4 deep package and AI-evaluation source milestone — 2026-08-02

- Source policy `us_broadcast_xdcam_hd_422_baseline` is now v1.4.0. It adds a
  bounded MXF wrapper/package/essence fact inventory and explicit `not_checked`
  disclosures for partition/index/KLV/ancillary/AS-profile structures that the
  installed analyzers do not qualify. These are advisories, not AS conformance.
- ZIP-carried IMF packages receive traversal-safe, entry/XML/hash-bounded
  AssetMap/PKL/CPL parsing, reference checks, and supported small-asset hash
  verification without extracting essence. Structural consistency is separate
  from Photon and never implies complete IMF application-profile conformance.
- HDR/color labels are discovered and cross-checked across ffprobe/MediaInfo;
  Dolby-related markers are disclosed. Neither path claims bitstream,
  mastering/playback, Dolby Vision/E/Atmos, or delivery conformance.
- Selectable template `waystation_house_xdcam_hd_422_v1` retains template
  source/effective hashes and overrides. It is explicitly a Waystation house
  template, not a broadcaster spec. The commercial benchmark schema records
  retained side-by-side outcomes and disagreements without a parity score.
- Prompt packets are now hash/schema validated before media extraction or
  spend. Shadow citations are restricted to supplied evidence IDs. Offline
  reviewer records support agree/disagree/needs-review/false-positive
  dispositions and holdout precision/recall/false-positive Wilson intervals;
  feedback cannot change policy or canonical delivery status.
- Focused deep-package, benchmark, interpretive-shadow, and shadow-evaluation
  proofs pass. Standard/Netflix, authority, Phase 2, caption/audio, QCTools,
  MediaInfo/MediaConch/Photon, triage/agentic/synthetic, calibration, gateway,
  client, Compose, and shell regressions also pass. A local Docker rebuild
  proved pinned tools and policy v1.4.0; the complete gateway-worker-MinIO loop
  processed a signed event, wrote all derivatives, and SDK-verified its
  manifest.
- This is source-only. Production remains on worker image
  `sha256:753b834f…` / policy v1.1.0. Production was not accessed or changed,
  and `AI_INTERPRETIVE_SHADOW=false` remains the default and production state.

## Phase 2 delivery-quality source milestone — 2026-08-02

- Phase 2 introduced policy `us_broadcast_xdcam_hd_422_baseline` v1.2.0. The
  broadcast-only adapters add bounded visual, audio, caption, QCTools, and
  cross-tool metadata evidence without changing Standard/Netflix behavior.
- Visual candidates: blockiness, blur, banding/contouring, temporal outliers,
  repeated regions, crop/matte layout, and two-frame boundary color-bars
  disclosure. Audio candidates: phase/polarity, clipping, click/pop impulses,
  short dropouts, and per-channel balance/dead channels. Persistent silence
  remains the existing programme-silence advisory. SRT/VTT continuity reports
  invalid, overlap, ordering, long-gap, and interval-union runtime evidence.
- FFmpeg analysis is capped at three four-second picture and three eight-second
  audio programme windows; QCTools remains capped at three eight-second
  excerpts with validated metrics and raw XML hashes. All new perceptual
  thresholds are deterministic advisories pending a real accepted/rejected
  corpus. Missing/malformed evidence is FYI / `not_checked`, never pass.
- Cross-validation compares already-collected ffprobe, MediaInfo, and
  MediaConch facts using field-aware normalization and report hashes. It is
  contradiction evidence, not a second MXF policy engine.
- This milestone initially added a 20-per-class calibration intake floor. The
  v1.3 milestone above supersedes it with independence, strata, holdout, and
  Wilson error-bound gates; synthetic fixtures remain behavior tests only.
- Focused Phase 2/QCTools/calibration/broadcast proofs, archive-tool and
  MediaInfo proofs, triage/agentic/synthetic/Netflix/Standard regressions,
  Python compile, gateway/client builds, both Compose configs, pinned-tool and
  broadcast Docker proofs, and the full local gateway-worker-MinIO loop passed.
- Production was not accessed, rebuilt, restarted, or deployed for this
  milestone. The live worker record above remains policy v1.1.0 at image
  `sha256:753b834f…`; `AI_INTERPRETIVE_SHADOW=false` remains unchanged.

## Large-file mode PROVEN on real media — 2026-08-01

First real large transfer end to end: **`CrossroadsFestival_Doyle_Bramhall_WM.mov`,
28,048,912,110 bytes (26.12 GiB), transfer-only, root-only mode.** Uploaded,
delivered and downloaded successfully. Download averaged **232 Mb/s
(28.95 MB/s) in 16:09**.

The delivery page correctly disclosed *"whole-file BLAKE3 root, but the
range-verification sidecar was not generated"* and correctly withheld the
verified-download control. That is the verification-mode design working as
intended on real media for the first time.

Four defects were found and fixed by driving it for real. None had been caught
by the 14-check rehearsal, because that only used a 765 KB fixture and never
exercised plain "Download original" on a video:

1. **Version skew wedged a 27 GiB upload.** The gateway had been rebuilt with
   large-file mode while the portal still served `578d37c`, which contains no
   `verificationMode` handling. The gateway answered `"root"`; the old client
   could not read the field, fell back to `"range"`, and built a ~1.7 GiB bao
   outboard in wasm. `finalize()` is a synchronous allocation that blocks the
   main thread, which also stalled the last part in flight — hence a freeze at
   28.97 of 28.98 GB rather than at a random point. Fixed by republishing.
2. **Legacy resume records guessed the verification mode.** Both defaults are
   wrong: `"range"` rebuilds a multi-GiB outboard and wedges the tab; `"root"`
   skips the sidecar for a small file and leaves a transfer the gateway recorded
   as range-verified with no `.obao` behind it. The client now ASKS —
   `/uploads/outboard-url` already answers `403 outboard_disabled` for root-only
   uploads, which settles it against the server's own record (`db78bfc`).
3. **"Download original" opened the media player instead of saving.** `<a
   download>` is same-origin-only and B2 is cross-origin, so the attribute was
   ignored and a `video/quicktime` response rendered inline — a 26 GiB file
   buffering into a browser tab. The gateway now signs
   `Content-Disposition: attachment` into the original's presigned URL;
   derivatives deliberately keep inline disposition (`7291c80`).
4. **No download progress.** Fixed with bytes/rate/ETA and a rolling 5-second
   window (`ab15668`).

**Measured, for the parallel-download decision later:** B2 throttles
per-connection, not per-client. One stream achieved 232 Mb/s; six parallel
streams measured 3.3× aggregate. Projecting that forward puts a 28 GB download
near the 800 Mb/s line limit — roughly 5 minutes instead of 16. Deferred until
after the deadline by explicit decision.

## Large-file mode checkpoint — 2026-07-31

- Production can accept uploads up to **350 GiB** via explicit root-only
  large-file mode.
- Files **≤16 GiB** keep bao outboard generation and verified-range download.
- Files **>16 GiB** skip `.obao`, store the whole-file BLAKE3 root, and the
  delivery page discloses that verified-range download is unavailable.
- Files **>100 GiB** force every worker/QC service off, making them
  transfer-only to protect the 390 GiB scratch disk.
- Sender sessions now slide while preserving the same session id, so long
  uploads can keep signing parts without changing ownership.
- Validated: gateway build, client build, production compose config,
  access-proof, toggle-proof, and targeted root-only initiate/outboard-refusal
  integration.

## Cost-aware AI triage checkpoint — 2026-07-31

- A new `qc_ai_triage` router runs after deterministic QC and before expensive
  GMI lanes when AI QC or Synthetic QC is requested.
- Triage receives metadata, deterministic check summaries, caption excerpt, and
  a few sampled frames. It may skip or narrow optional model spend for AI QC,
  Synthetic QC, typography, and critic.
- Triage is **not a verdict engine**: it never marks media clean or failed, and
  every skip is disclosed in `qc_report.json` and the delivery page.
- A source `.genblaze.json` manifest prevents triage from skipping requested
  Synthetic QC; the recorded generation intent remains the stronger routing
  signal.
- If triage fails, returns invalid JSON, or GMI is unavailable, Waystation falls
  back to the sender-requested AI behavior.
- Validated: `scripts/triage-proof.sh`, `scripts/agentic-qc-proof.sh`, client
  production build.

## Track A hosted MVP (2026-07-27)

Seven steps, each committed separately on `codex/hosted-waystation-mvp`:

1. **Client transport** (`client/src/config.ts`) — API base from a `<meta>` tag
   so the deployed host changes without a rebuild; `credentials:"include"`;
   status-aware decoding; `EventSource` with `withCredentials`; share links
   that preserve the subpath. Vite `base` is BUILD-ONLY (in dev it 404s the
   root and hangs the readiness loops in dev-up/live-run/live-event-run).
2. **SQLite control plane** (`gateway/src/db.ts`) via **node:sqlite** — built
   into Node, verified in the deploy image (node:22-slim = 22.23.1), so no
   native module to compile. Fixes the restart bug that silently promoted a
   TRANSFER-ONLY job to full AI QC and billed it. Meter events idempotent.
3. **Sender auth** (`gateway/src/auth.ts`) — `crypto.scrypt` code hash, one-shot
   exchange for a signed `HttpOnly; SameSite=Strict` cookie (Secure in prod
   only), exact credentialed CORS with preflight BEFORE auth, rate limits.
4. **Ownership** — every upload route verifies key+uploadId belong to the
   session; neutral 404 otherwise. Validation before any B2 state exists.
5. **Cost controls** (`gateway/src/limits.ts`) — kill switch, active/session
   and daily ceilings, service allowlist, `.ref.*` refusal gating the reference
   VMAF lane. All at the dispatch boundary; QC internals untouched.
6. **Recipient scoping** — expiry + revocation, transfer-scoped download
   replacing the arbitrary-key signing oracle, billing ledger removed from the
   recipient view (now sender-only).
7. **`/healthz` + access panel + release export + prod compose** — export writes
   a checksummed release manifest into OrbitWebsite; `docker-compose.prod.yml`
   is standalone with cloudflared and ZERO published ports.

Key invariant: **dev stays permissive, production fails closed.**
`WAYSTATION_AUTH_MODE` defaults `disabled`, DB `:memory:`, reference QC allowed
— that is what keeps the existing proof suite green. Under `NODE_ENV=production`
the gateway refuses to start with auth off, missing/short secrets, or an
ephemeral database.

New env (see `docker-compose.prod.yml` for the deployed values):
`WAYSTATION_AUTH_MODE`, `WAYSTATION_ACCESS_CODE_HASH`,
`WAYSTATION_SESSION_SECRET`, `WAYSTATION_SESSION_TTL_SECONDS`,
`WAYSTATION_ALLOWED_ORIGINS`, `WAYSTATION_DB_PATH`,
`WAYSTATION_ACCEPT_UPLOADS`, `MAX_UPLOAD_BYTES`,
`MAX_ACTIVE_UPLOADS_PER_SESSION`, `MAX_JOBS_PER_SESSION`, `MAX_DAILY_JOBS`,
`ALLOW_AI_QC`, `ALLOW_SYNTHETIC_QC`, `ALLOW_EXPENSIVE_REFERENCE_QC`,
`RECIPIENT_LINK_TTL_DAYS`, `TUNNEL_TOKEN`.
Generate the code + secrets with `node scripts/make-access-code.mjs` — the code
prints once; only the hash is ever configured, never committed.

Verified in a real browser cross-origin (the condition the vite proxy hides):
wrong code refused with the gate held, correct code reveals the sender UI, the
code field cleared, `document.cookie` cannot see the session, nothing in
local/sessionStorage, and the session survives a reload.

## Infrastructure checkpoint — **COMPLETE (2026-07-28)**

All eight items are done; none is blocking any more:

1. ✓ VPS provisioned and hardened (Vultr, Ubuntu 24.04, UFW OpenSSH only)
2. ✓ Docker/Compose installed; images built natively on the VPS (amd64)
3. ✓ Production B2 + GMI secrets on the VPS `.env` (password manager holds them)
4. ✓ Cloudflare Tunnel `waystation-production` → `api.orbitolive.com`
5. ✓ B2 CORS for `https://orbitolive.com` + `https://www.orbitolive.com`
6. ✓ B2 event rule enabled, unsuspended, targeting `/api/events/b2`
7. ✓ Judge-code delivery method settled (owner-held, never on screen)
8. ✓ Rehearsal asset used

The pinned release was exported, the OrbitWebsite branch merged and published,
and the 14-check rehearsal passed **14/14**. Remaining before submission:
record the demo. See `docs/DEPLOY.md` for the rehearsal record.

## Recipient-capability hygiene

Recipient transfer ids are **bearer capabilities** — anyone holding one can read
the delivery. The rehearsal id was committed to public documentation and to a
public commit message, so it was **revoked on the production control plane**
(`transfers.revoked = 1`). Both `/transfers/:id` and `/transfers/:id/download`
now return a neutral 404 byte-identical to an unknown id, and every presigned
URL minted during that run has passed its 3600 s TTL.

Git history was deliberately **not** rewritten: the commit is already public, so
revocation is the control that actually works. Going forward, **record only a
shortened id** (first 8 characters) in tracked files and commit messages.

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
- **Production status: the deployed Passport is `UNCALIBRATED`, and that is
  correct.** The published WORM manifest is bound to commit `e85fd947`;
  production runs `578d37c`, so `citation_state()` rightly refuses to cite it.
  The 2026-07-28 rehearsal reported `UNCALIBRATED · "no proficiency manifest for
  this configuration"` and jury `SINGLE_SOURCE · no juror configured`. Both are
  honest output and are safe to show on camera.
- **Never** set `WAYSTATION_COMMIT` to the older `e85fd947` sha to make the
  citation read EXACT — that manufactures a binding for code which did not
  produce those numbers, and defeats the entire point of the Passport. A citable
  Passport requires publishing a NEW manifest against the exact deployed
  configuration from a clean worktree. Does NOT block recording.

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
pipeline import, and **every `scripts/*-proof.sh` green (discovered from the filesystem, not a fixed count)**. Docker, Photon,
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
and every `scripts/*-proof.sh` — green (discovered, not a fixed count).

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
- ~~Event Notifications are registered per-tunnel~~ — **SUPERSEDED 2026-07-28.**
  That was true only while the pipeline ran behind an ephemeral cloudflared
  quick-tunnel. Production now has a **stable hostname**, so the B2 rule
  (`waystation-pipeline`, prefix `transfers/`) is registered **once** against
  `https://api.orbitolive.com/api/events/b2` and stays valid. Verified enabled,
  unsuspended and firing during the rehearsal.
  **Do not run `scripts/b2-register-events.sh` against production** — it would
  repoint the live rule at whatever tunnel happens to be up and silently stop
  the hosted pipeline. Those scripts remain only for local development.
- The pipeline venv is Python 3.13 and was REBUILT on 2026-07-19 after the
  directory rename: venvs bake absolute-path shebangs into console scripts
  (e.g. uvicorn), so `.venv` must be recreated (not moved) when the checkout
  path changes. `.venv/bin/python` is a symlink and kept working, which
  masked the break until a console script was run. On this handoff, **all then-current
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
  for the Phase 1 install is recorded above; the prior full-suite result remains
  historical and is not restated as having been rerun for this source-only task.
- Exact next step: **record the demo video.** No code work is required first.
  **`docs/demo-script.md` is the authoritative hosted-production procedure** —
  shot list plus a "How to record" plan (silent screen captures + separate
  voiceover, setup checklist, capture order, edit rules), a "never on camera"
  list, and an after-recording revocation step.

  Sequence: confirm `https://api.orbitolive.com/healthz` answers and the portal
  manifest parses as JSON, authenticate at
  `https://orbitolive.com/waystation/` **before** the capture starts, then
  record. Finally re-paste `docs/devpost-about.md` into Devpost.

  > **Superseded:** do NOT "bring the stack up with `scripts/live-event-run.sh`"
  > or "run `scripts/b2-register-events.sh` for the fresh tunnel". There is no
  > local stack and no ephemeral tunnel in the hosted deployment; repointing the
  > production B2 rule would break it. Do NOT wire passport env vars either —
  > the deployed Passport is honestly `UNCALIBRATED` and must stay that way.
- Live-model calibration of the generated lane is PARTIAL, not complete. The
  proficiency session put real GMI through 10 blind assets and validated TWO of
  the five model stages — the coarse **scene ledger** and **native-resolution
  typography** — plus their deterministic reducers, at 5/5 sensitivity and 5/5
  specificity. It did NOT exercise the **planner** (`plan_prompt`; the runner
  deliberately uses the deterministic baseline plan), the **jittered fine
  verification** pass, **prompt adherence**, or the **artifact/anatomy
  specialist**. Those four remain live-unvalidated — see NEXT_STEPS. This does
  not block recording, but do not claim on camera that the whole generated lane
  is live-calibrated; the passport beat covers exactly what was measured.
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
