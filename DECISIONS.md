# DECISIONS.md

## Active Decisions

Durable decisions only. Full narrative, measurements, rejected alternatives and
same-day reversals live in [`docs/DECISIONS_HISTORY.md`](docs/DECISIONS_HISTORY.md)
(archive copy of the pre-V2.2 record with its body preserved and only the title and banner changed; entries cited as *History*). Where the two differ,
this file governs. Implementation-level and operational entries not promoted
here (for example the 2026-08-02/03 AI run-schema versions, 2026-08-01 delivery
progress UX, 2026-09-01 gateway-only release gates, SyncNet image build notes)
remain in the history file. ADR numbers are stable and never renumbered.

### [ADR-001] Waystation is a separate product from OrbitXfer
- **Status**: `ACCEPTED`
- **Decision**: Waystation ships as its own public repository (`russomon/waystation`) with its own identifiers. OrbitXfer remains the P2P desktop product.
- **Rationale**: Waystation began as "OrbitXfer Web" but diverged into a cloud delivery and QC system. The two share almost no code path and target different users.
- **Invariant**: DO keep the repositories separate. DO NOT merge them or move code between them unless asked.
- **Date**: 2026-07-18

### [ADR-002] Internal and competitive documents stay out of this public repository
- **Status**: `ACCEPTED`
- **Decision**: Competitive analyses and the user's personal reference files live in the user's Claude project directory, never in the repository. Two such files were removed from history before the first push.
- **Rationale**: A public repository should not carry material that reads poorly if shared.
- **Invariant**: DO decide whether a document is repository-facing or internal before writing it. DO NOT commit internal material or copy it wholesale into this repository.
- **Date**: 2026-07-18

### [ADR-003] Python 3.13 floor for the pipeline
- **Status**: `ACCEPTED`
- **Decision**: The pipeline venv is rebuilt on Python 3.13 and the requirement is pinned.
- **Rationale**: `genblaze-core` requires Python 3.11 or later; the real SDK needs it, and it retires the boto3 3.9 deprecation. A renamed or moved checkout breaks venv shebangs, so rebuild the venv rather than relocate it (History 2026-07-19).
- **Invariant**: DO use Python 3.13+ for `pipeline/`. DO NOT relocate a venv; rebuild it.
- **Date**: 2026-07-18

### [ADR-004] The pipeline worker is stateless and deployable anywhere
- **Status**: `ACCEPTED`
- **Decision**: Everything durable lands in B2; the worker ships as a container. The sender chooses local or cloud compute per transfer, and the chosen worker's label is recorded in the provenance manifest.
- **Rationale**: Backblaze sells storage and events, not compute. Statelessness scales horizontally, deploys to any host, and keeps the deployment decision reversible.
- **Invariant**: DO keep durable state out of the worker. DO NOT add local persistence that prevents horizontal scaling.
- **Date**: 2026-07-18

### [ADR-005] Genblaze manifests under B2 Object Lock are the trust anchor
- **Status**: `ACCEPTED`
- **Decision**: Every QC run emits a real `genblaze-core` manifest (schema v1.5), canonical-hashed and SDK-verified before upload, written with COMPLIANCE-mode Object Lock when `MANIFEST_LOCK_DAYS > 0`. Local `scripts/dev-up.sh` always runs with `MANIFEST_LOCK_DAYS=0` because MinIO does not support B2 Object Lock.
- **Rationale**: The manifest is tamper-evident and Object Lock makes it tamper-proof; this was proven on real B2 by refusing deletion from a key holding `deleteFiles` and `bypassGovernance`. QC reports must be evidence, not only output.
- **Invariant**: DO sign and verify manifests before upload. DO NOT let a local non-retaining store claim Object Lock support.
- **Date**: 2026-07-18

### [ADR-006] Deterministic and AI QC are separate, cooperating lanes
- **Status**: `ACCEPTED`
- **Decision**: Deterministic instruments measure anything with a specification, threshold or contract (loudness, legal range, conformance, hashes). AI judges what needs perception or intent. AI verdicts annotate the report and never overwrite an instrument reading.
- **Rationale**: Full-coverage measurement is cheap and reproducible; sampling-based AI is neither, and a specification-defined number cannot be estimated. The hybrid is the product, not a transitional compromise.
- **Invariant**: DO keep the two gates separate. DO NOT let AI output change a deterministic reading, status or tier.
- **Date**: 2026-07-18

