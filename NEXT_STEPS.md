# Next Steps

Repo: waystation

Use this file for the short forward-looking queue, not the full project
history.

## Now

- **Release and record the explicit Genblaze/GMI workflow.** Source now includes
  the dedicated opt-in run, B2 evidence artifacts, stage/provenance timeline,
  and compact recipient view. It is not deployed and both production gates are
  false. Follow `docs/AI_INTERPRETIVE_RUN.md`: deploy first with gates false,
  enable reversibly, make one bounded credentialed GMI run with other AI lanes
  off, verify hashes/metering/authority, then record. Do not claim the mock proof
  as live-provider validation.

- ~~Deploy the 350 GiB large-file build~~ — **DONE 2026-08-01.** Gateway is at
  `7291c80`, banner reports `max=350.0GiB verifiedRangeMax=16.0GiB
  rootOnly=true maxQC=100.0GiB`.

- ~~Smoke test large-file mode~~ — **DONE 2026-08-01, on real media.** A
  26.12 GiB `.mov` went through transfer-only end to end: `verificationMode:"root"`,
  no `.obao`, delivery page disclosed the missing sidecar and withheld the
  verified-download control. Download averaged 232 Mb/s in 16:09. Four defects
  found and fixed doing it — see `CURRENT_WORK.md`.

- ~~**Reconcile the stale worker image.**~~ **DONE 2026-08-02.** The worker was
  rebuilt from source commit `ecfcc01` and now runs image `sha256:753b834f…`
  with pinned qcli/MediaConch, policy v1.1.0, deterministic timeline/QCTools
  analysis, prompt compilation, and future-upload cost-aware triage routing.
  Worker health and both internal/public health endpoints passed; gateway and
  cloudflared container IDs were unchanged. No historical upload was replayed.
  `AI_INTERPRETIVE_SHADOW=false`, so interpretive model spend remains off.
  See `CURRENT_WORK.md` and `docs/DEPLOY.md` for exact evidence.

- ~~**Phase 1 deterministic milestone 1, steps 1-3.**~~ **DONE in source
  2026-08-02.** The versioned U.S. broadcast XDCAM baseline, active ffprobe /
  FFmpeg / MediaInfo / MediaConch metadata reducers, structured evidence, and
  known-good/known-bad proofs are present. It is a house baseline, not complete
  broadcast-MXF or universal network parity.

  ~~Next: bounded QCTools extraction and timeline/prompt/shadow plumbing.~~
  **DONE in source 2026-08-02.** QCTools runs bounded advisory signalstats
  excerpts with raw report hashes; timeline events are evidence-rich; targeted
  review packets and spend-off shadow execution are proven; scoped aspect,
  color-matrix/range and programme-start rules are in policy v1.1.0.

  Remaining calibration: representative customer/network accepted and rejected
  masters. Do not broaden advisory QCTools, black/freeze/silence/legal-range
  authority from synthetic fixtures alone.

- ~~**Phase 2 delivery-grade visual/audio source milestone.**~~ **DONE in
  source 2026-08-02; not deployed.** Policy v1.2.0 adds bounded advisory
  blockiness, blur, banding, temporal/layout/color-bars, phase, clipping,
  click/pop, dropout, channel-consistency, SRT/VTT continuity/coverage, and
  three-tool metadata contradiction evidence. QCTools adds validated advisory
  anomaly candidates while retaining raw-report hashes. The corpus intake gate
  and fixtures are in `calibration/`, `docs/QC_CALIBRATION.md`, and
  `scripts/phase2-quality-proof.sh`.

  Next: collect real, decision-backed accepted/rejected deliveries. Keep every
  Phase 2 threshold advisory until a reviewed corpus justifies a new policy
  version. Production remains on worker policy v1.1.0 and
  `AI_INTERPRETIVE_SHADOW=false`; deployment requires a separate decision.

