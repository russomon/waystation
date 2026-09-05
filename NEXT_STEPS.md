# Next Steps

Repo: waystation

The actionable work queue. Current state lives in `CURRENT_WORK.md`; durable
decisions in `DECISIONS.md`. Keep this file short — an item that is finished
gets deleted, an item that stops making sense moves to **Obsolete** with a
reason.

Waystation is currently **parked**: production is transfer-only with no worker,
and nothing here is urgent.

## Now

- **Decide the fate of `codex/hosted-cloud-control`.** It has carried one
  unmerged commit — "Show hosted cloud compute selection" — since 2026-08-04.
  Merge it or delete the branch; a month-old dangling branch is a trap for the
  next agent.
- **Add a proof-suite runner.** There are 40 `scripts/*-proof.sh` and no way to
  run them as a suite, so "the proofs are green" is currently a manual claim.
  A discovery-based runner (`ls scripts/*-proof.sh`, run each, tally
  `PASS ✓` / `FAIL`, honour the self-skip convention) also stops the table in
  `SHARED_CODING_WORKFLOW.md` from drifting again.

## Planned

Real engineering, deliberately deferred. Any of these can start whenever.

- **Deterministic tooling for the worker image.** Register in
  `docs/DEFERRED_TOOLING.md` — currently OpenCV, with the pin, the derived-layer
  build and the integration point already worked out. Do this while a full-QC
  box is already up; that is the cheap moment.
- **Parallel ranged downloads.** Measured 2026-08-01: B2 throttles per
  connection, not per client. One stream reached 232 Mb/s; six streams measured
  **3.3× aggregate**. The uploader already runs `CONCURRENCY = 6`; downloads
  never got the same treatment. Ranges may complete out of order because the
  File System Access writable supports positional writes. Projection puts a
  28 GB download near the line limit — ~5 minutes instead of 16.
  **Re-measure on an idle link first**: the 3.3× was taken while a real
  download competed for the same pipe, so 6 may not be the right concurrency.
- **Stream verified downloads to disk.** `downloadVerified` still accumulates
  every verified range into an in-memory `Blob` (`client/src/downloader.ts`).
  Harmless today only because it is hidden for root-only transfers — but it is
  reachable and ungated for range-mode transfers up to 16 GiB, where a tab dies
  around 1–2 GiB. Reuse the `DownloadSink` shape already proven in the
  "Download original…" path. The same fix is needed for "Verify provenance",
  which does one `arrayBuffer()` over the whole original; note that WebCrypto
  has **no incremental digest**, so this needs a streaming SHA-256 added to
  `crates/blake3-outboard` (mirror the existing `Blake3Hasher`).
- **Export SyncNet's full measurement as drift, not just offset.**
  `qc/avsync.py` scrapes three summary lines and reports ONE offset for the best
  face track, discarding almost everything SyncNet computes: `activesd.pckl`
  holds a per-track distance matrix (frames × lags — 314×31 on the bundled
  `example.avi`), plus `tracks.pckl` and a per-frame confidence curve.
  The unlock is **deterministic, not AI**: an argmin per window over that matrix
  turns one number into an offset *trajectory*, and a regression over it
  separates defects that are currently indistinguishable — flat means a constant
  offset (mux/container error), sloped means progressive drift (clock mismatch),
  stepped at a scene boundary means a reel-assembly error, and a confidence dip
  means the measurement is untrustworthy *in that interval only*.
  Emit per-track `{start, end, offset_ms, confidence}` plus a `drift`
  characterization and low-confidence intervals into the deterministic dossier.
  The model's role stays strictly downstream: correlate, explain a probable
  cause, aim the bounded evidence request. It must never produce, estimate or
  adjudicate the offset.
- **Decide on synthetic-origin QC.** Full design preserved in
  `docs/SYNTHETIC_ORIGIN_PLAN.md` — deliberately not implemented. The deciding
  factor is whether a corpus can be assembled; the code is the cheaper half.
- **Deploy policy v1.4.** Complete in source since 2026-08-02, never deployed.
  Adds bounded advisory MXF, IMF and HDR/Dolby metadata evidence, the house
  delivery template, hash-validated shadow packets and offline Wilson
  evaluation. It claims no AS/IMF/HDR/Dolby conformance. Production still runs
  **v1.1.0** with `AI_INTERPRETIVE_SHADOW=false`; deploying is a separate
  explicit decision.