### [ADR-007] Every capability claim carries a proof script
- **Status**: `ACCEPTED`
- **Decision**: Each capability ships with a self-contained `scripts/*-proof.sh` that builds violating media or fixtures, runs the real code, and asserts outcomes. Anything not provable is marked honestly gated in `README.md`. Proof guards are mutation-tested before they are trusted.
- **Rationale**: Reproducibility is the differentiator against "contact sales" incumbents, and several genuine bugs were found only because proofs assert on live output.
- **Invariant**: DO add or extend a proof for every new claim and keep existing proofs green. DO enumerate proofs from disk (`ls scripts/*-proof.sh`). DO NOT treat a failing proof as an obstacle to route around, and DO NOT cite a stored proof count or table as authoritative.
- **Date**: 2026-07-19

### [ADR-008] GitHub is the source of truth; the repository is the shared memory
- **Status**: `ACCEPTED`
- **Decision**: Repo-local files carry state between machines, Codex, Claude Code and Cursor. Active repositories live under `/Users/Shared/Orbit/Code/`. `origin` uses SSH. Consumer file sync is never used for live source. Migrated to the Shared Git-Centric Context V2.2 contract (V2 2026-09-04, V2.1 2026-09-11).
- **Rationale**: Git keeps source exact; repo-local notes keep agents aligned without depending on chat history or platform memory.
- **Invariant**: DO treat the repository as authoritative over memory or conversation. DO NOT use iCloud, Dropbox or Google Drive for live source.
- **Date**: 2026-07-19

### [ADR-009] Waystation reports QC issues and never repairs media
- **Status**: `ACCEPTED`
- **Decision**: The self-healing runtime was retired. A versioned read-only AI inspection charter (independent sweep, one bounded allowlisted evidence round, instrument-informed sweep, critic) feeds a deterministic 18-risk registry that accounts for model omissions and separates verdict from coverage.
- **Rationale**: The product is stronger as a trusted observer that hands findings to a human or later system. The worker cannot alter the submitted master, AI cannot run arbitrary tools, and unresolved risks stay visible rather than implied clean.
- **Invariant**: DO give every applicable registered risk an explicit disposition, including unresolved gaps. DO NOT add repair or transformation to the QC path.
- **Date**: 2026-07-23

### [ADR-010] Lip-sync: no VLM judgment; perceive-then-compute; SyncNet is optional
- **Status**: `ACCEPTED`
- **Decision**: A general VLM must not judge A/V sync. Measured lip-sync uses an optional SyncNet analyzer (`qc/avsync.py`; opt-in `INSTALL_SYNCNET` image build). Models may only perceive under deterministic control (`qc/hybrid.py` `HybridCheck`; `align` abstains when ambiguous). A hybrid WARN raises SUSPECTED; a hybrid PASS never CLEARs.
- **Rationale**: A controlled probe showed the VLM confabulated, calling a 1.7 s offset in sync with high confidence. Sampled stills plus audio give no time-locked correspondence. Perception plus cross-correlation did recover exact offsets.
- **Invariant**: DO emit an explicit FYI when the analyzer is absent. DO NOT let a VLM or a missing tool clear or confirm `lip_sync`.
- **Date**: 2026-07-23

### [ADR-011] Only instruments reject; no model finding may be a BLOCKER
- **Status**: `ACCEPTED`
- **Decision**: `checks_from_findings` caps every agentic (model) finding at ISSUE, under any risk id. Supersedes the narrower same-month `unregistered_observation` cap, kept in history. Profile-governed escalation still happens after this point in `worker.run_ai_qc`.
- **Rationale**: Live runs showed the model restating measured defects as its own findings and laundering them through ill-fitting registered ids, inflating BLOCKERs (6 then 5 for 3 real defects). The prompt layer reduces restatement but is not load-bearing; the deterministic cap is.
- **Invariant**: DO re-run the model against any guard that constrains it; replaying old output cannot show routing-around. DO NOT narrate model restatements as independent corroboration of instruments. DO NOT rely on prompt wording as the control.
- **Date**: 2026-07-24