- ~~**Authority, calibration, captions, and audio-map correction package.**~~
  **DONE in source 2026-08-02; not deployed.** Policy v1.3.0 removes every
  AI-to-BLOCKER path (including the former Netflix censorship exception),
  makes canonical delivery status/tiers deterministic-only, relabels the YDIF
  PSE screen as non-blocking guidance, structurally isolates interpretive
  shadow observations, adds independent stratified holdout/Wilson calibration
  gates, accepts bounded SCC/MCC/RCWT caption transports with honest service
  limits, and enforces explicitly declared audio track maps. Next: review the
  source/demo behavior, then make a separate production deployment decision.
  Production and AI shadow remain unchanged.

- ~~**Phase 3-4 deep package and AI-evaluation source milestone.**~~ **DONE in
  source 2026-08-02; not deployed.** Policy v1.4.0 adds bounded advisory MXF,
  IMF, HDR/Dolby metadata evidence, one provenance-carrying Waystation house
  template, side-by-side human/commercial benchmark intake, hash-validated
  shadow packets, evidence citation constraints, reviewer dispositions, and
  offline Wilson evaluation. It does not claim AS/IMF/HDR/Dolby conformance,
  commercial parity, or network acceptance. Next: collect retained real
  customer decisions, qualified analyzer outputs, commercial comparisons, and
  human shadow reviews. Production remains policy v1.1.0 and shadow remains
  disabled; deployment requires a separate explicit decision.

- **Record the baseline hackathon demo.** The hosted MVP is deployed, published
  and rehearsed — **14/14 production checks passed 2026-07-28** (record in
  `docs/DEPLOY.md`). Nothing infrastructural blocks recording.

- **Prepare the showcase asset** — the rehearsal deliberately used a cheap
  10 s / 640×360 fixture to validate plumbing at minimum cost. That is the
  *infrastructure rehearsal asset*, not the demo asset. For the recording,
  prepare a separate **20–45 s, 720p or 1080p, known-generated** clip with:
  genuine generator/model/prompt captured in a truthful `source.genblaze.json`;
  visible text or signage across multiple shots; subject motion and temporal
  continuity; audio plus a caption sidecar where practical; enough intentional
  complexity to exercise synthetic QC, prompt adherence, evidence sampling and
  the Passport. Do not let a weak test fixture become the public demonstration.

- **After the deadline: parallel ranged downloads.** Measured 2026-08-01 —
  B2 throttles per-connection, not per-client. A single stream achieved
  232 Mb/s; six parallel streams measured **3.3× aggregate**. The uploader
  already uses `CONCURRENCY = 6`; downloads never got the same treatment.
  Ranges can complete out of order because the File System Access writable
  supports positional writes (`writable.write({ type: "write", position, data })`).
  Projection puts a 28 GB download near the 800 Mb/s line limit — roughly
  5 minutes instead of 16. **Re-measure on an idle link first**: the 3.3× ratio
  was taken while a real download was competing for the same pipe, so the
  absolute numbers are depressed and the right concurrency may not be 6.

- **After the deadline: stream verified downloads to disk.** `downloadVerified`
  still accumulates every verified range into an in-memory `Blob`
  (`client/src/downloader.ts`). It is currently harmless only because it is
  hidden for root-only transfers — but it is still reachable, and ungated, for
  range-mode transfers up to 16 GiB, where a tab will die around 1–2 GiB. Reuse
  the `DownloadSink` shape now proven in the "Download original…" path. The
  same fix is needed for "Verify provenance", which does one
  `arrayBuffer()` over the whole original; note WebCrypto has **no incremental
  digest**, so that needs a streaming SHA-256 added to
  `crates/blake3-outboard` (mirror the existing `Blake3Hasher`).

- **Then decide on synthetic-origin QC.** Full design preserved in
  `docs/SYNTHETIC_ORIGIN_PLAN.md` — deliberately NOT implemented, so it cannot
  destabilise the submission. Deciding factor is whether the corpus can be
  assembled in time; the code is the cheaper half.

