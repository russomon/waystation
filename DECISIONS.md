# Decisions

Repo: waystation

Use this file to record durable project decisions so they do not live only in
chat threads.

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
