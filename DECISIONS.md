# Decisions

Repo: waystation

Use this file to record durable project decisions so they do not live only in
chat threads.

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