- **The deployed Passport is honestly `UNCALIBRATED`. Leave it that way.**

  A proficiency manifest exists and is WORM-locked on B2 at
  `proficiency/rendered_text_mutation/d1a360c1df22-e85fd947.json` (COMPLIANCE;
  bound to commit `e85fd947`; primary gemini-3.5-flash 5/5 plants caught, 5/5
  clean twins passed, Wilson [0.566, 1.0], PROVISIONAL n=5; juror
  gemini-3.6-flash 5/5 offline; deployed pair policy 3 reproduced / 2
  contested). **That record is bound to `e85fd947`. Production runs `578d37c`.**

  > **Do not set `WAYSTATION_COMMIT=<e85fd947 sha>` on the production
  > deployment.** `citation_state()` compares the recorded config against the
  > running one; overriding the commit to match an older manifest would
  > manufacture an EXACT citation for code that did not produce those numbers.
  > That is falsifying the binding, and it is the one thing the whole Passport
  > design exists to prevent. The rehearsal on 2026-07-28 correctly reported
  > `UNCALIBRATED · "no proficiency manifest for this configuration"`, which is
  > the truthful state and is safe to show on camera.

  The **only** honest way to a citable Passport is to publish a *new* manifest
  against the exact deployed configuration — commit, model identities, prompts,
  reducers, sampling configuration — from a clean worktree, then point
  `PROFICIENCY_MANIFEST_PATH` at that new record. Re-run `--publish` whenever
  any of those change; the citation is supposed to flip to UNCALIBRATED when
  they do. **Do not alter the production Passport configuration** to chase a
  green label.

- **Live-calibrate the REMAINING generated-media stages** (partially done —
  does NOT block recording). The 2026-07-24 proficiency session put real GMI
  through 10 blind assets and validated two of the five model stages: the
  coarse **scene ledger** and **native-resolution typography**, plus their
  deterministic reducers (5/5 sensitivity, 5/5 specificity). Still
  live-unvalidated, all currently mock-proven only:
  the **planner** (`plan_prompt` — the proficiency runner deliberately uses the
  deterministic baseline plan), the **jittered fine verification** pass and its
  repeated-finding stability, **prompt adherence**, the **artifact/anatomy
  specialist**, and 14-risk accounting/report readability end to end.
  To close it: run one representative generated clip plus its `.genblaze.json`
  through real GMI and inspect the recipient page. Tune prompts/normalizers
  only if the capture exposes a concrete failure, and add that failure to
  `scripts/synthetic-qc-proof.sh`.
- **Demo video**: record against **`docs/demo-script.md`**, which is the
  **authoritative hosted-production procedure** (≤3:00 shot list). Record
  against the deployed service at `https://orbitolive.com/waystation/` /
  `https://api.orbitolive.com/api`.

  > **Superseded:** earlier revisions of this file told you to start
  > `scripts/live-event-run.sh` and run `scripts/b2-register-events.sh` to point
  > the B2 rule at a fresh quick-tunnel. **Do not do that.** Those steps belong
  > to the old local/quick-tunnel workflow. The production rule
  > (`waystation-pipeline`, prefix `transfers/`) is permanently registered
  > against `https://api.orbitolive.com/api/events/b2` and was verified enabled
  > and unsuspended during the 2026-07-28 rehearsal — re-registering it would
  > point production at a dead tunnel and break the deployment. There is nothing
  > to start and nothing to register before recording.
- **Devpost**: re-paste the updated "What it does" and "What's next" sections
  from `docs/devpost-about.md`; the repo URL is
  `https://github.com/russomon/waystation`.
- **Optional host-run demo polish**: install `mediainfo` if the recording
  machine runs the worker directly and should show the new MXF OP1a / AS-11 /
  HDR metadata cross-checks. The Docker worker includes it.
- **Live agentic-report capture**: DONE 2026-07-24 — `demo-master.mp4` run
  through real GMI (Netflix strict) three times. All three passes, the prompt
  hash (`human-qc-charter/1.0`), coverage accounting and residual review render
  cleanly; the hybrid lane metered live (`qc_hybrid` 36 frames) and correctly
  stayed quiet on a faceless/stereo master. It also caught a real defect no
  mock-based proof could: the model restating measured instrument findings as
  its own blockers (6 BLOCKERs for 3 defects) — fixed by capping every agentic
  finding at ISSUE (DECISIONS 2026-07-24). Final: a stable 3 BLOCKERs.
  REMAINING: re-capture once more only if the report or charter changes again;
  read coverage numbers off the screen on the take, since they vary per run
  (5/13 → 7/13 assessed across the three runs — normal model variance).