### [ADR-012] AI Reliability Passport: blind Jury plus Proficiency Foundry, never a composite score
- **Status**: `ACCEPTED`
- **Decision**: AI findings carry a passport with two independently measured axes: Jury reproducibility (a second model re-perceives the same evidence blind, replayed through the same reducer; `reproduced | contested | single_source`) and Proficiency (planted-defect suites, deterministic scoring, Wilson 95% intervals). A contested finding stays SUSPECTED with raised priority. Proficiency manifests are published to B2 under COMPLIANCE Object Lock and cited only on an EXACT configuration match (`foundry.citation_state`); drift renders the lane UNCALIBRATED. Handoff packets replace "regeneration advice".
- **Rationale**: A single "87% confidence" would recreate false certainty. Disagreement is information, never an eraser. The published record (commit `e85fd947`, n=5, PROVISIONAL) validates only two of five generated-lane stages; the planner, jittered verification, prompt adherence and artifact specialist remain mock-proven.
- **Invariant**: DO publish a new manifest from a clean worktree against the exact deployed configuration to earn a citation. DO NOT emit a composite score. DO NOT set `WAYSTATION_COMMIT` to an older manifest's commit or alter production Passport configuration to chase a green label; `UNCALIBRATED` is the truthful state.
- **Date**: 2026-07-24

### [ADR-013] Hosted MVP: the API is published only behind auth, ownership and ceilings
- **Status**: `ACCEPTED`
- **Decision**: Sender auth is one high-entropy code (scrypt hash) exchanged for a signed, short-lived `HttpOnly; SameSite=Strict` cookie (Secure in production), with stateless sessions. Every upload route verifies key and uploadId belong to the session and returns a neutral 404 otherwise. State is SQLite via `node:sqlite` with idempotent meter events. Cost controls act at the dispatch boundary. Recipient links stay open but have expiry and revocation. CORS is exact-origin with credentials and registered before routes. `/healthz` discloses nothing. Production uses a standalone compose with cloudflared dialling out and zero published ports. Dev stays permissive; under `NODE_ENV=production` the gateway refuses to start with auth disabled, weak secrets or an ephemeral database.
- **Rationale**: Before hosting, the API had no authentication, authorization, limits or durable state, so publishing it would have given anyone presigned write URLs and unbounded GMI spend. Preflight must precede the session gate or the browser never sends the real request.
- **Invariant**: DO fail closed in production. DO verify ownership on every upload route with a neutral 404. DO NOT use the retired literal `waystationQC` secret. DO NOT put auth ahead of CORS preflight. DO NOT publish new API routes without session, ownership and ceiling checks.
- **Date**: 2026-07-27

### [ADR-014] Large files above 16 GiB use root-only verification
- **Status**: `ACCEPTED`
- **Decision**: Files above 16 GiB use `root` verification mode: a whole-file BLAKE3 root is recorded, no `.obao` is uploaded, `/uploads/outboard-url` is refused, and delivery states that verified-range is unavailable. Files at or below 16 GiB use `range` mode. Above 100 GiB every worker/QC service is forced off. The mode is chosen by the server (`verificationModeForSize`) and stored on the upload.
- **Rationale**: The bao outboard is built in browser wasm memory and is not credible at 350 GiB. The 100 GiB cutoff protected a 390 GiB scratch disk that no longer exists in the transfer-only deployment, so that limit is historical context rather than a current constraint. Native large-file verification is an unbuilt idea (`docs/NATIVE_SENDER_PLAN.md`).
- **Invariant**: DO let the server own `verificationMode`. DO NOT describe root-mode transfers as range-verified.
- **Date**: 2026-07-31

### [ADR-015] Cost-aware AI triage routes spend, never verdicts
- **Status**: `ACCEPTED`
- **Decision**: `qc_ai_triage` runs after deterministic QC and may only skip or narrow optional model spend. Every skip is recorded and shown. Invalid output or provider failure falls back to the sender-requested behavior. A source `.genblaze.json` manifest still forces Synthetic QC.
- **Rationale**: Running every GMI lane on every upload is expensive and redundant, but a router must not become a verdict engine.
- **Invariant**: DO record every skipped lane. DO NOT let triage clear, fail, suppress or rewrite deterministic QC.
- **Date**: 2026-07-31

