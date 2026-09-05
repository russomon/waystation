# Decisions

Repo: waystation

Durable decisions a future agent should not have to rediscover — architectural
choices, technology selections, compatibility requirements, data-format and API
conventions, security calls, and approaches deliberately **rejected** and why.

This is **not** a changelog, a session log, or a list of implementation details.
Current state belongs in `CURRENT_WORK.md`, the queue in `NEXT_STEPS.md`, and
finished narrative in `docs/PROJECT_HISTORY.md`.

Entries are newest-first, headed `### YYYY-MM-DD - short claim`, and record:
**Context** (what forced the choice), **Decision / result**, **Why it matters**,
and where useful the rejected alternative and how the decision was verified.
Superseded entries are kept and marked, not deleted — the history of a reversal
is itself the useful part.

### 2026-09-01 - Protected transfers ship as a gateway-only production change

- The low-cost hosted deployment remains `docker-compose.transfer.yml` with
  only gateway and cloudflared. Password protection changes control-plane
  authorization and the static client; it does not require or justify starting
  a QC worker.
- Before migration, take a consistent `VACUUM INTO` snapshot of the WAL-mode
  control database. A successful release must preserve row counts, report
  schema v3 and `integrity_check=ok`, keep cloudflared's container identity,
  and verify every hosted client artifact against its pinned manifest.
- Production met these gates at source `5bb5952`; OrbitWebsite `511f52a`
  publishes the matching client. A complete authenticated recipient exercise
  uses the private access code and must never place that code in logs or docs.

### 2026-09-01 - Recipient passwords gate transfer access without encrypting objects

- A sender may leave the download password blank or provide **1–128
  characters**. Complexity rules are deliberately absent; rate limiting,
  salted scrypt storage, and a short-lived unlock provide the security bounds
  without preventing passphrases or one-character demo credentials.
- Password protection applies to both Transfer and Transfer + QC and to every
  file in a client batch. Each file remains an independent protected transfer.
- Protected transfer metadata, progress, and download-token signing require
  the originating sender session or a transfer-specific signed HttpOnly unlock
  cookie. A missing optional analyzer or QC service is unrelated to access.
- The gateway never stores the plaintext password. Recipient passwords are an
  authorization gate, not client-side encryption: a presigned B2 URL issued
  after unlock remains usable until its existing signature expires.

### 2026-09-01 - Integrity and upload progress are separate user-visible work

- BLAKE3/Bao runs in a Web Worker concurrently with the existing multipart B2
  upload. Finalizing the outboard is reported separately from reading bytes;
  it is no longer displayed as an unexplained 100% hashing pause.
- Every result exposes independent Integrity check and Upload progress. The
  full share URL is the link text and a standard copy icon provides explicit
  clipboard feedback.
- Sender and recipient pages use the established Orbit Olive visual language.
  Branding does not change transfer identity, integrity, or QC behavior.

### 2026-09-01 - Transfer is the default and batches preserve file identity

- Waystation opens in **Transfer** mode because secure delivery is the primary
  path. **Transfer + QC** remains a deliberate second mode containing the
  existing QC and AI controls; no QC capability is removed from the API or
  recipient report.
- A sender may select several files at once, add more in later picker actions,
  or drag-and-drop files. The client queues and uploads them sequentially so a
  batch does not multiply the uploader's existing per-file multipart
  concurrency.
- Every queued file creates its own transfer ID, resumable multipart upload,
  progress record, retry outcome, and share link. A batch is convenience at
  the client boundary, not a new archive object or shared delivery identity.
- Captions and Genblaze manifests attach only when Transfer + QC has exactly
  one master. Applying one sidecar across a multi-master batch would be
  ambiguous and is therefore disabled rather than guessed.
- Transfer mode explicitly sends all service flags off and relies on the
  gateway's proven transfer-only path. This change does not require a gateway
  or worker deployment.

### 2026-08-03 - Caption semantics require temporal alignment, not prompt proximity

- An AI caption match or text-quality clearance is ineligible unless a cited
  audio window contains at least one temporally overlapping caption cue and the
  observation supplies a bounded transcription. Supplying an entire sidecar
  near unrelated audio let a credentialed model invent correspondence despite
  deterministic 0% overlap; prompt instructions alone were not an enforcement
  boundary.
- Video runs with temporal continuity in the versioned risk registry reserve
  one bounded frame sequence even when the planner omits it. Isolated stills
  remain insufficient and produce `not_checked`.
- `interpretive_reuse` is successful AI poster selection with zero incremental
  model calls, not a fallback. The recipient UI must describe it accordingly.
- Run schema `1.8`, packet `1.2`, and prompt `1.7` implement these rules.
  Production was not accessed or changed; local authority remains `shadow`.

### 2026-08-03 - Sender AI is consolidated and local cloud means Docker

- The current sender exposes one AI QC workflow: **AI Interpretive Analysis**.
  It consolidates independent sweep, adaptive evidence, critic/jury, synthesis,
  caption context, temporal sequence evidence, and deterministic audio signal
  grounding. The legacy `qc_ai` request remains API-compatible but is hidden;
  when an older client requests both, explicit interpretation wins and legacy
  AI QC is suppressed to prevent duplicate analysis and spend.
- Cloud compute remains visible and checked by default. Local development
  registers a host worker and the shipped Docker worker by default, so checked
  means a distinct tool-complete Docker process rather than an undisclosed
  fallback. Hosted forced-compute builds keep the same control visible but
  disabled at the enforced value.
- **Creative and delivery context (optional)** is the sender label for the
  existing bounded `review_brief` contract. Renaming the API field would add
  migration risk without changing its security or provenance semantics.
- Thumbnail selection reuses a clean, allowlisted frame cited by the explicit
  interpretive result whenever possible. Reuse has zero additional provider
  calls and no duplicate extraction; the standalone GMI selector is retained
  only as a disclosed fallback.
- These are source and local-proof decisions. Paid explicit defaults remain
  disabled, authority defaults to `shadow`, and production was not changed.

### 2026-08-03 - Judge calibration is a retained profile, not ad hoc shell state

- `scripts/judge-calibration-up.sh` pins the credentialed shadow calibration
  profile to three frames, a bounded 6,144-token specialist ceiling, Gemini
  3.5 visual/audio, and Gemini 3.6 planner/jury/synthesis. Paid defaults remain
  off; no model runs until a sender explicitly selects AI Interpretive Analysis.
- A schema-valid but unusable or malformed provider response may receive one
  compact correction attempt. Every successful provider response is separately
  metered and retained in the attempt ledger; repair can never disappear as a
  single reported call.
- Requested worker compute and actual worker compute are distinct provenance
  fields. Selecting cloud without `PIPELINE_URL_CLOUD` records the local
  fallback; GMI Cloud inference is shown separately from worker location.
- Isolated still frames cannot prove or clear a freeze/timeline defect. The
  reducer retains such temporal output only as `not_checked` with an explicit
  sampling limitation.
- The retained planted/clean pair validates one typography slice, not all AI
  risks and not production. Production remains unchanged and shadow stays the
  only authorized mode for the judge run.

### 2026-08-02 - GMI JSON is a transport contract, not a prose request

- Every explicit AI planner, specialist, jury, and synthesis call supplies a
  provider-supported structured-output mode through Genblaze GMI
  `response_format`, followed by strict bounded local Pydantic validation.
  Gemini uses `json_object` because its GMI backend rejected the OpenAI strict
  schema envelope; compatible endpoints receive the schema directly.
  Asking for JSON only in prompt text is insufficient: a credentialed visual
  stage exhausted 4,096 tokens and returned no complete object despite the
  compact prose contract.
- Provider schema enforcement does not replace Waystation's sanitizer,
  evidence allowlist, authority reducer, or fail-closed state. It reduces
  malformed output; it does not make model content trusted.
- Run schema v1.5 records response mode, local validation state,
  response-schema versions and hashes in stage
  provenance and the prompt packet. Schema rejection, truncation, malformed
  output, or unsupported provider behavior remains `not_checked`, never pass.
- Production and paid defaults remain unchanged. A planted/clean-twin live
  shadow pair is required before release or authority-mode promotion.
- Retryable 429/server/timeout failures receive two bounded attempts by default,
  recorded individually with delay and outcome. Invalid-input failures are not
  retried.