## Soon

- **Export SyncNet's full measurement into the agentic dossier (drift, not just
  offset).** `qc/avsync.py` today scrapes three summary lines from stderr and
  reports ONE offset for the best face track, discarding nearly everything
  SyncNet computes: `activesd.pckl` holds a per-track distance matrix of shape
  (frames × lags) — 314×31 on the bundled `example.avi` — plus `tracks.pckl`
  (face-track boxes + timings) and a per-frame confidence curve.
  The unlock is DETERMINISTIC, not AI: an argmin per WINDOW over that matrix
  turns one number into an offset *trajectory*, and a regression over it
  separates defects that are currently indistinguishable:
    - flat → constant offset (mux/container error)
    - sloped → progressive drift (sample-rate / clock mismatch)
    - stepped at a scene boundary → reel-assembly / edit error
    - confidence dip → measurement untrustworthy in THAT interval only
  Build: emit per-track `{start, end, offset_ms, confidence}` plus a computed
  `drift` characterization (`constant|progressive|stepped`, slope in ms/min) and
  low-confidence intervals, and feed it into the deterministic dossier the
  informed pass already receives. It is a natural third reducer alongside the
  hybrid framework's `align` / `compare_declared` / `persistence`.
  The MODEL's role is strictly downstream and must stay there: correlate the
  trajectory with other lanes (scene cuts, black frames, caption cues) to
  explain a probable CAUSE, aim the bounded evidence-request round at the
  low-confidence interval, and phrase it for an operator. It must never produce,
  estimate, or adjudicate the offset (and since 2026-07-24 it cannot escalate
  one to BLOCKER regardless). Caveat: the model restated instrument numbers in
  all three live runs, so expect it to restate these too — the value is the
  correlation and the drift characterization, not re-reporting figures.
  Not demoable on the current demo master (no face) — see `docs/demo-script.md`.
- Dolby Vision dynamic-metadata canvas verification via `dovi_tool` (currently
  an explicit `REVIEW_REQUIRED` registry item; Venera Pulsar ships this, so it
  remains a real specialist-tool gap).
- Per-customer billing on the metering ledger (Stripe/Lago meters).

## Later

- Jury policy 1.1 candidate, from the LIVE pair-policy data: both models
  caught 5/5 plants standalone, yet the deployed policy scored 3 reproduced /
  2 contested — `match_key` requires identical `evidence_ids`, so a juror that
  flags the same mutation across a DIFFERENT consecutive evidence pair reads
  as contested. Honest but conservative (contested only raises review
  priority; nothing is lost). Consider relaxing evidence_ids to overlap-based
  matching under a bumped JURY_POLICY_VERSION, then re-publish proficiency —
  exactly the drift-invalidation flow the passport was designed for.

- Queue between gateway and workers, then autoscaling on backlogged
  media-minutes (the metering ledger is already the right signal).
- Deeper ABR support: segment/ladder playback rather than manifest lint.
- Full-timeline dead-pixel tracking and dedicated click/pop/test-tone
  classifiers. The agentic reporter now samples scene/anomaly frames and audio
  windows and requests more evidence, but does not claim exhaustive timeline
  clearance.
- Hybrid framework, next specs: `qc/hybrid.py` (perceive-then-compute) now
  makes logo/watermark **persistence** (is the bug present in every window, or
  intermittent → `persistence` reducer) and shot-content **continuity**
  straightforward new `HybridCheck` instances. Also validate the lip-sync
  instance on a REAL-face clip — the cartoon stimulus proved the mechanism but
  real mouths are subtler — before leaning on it for any certification-adjacent
  claim.

## Blockers

- None. Backblaze Event Notifications and the B2-fired reactive loop remain
  proven end to end. Real-GMI calibration of the expanded generated-media
  schemas is a required pre-recording validation task, not an external blocker.