### [ADR-016] Deployment state is container contents, not a commit hash
- **Status**: `ACCEPTED`
- **Decision**: Deployment is established by image build time and the contents of the running container. Rebuild services individually and report which. Source commits, `git rev-parse` on the host, and runbook entries are records, not verification.
- **Rationale**: A branch two commits ahead was misreported as drift when content was identical, while the real gap was a worker container not rebuilt since 2026-07-28. A checkout updates source; only a rebuild updates what runs.
- **Invariant**: DO report source-complete, recorded-deployed and independently-verified as separate facts. DO NOT infer what runs from a commit hash.
- **Date**: 2026-08-01

### [ADR-017] Client and gateway ship in lockstep; never guess a server-owned value
- **Status**: `ACCEPTED`
- **Decision**: A gateway change that alters the client contract is not deployed until the client is republished, and the client never defaults a value the server owns. The client asks for `verificationMode`; only `403 outboard_disabled` means root.
- **Rationale**: A 27 GiB upload wedged at 99.97% because a stale portal client defaulted the mode and built a roughly 1.7 GiB outboard in wasm. A republished client does not reach an already-open tab.
- **Invariant**: DO verify every gateway path the pinned bundle calls exists at the deployed commit before publishing. DO confirm the client version before committing hours to a long operation. DO NOT default a server-owned value client-side.
- **Date**: 2026-08-01

### [ADR-018] Downloads: forced save, parallel ranges at concurrency 12, measured over gigabytes
- **Status**: `ACCEPTED`
- **Decision**: The gateway signs `ResponseContentDisposition: attachment` into the original's presigned URL; derivatives stay inline. Where the File System Access API exists, the page pipes bytes to a chosen file and shows bytes, rate and ETA. Downloads use parallel ranged requests, `DOWNLOAD_CONCURRENCY = 12` (measured 91 MB/s versus 23 MB/s single-stream). B2 throttles per connection, so parallelism is the lever.
- **Rationale**: `<a download>` is ignored cross-origin, so a 26 GiB `.mov` opened in the media player. Samples of 50–200 MB measure TCP slow-start, not capacity, and twice produced wrong conclusions.
- **Invariant**: DO measure throughput over at least about 1 GB per configuration, interleaved, taking the best of several. DO NOT claim a concurrency above 12 without measuring it.
- **Date**: 2026-08-01

### [ADR-019] Delivery authority is dual-key; AI holds a constrained, evidence-gated key
- **Status**: `ACCEPTED`
- **Decision**: Canonical delivery `status` and `tiers` come from deterministic checks only; every AI-origin source is advisory and separate. The explicit AI Interpretive gate has independent authority over versioned perceptual categories and may HOLD or REJECT only through its versioned policy (modes `shadow`, `hold`, `enforce`; default `shadow`, run-disabled). An enforceable finding needs two distinct provider/model source identities plus a separate synthesis agreement, allowlisted stored evidence, policy confidence, `reject` severity and `confirmed_defect` intent. Missing, malformed or incomplete AI output is HOLD/`not_checked`, never READY. Caption and temporal claims need cited, temporally aligned evidence. Provider output uses a structured-output transport contract and is still sanitized. The optional review brief is untrusted context.
- **Rationale**: Synthesis is adjudication, not independent evidence. Prompt instructions alone were not an enforcement boundary: a model invented caption correspondence despite 0% overlap, and a visual stage truncated without a complete object. Isolated still frames cannot prove or clear a freeze or timeline defect.
- **Invariant**: DO require reducer-checked evidence for any AI rejection. DO NOT let AI erase a deterministic failure, rewrite an instrument value, create a composite score, or gain authority from raw text. DO NOT enable paid or enforcing defaults without a separate decision.
- **Date**: 2026-08-02

### [ADR-020] Versioned house baselines are not network compliance; thresholds are corpus-gated
- **Status**: `ACCEPTED`
- **Decision**: Profile `us_broadcast_xdcam_hd_422_v1` (policy pack v1.1.0) states its exact MXF OP1a/XDCAM assumptions and accepts only explicit overrides (unknown keys fail closed; source and effective hashes retained). Wrapper facts, measurements and policy decisions are kept separate. Phase 2 perceptual metrics, QCTools measurements, PSE, MXF/IMF/HDR/Dolby metadata and CEA caption transport are advisory. Only explicit, repeatable policy rules may reject, and promotion requires real decision-backed corpora, independent splits, Wilson bounds and a new policy version. Preservation CLIs (pinned qcli and MediaConch) are provenance plumbing and never clear media.
- **Rationale**: "U.S. broadcast MXF" is not one specification; synthetic fixtures prove code behavior, not network acceptance. Historical: the former full-QC production worker (spun down 2026-08-31) ran policy v1.1.0 with `AI_INTERPRETIVE_SHADOW=false`. The recorded current deployment is transfer-only with no worker (`docs/DEPLOY.md`), so no policy version is running in production; policy v1.4 is source-complete and has never been deployed.
- **Invariant**: DO mark unavailable or malformed measurements `not_checked`. DO NOT claim AS-11, IMF, HDR/Dolby, SMPTE 436, CEA-608/708 or network conformance, invent private network rules, or emit a composite score.
- **Date**: 2026-08-02