### 2026-08-02 - AI authority requires distinct sources and confirmed intent

- Synthesis is adjudication, not independent evidence. Repeating a specialist
  observation can never satisfy corroboration by itself. Enforceable AI risks
  require two distinct configured provider/model source identities plus a
  separate synthesis agreement; identical model identities used in different
  stages count once, and output missing that provenance is ineligible.
- An enforceable finding must also carry allowlisted stored evidence, policy
  confidence, `reject` severity, and `confirmed_defect` intent. Ambiguous
  creative/editorial intent is a review hold, never an AI rejection.
- Visual evidence is source-time ordered and the model must transcribe visible
  text per frame before judging mutation. Typography rejection requires two
  distinct transcribed evidence IDs and an observed text transition.
  Contradictory `no_concern` typography
  output fails closed to `not_checked`; static composition alone is not a
  freeze diagnosis.
- The optional sender review brief is bounded to 2,000 characters and treated
  as untrusted context. Public provenance directly exposes only presence,
  length, and SHA-256; generated observations may still restate context that is
  relevant to their finding.
- Policy v1.1.0 and run schema v1.5 implement this boundary. The optional jury
  model is configuration-only and adds one metered call when set; absent jury
  configuration is explicit and cannot qualify an AI rejection. Production
  and paid modes were not changed.

### 2026-08-02 - AI completion is structural and sample edges are not source defects

- An explicit AI run is `complete` only when synthesis returns one unique,
  sanitized observation for every versioned policy risk. Specialist success or
  a partial synthesis cannot substitute for complete coverage and remains
  `not_checked`/HOLD.
- Planner output selects bounded evidence locations; code deterministically
  restores the complete policy risk registry. Synthesis receives only compact,
  detached grounding, the validated risk list, evidence catalog, and sanitized
  specialist observations. This preserves AI judgment while eliminating
  repeated narrative that caused provider truncation.
- An extracted audio window's first/last sample is not a source edit. Every
  window records whether its edges equal actual source boundaries. An audible-
  defect claim located only at an interior extraction edge is forced to
  `not_checked`; interior defects remain eligible for review.
- Interpretive run schema v1.2 records prompt/output sizes, token ceilings,
  finish reason, truncation, expected/observed/missing risks, and boundary
  suppression. Production and paid modes remain unchanged.

### 2026-08-02 - Preview imagery is AI-selected, never AI-generated

- Thumbnailing extracts at most six actual source frames across distributed
  timeline anchors. Scene-cut enrichment is capped to short assets so a
  thumbnail-only large transfer never incurs a full-timeline scan. A configured
  GMI vision model may select only
  one candidate ID from that allowlist; it cannot create or modify preview
  imagery.
- The selected frame, all candidate timecodes and hashes, prompt/model/usage,
  provider finish reason, and selection method are stored in a provenance-
  covered `thumbnail_selection.json`. Invalid IDs, malformed output, provider
  failure, or missing credentials use a disclosed deterministic fallback.
- Selecting Preview thumbnail now adds one GMI call when a key is configured.
  Production remains unchanged until a separate deployment decision.

### 2026-08-02 - Local MinIO is non-retained and specialist prompts are lane-scoped

- Local `scripts/dev-up.sh` always starts the worker with
  `MANIFEST_LOCK_DAYS=0`. A production `.env` retention value must not make a
  local MinIO bucket pretend to support B2 Object Lock. Production and Compose
  retain their explicit environment behavior.
- Visual and audio specialists receive only the validated risks and evidence
  relevant to their lane. Synthesis alone receives the complete review plan.
  Provider output is compact JSON with a bounded configurable ceiling, and
  `finish_reason` is retained so truncation is directly auditable.
- The first credentialed local explicit run was an integration diagnostic, not
  QC validation: evidence storage and two paid provider calls succeeded, but no
  structured observation or final manifest did.

### 2026-08-02 - Explicit AI interpretation becomes a constrained delivery gate

- Product decision: Waystation uses dual-key delivery authority. Deterministic
  instruments retain immutable authority over measured conformance. The
  explicit AI Interpretive gate has independent authority over versioned
  perceptual categories and can contribute HOLD/REJECT. AI can never erase a
  deterministic failure, rewrite an instrument value, or create a composite
  trust/quality score.
- Architecture: a configurable GMI planner turns detached deterministic facts
  into an allowlisted bounded review plan. Configurable visual/audio specialist
  models inspect stored B2 evidence concurrently; synthesis emits one structured
  state per required risk. Raw provider text has no direct authority. A pure
  policy reducer requires accepted evidence IDs, confidence, policy category,
  category coverage, and cross-stage corroboration.
- Rollout: `shadow` records the proposed AI decision, `hold` lets AI stop
  release, and `enforce` lets qualified enforceable findings reject. Defaults
  remain run-disabled and `shadow`. Missing, malformed, incomplete, or omitted
  AI evidence yields HOLD/not_checked, never READY.
- First-pass scope: visible image, typography, and audible defects may enforce.
  Temporal continuity, lip sync, caption semantics, editorial/creative intent,
  and aesthetics are HOLD-only pending native video evidence and retained
  real-corpus calibration. Stage corroboration is disclosed as pipeline-stage
  corroboration, not independent-model consensus.
- Deployment consequence: source/tests/docs only. Production was not accessed,
  rebuilt, restarted, or deployed; no paid call or authority mode was enabled.

### 2026-08-02 - Initial explicit-run advisory boundary (superseded in source)

- Decision: add a dedicated sender-selected AI Interpretive Analysis run rather
  than repurposing hidden shadow evaluation. The real GMI call boundary is
  `genblaze_gmicloud.chat`; Genblaze Core run/step builders record orchestration
  and the existing delivery manifest covers B2 result/evidence artifacts.
- Decision: visual and audio stages may overlap under a bounded concurrency of
  two, followed by synthesis. Provider/model/timeout/fallback are configuration.
  A fallback is attempted only when explicitly configured and every attempt,
  usage event, timing, and outcome is recorded. Unsupported or missing provider
  configuration is `not_checked`.
- Authority boundary: output is sanitized into fresh `advisory_observations`;
  citations are limited to stored evidence IDs. AI cannot create checks,
  status, tiers, BLOCKERs, repairs, or a composite score. Canonical QC is never
  passed by reference to provider or sanitizer code.
- Spend/deployment boundary: gateway permission, worker execution gate, and
  sender selection are all required. Both source production gates default
  false. Shadow, triage/deeper AI, Synthetic QC, Summary, and explicit analysis
  are separately metered. This source task does not access or alter production.

### 2026-08-02 - Deep package facts and AI evaluation do not imply conformance or authority

- Decision: policy v1.4.0 adds bounded MXF fact inventory, safe IMF manifest /
  reference / small-asset-hash inspection, and HDR/Dolby metadata discovery.
  These are advisory evidence slices. Unsupported MXF partition/index/ANC and
  AS-profile facts, complete IMF application profiles, and HDR/Dolby bitstream
  conformance remain `not_checked` without qualified analyzers and fixtures.
- Decision: network-template infrastructure ships one selectable Waystation
  house template only. It retains source/effective hashes and overrides but is
  not a broadcaster specification; private network rules must never be
  invented.
- Decision: commercial-QC benchmarking records retained side-by-side outcomes,
  versions, evidence references, and disagreement taxonomy. It emits no parity,
  acceptance, quality, or trust score and cannot update policy.
- Decision: AI review packets are bounded and hash-validated before extraction
  or spend. Shadow citations are allowlisted to packet evidence. Reviewer
  dispositions feed an offline holdout evaluator with precision/recall and
  Wilson intervals; they never promote AI to delivery authority.
- Deployment consequence: source/tests/docs only. Production remains on the
  previously recorded worker image/policy v1.1.0; no production host or
  container was accessed. `AI_INTERPRETIVE_SHADOW=false` remains unchanged.

### 2026-08-02 - Deterministic-only delivery authority is enforced centrally

- Decision: canonical delivery `status` and `tiers` are computed from
  deterministic checks only. Every AI-origin source (agentic, support, hybrid,
  triage, synthetic, or interpretive shadow) is capped at advisory severity and
  reported separately. The former Netflix model-censorship escalation to
  `fail`/`BLOCKER` is removed; model evidence cannot become policy authority.
