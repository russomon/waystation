# OrbitXfer Web

Send huge media — it arrives smarter. High-speed delivery over **Backblaze B2**
(the cloud waystation) with an AI enrichment pipeline (**Genblaze + GMI Cloud**)
that runs while the file is parked, and a verifiable provenance trail.

Built for the [Backblaze Generative Media Hackathon](https://backblaze-generative-media.devpost.com/).

## Flow

```
browser ──parallel multipart (BLAKE3)──▶ B2 (originals)
                                          │ object-created Event Notification
                                          ▼
                                   gateway /api/events/b2
                                          │ dispatch
                                          ▼
                              Genblaze pipeline (GMI Cloud)
                       transcode preview · transcribe · caption · summarize · tag
                                          │ derivatives + provenance manifest
                                          ▼
                                  B2 (derivatives/)   ──CDN──▶ recipient
        progress streams the whole way via SSE (gateway /api/progress/:id)
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
( cd pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt )  # needs ffmpeg

# every time
bash scripts/dev-up.sh                          # MinIO + gateway + pipeline + Vite client
#   GMI_API_KEY=... bash scripts/dev-up.sh      # to enable the real summarize step
```

Or run pieces individually: `npm run dev:gateway` · `dev:client` · `dev:pipeline`.
For real B2 webhooks in dev, expose the gateway: `cloudflared tunnel --url http://localhost:8787`.

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
- ✅ **AI-assisted QC lane** (`qc_ai` toggle, on by default). Two checks via
  GMI's multimodal gemini (`GMI_MULTIMODAL_MODEL`, default
  `google/gemini-3.5-flash` — accepts both `image_url` AND `input_audio`
  through the OpenAI-compatible API; GMI serves no whisper models, gemini
  IS the ASR):
  - **`ai_visual`** — vision review of `AI_QC_FRAMES` (4) sampled frames for
    defects filters can't name: test patterns, slates, watermarks, burned-in
    timecode, letterboxing, corruption. Live run correctly flagged a
    `testsrc` clip as "Test pattern".
  - **`ai_caption_accuracy`** — the caption-QC instrument: transcribe an
    `AI_QC_ASR_SECONDS` (45s) audio window, word-error-rate the transcript
    against the caption cues covering that window; ≥80% word match passes.
    Live run: TTS speech + matching SRT → 100% (21/21 words); mismatched
    captions → 0%, flagged.
  Verdicts merge into the same provenance-covered `qc_report.json`
  (`report.ai` records model + units); metered as `qc_ai` (frames) +
  `qc_ai_asr` (seconds). Proven without cloud spend by
  `scripts/ai-qc-proof.sh` (mock GMI server; matching vs mismatched
  captions, gating, metering) and live against real GMI.
- ✅ **Comprehensive QC engine** (`pipeline/qc/` — structural → signal → AI
  execution order, per-analyzer crash isolation, findings tiered
  **BLOCKER / ISSUE / FYI**). Beyond the original lane:
  - *Structural (Task 1)*: DTS monotonicity + timeline-gap scan,
    header-vs-payload comparison, multipart-delivery detection, HLS/DASH
    manifest lint, IMF detection with **Photon** wrapped as a subprocess
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
- ✅ **Self-Healing Engine** (sender toggle): two-pass linear loudnorm to
  the profile target (video stream copied — no re-render) and a luma/chroma
  limiter legalizer when levels are illegal. The healed copy is
  **re-measured with the same instruments** and shipped as a provenance-
  covered derivative with its own download button.
  All proven by `scripts/netflix-qc-proof.sh`: compliant 24p/−24 LUFS
  master passes with ZERO blockers (incl. VMAF 97.9 / MOS 4.9 vs its
  mezzanine); a 30fps/superwhite/hot-audio master draws exactly 4 BLOCKERs
  under Netflix but zero under Standard; its healed copy re-measures at
  −24.0 LUFS / TP ≤ −2 / legal luma; a strobe clip hard-fails the PSE
  scanner; `.ref` sidecars upload but never trigger pipeline runs.
- **Declared, honestly gated** (explicit FYI findings, not silent gaps):
  Dolby Vision dynamic-canvas verification (needs dovi_tool RPU parsing),
  lip-sync ms offsets (no video-input modality on GMI's API), dead-pixel
  tracking (needs long-window frame accumulation), Photon execution
  (needs a JVM + `PHOTON_JAR`).

Reproduce locally (no cloud creds), each self-contained on MinIO + ffmpeg:
`bash scripts/phase2-loop-proof.sh` · `bash scripts/delivery-proof.sh` ·
`node gateway/scripts/e2e.mjs` (with a gateway pointed at MinIO/B2).

## Gotchas

1. **B2 CORS must `exposeHeaders: ["ETag"]`** or `complete` fails (`config/b2-cors.json`).
2. **Pipeline writes go under `derivatives/`** so they don't re-trigger the event; the gateway also drops `.obao` sidecars.
3. On Cloudflare Workers, the gateway's presigning would switch from `@aws-sdk` to `aws4fetch` (already used by `cdn-worker`).