### [ADR-021] Preview imagery is AI-selected, never AI-generated
- **Status**: `ACCEPTED`
- **Decision**: Thumbnailing extracts up to six real source frames; a GMI model may select only one candidate ID from that allowlist. Selection method, hashes and usage are stored in provenance; failures use a disclosed deterministic fallback.
- **Rationale**: A preview must show actual source content; scene-cut enrichment is capped to short assets so large transfers never incur a full-timeline scan.
- **Invariant**: DO restrict AI to selecting among extracted frames. DO NOT let a model create or modify preview imagery.
- **Date**: 2026-08-02

### [ADR-022] Transfer is the default mode and batches preserve file identity
- **Status**: `ACCEPTED`
- **Decision**: The sender opens in Transfer mode; Transfer + QC is a deliberate second mode. Each queued file gets its own transfer ID, resumable multipart upload, progress record and share link, uploaded sequentially. Captions and manifests attach only when Transfer + QC has exactly one master. Transfer mode sends every service flag off.
- **Rationale**: Secure delivery is the primary path. A batch is a client convenience, not an archive object; one sidecar across several masters would be ambiguous.
- **Invariant**: DO keep one transfer per file. DO NOT guess sidecar attachment for multi-master batches.
- **Date**: 2026-09-01

### [ADR-023] Recipient passwords gate access and bind to the download; they do not encrypt
- **Status**: `ACCEPTED`
- **Decision**: A sender may leave the password blank or set one; new transfers require at least 4 characters, older links keep theirs, with no complexity rules. Passwords are salted scrypt, never stored in plaintext. Only a transfer-scoped signed `HttpOnly` unlock cookie authorizes a protected transfer, sliding 1 h per authorized request; the sender session is not a key (2026-09-11), and only `/progress/:id` exempts it via a separate `progressGate`. Download tickets were removed (2026-09-30). Unlock is capped at 10/min per address, 60/min deployment-wide and 20 wrong answers per link per hour. Protected transfers cannot be fetched by curl/aria2c or another machine.
- **Rationale**: A copied ticketed link bypassed the password, and a sender who could skip the gate could not rehearse what a recipient sees. A presigned URL issued after unlock stays valid until its signature expires, so this is an authorization gate, not encryption.
- **Invariant**: DO require the unlock cookie on every delivery route. DO NOT add a sender or ticket bypass, call this end-to-end encryption, or store a plaintext password.
- **Date**: 2026-09-01

### [ADR-024] Mediated download returns JSON; a browser cannot fetch a cross-origin redirect
- **Status**: `ACCEPTED`
- **Decision**: `GET /transfers/:id/original` redirects by default (correct for navigation and CLI tools); `?format=json` returns `{ url }` for script use, behind the identical gate (revocation, expiry, password, scope, metering). The client fetches storage itself, so preflight is permitted.
- **Rationale**: A preflighted request may not follow a cross-origin redirect, and a redirected cross-origin request carries `Origin: null`, which B2 refuses. Correct CORS on both sides still cannot work. Adding `null` to bucket origins would expose objects to every sandboxed iframe and `data:` document.
- **Invariant**: DO design the machine-facing shape explicitly rather than assuming a redirect is transparent. DO NOT add `null` to allowed origins, and DO NOT send `Range` to a redirecting endpoint.
- **Date**: 2026-09-07