- Decision: the current PSE implementation is a bounded luma-difference
  candidate heuristic, not a compliance engine. It is non-blocking in every
  profile and references ITU-R BT.1702-3 (11/2023) as guidance only. Full PSE
  conformance is deferred to qualified tooling, authoritative rules, and test
  vectors.
- Decision: AI Interpretive Shadow receives detached packet copies and emits
  fresh `advisory_observations`, not delivery-shaped checks. It remains
  disabled by default and cannot mutate canonical checks, packets, status,
  tiers, or outcome.
- Decision: calibration promotion review requires independent deduplicated
  source masters, explicit training/holdout splits, required content/codec/
  cadence/audio-layout strata, Wilson 95% error bounds, and asymmetric false-
  positive/false-negative targets. Passing does not automatically promote a
  rule; an explicit versioned policy decision is still required.
- Decision: policy v1.3.0 adds bounded SCC/MCC/RCWT transport visibility,
  decode/continuity evidence, and an explicit declared audio-track map. It does
  not claim complete CEA-608/708 or SMPTE 436 ANC conformance. Service metadata
  that FFmpeg cannot preserve is `not_checked`; semantic channel assignment
  remains advisory without authoritative reference metadata.
- Deployment consequence: source/tests/docs only. Production was not accessed,
  rebuilt, restarted, or deployed, and `AI_INTERPRETIVE_SHADOW=false` remains
  the production setting.

### 2026-08-02 - Phase 2 perceptual metrics remain corpus-gated advisories

- Decision: policy v1.2.0 adds bounded broadcast-only visual, audio, caption,
  QCTools, and cross-tool metadata measurements. These are deterministic
  evidence but do not gain hard delivery authority merely because a tool emits
  a number. Standard and Netflix profiles remain unchanged.
- Decision: only explicit, repeatable policy rules may reject. Every new
  perceptual threshold remains `deterministic_advisory`; unavailable or
  malformed measurements are `not_checked`. AI remains disabled by default,
  advisory when enabled, and unable to change deterministic status or tiers.
- Decision: synthetic fixtures prove code behavior, not network acceptance.
  Threshold promotion requires real decision-backed accepted/rejected records,
  documented review, a new policy version, and regression proof. The initial
  20-per-class floor was superseded later that day by the v2 independence,
  stratified holdout, and Wilson error-bound gates recorded above. Neither
  helper can update policy automatically. No composite score is permitted.
- Deployment consequence: this milestone is source-only. Production remains on
  the previously recorded v1.1.0 worker image with
  `AI_INTERPRETIVE_SHADOW=false` until separately approved.

### 2026-08-02 - A versioned house baseline is not universal network compliance

- Context: "U.S. broadcast MXF" is not one universal delivery specification.
  Network/customer requirements differ, while wrapper facts, measurements and
  policy decisions are different kinds of evidence.
- Decision: milestone 1 ships profile `us_broadcast_xdcam_hd_422_v1`, backed by
  immutable policy pack `us_broadcast_xdcam_hd_422_baseline` v1.1.0. It states
  its exact MXF OP1a/XDCAM assumptions and accepts only explicit nested JSON
  overrides. Unknown override keys fail closed; reports retain both source and
  effective policy hashes plus the override object.
- Decision: every baseline finding separates `expectation`, `observation`,
  `evidence`, `provenance`, `decision`, and policy identity. Full decode,
  wrapper/essence/timing/audio/metadata/caption/boundary rules may reject from
  deterministic evidence. Black/freeze/silence and legal-range screens remain
  advisory until calibrated. Event authority is an explicit overrideable policy
  value; baseline defaults remain advisory. There is no composite score and AI
  gains no policy authority.
- MediaConch boundary: use its supported MAXML/MediaInfo metadata output for an
  independent fact set, then apply a pure Waystation reducer. Do not claim its
  implementation checker certifies MXF.
- QCTools boundary: run only bounded timeline excerpts, reduce only validated
  signalstats fields, retain raw XML hashes and exact qcli provenance, and keep
  all measurements advisory pending real accepted/rejected corpus calibration.
  Unavailable, failed, timed-out, or malformed analysis is `not_checked`.
- AI boundary: compile targeted deterministic-review packets locally. The AI
  Interpretive Pass is an explicit runtime opt-in, executes in shadow mode,
  records model/prompt/input provenance and uncertainty, and is stored outside
  canonical delivery checks so it cannot alter deterministic status or tiers.
- Deployment consequence: source/image readiness and production activation are
  recorded separately. The worker-only production activation completed on
  2026-08-02 from source commit `ecfcc01`; interpretive shadow remains disabled.
  See CURRENT_WORK.md for exact runtime evidence.

### 2026-08-02 - Activate deterministic QC and triage with a worker-only rebuild

- Decision: after source proofs and image inspection passed, rebuild and
  recreate only the production worker with `--no-deps`. Preserve gateway,
  cloudflared, the control volume, scratch contents, and historical uploads.
- Result: running worker image `sha256:753b834f…` contains the pinned qcli and
  MediaConch CLIs, baseline policy v1.1.0, deterministic timeline/QCTools
  adapters, prompt compiler, and cost-aware triage route. Both health endpoints
  passed and the running image matched the inspected image exactly.
- AI-spend boundary: `AI_INTERPRETIVE_SHADOW=false` remains explicit in
  production. Cost-aware triage can route the already-requested AI lanes on
  future uploads; the new interpretive shadow pass does not run or spend by
  default and can never alter deterministic status.

### 2026-08-01 - Install preservation CLIs before activating their policies

- Status: superseded for MediaConch and QCTools by the 2026-08-02 baseline
  decision above.

- Context: Phase 1 needs stronger deterministic analytics and preservation
  policy plumbing, but package presence is not evidence that a file was checked
  and neither QCTools nor MediaConch implies complete broadcast-MXF parity.
- Decision: the Docker worker builds only QCTools' headless `qcli` from pinned
  official revision `29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2` and installs pinned
  Debian `mediaconch=25.04-2`; image labels and report metadata expose those
  exact inputs. No GUI applications ship.
- Decision: this install step is availability/provenance plumbing only. Until
  versioned policies, bounded report extraction, pure reducers, and fixture
  proofs land, both tools emit `FYI · not checked` whether absent or installed.
  Neither may clear or reject media. Existing deterministic policy instruments
  retain sole rejection authority; AI remains advisory.
- Historical deployment consequence: this source-only install did not itself
  rebuild the VPS worker. The later, explicitly authorized worker-only rebuild
  completed on 2026-08-02; see the decision above.

### 2026-08-01 - "The VPS is at commit X" does not mean commit X is running

- Context: branch head sat 2 commits ahead of the deployed gateway commit and
  was reported as production drift. Comparing content rather than counting
  commits showed `gateway/`, `pipeline/` and `crates/` were **identical**, and
  the published client matched branch head exactly — the two commits were one
  already-published client change and one docs change. There was no drift.
- The real gap was the opposite of what the commit count suggested: the triage
  commit `e89da62` is an **ancestor** of the deployed commit, so its source was
  already on the VPS, but the worker **container** had not been rebuilt since
  2026-07-28 and was running pre-triage code. Confirmed by grepping the running
  container (`qc_ai_triage`: 0 occurrences) against the source (3).
- Decision: deployment state is established by **image build time and container
  contents**, never by `git rev-parse` on the host. A checkout updates source;
  only a rebuild updates what runs. Record both when reporting what is deployed.
- Corollary: rebuild services individually and say which. Rebuilding only the
  gateway is a legitimate choice, but it leaves the worker on older code and
  that must be stated rather than assumed away.

### 2026-08-01 - Client and gateway ship in lockstep; never guess a server-owned value

- Context: A real 27 GiB upload wedged at 99.97%. The gateway had been rebuilt
  with large-file mode while the portal still served a client from three days
  earlier that contained no `verificationMode` handling at all. The gateway
  correctly answered `"root"`; the old client could not read the field, fell
  back to `"range"`, and built a ~1.7 GiB bao outboard inside wasm. `finalize()`
  is a synchronous allocation that blocks the main thread, so it also stalled
  the parts still in flight — which is why it froze just short of complete
  rather than at a random point.