## Later

- **Jury policy 1.1 candidate.** From live pair-policy data: both models caught
  5/5 plants standalone, yet the deployed policy scored 3 reproduced /
  2 contested, because `match_key` requires identical `evidence_ids` — a juror
  flagging the same mutation across a *different* consecutive evidence pair
  reads as contested. Honest but conservative. Consider relaxing to
  overlap-based matching under a bumped `JURY_POLICY_VERSION`, then re-publish
  proficiency: exactly the drift-invalidation flow the passport was designed for.
- **Validate the hybrid lip-sync instance on a real-face clip.** The cartoon
  stimulus proved the mechanism; real mouths are subtler. Do this before leaning
  on it for any certification-adjacent claim.
- **Hybrid framework, next specs.** `qc/hybrid.py` makes logo/watermark
  **persistence** and shot-content **continuity** straightforward new
  `HybridCheck` instances.
- **Dolby Vision dynamic-metadata canvas verification** via `dovi_tool` —
  currently an explicit `REVIEW_REQUIRED` registry item and a real
  specialist-tool gap.
- Queue between gateway and workers, then autoscaling on backlogged
  media-minutes — the metering ledger is already the right signal.
- Per-customer billing on the metering ledger (Stripe/Lago meters).
- Deeper ABR support: segment/ladder playback rather than manifest lint.
- Full-timeline dead-pixel tracking and dedicated click/pop/test-tone
  classifiers. The agentic reporter samples scene/anomaly frames and audio
  windows and requests more evidence, but does not claim exhaustive timeline
  clearance.

## Blocked

Not blocked by defects — blocked on inputs that do not exist yet.

- **Promoting Phase 2 / Phase 3-4 thresholds beyond advisory** needs real,
  decision-backed accepted and rejected deliveries. Do not broaden authority
  from synthetic fixtures alone. Intake gate: `calibration/`,
  `docs/QC_CALIBRATION.md`, `scripts/phase2-quality-proof.sh`.
- **Live calibration of the remaining generated-media stages.** The 2026-07-24
  proficiency session put real GMI through 10 blind assets and validated two of
  five model stages — the coarse **scene ledger** and **native-resolution
  typography**, plus their deterministic reducers, at 5/5 sensitivity and 5/5
  specificity. Still live-unvalidated, mock-proven only: the **planner**
  (`plan_prompt`), the **jittered fine verification** pass, **prompt adherence**,
  and the **artifact/anatomy specialist**. To close it, run one representative
  generated clip plus its `.genblaze.json` through real GMI. Tune prompts or
  normalizers only if a concrete failure appears, and add that failure to
  `scripts/synthetic-qc-proof.sh`.

### The deployed Passport is honestly `UNCALIBRATED`. Leave it that way.

A proficiency manifest exists, WORM-locked on B2 under `proficiency/`
(COMPLIANCE; bound to commit `e85fd947`). **That record is bound to `e85fd947`,
which is not what production runs.**

> **Do not set `WAYSTATION_COMMIT` to an older manifest's commit on the
> production deployment.** `citation_state()` compares the recorded
> configuration against the running one; overriding the commit to match an
> older manifest would manufacture an EXACT citation for code that did not
> produce those numbers. That is falsifying the binding, and it is the one
> thing the whole Passport design exists to prevent. `UNCALIBRATED` is the
> truthful state.

The only honest route to a citable Passport is to publish a *new* manifest
against the exact deployed configuration — commit, model identities, prompts,
reducers, sampling — from a clean worktree, then point
`PROFICIENCY_MANIFEST_PATH` at it. Re-run `--publish` whenever any of those
change; the citation is *supposed* to flip to UNCALIBRATED when they do. Never
alter the production Passport configuration to chase a green label.

## Obsolete

Kept briefly so nobody re-queues them. The Backblaze Generative Media Hackathon
was submitted on 2026-08-03 and judging closed 2026-08-12.

- ~~Record the demo video~~ — the procedure survives in `docs/demo-script.md`
  if a product demo is ever wanted, but no deadline drives it.
- ~~Prepare the 20–45 s showcase asset~~ — same.
- ~~Re-paste the Devpost "What it does" / "What's next" copy~~ — the Devpost
  page is closed; `docs/devpost-about.md` remains as marketing source material.
- ~~Install `mediainfo` on the recording machine~~ — recording-specific polish.