### [ADR-025] Resume is Range requests plus bookkeeping, recorded only after close()
- **Status**: `ACCEPTED`
- **Decision**: Resume uses HTTP Range plus a per-transfer IndexedDB record (`client/src/downloadResume.ts`). A `FileSystemWritableFileStream` commits nothing until `close()`, so completed ranges are persisted only after a successful close and resume uses `keepExistingData: true`. Pause aborts the pool and never falls back to a single stream. Killing the tab starts over.
- **Rationale**: Recording ranges before close produced a correctly sized file full of garbage. Verified streaming (iroh/BLAKE3 style) was rejected for the browser path.
- **Invariant**: DO persist range bookkeeping only after `close()`. DO NOT trust a resumed download beyond what storage guarantees.
- **Date**: 2026-09-07

### [ADR-026] One download path: verify before write, or honestly say it is absent
- **Status**: `ACCEPTED`
- **Decision**: `saveToDisk` (`client/src/delivery.ts`) is the only download path. When the `.obao` sidecar is at most 256 MB, every range is verified against the BLAKE3 root before it is written (ranges capped at 8 MiB). Above that it proceeds unverified and the status line says so. `planRanges` aligns to whole 1024-byte BLAKE3 chunks.
- **Rationale**: Misaligned ranges would have failed verification on exactly the large transfers it exists for, and silence about an unverified download is worse than saying it plainly.
- **Invariant**: DO verify before writing, or state verification is absent. DO NOT reintroduce a second download button or whole-file buffering.
- **Date**: 2026-09-08

### [ADR-027] User-facing byte counts are decimal; operator surfaces stay binary
- **Status**: `ACCEPTED`
- **Decision**: `client/src/format.ts` is the only user-facing formatter (MB/GB as Finder and B2 invoices count). Boot banner, `limits.ts`, `docs/DEPLOY.md`, the 16 MiB part floor and the 5 GiB PUT cap stay binary.
- **Rationale**: Each surface uses the units its underlying limits are specified in.
- **Invariant**: DO recompute the value when relabeling a unit. DO NOT add a second formatter.
- **Date**: 2026-09-08

### [ADR-028] "Active" uploads age out; quotas are re-scoped with billing
- **Status**: `PROVISIONAL`
- **Decision**: `countActive` is bounded by `ACTIVE_UPLOAD_WINDOW_HOURS` (default 24) and production runs `MAX_ACTIVE_UPLOADS_PER_SESSION=3`. The job-count quotas (`MAX_JOBS_PER_SESSION`, `MAX_DAILY_JOBS`; production 10 and 20, defaults 20 and 200) are re-scoped together with billing, not before. Paid sessions already bypass the job-count caps.
- **Rationale**: A ceiling of 1 wedged a real session after a Wi-Fi drop. The quotas were QC cost controls; in transfer-only mode a count is the wrong unit and `MAX_DAILY_JOBS` is a global ceiling. Provisional because the replacement design is open (NEXT_STEPS).
- **Invariant**: DO treat upload-count quotas as a pricing question. DO NOT raise the numbers as a substitute for the re-scope.
- **Date**: 2026-09-08

### [ADR-029] Named sender codes live in the database; the environment code is the admin
- **Status**: `ACCEPTED`
- **Decision**: `WAYSTATION_ACCESS_CODE_HASH` is the admin code and opens `/admin/*`. Every other code is a row in `access_codes`: server-generated or admin-chosen (8–64 characters, case-sensitive, exact match), shown once, scrypt-hashed, never logged or listed, with labels unique among live codes. Sessions carry `oid`/`adm`; `requireSession` re-checks the owner row each call, so revocation takes effect next request. `owner_id` is recorded on uploads and transfers. Non-admins get a neutral 404 on `/admin/*`. Login is capped at 10/min per address and 60/min deployment-wide. No delete, un-revoke or rename.
- **Rationale**: One shared code meant SSH and a restart per client and no record of who sent what; a durable `owner_id` is the one thing the commercial plan says must not be deferred. A chosen code that duplicates an active code would credit one client's transfers to another.
- **Invariant**: DO record `owner_id` on every upload and transfer. DO NOT treat ownerless sessions as anybody, store or log a plaintext code, or allow duplicate active codes.
- **Date**: 2026-09-17

