# Waystation - Devpost "About the project"

> Paste-ready copy for the Devpost submission form. Everything claimed here is
> reproduced by a proof script in `scripts/` or was verified live against real
> B2 + GMI - no aspirational features.

## Elevator pitch (≤ 200 chars)

Send mastered video through a cloud waystation on Backblaze B2 - it arrives
QC'd to broadcast spec, AI-reviewed, self-healed, and provable under an
immutable WORM manifest.

---

## Inspiration

Studios move mastered video with tools like IBM Aspera - fast, but the file
arrives exactly as dumb as it left. Meanwhile every delivery still gets
QC'd, summarized, and cataloged *after* it lands, by hand or by a second
enterprise product (Interra BATON, Telestream Vidchecker, Venera Pulsar -
all thousands per seat). The file spends minutes parked in cloud storage
either way. **Waystation uses that parking time**: while your master sits in
Backblaze B2, a reactive pipeline QCs it against a delivery spec, reviews it
with multimodal AI, fixes what's fixable, and locks the evidence under
Object Lock - so what arrives is not a file, but a *delivery*.

## What it does

- **Verified transfer** - browser-side BLAKE3 + parallel presigned multipart
  straight to B2, crash-resumable via `ListParts`; a bao outboard sidecar
  enables verified *range* downloads (every chunk checked against the
  content root before it's accepted).
- **Reactive pipeline** - B2 Event Notifications (HMAC-signed webhook) fire
  the QC worker the moment the object lands. No polling, no compute babysitting.
- **Broadcast-grade QC** - structural (timecode continuity, container
  integrity, multipart detection), signal (full-decode pass, black/freeze/
  silence, EBU R103 legal range with a real amplitude+area policy, ITU-R
  BS.1770-4 loudness/true-peak/LRA, phase, clipping, hum, mattes, PSE
  flash-risk), captions (timing, collisions, CPS/WPM, encoding, speech-sync
  drift), and reference SSIM/PSNR/**VMAF scored as a 1–5 MOS** against an
  optional source mezzanine.
- **AI QC lane (GMI Cloud)** - Gemini vision reviews sampled frames for what
  filters can't name (slates, watermarks, burned-in timecode, censorship
  artifacts); Gemini's audio modality transcribes a sample window and the
  transcript is **word-error-rate diffed against the captions** - automated
  caption accuracy. Plus a caption-grounded one-line summary for the recipient.
- **AI-targeted escalation** - the lanes cooperate: when the deterministic
  scanner flags black/frozen segments, Gemini adjudicates before/inside/after
  frames from those exact timecodes - same-shot-continuing means DEFECT,
  scene-change means intentional editorial event. Live-verified: it called a
  spliced-in black hole "an accidental dropout" and a fade-to-black between
  scenes "an intentional transition."
- **Prompt-native QC** - the semantic checks incumbents sell as trained
  classifiers, done as structured prompts: slates READ and cross-checked
  against the delivery, burned-in text/QR/timecode read off the pixels
  (a live run transcribed the test pattern's frame counter), rating cards,
  viewer-perception severity judgments, a prompted no-reference MOS, and
  subtitle proofreading.
- **Synthetic QC for generative media** - QC for video that was never shot:
  generation artifacts (anatomy, garbled text, physics, AI sheen), temporal
  coherence across frame bursts (identity drift, object permanence), and the
  one no incumbent can build - **prompt adherence**: the Genblaze manifest's
  recorded generation prompt becomes the QC reference, and the waystation
  scores whether the output matches its own declared intent. Live: 98/100
  for a faithful clip, 0/100 for a mismatched one.
- **Netflix strict profile** - one toggle swaps thresholds for a
  zero-tolerance delivery spec (−24 LKFS ±1, −2 dBTP, native frame rates
  only, no pulldown, PSE hard-fail). Findings tier into
  **BLOCKER / ISSUE / FYI**.
- **Self-healing** - failed loudness is normalized to target with a two-pass
  linear loudnorm (video stream copied, no re-render); illegal video levels
  are clamped by a limiter legalizer. The healed copy is **re-measured with
  the same instruments** and delivered beside the original.
- **Provable provenance** - every run emits a real **Genblaze manifest**
  (`genblaze-core`, schema v1.5): Run → Steps with provider/model
  attribution → SHA-256 Assets, canonical-hashed and verified with the
  SDK's own verifier, then written to B2 under **Object Lock COMPLIANCE** -
  in our live run the bucket owner's own key, holding `deleteFiles` +
  `bypassGovernance`, was refused deletion.
- **Billing-ready metering** - every billable act (transfer GB, QC minutes,
  AI frames, ASR seconds, heal runs) is a ledger entry traceable to the
  manifest; maps 1:1 onto Stripe/Lago usage meters.
- **Transfer-only mode** - turn everything off and it's a plain verified
  file-transfer tool. Every service is a sender-side toggle.

## How we built it

Browser (Vite/TS + Rust→wasm BLAKE3/bao) → Hono/Node gateway (control plane
only - presigned URLs, event webhook, SSE progress, metering; it never
touches file bytes) → Python/FastAPI worker (ffmpeg/ffprobe deterministic
lanes + GMI Cloud multimodal lane) → everything back into B2 under
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
- Self-heal took a −10.7 LKFS / +8.1 dBTP master to **−24.3 LKFS / −5.1
  dBTP, verified by re-measurement**, in one automatic pass.
- Live Gemini vision caught the **burned-in timecode** in our test master
  unprompted; ASR caption accuracy scored 21/21 words.
- A QC report nobody - including us - can alter for 24 hours.
- Six one-command proof scripts; every feature claim in this page is
  executable.

## What we learned

Deterministic instruments and AI judges are complements, not substitutes:
ffmpeg measures LUFS, Gemini recognizes a slate - a QC system needs both
lanes, and the provenance layer must anchor *both* kinds of verdicts.

## What's next

Dolby Vision canvas verification via dovi_tool, and per-customer billing
on the metering ledger. (IMF validation via Netflix's Photon already
executes: a non-conformant package is a BLOCKER with Photon's own ST
2067-21 schema findings in the report.)

---

## Built with (tags)

`backblaze-b2` · `gmi-cloud` · `gemini` · `typescript` · `rust` ·
`webassembly` · `python` · `fastapi` · `hono` · `node.js` · `vite` ·
`ffmpeg` · `blake3` · `bao` · `boto3` · `cloudflare-workers` ·
`cloudflared` · `server-sent-events` · `minio` · `vmaf` · `libx264` ·
`object-lock` · `s3-api` · `websockets`
