# Waystation

Send mastered video — it arrives **QC'd, summarized, and provable**.
High-speed verified delivery over **Backblaze B2** (the cloud waystation) with
a broadcast-grade QC engine + AI lane (**GMI Cloud**) that runs while the file
is parked, a single-toggle **Netflix strict profile**, an **agentic read-only
QC report** for human-detectable risks, and a WORM-locked provenance trail.

Built for the [Backblaze Generative Media Hackathon](https://backblaze-generative-media.devpost.com/).

## Flow

```
browser ──parallel multipart (BLAKE3 + bao outboard)──▶ B2 (originals)
                                          │ b2:ObjectCreated Event Notification
                                          ▼
                                   gateway /api/events/b2  (HMAC-verified)
                                          │ dispatch (sender-selected services)
                                          ▼
                          QC + AI pipeline (ffmpeg/ffprobe + GMI Cloud)
        structural → signal (AV/caption QC, BS.1770-4, R103, PSE)
        → blind AI inspection → adaptive evidence → informed pass → critic
                                          │ derivatives + WORM provenance manifest
                                          ▼
                                  B2 (derivatives/)   ──CDN──▶ delivery page
        progress streams the whole way via SSE (gateway /api/progress/:id)
```

## For judges: verify the claims in one command each

Every capability below is proven by a self-contained script (MinIO + ffmpeg,
no cloud creds needed) that builds violating media, runs the pipeline, and
asserts the results:

```bash
bash scripts/agentic-qc-proof.sh   # charter, request allowlist, mandatory 18-risk accounting, no-repair contract
bash scripts/coverage-proof.sh     # detection coverage: tiled full-timeline PSE, blind-pass audio, scene/anomaly frames, lip-sync proxy
bash scripts/netflix-qc-proof.sh   # Netflix profile: 4 BLOCKERs, reporter-only mode, PSE, VMAF/MOS
bash scripts/ai-qc-proof.sh        # 3-pass agentic lane + adaptive evidence + ASR WER (mock GMI, zero spend)
bash scripts/qc-proof.sh           # deterministic AV + caption QC with exact defect counts
bash scripts/toggle-proof.sh       # sender toggles gate the pipeline; transfer-only = zero derivatives
bash scripts/object-lock-proof.sh  # WORM manifest: locked version cannot be deleted
bash scripts/phase2-loop-proof.sh  # signed event -> pipeline -> derivatives + manifest + SSE
```

## Layout

| Path | What |
|---|---|
| `gateway/` | Control plane (Hono/Node): presigned URLs, `ListParts` resume, **B2 event webhook → pipeline**, SSE progress. Never touches bytes. |
| `client/` | Browser app (Vite/TS): chunk + BLAKE3 + parallel multipart upload, resumable; verified download. |
| `crates/blake3-outboard/` | Rust→wasm BLAKE3 (root now; bao outboard for verified range download next). |
| `cdn-worker/` | Cloudflare Worker: token-gated streaming from the private B2 bucket (free B2→CF egress). |
| `pipeline/` | Python Genblaze worker: fan-out AI steps on GMI Cloud, writes manifest to B2. |
| `config/` | B2 CORS + Event Notification rule. |

## Run (local)

One command brings up the whole stack on MinIO (no cloud creds needed) — open
`localhost:5173`, drag in a small video, watch the pipeline, open the share link:

```bash
# one-time setup
npm install                                    # workspaces
npm run build:wasm                             # needs cargo + wasm-pack
( cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt )  # needs ffmpeg

# every time
bash scripts/dev-up.sh                          # MinIO + gateway + pipeline + Vite client
#   GMI_API_KEY=... bash scripts/dev-up.sh      # to enable the real summarize step
```

Or run pieces individually: `npm run dev:gateway` · `dev:client` · `dev:pipeline`.
For real B2 webhooks in dev, expose the gateway: `cloudflared tunnel --url http://localhost:8787`.

## Deploy (anywhere)

The waystation ships as two containers — gateway (control plane, tiny,
always-on) and worker (the compute: python 3.13 + ffmpeg + **MediaInfo** +
a JRE + **Netflix Photon baked in**, stateless, scale horizontally):

```bash
docker compose up --build     # .env supplies B2/GMI config at runtime
```

Point your B2 Event Notification rule at `https://<host>/api/events/b2`
(TLS via reverse proxy or cloudflared). The worker holds no state between
jobs — everything durable lands in B2 — so it runs identically on a $30
VPS (Hetzner; **Vultr has zero-cost transfer with Backblaze**), scale-to-
zero platforms (Fly.io Machines), or k8s. Mount real scratch space over
`/tmp` for large masters. Secrets never enter the images (`.dockerignore`
excludes `.env`; config is injected at runtime).

Proven by `scripts/docker-proof.sh`: the built containers + MinIO run the
full loop — signed event → containerized pipeline → derivatives + an
SDK-verified Genblaze manifest — and the worker image answers for ffmpeg,
MediaInfo, Java, and 61 Photon jars.

**Scaling the worker.** Two axes, with a plateau worth knowing:

```bash
WORKER_CPUS=8 docker compose up          # vertical: cap/grant CPU per worker (0 = unlimited)
docker compose up --scale worker=3       # horizontal: N stateless workers, DNS round-robined
```

A standard QC run costs ~0.1–0.3× content duration on 8 cores (full-decode
passes dominate; the AI lane is ~zero local CPU — inference is GMI's).
The heavy hitter is opt-in reference VMAF (~content duration). Per-job speedup plateaus around
8–16 cores — ffmpeg decode threads saturate — so past one beefy worker,
scale horizontally: jobs are independent and workers stateless.
Roadmap: the metering ledger already bills QC in media-minutes, which IS
the autoscaling signal — a queue + KEDA scaling workers on backlogged
media-minutes.

**Hybrid compute — a sender checkbox.** Register two workers on the
gateway (`PIPELINE_URL` = local, `PIPELINE_URL_CLOUD` = the Docker/cloud
worker) and the sender's **"Cloud compute"** checkbox routes each transfer
at dispatch. Every worker carries a `WORKER_LABEL` stamped into progress
events (`waystation @ cloud-docker: …`) and into the **Genblaze manifest**
(`run.metadata.compute`) — the delivery page's provenance line shows
exactly where the master was processed. A deployed worker sets
`GATEWAY_URL` for its own route back to the gateway. Proven by
`scripts/compute-proof.sh`: two transfers through the same gateway, one
per checkbox state — manifests record `local` and `cloud-docker`
respectively, each crunched by a genuinely different process (host python
vs the shipped container).

Multipart is assembled server-side from `ListParts`, so the browser never reads
part ETags — no cross-origin Expose-Headers needed (works on MinIO and B2).

## Status

- ✅ **Phase 1 — transfer, verified end-to-end** (`gateway/scripts/e2e.mjs`,
  passed at 40 MB + 250 MB on a real S3 API): presigned multipart upload →
  `ListParts` resume → complete → download → BLAKE3 verify.
- ✅ **Phase 2 slice — reactive loop, verified end-to-end**
  (`scripts/phase2-loop-proof.sh`): signed B2 event → gateway → pipeline
  doing **real work** (ffprobe metadata + ffmpeg poster frame) → provenance
  manifest + derivatives in storage → live SSE progress. Loop-safe
  (outputs under `derivatives/`).
- ✅ **Recipient delivery page** (`/?t=<id>`) — preview, AI summary,
  download, and a working **Verify provenance** button (re-hashes the
  original + derivatives, compares to the manifest). Endpoint
  `GET /api/transfers/:id`; proven by `scripts/delivery-proof.sh`.
- ✅ **bao outboard — verified, resumable, tamper-checked range download.**
  Upload produces a `.obao` sidecar; download pulls the object in
  chunk-aligned ranges and verifies each against the BLAKE3 root before
  accepting (`crates/blake3-outboard` + `client/src/downloader.ts`).
  Native cargo tests + the comprehensive `gateway/scripts/e2e.mjs` cover it.
- ✅ **B2 Object Lock on the manifest** — when `MANIFEST_LOCK_DAYS > 0`, the
  provenance manifest is written WORM (COMPLIANCE retention): immutable,
  even to the account owner, until expiry. Proven by
  `scripts/object-lock-proof.sh` (locked version cannot be deleted).
  Requires the bucket created with Object Lock enabled.
- ✅ **Metering ledger (billing-ready).** Every billable event — transfer GB,
  thumbnail, summarize, QC minutes — is recorded per transfer, each entry
  traceable to the provenance manifest (`gateway/src/metering.ts`,
  `GET /api/transfers/:id/usage`, optional `METERING_FILE` JSONL export).
  Maps 1:1 onto Stripe/Lago usage meters for real billing later.
- ✅ **Deterministic QC lane.** ffmpeg/ffprobe checks at the waystation —
  decode/corruption, black frames, freeze frames, audio silence, EBU R128
  loudness, stream conformance — **plus caption/subtitle QC**: track
  presence, SRT/VTT validity, cue timing (overlaps, past-EOF, ordering),
  readability limits (20 CPS, 42 chars/line, 2 lines/cue), and coverage.
  A sidecar `.srt`/`.vtt` uploaded with the master rides into the QC (and
  never triggers its own pipeline run). Report written as a
  provenance-covered `qc_report.json`, billed per media-minute, rendered as
  a pass/warn/fail badge on the delivery page. Proven by
  `scripts/qc-proof.sh` (clean master + compliant captions pass; black+
  silent clip with broken captions flagged with exact defect counts).
- ✅ **AI summary via GMI Cloud** (`summarize_via_gmi`) — grounded in the
  caption text + codec/resolution facts, so it describes the actual content.
  Proven live against real B2 + GMI (`scripts/live-run.sh`,
  `GMI_MODEL=google/gemini-3.5-flash`).
- ✅ **Sender front end with per-service toggles.** The upload page
  (`client/index.html`) has a master picker, an optional `.srt`/`.vtt`
  captions picker, and a services panel — AV QC, Caption QC, preview
  thumbnail, AI summary — plus a **Transfer only** switch that turns
  everything off and makes Waystation a plain verified file-transfer tool.
  Selections ride the `complete` call, are stored per transfer, and gate
  the pipeline at BOTH triggers (dev-complete and the signed B2 event
  path); disabled steps emit `step_skipped`, all-off emits
  `pipeline_skipped` and no worker run at all. Proven by
  `scripts/toggle-proof.sh` (transfer-only produces zero derivatives;
  caption-QC-only report contains no AV checks; no-options default runs
  everything; non-caption sidecar names rejected).
- ✅ **Agentic AI QC reporter** (`qc_ai` toggle, on by default) via
  Genblaze's `genblaze_gmicloud.chat` SDK wrapper and GMI's multimodal gemini
  (`GMI_MULTIMODAL_MODEL`, default
  `google/gemini-3.5-flash` — accepts both `image_url` AND `input_audio`
  through the OpenAI-compatible API). A versioned standing charter performs
  three separate passes: an independent sweep with no instrument findings,
  an instrument-informed reconciliation after one bounded adaptive evidence
  round, and an independent critic. The model can request only allowlisted,
  read-only evidence: frame, frame burst, contact sheet, audio window,
  transcript window, or pixel crop. Numeric inputs are clamped before ffmpeg.
  No pass can execute commands or alter media.
  - **`ai_caption_accuracy`** — the caption-QC instrument: transcribe an
    `AI_QC_ASR_SECONDS` (45s) audio window, word-error-rate the transcript
    against the caption cues covering that window; ≥80% word match passes.
    Live run: TTS speech + matching SRT → 100% (21/21 words); mismatched
    captions → 0%, flagged.
  Findings merge into the same provenance-covered `qc_report.json`
  (`report.agentic` records prompt version/hash, passes, evidence, and model;
  `report.ai` records units); metered as `qc_ai` (frames) +
  `qc_ai_asr` (seconds). Proven without cloud spend by
  `scripts/ai-qc-proof.sh` (mock GMI server; all three passes, adaptive
  evidence, matching vs mismatched captions, gating, metering).
- ✅ **Comprehensive QC engine** (`pipeline/qc/` — structural → signal → AI
  execution order, per-analyzer crash isolation, findings tiered
  **BLOCKER / ISSUE / FYI**). Beyond the original lane:
  - *Structural (Task 1)*: DTS monotonicity + timeline-gap scan,
    header-vs-payload comparison, multipart-delivery detection, optional
    **MediaInfo** wrapper/profile cross-checks (MXF OP1a, AS-11/UK DPP
    visibility, HDR/Dolby metadata FYIs), HLS/DASH manifest lint, IMF
    detection with **Photon** wrapped as a subprocess
    (graceful, explicit finding when JVM/jar absent).
  - *Video (Task 2)*: EBU-R103-style legal range with a proper
    **amplitude + picture-area** policy (lut violation-mask → exact
    out-of-range pixel fraction; codec ringing doesn't false-flag),
    letterbox/pillarbox mattes, aspect/anamorphic sanity, field order +
    3:2 pulldown cadence (idet), picture boundaries, upconversion screen,
    **PSE flash-risk scanner** (BT.1702-informed YDIF analysis),
    CEA-608/A53 + AFD + Dolby Vision side-data detection, and a
    **reference lane** vs an uploaded `*.ref.*` mezzanine: SSIM, PSNR, and
    **VMAF as the PVQ model (reported as 1–5 MOS)**.
  - *Audio (Task 3)*: BS.1770-4 integrated + max short-term + LRA +
    **max true peak** (ebur128 peak=true), inter-channel phase correlation,
    clipping monitor (astats), 50/60 Hz hum band-energy screen, channel-map
    verification.
  - *Text (Task 4)*: collision matrix + rapid transitions, CPS + WPM
    density, encoding/markup validation, and a speech-alignment analyzer
    that estimates sync drift by sliding cues against silencedetect speech
    activity. AI lane adds profanity/compliance NLP + spoken-language-vs-tag
    verification + censorship-artifact screening (Rule 3).
- ✅ **Netflix strict profile** — single toggle in the sender UI. Enforces
  the delivery constraints wherever the toolchain can measure them:
  −24 LKFS ±1.0 / −2.0 dBTP hard limits, allowed native framerates only,
  no VFR / pulldown / interlace, single-asset rule, censorship elements
  blocked, PSE hard-fail, R103 escalation. Report carries
  `profile_label: Netflix_Delivery_Specification_Strict` + tier counts,
  rendered as chips on the delivery page.
- ✅ **Read-only reporting contract and mandatory risk coverage.** Waystation
  never repairs or rewrites the master. `qc_report.json` separates the QC
  verdict from coverage completeness and includes all 18 registered risk
  families, each with `CLEAR`, `CONFIRMED`, `SUSPECTED`, `REVIEW_REQUIRED`,
  `UNVERIFIED`, `BLOCKED`, or `NOT_APPLICABLE`. The deterministic validator
  fills any model omission, so a clean sample cannot silently erase certified
  PSE, Dolby/HDR internals, lip sync, dead pixels, subtle artifacts, creative
  intent, color intent, ABR playback, audio transients/channel semantics,
  language/localization, editorial continuity, AS-11/DPP, IMF, or encrypted
  stream risk. `accounting_complete` means no category was omitted;
  `assessment_complete` remains false while any review/gap is unresolved.
  Proven by `scripts/agentic-qc-proof.sh` and `scripts/ai-qc-proof.sh`.
  `scripts/netflix-qc-proof.sh` also sends the retired legacy `self_heal`
  option and proves it creates no check, derivative, meter, or manifest step.
  The same proof shows a compliant 24p/−24 LUFS
  master passes with ZERO blockers (incl. VMAF 97.9 / MOS 4.9 vs its
  mezzanine); a 30fps/superwhite/hot-audio master draws exactly 4 BLOCKERs
  under Netflix but zero under Standard; a strobe clip hard-fails the PSE
  screening scanner; `.ref` sidecars upload but never trigger pipeline runs.
- ✅ **Real-cloud run with the full engine** (`scripts/live-event-run.sh`):
  cloudflared tunnel → public webhook → gateway with the dev trigger OFF —
  a production-shaped, HMAC-signed `b2:ObjectCreated` event delivered over
  the public internet drove the pipeline against real B2 + real GMI.
  Live results: 3 BLOCKERs as mastered (30p framerate, −10.7 LKFS,
  +8.1 dBTP); Gemini vision caught the **burned-in timecode** in the test
  pattern; caption accuracy 100% (21/21 words vs real ASR); summary grounded
  in captions. The current product intentionally reports rather than repairs.
- ✅ **WORM provenance on real Backblaze B2** (`MANIFEST_LOCK_DAYS=1`):
  the manifest wrote with COMPLIANCE retention (24 h). Versioned delete →
  **AccessDenied**, retention shortening → refused — with a key that holds
  `deleteFiles` AND `bypassGovernance`. The QC report's manifest is
  provably immutable, even to the bucket owner.
- ✅ **B2-fired Event Notifications — the reactive loop, proven end to end
  by Backblaze itself** (`scripts/live-event-run.sh` +
  `scripts/b2-register-events.sh`). A `b2:ObjectCreated:*` rule (prefix
  `transfers/`, HMAC-signed) is registered on the bucket via the native
  API, pointing at the gateway through a cloudflared tunnel, with the dev
  trigger OFF. Airtight test: an object uploaded **directly to B2**, with
  the gateway never contacted for the upload — within ~3 s **B2 fired the
  event**, the gateway dispatched, and the pipeline ran 28 QC checks and
  wrote a thumbnail, QC report, and a COMPLIANCE-locked Genblaze manifest
  back to B2 (delete then refused with AccessDenied). The only registered
  path that dispatches a job is the webhook, so Backblaze — not the
  browser, not the gateway — started the pipeline. Quick-tunnel URLs are
  ephemeral; re-run `scripts/b2-register-events.sh` after a tunnel restart.
- ✅ **Real Genblaze manifests** (`genblaze-core` 0.3.6, schema v1.5): the
  provenance manifest is a genuine `genblaze_core.models.Manifest` — Run →
  Steps (with provider/model attribution: `ffmpeg/poster-frame`,
  `waystation/qc-reporter`, plus separate `gmicloud/<model>` independent,
  informed, and critic steps) → Assets with SHA-256 —
  canonical-hashed and **self-verified with the SDK's own verifier** before
  upload, then WORM-locked. The delivery page shows the schema + canonical
  hash and its Verify button re-hashes every asset against the manifest.
  Proven by `scripts/delivery-proof.sh` (SDK `verify_hash()` + asset
  re-hash assertions). Pipeline venv now Python 3.13.
- ✅ **AI-targeted escalation** — the two lanes cooperate: when blackdetect/
  freezedetect flag segments, their exact timecodes ride in the report
  (`report.detections`) and the AI lane samples a **before / inside / after**
  frame triple around each one for Gemini to adjudicate — same-shot-
  continuing ⇒ DEFECT, scene-change ⇒ intentional editorial event. Verdicts
  land as an `ai_escalation` supervisor annotation (instrument readings are
  never mutated) and are metered separately (`qc_ai_escalation`, frames).
  Live-verified both ways: a black hole punched into a continuing shot →
  "accidental dropout/defect"; a fade–hold–fade into a new scene →
  "intentional transition". Proven by `scripts/ai-qc-proof.sh` (clip E:
  detection timecodes in the report, verdict surfaced, frames metered,
  and NO escalation call when nothing was flagged).
- ✅ **Photon executes for real (Rule 4).** `scripts/fetch-photon.sh`
  vendors Netflix's Photon 5.0.1 + its 60-jar dependency tree from Maven
  Central (gitignored under `vendor/`); with `PHOTON_JAR` set, an IMF
  package (zip carrying `ASSETMAP.xml`) is extracted and run through
  **IMPAnalyzer** as a subprocess — its genuine ST 2067-21 schema findings
  parse into the report and a non-conformant package is a **BLOCKER**
  under the netflix profile. The wrapper probes for a *working* JVM
  (macOS's `/usr/bin/java` stub famously exists-but-fails) and flags
  "no analysis output" rather than false-passing. Proven by
  `scripts/photon-proof.sh` (self-skips with instructions when Photon
  isn't fetched).
- ✅ **Measured lip-sync via SyncNet (not a VLM).** A general vision model
  was empirically shown to confabulate lip-sync verdicts — it called a gross
  1.7 s A/V offset "in sync" with high confidence — so Waystation does NOT
  use the AI lane for sync. Instead `qc/avsync.py` wraps the purpose-built
  **SyncNet** AV-sync model (`scripts/fetch-syncnet.sh`, `SYNCNET_DIR`) as an
  optional analyzer (Photon pattern): it reports a real per-face-track offset
  in ms. When SyncNet is absent it emits an explicit FYI — never a silent
  pass — and the deterministic container/envelope proxy catches gross drift.
  The coverage engine forbids the AI model from ever clearing the `lip_sync`
  risk (`model_unreliable`), and more broadly instruments now always win over
  model dispositions. Proven by `scripts/avsync-proof.sh`.
- ✅ **Prompt-native human QC charter** — the independent sweep explicitly
  searches sampled evidence for pixel defects, isolated corruption, banding,
  moire, cadence/judder, color discontinuities, text/graphics mistakes,
  audio clicks/dropouts/tones/channel errors, lip sync, language/localization,
  editorial continuity, creative ambiguity, and generated-media failure
  modes. Captions and metadata are treated as untrusted evidence to prevent
  prompt injection. The report identifies evidence IDs, timecodes, confidence,
  and known sampling limits instead of claiming full-timeline clearance.
- ✅ **Synthetic QC lane** (`qc_synthetic` toggle) — QC for media that was
  never shot. Three prompt engines: **generation artifacts** (anatomy,
  garbled glyphs, physics, seams, AI sheen + an origin assessment),
  **temporal coherence** (frame bursts checked for identity drift and
  object permanence — the live run caught testsrc2's morphing shape as a
  permanence violation), and **prompt adherence**: an uploaded
  `.genblaze.json` generation record makes the manifest's own prompt the
  QC reference — live-scored **98/100** for a matching prompt and
  **0/100** for a mismatched one ("no red ball visible; nothing bounces").
  Metered as `qc_synthetic` frames; redacted prompts reported honestly as
  not-scorable. Proven by `scripts/synthetic-qc-proof.sh` (mock GMI:
  defects surfaced, gating, sidecar event-filtering, metering) and live
  against real GMI. GMI calls now pace themselves and back off on 429s.
- **Declared, honestly gated**: unsupported certification and specialist
  bitstream/playback checks remain explicit `REVIEW_REQUIRED` or `UNVERIFIED`
  registry entries rather than silent gaps or false passes.

Reproduce locally (no cloud creds), each self-contained on MinIO + ffmpeg:
`bash scripts/phase2-loop-proof.sh` · `bash scripts/delivery-proof.sh` ·
`node gateway/scripts/e2e.mjs` (with a gateway pointed at MinIO/B2).

## Gotchas

1. **B2 CORS must `exposeHeaders: ["ETag"]`** or `complete` fails (`config/b2-cors.json`).
2. **Pipeline writes go under `derivatives/`** so they don't re-trigger the event; the gateway also drops `.obao` sidecars.
3. On Cloudflare Workers, the gateway's presigning would switch from `@aws-sdk` to `aws4fetch` (already used by `cdn-worker`).