### [ADR-030] QC preview: the tab is a showcase for clients and live for the admin
- **Status**: `ACCEPTED`
- **Decision**: `WAYSTATION_QC_MODE` is `live` (default) or `preview`; anything else refuses to boot. In preview, a non-admin QC initiate is refused 403 `qc_preview` before anything exists on B2; `GET /session` reports the mode per viewer. Independent of `MAX_QC_BYTES`; flip both when QC returns.
- **Rationale**: The API is authoritative; a page-only lock is a suggestion. Refusing at initiate leaves no multipart to sweep and no meter event.
- **Invariant**: DO enforce QC mode at the API before spend. DO NOT rely on a client-only disable or refuse only at `/uploads/complete`.
- **Date**: 2026-09-17

### [ADR-031] Pay-per-gig: payment is authorization; the API is authoritative over budget and downloads
- **Status**: `ACCEPTED`
- **Decision**: A public sender pays by Stripe Checkout (card) or Coinbase Commerce (crypto) and a confirmed payment mints a payment-backed session; there is no signup, and access codes remain for comped/admin free uploads. One charge per checkout priced on total decimal GB. Webhooks verify the RAW body before parsing. The order's `priced_bytes` is the upload budget, reserved atomically at `POST /uploads`. `transfers.downloads_allowed` is set from the order at complete and enforced by grants (`download_grants`): one download is one grant, and the next ungranted request is `403 downloads_exhausted`. NULL means unlimited so comped and pre-feature transfers are never retroactively capped. `WAYSTATION_PAYMENTS_MODE=test` short-circuits the network for proofs.
- **Rationale**: This makes the tool a product without a signup system, keeps the API authoritative over what a client cannot inflate, and reuses session/ownership/metering machinery. Grants are the audit trail a charged feature needs. Pricing specifics are in ADR-032.
- **Invariant**: DO derive budget and download allowance from the order, never a client value. DO NOT charge per file, store a downloads-used counter, or default `downloads_allowed` to a NOT NULL value.
- **Date**: 2026-09-19

### [ADR-032] Pay-per-gig v2 pricing: flat add-ons, link weeks and a hidden bonus download
- **Status**: `ACCEPTED`
- **Decision**: Base is $0.02 per decimal GB, rounded up once. Stripe adds 3% plus 30 cents (floored at the $0.50 minimum); Coinbase adds 2%. Extra downloads (included 2, up to 10) cost a flat 1 cent/GB each. Link lifetime is selectable at 1 week included, up to 5, each extra week a flat 1 cent/GB; link life is weeks × 7 + 1 day. Every paid link is enforced at `chosen + 1` downloads; the sender sees and pays only for the chosen count. Paid links default to 8 days; comped and admin links keep `RECIPIENT_LINK_TTL_DAYS`. Constants live in `gateway/src/pricing.ts`. Supersedes the pricing specifics of the 2026-09-19 entry.
- **Rationale**: The owner found extra downloads too dear, link lifetime unchoosable, and wanted goodwill against a wasted pull. Add-ons stay flat so no gateway percentage compounds.
- **Invariant**: DO keep add-ons flat. DO NOT enforce the paid download count below `chosen + 1` or change prices without updating `scripts/payment-gateway-proof.sh`.
- **Date**: 2026-09-21

### [ADR-033] OrbiStation is the public name; internal identifiers keep Waystation
- **Status**: `ACCEPTED`
- **Decision**: The display name users read is **OrbiStation** (app title, headings, mode labels, email template and From default, Stripe charge description). The repository name, `WAYSTATION_*` variables, `waystation-api`/`-compute` meta tags, QC profile ids, Docker service names and the database keep the Waystation name on purpose. The client is served at `/orbistation/` (`/waystation/` 301-redirects) and the sender-page base used for payment success/cancel redirects comes from `WAYSTATION_PUBLIC_BASE_URL` (value on the host: UNKNOWN — not recorded in repository documents).
- **Rationale**: A display rename costs nothing operationally, while renaming identifiers would break deployed environments, scripts and stored state (commit `5d47d6d`).
- **Invariant**: DO use "OrbiStation" in user-facing copy. DO NOT globally rename `waystation` identifiers or the repository without an explicit decision.
- **Date**: 2026-09-27