- Decision 1: **A gateway change that alters the client contract is not
  deployed until the client is republished.** Where the pinned client is
  deliberately ahead of the gateway, verify every gateway path the bundle calls
  exists at the deployed commit before publishing, and record that in the commit
  message.
- Decision 2: **Never default a value the server owns.** `verificationMode` is
  decided by `verificationModeForSize()`, stored in `uploads.verification_mode`,
  enforced by `/uploads/outboard-url`, and carried onto the transfer at
  `complete`. A client-side default was wrong in BOTH directions — `"range"`
  wedges the tab on a huge file, `"root"` leaves a transfer the gateway recorded
  as range-verified with no `.obao` behind it. The client now asks; only the
  specific `403 outboard_disabled` means root, and any other error is rethrown
  rather than misread as a mode.
- Operational corollary: **a republished client does not reach an open tab.**
  Anyone retrying after a publish must reload first, and for a long operation
  the client version should be confirmed before committing hours to it. Two
  attempts were burned on a stale tab because this was not said explicitly.

### 2026-08-01 - Delivery must force a download and show real progress

- Context: "Download original" on a 26 GiB `.mov` opened the browser's media
  player and buffered the object instead of saving it.
- Cause: `<a download>` is specified to apply only to same-origin URLs. B2 is a
  different origin, so browsers ignore the attribute and simply navigate; B2
  then answers `Content-Type: video/quicktime` with no disposition and the
  browser renders it inline. This affected ANY video transfer at any size, and
  survived the 14-check rehearsal because that only ever used a 765 KB fixture
  and never clicked plain "Download original" on a video.
- Decision: the gateway signs `ResponseContentDisposition: attachment` into the
  **original's** presigned URL. Derivatives keep inline disposition — the page
  renders the thumbnail and fetches the QC JSON, and neither should download.
- Decision: where the File System Access API exists, the page asks where to save
  and pipes `response.body` straight into the file; writes are awaited so
  backpressure is natural and nothing is buffered. Elsewhere it falls back to
  the anchor, which now saves correctly because of the gateway change.
- Decision: a transfer that runs for tens of minutes must show bytes, rate and
  ETA, not a spinner or a bare percentage. Finder's size column is NOT a
  progress indicator here — the FSA writable commits through a swap file, so the
  visible size barely moves while the transfer progresses. Rate is a rolling
  5-second window: since-start reacts too slowly to be useful, per-chunk is too
  jittery to read.

### 2026-08-01 - B2 throttles per connection; parallelism is the lever

- Context: a 26.12 GiB download averaged 232 Mb/s on an 800 Mb/s line.
- Measured: one stream 232 Mb/s; six parallel streams **3.3× aggregate** from the
  same machine at the same moment. The uploader already exploits this with
  `CONCURRENCY = 6`; the download path is single-stream and never did.
- Decision: parallel ranged download is worth roughly 3× and is DEFERRED until
  after the 2026-08-03 deadline by explicit owner decision. Re-measure on an
  idle link before building — the ratio above was taken while a real download
  competed for the same pipe, so the absolutes are depressed and 6 may not be
  the right concurrency.

### 2026-07-31 - Cost-aware AI triage routes spend, never verdicts

- Context: Running every GMI-assisted lane on every upload is expensive and
  redundant. The user asked for progressive AI QC: cheap early analysis should
  decide which deeper model passes are worth spending on, and later prompts
  should inherit useful context instead of starting cold.
- Decision: Add `qc_ai_triage` as a lightweight GMI router after deterministic
  QC and sidecar discovery, before full AI QC and Synthetic QC. It receives
  metadata, deterministic check summaries, caption excerpt, source-manifest
  presence, and a small frame sample. It returns strict JSON decisions for
  `run_ai_qc`, `run_synthetic_qc`, `run_typography`, `run_critic`, priority
  timecodes, visible-text signal, synthetic likelihood, and short reasons.
- Guardrails: Triage is not a verdict engine. It cannot clear, fail, suppress,
  or rewrite deterministic QC. It may only skip or narrow optional model spend,
  and every skip is recorded in `qc_report.json` and rendered on the recipient
  page. Invalid JSON, GMI failure, or no triage result falls back to the
  sender-requested behavior.
- Synthetic rule: a source `.genblaze.json` manifest is stronger evidence than
  triage, so requested Synthetic QC still runs when a generation manifest is
  present even if triage says synthetic likelihood is low.
- Consequence: The staged reliability architecture remains intact. Independent
  sweep, adaptive evidence, critic, asset blueprint, continuity ledger, and
  typography still exist as separate auditable passes, but the worker can avoid
  obviously low-value spend before invoking them.

### 2026-07-31 - 350 GiB now uses root-only large-file mode

- Context: The production scratch disk is mounted on `/mnt/waystation-scratch`
  with roughly 390 GiB available, and the immediate requirement is to accept
  files up to **350 GiB now**. The current browser-side bao outboard path is
  not a credible 350 GiB implementation: it produces a range-verification
  sidecar in JS/WASM memory and would force upload UX, storage, and memory
  assumptions that are false at this size.
- Decision: Allow production uploads up to **350 GiB** by switching files above
  **16 GiB** into explicit `root` verification mode instead of blocking the
  upload until multipart bao outboard generation exists. Root mode computes and
  stores a whole-file BLAKE3 root, skips `.obao` upload, refuses
  `/uploads/outboard-url`, and labels delivery as large transfer / BLAKE3 root
  recorded / verified-range unavailable. Files at or below 16 GiB keep the
  existing `range` mode with `.obao` and verified-range download.
- Cost and disk boundary: Files above **100 GiB** force every worker/QC service
  off, including synthetic QC, thumbnailing and summarization. At that size the
  hosted product is transfer-only; this protects the 390 GiB scratch disk from
  sidecar, transcode, and analysis amplification.
- Consequence: This makes 350 GiB uploads usable now, but it is not full
  350 GiB verified-range delivery. Recipients get direct download plus the
  recorded BLAKE3 root; full multipart/range-backed outboard generation remains
  Phase 2.

### 2026-07-27 - Hosted MVP: the API is published only behind auth, ownership, and ceilings

- Context: Track A of `WAYSTATION_HOSTED_MVP_AND_COMMERCIAL_PLATFORM.md` — serve
  the client at `orbitolive.com/waystation/` with the API at
  `api.orbitolive.com/api/`. Before hosting, the API had **no authentication,
  no authorization, no limits, and no durable state**. Publishing it as-is
  would have handed anyone presigned write URLs into the bucket and unbounded
  GMI spend. Four verified defects drove the work:
  `GET /downloads?key=` handed an unvalidated key to the CDN token signer — an
  oracle for ANY object; `store.ts` was an in-memory Map ("Lost on restart")
  whose loss silently promoted a TRANSFER-ONLY job to full AI QC and billed it,
  because `options: undefined` means "all services on"; `metering.ts` had no
  idempotency key so retried callbacks double-counted; and no upload route
  verified that a key belonged to the caller.
- Decision / result, in dependency order (SQLite first, so sessions and upload
  ownership persist correctly on their first write rather than being built in
  memory and rewritten):
  1. One client transport module: API base from a `<meta>` tag (changeable in
     deployed HTML without a rebuild), `credentials:"include"`, status-aware
     decoding, `EventSource` with `withCredentials`. Vite `base` is applied to
     BUILDS ONLY — in dev it would 404 the root and hang the `curl` readiness
     loops in dev-up/live-run/live-event-run.
  2. SQLite via **node:sqlite** (built into Node; verified in the deploy image
     node:22-slim 22.23.1) over better-sqlite3, whose native build is a real
     risk in a container days before a deadline. Tables transfers/uploads/
     meter_events; meter events idempotent. SQL NULL options stay distinct from
     a recorded object — persisting that distinction faithfully IS the fix.
  3. Sender auth: one high-entropy code hashed with **crypto.scrypt** (no
     native Argon2 dependency), exchanged ONCE for a signed, short-lived,
     opaque `HttpOnly; SameSite=Strict` cookie (Secure in production only,
     since a Secure cookie is never stored over plain http). Stateless
     sessions, so rotating the signing secret invalidates all of them at once.
  4. Ownership: every upload route verifies key+uploadId belong to the session,
     returning a NEUTRAL 404 so the API never confirms another session's work.
  5. Cost controls at the dispatch boundary only — kill switch, active/session
     and daily job ceilings, service allowlist, and a `.ref.*` sidecar refusal
     that gates the reference SSIM/PSNR/VMAF lane without touching QC code.
  6. Recipient links stay open (a delivery must open without a sender session)
     but gained expiry + revocation, a transfer-scoped download replacing the
     oracle, and removal of the billing ledger from the recipient view.
  7. `/healthz` that discloses nothing; a pinned, checksummed release export
     into OrbitWebsite; a STANDALONE production compose (Compose merges `ports`
     additively, so an overlay cannot remove the public 8787 mapping) with
     cloudflared dialling out — zero published ports.
