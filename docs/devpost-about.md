# Waystation - Devpost "About the project"

> Paste-ready copy for the Devpost submission form. Everything claimed here is
> reproduced by a proof script in `scripts/` or was verified live against real
> B2 + GMI - no aspirational features.

## Elevator pitch (≤ 200 chars)

Send mastered video through a cloud waystation on Backblaze B2 - it arrives
QC'd to broadcast spec, independently AI-inspected, and provable under an
immutable WORM manifest - with every unresolved risk disclosed.

---

## Inspiration

Studios move mastered video with tools like IBM Aspera - fast, but the file
arrives exactly as dumb as it left. Meanwhile every delivery still gets
QC'd, summarized, and cataloged *after* it lands, by hand or by a second
enterprise product (Interra BATON, Telestream Vidchecker, Venera Pulsar -
all thousands per seat). The file spends minutes parked in cloud storage
either way. **Waystation uses that parking time**: while your master sits in
Backblaze B2, a reactive pipeline QCs it against a delivery spec, reviews it
with multimodal AI, builds a read-only issue report, and locks the evidence under
Object Lock - so what arrives is not a file, but a *delivery*.

## What it does

- **Verified transfer** - browser-side BLAKE3 + parallel presigned multipart
  straight to B2, crash-resumable via `ListParts`; a bao outboard sidecar
  enables verified *range* downloads (every chunk checked against the
  content root before it's accepted).
- **Reactive pipeline** - B2 Event Notifications (HMAC-signed webhook) fire
  the QC worker the moment the object lands. No polling, no compute babysitting.
  Proven with real Backblaze events: an object uploaded straight to the bucket
  (the gateway never touched) had B2 itself fire the event and drive the whole
  pipeline within seconds.
- **Broadcast-grade QC** - structural (timecode continuity, container
  integrity, multipart detection, optional MediaInfo MXF OP1a / AS-11 / HDR
  metadata cross-checks), signal (full-decode pass, black/freeze/
  silence, EBU R103 legal range with a real amplitude+area policy, ITU-R
  BS.1770-4 loudness/true-peak/LRA, phase, clipping, hum, mattes, PSE
  flash-risk), captions (timing, collisions, CPS/WPM, encoding, speech-sync
  drift), and reference SSIM/PSNR/**VMAF scored as a 1–5 MOS** against an
  optional source mezzanine.
- **Agentic AI QC reporter (GMI Cloud)** - a versioned standing charter runs
  three passes: an independent human-defect sweep with no instrument results,
  an instrument-informed reconciliation after a bounded adaptive evidence
  round, and an independent critic. The agent can request only read-only
  frames, frame bursts, contact sheets, audio windows, transcripts, or pixel
  crops; it cannot execute commands or alter media. Gemini's audio modality
  also transcribes a sample window that is **word-error-rate diffed against
  the captions** for automated caption accuracy.
- **AI-targeted escalation** - the lanes cooperate: when the deterministic
  scanner flags black/frozen segments, Gemini adjudicates before/inside/after
  frames from those exact timecodes - same-shot-continuing means DEFECT,
  scene-change means intentional editorial event. Live-verified: it called a
  spliced-in black hole "an accidental dropout" and a fade-to-black between
  scenes "an intentional transition."
- **Prompt-native human QC** - the charter searches evidence for pixel defects,
  isolated corruption, banding, moire, cadence/judder, color discontinuities,
  text and graphics mistakes, clicks/dropouts/tones, channel errors, lip sync,
  language/localization, editorial continuity, creative ambiguity, and
  generated-media failure modes. Filenames, captions, metadata, transcripts,
  and visible text are explicitly treated as untrusted evidence.
- **Synthetic QC for generative media** - QC for video that was never shot:
  a planning agent turns the recorded generation intent into atomic QC
  assertions, while a deterministic fallback accounts for all 14 generated-
  media dimensions. A full-timeline coarse scene ledger tracks subjects,
  objects, backgrounds, and text; suspicious timecodes receive jittered dense
  verification, and model-located typography is re-read from native-resolution
  crops and compared across time. The report exposes the blueprint, evidence,
  unresolved dimensions, and **prompt adherence** against the Genblaze
  manifest's own recorded intent. Sampled AI observations can raise an ISSUE,
  never reject or claim full-timeline clearance. Earlier live captures scored
  98/100 for a faithful clip and 0/100 for a mismatched one; the expanded flow
  is integration-proven with mock GMI.
- **AI Reliability Passport - Waystation QCs the AI** - the innovation no
  QC product ships: every AI-derived finding carries an auditable measurement
  of the AI itself, on two axes and never a composite score. **Blind Jury:**
  a second model family independently re-perceives the same evidence (it is
  never shown the first model's findings), its observations replay through the
  same deterministic reducer, and the structured findings are matched in code
  → `reproduced / contested / single_source`; a contested finding stays
  suspected with *raised* review priority. **Proficiency Foundry:** seeded
  challenge suites plant one precisely measured defect (a sign that flips
  `ARRIVALS → 4RRIVALS`) beside untouched clean twins, hide the ground truth,
  run the exact production lane blind, and score detection deterministically —
  sensitivity AND clean-twin specificity with Wilson intervals, honestly
  labeled `PROVISIONAL · n=5`. The proficiency record is sealed under B2
  Object Lock and citable only while the exact model/prompt/reducer
  configuration still matches — any drift renders the lane UNCALIBRATED. In
  our first live run the planted mutation was caught by the primary model and
  independently reproduced by the blind juror.
- **Netflix strict profile** - one toggle swaps thresholds for a
  zero-tolerance delivery spec (−24 LKFS ±1, −2 dBTP, native frame rates
  only, no pulldown, PSE hard-fail). Findings tier into
  **BLOCKER / ISSUE / FYI**.
- **No silent gaps** - the final report separates QC verdict from coverage.
  A deterministic validator accounts for 18 risk families even if the model
  omits one: certified PSE, Dolby/HDR internals, lip sync, dead pixels, subtle
  artifacts, creative/color intent, ABR playback, audio transients/channel
  semantics, language/localization, editorial mistakes, AS-11/DPP, IMF, and
  encrypted streams. Every applicable item is `CLEAR`, `CONFIRMED`,
  `SUSPECTED`, `REVIEW_REQUIRED`, `UNVERIFIED`, or `BLOCKED`. Waystation is a
  reporter only and never rewrites the submitted master.
- **Provable provenance** - every run emits a real **Genblaze manifest**
  (`genblaze-core`, schema v1.5): Run → Steps with provider/model
  attribution → SHA-256 Assets, canonical-hashed and verified with the
  SDK's own verifier, then written to B2 under **Object Lock COMPLIANCE** -
  in our live run the bucket owner's own key, holding `deleteFiles` +
  `bypassGovernance`, was refused deletion.
- **Billing-ready metering** - every billable act (transfer GB, QC minutes,
  AI frames, ASR seconds, and adaptive evidence) is a ledger entry traceable to the
  manifest; maps 1:1 onto Stripe/Lago usage meters.
- **Transfer-only mode** - turn everything off and it's a plain verified
  file-transfer tool. Every service is a sender-side toggle.

## How we built it

Browser (Vite/TS + Rust→wasm BLAKE3/bao) → Hono/Node gateway (control plane
only - presigned URLs, event webhook, SSE progress, metering; it never
touches file bytes) → Python/FastAPI worker (ffmpeg/ffprobe deterministic
lanes + Genblaze `genblaze_gmicloud.chat` into GMI Cloud) → everything back into B2 under
`derivatives/`. Backblaze B2 is used deeply: S3-compatible multipart with
server-side `ListParts` assembly (no CORS ETag exposure needed), Event
Notifications over a cloudflared tunnel, Object Lock COMPLIANCE for the
manifest, presigned delivery. AI runs on GMI Cloud's OpenAI-compatible API
(`google/gemini-3.5-flash`) - one discovery we're proud of: GMI serves no
dedicated ASR model, but Gemini accepts `input_audio` content parts, so
**Gemini is the ASR** for caption-accuracy checking.

## Challenges we ran into

- Absolute-min/max legal-range checking flags *every* lossy encode (codec
  ringing), so we implemented the industry policy: out-of-range **pixel
  fraction** vs a picture-area threshold, measured exactly with a lut
  violation-mask (and discovered ffmpeg's `lutyuv` min/max values are
  color-range dependent the hard way).
- Browser multipart on B2/MinIO without CORS `ExposeHeaders` - solved by
  assembling from `ListParts` server-side, so the browser never reads ETags.
- A caption file that alphabetically sorted before the master exposed a
  sidecar-detection bug on the delivery page - caught because we demo on the
  real UI, not just scripts.

## Accomplishments we're proud of

- The same violating master gets **4 BLOCKERs under Netflix strict and zero
  under Standard** - profiles are real policy, not labels.
- A model cannot manufacture an all-clear: the deterministic registry inserts
  every omitted applicable risk and preserves certification/intent limits as
  explicit review items.
- Live Gemini vision caught the **burned-in timecode** in our test master
  unprompted; ASR caption accuracy scored 21/21 words.
- A QC report nobody - including us - can alter for 24 hours.
- Sixteen one-command proof scripts; every feature claim in this page is
  executable.

## What we learned

Deterministic instruments and AI judges are complements, not substitutes:
ffmpeg measures LUFS, Gemini recognizes a slate - a QC system needs both
lanes, and the provenance layer must anchor *both* kinds of verdicts.

## What's next

Specialist Dolby Vision RPU/canvas verification via dovi_tool, certified PSE,
full-timeline dead-pixel/audio-transient classifiers, and real-player ABR
exercise. Those are already explicit unresolved registry items rather than
silent passes. IMF validation via Netflix Photon already executes, and
per-customer billing can build directly on the metering ledger.

---

## Built with (tags)

`backblaze-b2` · `gmi-cloud` · `gemini` · `typescript` · `rust` ·
`webassembly` · `python` · `fastapi` · `hono` · `node.js` · `vite` ·
`ffmpeg` · `blake3` · `bao` · `boto3` · `cloudflare-workers` ·
`cloudflared` · `server-sent-events` · `minio` · `vmaf` · `libx264` ·
`object-lock` · `s3-api` · `websockets`