### [ADR-034] End-to-end encryption is shelved; harden the server-readable model
- **Status**: `ACCEPTED`
- **Decision**: E2E encryption (fragment-carried key, chunked AES-GCM; `docs/E2E_ENCRYPTION_PLAN.md`) is not implemented. Marketing claims match what exists: encrypted in transit and at rest (bucket default SSE-B2 AES256 verified 2026-09-30), not end-to-end.
- **Rationale**: The owner requires vanilla-browser delivery with no service worker, decrypt tool or local staging copy; under that only desktop Chromium could stream decrypted bytes to a chosen location, and that trade was declined.
- **Invariant**: DO keep claims to what the model provides. DO NOT describe the service as end-to-end encrypted unless a constraint changes (service worker acceptable, or Chromium-only large encrypted downloads acceptable).
- **Date**: 2026-09-30

### [ADR-035] Security hardening: storage purge, least-privilege B2 key, headers
- **Status**: `ACCEPTED`
- **Decision**: Expired or revoked transfers are permanently deleted (every version and delete marker, since the bucket is versioned) 7 days after the link died; schema v7 adds `revoked_at`/`purged_at`. Purge is irreversible, ships dry-run by default (`WAYSTATION_PURGE_MODE`), and only UUID-shaped ids become prefixes. The usage ledger is owner-only. The API sends HSTS, nosniff, `X-Frame-Options: DENY`, `no-referrer` and a deny-all CSP; the portal ships HSTS and an enforced CSP on `/orbistation/*`, with Cloudflare Web Analytics removed from OrbiStation. The production B2 key is limited to `listBuckets, listFiles, readFiles, writeFiles, deleteFiles` on the one bucket (`orbistation-gateway-min`, CLI-created).
- **Rationale**: A security review found long-lived data, an over-broad 25-capability key (including `writeBuckets` and `bypassGovernance`) and missing headers. Objects under COMPLIANCE Object Lock cannot be purged and are retried.
- **Invariant**: DO read the dry-run list and take a WAL-safe backup before enabling or changing purge. DO NOT widen the production B2 key beyond what the gateway uses, or log full transfer ids (8-character prefixes only).
- **Date**: 2026-09-30

### [ADR-036] Browser downloads renew their storage URL; metering keys on the download
- **Status**: `ACCEPTED`
- **Decision**: The 1-hour presigned storage URL TTL is kept (`WAYSTATION_STORAGE_URL_TTL_SECONDS`, default 3600). The client renews through the mediated route (`client/src/storageSource.ts`), proactively 5 minutes before expiry and reactively once on a storage 401/403, single-flight across the 12 workers; renewal re-checks revocation. Egress is metered once per download (a live grant or a valid `continuation` token), not per hour. The continuation token is HMAC-signed under a separate domain so it can never open a protected transfer and is metering-only.
- **Rationale**: Downloads over one hour stalled at the hour mark and each renewal re-billed the whole file. Lengthening the TTL would let a leaked storage URL outlive revocation; per-range resolution and CDN-worker streaming were rejected.
- **Invariant**: DO keep renewal single-flight and domain-separated. DO NOT lengthen the TTL to avoid renewal, treat a continuation token as authorization, or re-meter renewals.
- **Date**: 2026-09-30

### [ADR-037] Branch policy: `main` is the canonical development branch
- **Status**: `ACCEPTED`
- **Decision**: Owner decision 2026-10-06: `main` is the canonical development branch going forward, replacing the earlier arrangement in which `codex/hosted-waystation-mvp` was the trunk and `main` a fast-forwarded follower. Use a separate named branch only for parallel or risky work, and merge or delete it promptly. `main` adopts the migration checkpoint by fast-forward only, after it is committed and pushed on the branch where it was made. The decision does not authorize deleting any other branch, including `codex/hosted-waystation-mvp`, whose disposition is TBD. `codex/hosted-cloud-control` was retired on 2026-10-06 after a recorded comparison; its tip is preserved by the tag `archive/hosted-cloud-control` (`docs/archive/BRANCH_RETIREMENTS.md`). `codex/hosted-waystation-mvp` is kept as a historical branch and is no longer mirrored from `main`.
- **Rationale**: The `codex/` prefix was only a name from when the work started, and a follower branch adds a manual mirroring step that agents can skip or perform inconsistently. Why the follower arrangement was originally chosen: UNKNOWN — not recorded in existing context.
- **Invariant**: DO report any difference between `main` and `origin/main` before doing anything else. DO fast-forward only. DO NOT push, merge or fast-forward `main` without explicit authorization in the current request, switch branches while uncommitted work is present, or delete a branch or worktree registration that was not specifically approved.
- **Date**: 2026-10-06