- CORS is exact-origin with credentials and registered BEFORE the routes.
  Hono's `cors()` answers OPTIONS with 204 and returns without calling next(),
  so preflight never reaches the session gate; had auth run first, preflight
  would 401 and the browser would never send the real request.
- **Dev stays permissive, production fails closed.** `WAYSTATION_AUTH_MODE`
  defaults to `disabled`, the database to `:memory:`, and reference QC to
  allowed — that is what keeps the existing proof suite green. Under
  `NODE_ENV=production` the gateway REFUSES to start with auth disabled, with
  missing/short secrets, or with an ephemeral database. The literal
  `waystationQC` from early planning is retired and must never be used.
- Deliberately deferred to Track B: post-probe reservation refinement and
  mid-pipeline budget reconciliation. Those need gateway↔worker↔pipeline
  coordination and would reach into submission-proven QC behaviour.
- Proof: `scripts/access-proof.sh` (16 assertion groups, MinIO-backed) covers
  session-required, cross-session ownership, validation-before-B2, preflight
  and exact CORS, the ceilings and kill switch, recipient scoping, `/healthz`
  non-disclosure, and that disabled mode leaves dev open. It is
  mutation-tested: reintroducing the undefined-options bug makes it fail.
  Three existing proofs (toggle, synthetic-qc, netflix-qc) had asserted the OLD
  weaker sidecar contract using a key that was never initiated — itself a write
  primitive into any transfer prefix — and now initiate a real upload and also
  assert an unowned key is refused, covering more than before.

### 2026-07-24 - AI Reliability Passport: blind Jury (reproducibility) + Proficiency Foundry

- Context: Every AI-QC product asks the user to TRUST model findings. This
  project has repeatedly measured why that fails. The innovation is to make the
  AI lane itself a measured instrument: every AI-derived finding carries an
  auditable passport with two independently measured axes — and NO composite
  score, ever (a single "confidence: 87%" would recreate false certainty).
- **Jury (reproducibility, not accuracy):** when the generated-typography
  reducer produces a finding and `GMI_JURY_MODEL` is set (opt-in, default
  EMPTY), a second model family re-perceives the SAME evidence under a strict
  BLINDNESS contract — it never sees the primary's findings. Its raw
  observations replay through the SAME normalizer + reducer, and the two
  structured finding sets are matched on `match_key` (`qc/jury.py`; findings
  gained `finding_id`/`match_key` identities in `qc/generated.py`). Verdicts:
  `reproduced | contested | single_source`. A CONTESTED finding STAYS
  SUSPECTED with RAISED review priority — disagreement is information, never
  an eraser. Diagnostics (raw agreement, confusion matrix, Gwet's AC1 — kappa
  is unstable on imbalanced labels) ride along; they are not the verdict.
  Probed live: gpt-4o/-mini sit in GMI's catalog but had NO serving capacity
  (429 on every attempt), so v1 ships gemini-3.5 × gemini-3.6 — disclosed in
  the passport as `same_family_cross_generation`, never claimed as vendor
  independence ("cross-family reproducibility", both ride GMI's control plane).
- **Proficiency Foundry (proficiency, not "calibration"):** seeded, randomized
  challenge suites — clean base, untouched clean twin, ONE precisely measured
  planted defect (`qc/foundry.py` plans; `foundry_render.py` renders with
  Pillow+ffmpeg; ground truth exact by construction, hidden from the models).
  `scripts/proficiency.sh --class rendered_text_mutation [--publish]` runs the
  EXACT production lane subset and scores deterministically
  (caught | missed | false_positive_on_twin), with Wilson 95% intervals always
  rendered beside raw counts and labeled PROVISIONAL at small n. Three systems
  measured separately: primary standalone, juror standalone offline (a
  juror-only catch is `offline_juror_only_catch` — under the deployed
  finding-only policy the jury characterizes reliability, it cannot add
  recall), and the deployed pair policy conditional on a primary finding.
  Control classes (loudness_delta_lu, bad_framerate) prove the scoring
  machinery only and are labeled as such.
- **Immutable proficiency manifest:** drafts are never citable; `--publish`
  refuses a dirty worktree and writes the record to B2 under COMPLIANCE Object
  Lock with full provenance (model ids, prompt sha256s, sampler/normalizer/
  reducer/policy/suite/renderer versions, commit + dirty flag, seed, asset +
  sidecar hashes, parameter ranges, n, Wilson CIs, execution date, and the
  disclosure that a remote model id does not pin weights). The report cites
  the manifest ONLY on an EXACT config match (`foundry.citation_state`) —
  never "latest"; any drift renders the lane UNCALIBRATED.
- **Handoff packets replace "regeneration advice"** (which is repair advice —
  rejected on reporter-only charter grounds): per-finding, fully deterministic
  `{finding_id, kind, timecodes, evidence_ids, related_assertion_ids,
  related_prompt_clauses, reliability_passport_ref}`, where prompt clauses
  come ONLY from assertion ids a reducer actually retained.
- First live run: a planted `ARRIVALS→4RRIVALS` was caught by the primary,
  independently reproduced by the blind juror — which transcribed the glyph
  differently (`4ARRIVALS` vs `4RRIVALS`) yet produced the SAME structured
  concern, vindicating match_key excluding before/after strings — and the
  clean twin passed both models untouched.
- Published record (2026-07-24, real GMI, WORM COMPLIANCE on B2):
  `proficiency/rendered_text_mutation/d1a360c1df22-e85fd947.json` — primary
  gemini-3.5-flash 5/5 plants caught, 5/5 clean twins passed, Wilson
  [0.566, 1.0], PROVISIONAL n=5; juror gemini-3.6-flash 5/5 offline; deployed
  pair policy 3 reproduced / 2 contested; citation verified EXACT.
- SCOPE, stated precisely so nobody later overclaims it: this live run
  validated TWO of the generated lane's five model stages — the coarse scene
  ledger and native-resolution typography — plus their deterministic reducers.
  The planner (`plan_prompt`), the jittered fine-verification pass, prompt
  adherence, and the artifact specialist remain mock-proven only (NEXT_STEPS).
  A passport measures the lane it was run against, not the whole synthetic lane.
- The 2 contested verdicts are a measured property of jury policy 1.0, not a
  model failure: both models caught 5/5 standalone, but `match_key` requires
  identical `evidence_ids`, so a juror flagging the same mutation across a
  different consecutive evidence pair reads as contested. Conservative and
  honest (contested only raises review priority). Relaxing it to overlap-based
  matching would bump JURY_POLICY_VERSION and invalidate this manifest — the
  drift-invalidation flow working exactly as designed.
- Proof: `scripts/jury-proof.sh` (reducer replay, contested-stays-suspected,
  PROMPT-BLINDNESS assertion, honest single_source) and
  `scripts/proficiency-proof.sh` (blind scoring branches through the real lane,
  manifest completeness, citation states, dirty-worktree refusal against an
  isolated repo, WORM publish with rejected delete).

### 2026-07-24 - Generated-media QC is an asset-specific plan plus deterministic ledgers

- Context: The original Synthetic QC lane used a broad artifact prompt, three
  sparse frame bursts, and one holistic prompt-adherence score. It could surface
  useful defects but did not account for generated-media dimensions separately,
  retain timeline state, or prove whether a suspicion survived denser sampling.
- Decision / result: Add a separate 14-risk generated-media registry and a
  planning pass that compiles recorded generation intent into bounded atomic
  assertions. A deterministic fallback fills every omitted registry dimension.
  Coarse anchor/scene-boundary evidence becomes a structured scene ledger;
  pure reducers compare same-shot subjects, objects, backgrounds, and assertion
  observations. Suspect timecodes receive jittered dense verification. Text
  regions located in the ledger are re-extracted at native resolution,
  transcribed literally, and compared by code across time. The complete plan,
  coverage, ledgers, findings, typography observations, and sampling audit live
  in `qc_report.json` and render on the recipient page.
- Trust boundary: This remains reporter-only. Model observations may raise an
  ISSUE but never a BLOCKER. Missing/unparseable planner, ledger, or typography
  output becomes an explicit baseline or review state, never a pass. “Stable”
  means the same normalized finding appeared in both coarse and jittered passes;
  it is not full-timeline clearance. Visible text and prompt content remain
  untrusted data.
- Why it matters: The AI lane now decides what this particular generated asset
  could get wrong, gathers bounded evidence, and accounts for what it could not
  verify. The result is inspectable and testable rather than a single opaque
  quality score.
- Proof: `scripts/synthetic-qc-proof.sh` drives the complete local B2/gateway/
  worker/report/metering path with mock GMI and asserts planning, registry
  completion, hierarchical evidence, deterministic scene diffs, native text
  mutation tracking, redacted-prompt handling, and toggle gating. All discovered proof
  scripts are green. Real-GMI calibration of the new structured prompts remains
  the exact next step before final recording.

### 2026-07-24 - Only instruments reject: no model finding may be a BLOCKER

- Context: A SECOND live capture tested the first fix below (capping only
  `unregistered_observation`) plus the prompt tightening. The prompt worked on
  its own terms — zero `unregistered_observation` findings, down from three —
  but the model simply LAUNDERED the same restatements through ill-fitting
  REGISTERED risk ids: "encoded at 30p, not an allowed delivery rate" filed as
  `creative_vs_defect`, "-10.9 LKFS, extremely loud" filed as `audio_transients`
  (neither id fits: one is creative-intent, the other is clicks/pops). Those ids
  were not capped, so the report still showed 5 BLOCKERs for 3 real defects.
- Decision / result: Widen the rule to its honest form — `checks_from_findings`
  caps EVERY agentic finding at ISSUE; no model finding, under any risk_id, can
  carry BLOCKER. Severity chosen by a model over sampled evidence is not a
  rejection-grade signal, and which registry slot it claims does not change
  that. Only instruments reject; the model annotates and escalates to a human.
- Why it matters: this is finally the 2026-07-18 rule ("AI verdicts annotate the
  report; they never overwrite an instrument reading") enforced where it was
  missing — the checks/tier list. Replaying BOTH real captures through the fix
  converges on exactly the three true instrument BLOCKERs (framerate, loudness,
  true_peak): run 1 `{6,1,13}` → `{3,4,13}`, run 2 `{5,1,13}` → `{3,3,13}`,
  overall status `fail` in both, driven by the instruments as it should be.
- Nothing is lost: model-only defects stay prominent as ISSUE, coverage still
  marks the risk SUSPECTED/CONFIRMED, and they appear in residual human review.
  Profile-governed escalation is untouched — `worker.run_ai_qc` re-escalates
  censorship to `fail` AFTER this point when the profile says so, which is an
  explicit policy decision rather than the model grading its own severity.
- Confirmed by a THIRD live run against the widened cap: `{BLOCKER 3, ISSUE 5,
  FYI 12}`, BLOCKERs exactly `framerate`/`loudness`/`true_peak`, and ZERO
  agentic findings at `fail`. Across the three runs the agentic-fail count went
  3 → 2 → 0 while the true defect count stayed 3.
- Note what run 3 also showed: the model restated all three instrument findings
  AGAIN (30p as `creative_vs_defect`, -10.9 LKFS and +8.1 dBTP as
  `audio_transients`) despite the tightened prompt. The prompt layer is
  therefore not load-bearing — it reduces restatement in some runs but does not
  stop it; the deterministic cap is what makes restatement harmless. Keep the
  prompt wording, but never rely on it.
- Residual, cosmetic and accepted: restatements still appear as agentic ISSUEs
  alongside the instrument BLOCKERs they echo. Harmless to the verdict, but do
  not narrate them as the AI "independently corroborating" the instruments —
  the informed pass was handed the dossier, so that would be an over-claim.
- Method note worth keeping: the first fix was verified only by replaying run 1
  and looked correct; it took a fresh live run to expose that it had merely
  moved the behaviour. When a guard constrains a model, re-run the model against
  the guard — replaying old output cannot show it routing around the new rule.
- Asserted in `scripts/agentic-qc-proof.sh` (blocker+issue findings across
  unregistered, laundered-registered, and genuine ids all resolve to `warn`).

### 2026-07-24 - (superseded, kept for history) unregistered_observation cap

- Context: The first LIVE agentic capture against real GMI (demo-master.mp4,
  Netflix strict) exposed something every mock-based proof had missed: the
  instrument-informed pass RESTATED three already-measured deterministic
  failures (30p framerate, -10.9 LKFS, 8.1 dBTP) as its own findings tagged
  `unregistered_observation` at `severity: blocker`. Nothing downstream stopped
  it, so the report showed **6 BLOCKERs for 3 real defects**, with the duplicates
  labelled "unregistered" — i.e. presented as newly discovered when they were
  the opposite. The mock could never produce this: its canned findings never
  collided with the deterministic ones.
- Decision / result: Enforce the invariant deterministically in
  `checks_from_findings` — a finding whose `risk_id` is
  `unregistered_observation` is capped at ISSUE and can never be BLOCKER. It
  sits outside the risk registry and is measured by no instrument, so sampled
  model perception must not auto-reject a delivery; it demands human review
  instead. Findings the model maps to a REGISTERED risk are unaffected and still
  carry BLOCKER. Second layer: the informed prompt now explicitly forbids
  restating a defect the dossier already measured, and narrows
  `unregistered_observation` to things absent from both registry and dossier.
- Why it matters: this is the existing "instruments win, the model annotates"
  rule (2026-07-18) finally applied to the CHECKS/tier list — it was previously
  enforced only for coverage dispositions, which is exactly how the model could
  inflate the blocker count. Verified by replaying the REAL captured model
  output through the fix: `{BLOCKER 6, ISSUE 1, FYI 13}` → `{BLOCKER 3, ISSUE 4,
  FYI 13}`, overall status still `fail` (driven by the instruments, as it should
  be). Asserted in `scripts/agentic-qc-proof.sh`, which also proves a
  registry-mapped blocker is NOT capped.
- Follow-up: the cap is deterministically proven; the prompt tightening can only
  be validated by another live run — do that before recording. Note the policy
  consequence: a master with no deterministic failures where the model finds a
  novel blocker-severity defect now lands `warn` (human review) rather than
  `fail` (auto-reject).

### 2026-07-23 - SyncNet baked into the Docker worker as an opt-in CPU build

- Context: SyncNet was integrated as an optional host analyzer (`qc/avsync.py`),
  but a containerized "remote worker" had no measured lip-sync unless the tool
  was installed on the host. The user asked to make it available in the image.
- Decision / result: Add an opt-in `INSTALL_SYNCNET` build arg to
  `pipeline/Dockerfile`. When set, **micromamba** supplies only a self-contained
  **Python 3.10** (SyncNet's version, independent of the image's 3.13 — so no
  cross-interpreter venv copying), and **pip** supplies **CPU torch 2.5.1**; it
  then clones `syncnet_python` and downloads the weights (+ `example.avi`).
  The base build (arg unset) is unchanged; `SYNCNET_DIR`/`SYNCNET_PYTHON` are
  set unconditionally and are harmless when absent (avsync `_resolve()` checks
  the dir exists → honest FYI). `docker-compose.yml` exposes it as
  `INSTALL_SYNCNET=1 docker compose build worker`.
- Two findings drove the final shape, after a first attempt built the env from
  upstream's `environment-cpu.yml` and FAILED to solve on arm64:
  (1) the **pytorch conda channel is x86_64-only** (`pytorch ==2.5.1 does not
  exist` for linux-aarch64), whereas pip's CPU wheels cover both arches — so the
  env is built with pip, not the upstream yml, and works on ARM hosts and
  Graviton-class cloud workers as well as x86_64;
  (2) SyncNet **never imports torchaudio or torchvision** despite the yml
  pinning both, so both are omitted — the install is only what the code actually
  imports (torch, cv2, numpy, scipy, python_speech_features, scenedetect, tqdm),
  with opencv as the `-headless` build so no libGL is needed in a slim image.
- Why it matters: measured lip-sync now ships with the remote worker, CPU-only
  (no GPU needed — SyncNet inference is light), without bloating the default
  image or making every worker carry torch.
- Also fixed a latent bug this required: `qc/avsync.py` invoked SyncNet's
  scripts by relative name with a relative model/S3FD-weight path, but
  `qc/util.py:run` never set a working directory — so the invocation only ever
  worked in its absent-tool branch. `run` gained a `cwd=` arg and avsync now
  runs both SyncNet steps with `cwd=SYNCNET_DIR`.
- Verified end-to-end in the built image (the run that had been pending since
  the analyzer was written): on SyncNet's own `data/example.avi`, `AV offset: 3`
  frames @25fps (**+120 ms**), `Min dist: 6.589`, `Confidence: 8.323` → the
  wrapper emitted `avsync_offset` warn/ISSUE and coverage escalated `lip_sync`
  to SUSPECTED/ASSESSED. The default image (arg unset) was rebuilt and still
  returns the honest FYI. Sizes: base 1.31 GB, SyncNet 2.95 GB.
- Follow-up: GPU is unnecessary for SyncNet (CPU inference is light — face
  detection ran ~48 fps on CPU), but a CUDA variant is a trivial swap (drop the
  `+cpu` pin / use upstream `environment.yml` on an x86_64 GPU host) if a large
  backlog ever justifies it.

### 2026-07-23 - Perceive-then-compute: a reusable hybrid QC framework

- Context: The "no VLM lip-sync" decision below ruled out asking the model to
  JUDGE a timing question. A follow-up probe drew the finer line: the same model
  asked ONLY to PERCEIVE (per-frame mouth openness, no timing claim) and paired
  with deterministic cross-correlation recovered a ground-truthed A/V offset
  exactly (0 ms and +833 ms), where holistic judgment had confabulated. The win
  generalizes — perception the model does reliably, math it cannot fake.
- Decision / result: Build it as architecture, not a one-off. New pure module
  `pipeline/qc/hybrid.py`: a `HybridCheck` spec (perception prompt + output kind
  + reducer) and deterministic reducers — `align` (cross-correlation offset),
  `compare_declared` (perceived vs declared), `persistence` (tag consistency).
  The worker owns the GMI call and evidence; `qc/` stays pure (no worker import).
  Two instances ship: perceptual **lip-sync** (mouth-openness vs audio envelope
  → `lip_sync`) and audio **channel semantics** (per-channel dialogue/music/
  effects/silence vs the declared layout → `channel_assignment`, e.g. flags
  dialogue on the LFE). `align` was hardened after the probe: per-lag Pearson
  over only the overlapping region + a peak-margin gate, so an ambiguous/aliased
  window ABSTAINS (reliable=False) rather than reporting a confident-wrong
  offset. Both risks are wired `model_unreliable`/`partial` in `build_coverage`,
  which now treats `source in {deterministic,hybrid}` as instruments: a hybrid
  WARN raises SUSPECTED, a hybrid PASS never CLEARs. Proven by
  `scripts/hybrid-proof.sh` (ffmpeg + venv, no cloud) and metered live as
  `qc_hybrid` in `ai-qc-proof`.
- Why it matters: This is the honest way to use a generative model in a
  trust-based QC reporter — for perception with a deterministic check on top,
  never for the part that has a right answer. It is not in tension with the
  decision below: that one forbids VLM *judgment* of sync; this one uses VLM
  *perception* under deterministic control, and still cannot CLEAR the risk.
- Follow-up: Logo/watermark persistence and shot-content continuity become
  straightforward `HybridCheck` specs (see NEXT_STEPS). The cartoon stimulus
  proved the mechanism; a real-face clip should validate mouth perception before
  the lip-sync instance is leaned on for a certification-adjacent claim.

### 2026-07-23 - No VLM-based perceptual lip-sync check (empirically disproven)

- Context: We considered a perceptual lip-sync check — show the multimodal
  model a talking-face frame burst + the audio and ask whether the mouth
  movements match the speech — to strengthen the `lip_sync` risk beyond the
  deterministic container/envelope proxy.
- Decision / result: DO NOT build it on a general VLM. A controlled probe
  (rendered talking face whose mouth tracks a speech envelope; an in-sync clip
  and offset twins sharing the same audio) showed gemini-3.5-flash on GMI
  confabulates: verdicts were unstable across identical inputs and confidently
  wrong, including calling a gross 1.7s offset "in_sync / high" on both trials.
  It fabricates specific word-timing rationales it cannot actually derive.
- Why it matters: A trust-based QC reporter must not emit confident-false
  findings. The failure is architectural — sampled still frames + an audio
  blob give no time-locked audio/visual correspondence, so the model cannot
  align them; a real face would fail identically. True lip-sync needs a
  purpose-built AV-sync model (SyncNet / AV-HuBERT class), not a chat VLM.
- Follow-up: Keep the deterministic lip-sync proxy (container offset + envelope
  cross-correlation) which honestly reports gross drift only. Do not re-attempt
  with a general VLM. Measured lip-sync now goes through SyncNet — see next.

### 2026-07-23 - Measured lip-sync via SyncNet as an optional analyzer

- Context: With the VLM ruled out, true lip-sync needs a purpose-built AV-sync
  model. joonson/syncnet_python reports a real AV offset (in 25 fps frames) +
  confidence per face track.
- Decision / result: Integrate SyncNet as an OPTIONAL external analyzer, the
  same pattern as Photon and MediaInfo — heavy (torch + weights), so it lives
  outside the base worker (`qc/avsync.py`, env `SYNCNET_DIR` / `SYNCNET_PYTHON`,
  setup via `scripts/fetch-syncnet.sh`). When absent it emits an explicit FYI
  and never silently passes. Wired into the `lip_sync` risk. Also hardened
  coverage: instruments now always win over model dispositions (the model only
  fills genuine gaps), and `lip_sync` is flagged `model_unreliable` so the VLM
  can never CLEAR or CONFIRM it. Parser verified against SyncNet's source
  output strings; honest-absence + no-model-clear proven by
  `scripts/avsync-proof.sh`.
- Why it matters: Lip-sync moves from a permanent REVIEW_REQUIRED to a real
  measurement when the tool is present, without ever letting an unreliable
  signal (VLM) or a missing tool masquerade as a clean result.
- Follow-up: End-to-end torch run is pending only on standing up the venv; the
  upstream is current (a 2026-04-17 "modernize-code" commit: torch 2.5.1,
  PySceneDetect 0.6.7.1, Python 3.10), so no dependency archaeology is expected —
  earlier notes calling it "8-year-old / needs pinning" were wrong. See
  NEXT_STEPS.

### 2026-07-23 - Widen detection coverage: sample the whole timeline, feed the reporter more

- Context: A model (and a windowed filter) can only flag what it is shown.
  Several analyses looked at a small slice of a long master, and the agentic
  blind pass saw only sparse, evenly-spaced, low-res frames and no audio.
- Decision / result: Five upgrades, each proven by `scripts/coverage-proof.sh`.
  (1) Signal analyses (legal range, PSE, chroma, idet cadence) tile short
  windows across the whole timeline instead of the first 60 s, with total
  analyzed seconds bounded. (2) The independent agentic pass now receives
  audio windows, not only frames. (3) Blind frames are selected at scene-change
  boundaries and deterministic anomaly timecodes plus anchors, not blind even
  spacing. (4) Frame budget scales with duration and evidence resolution rose
  to 1024 px. (5) A deterministic lip-sync proxy (container A/V offset +
  envelope cross-correlation) turns the `lip_sync` risk from a permanent
  REVIEW_REQUIRED into a measurable SUSPECTED when drift is real.
- Why it matters: These directly raise recall — the odds of catching a real
  incident — without touching the read-only reporter contract or letting a
  passing proxy over-claim (a clean lip-sync proxy still does not CLEAR the
  risk; certified PSE remains a separate, always-disclosed gap).
- Follow-up: Tunable via `SIGNAL_TILE_*`, `AI_QC_FRAMES*`, `AI_QC_FRAME_SCALE`,
  `AI_QC_AUDIO_WINDOWS`, `AI_QC_SCENE_THRESHOLD`. Capture a real-GMI report to
  confirm the richer evidence reads well in the final UI.

### 2026-07-23 - Waystation reports QC issues and never repairs media

- Context: Automated healing made the product responsible for creative and
  technical transformations, while the hackathon value is stronger as a
  trusted QC observer that can hand findings to a human or later system.
- Decision / result: Retire the self-healing runtime, option, derivative, UI,
  metering, and manifest step. Add a versioned read-only AI inspection charter
  with an independent sweep, one bounded allowlisted evidence round, an
  instrument-informed sweep, and a critic. A deterministic 18-risk registry
  accounts for model omissions and separates verdict from coverage.
- Why it matters: The worker cannot alter the submitted master, AI cannot
  execute arbitrary tools, and unresolved human/certification/specialist risks
  remain visible rather than being implied clean.
- Follow-up: Keep the registry versioned, prove new risk claims, and capture a
  real-GMI report before recording the demo.

### 2026-07-23 - Add optional MediaInfo structural QC

- Context: Gemini's file-based QC suggestions called out MediaInfo as useful
  for wrapper/profile metadata that ffprobe can miss, especially MXF OP1a,
  AS-11/UK DPP metadata, HDR labels, and Dolby audio stream identifiers.
- Decision / result: Add MediaInfo as an optional structural analyzer in the
  deterministic QC lane. If `mediainfo` is unavailable, Waystation emits an
  explicit FYI finding instead of silently passing. If present, MediaInfo
  findings join the same tiered report; non-OP1a MXF is a BLOCKER under the
  Netflix profile.
- Why it matters: This improves broadcast-delivery credibility without making
  a fresh clone or demo machine depend on another host binary just to run.
- Follow-up: Install `mediainfo` on recording/review machines when you want
  those extra wrapper checks to appear in the demo report.

### 2026-07-19 - Reactive loop proven with genuine Backblaze events; rename requires venv rebuild

- Context: Backblaze enabled Event Notifications on the account. The last
  unproven link was whether B2 itself (not a manually-fired webhook) would
  drive the pipeline.
- Decision / result: Register a `b2:ObjectCreated:*` rule (prefix
  `transfers/`) via the native API pointing at the gateway through a
  cloudflared tunnel, dev trigger OFF. Proven airtight by uploading an object
  **directly to B2** (gateway never contacted) and observing B2 fire the
  event, which drove the full pipeline to a COMPLIANCE-locked manifest. Also
  learned: renaming the checkout directory breaks the Python venv, because
  console-script shebangs hold absolute paths — the venv must be REBUILT
  (`python3.13 -m venv .venv`) after a move, not relocated. `.venv/bin/python`
  is a symlink and keeps working, which masks the break until a console script
  (uvicorn) is run.
- Why it matters: the reactive architecture is a scored hackathon criterion,
  and it is now demonstrable with real B2 events rather than a stand-in.
- Follow-up: quick-tunnel URLs are ephemeral; re-run
  `scripts/b2-register-events.sh` after any tunnel restart. A fresh clone must
  build its own venv per `SHARED_CODING_WORKFLOW.md`.

### 2026-07-19 - Adopt the shared cross-machine coding workflow

- Context: This Mac joined a shared workflow spanning multiple Macs, Codex,
  Claude Code, and GitHub.
- Decision: GitHub is the source of truth; repo-local handoff files
  (`AGENTS.md`, `CLAUDE.md`, `CURRENT_WORK.md`, `NEXT_STEPS.md`,
  `DECISIONS.md`, `SHARED_CODING_WORKFLOW.md`) carry state between machines
  and agents. Active repos live under `/Users/Shared/Orbit/Code/`. Consumer
  file sync is never used for live source. `origin` uses SSH.
- Why: Git keeps source exact; repo-local notes keep agents aligned without
  depending on chat history.
- Follow-up: Done — the local checkout was renamed from `orbitxfer-web` to
  `waystation` on 2026-07-19 so the path matches the repo on every machine,
  and the repo was added to the active-repo list in the shared-environment
  plan document.

### 2026-07-19 - Every capability claim carries a proof script

- Context: The project makes strong claims (broadcast QC, Netflix profile,
  self-healing, provenance) against established commercial products.
- Decision: Each capability ships with a self-contained `scripts/*-proof.sh`
  that builds violating media, runs the real pipeline, and asserts outcomes.
  Anything not provable is marked as honestly gated in `README.md`.
- Why: Reproducibility is the differentiator against "contact sales"
  incumbents, and it catches real regressions — several genuine bugs were
  found only because the proofs assert on live output.
- Follow-up: Keep all proofs green before any submission-worthy handoff.

### 2026-07-18 - Waystation is a separate product from OrbitXfer

- Context: Waystation began as "OrbitXfer Web" but diverged into a cloud
  delivery + QC system rather than a P2P transfer app.
- Decision: Ship it as its own public repo (`russomon/waystation`) with its
  own name and identifiers. OrbitXfer remains the P2P desktop product.
- Why: The products share almost no code path and target different users.
- Follow-up: In-repo identifiers were renamed away from `orbitxfer-*`; the
  local directory name is the last remnant.

### 2026-07-18 - Deterministic and AI QC are separate, cooperating lanes

- Context: Whether AI could replace the ffmpeg/ffprobe measurement lane.
- Decision: Keep both. Deterministic instruments measure anything with a spec,
  threshold, or contract (loudness, legal range, conformance, hashes). AI
  judges anything requiring perception or intent (slates, watermarks, defect
  vs. editorial choice, caption accuracy, generative artifacts). AI verdicts
  annotate the report; they never overwrite an instrument reading.
- Why: Full-coverage measurement is cheap and reproducible; sampling-based AI
  is neither, and a specification-defined number cannot be estimated. The
  hybrid is the product, not a transitional compromise.
- Follow-up: AI-targeted escalation (AI adjudicates the exact timecodes the
  deterministic lane flags) is the pattern for future cooperation.

### 2026-07-18 - Genblaze manifests under B2 Object Lock are the trust anchor

- Context: QC reports need to be evidence, not just output.
- Decision: Every run emits a real `genblaze-core` Manifest (schema v1.5),
  canonical-hashed and SDK-verified before upload, written to B2 with
  COMPLIANCE-mode Object Lock when `MANIFEST_LOCK_DAYS > 0`.
- Why: The manifest is tamper-evident; Object Lock makes it tamper-proof —
  proven on real B2 by refusing deletion from a key holding `deleteFiles` and
  `bypassGovernance`.
- Follow-up: `MANIFEST_LOCK_DAYS=1` for demos.

### 2026-07-18 - Python 3.13 floor for the pipeline

- Context: `genblaze-core` requires Python >= 3.11; the venv was on 3.9.
- Decision: Rebuild the pipeline venv on Python 3.13 and pin the requirement.
- Why: Enables the real Genblaze SDK and retires the boto3 3.9 deprecation.
- Follow-up: `SHARED_CODING_WORKFLOW.md` documents `python3.13 -m venv .venv`.

### 2026-07-18 - The worker is stateless and deployable anywhere

- Context: Backblaze sells storage and events, not compute.
- Decision: Keep the pipeline worker stateless (everything durable lands in
  B2) and ship it as a container. The sender chooses local or cloud compute
  per transfer; the chosen worker's label is recorded in the provenance
  manifest.
- Why: It scales horizontally, deploys to any host, and keeps the deployment
  decision reversible.
- Follow-up: Scale horizontally (`--scale worker=N`) rather than vertically;
  per-job speedup plateaus around 8–16 cores.

### 2026-07-18 - Internal and competitive documents stay out of this repo

- Context: The repo is public; competitor comparisons were drafted during
  planning.
- Decision: Competitive analyses and personal reference files live in the
  user's Claude project directory, never in the repo.
- Why: Public repos should not carry material that reads poorly if shared.
- Follow-up: Two such files were removed from history before the first push.
