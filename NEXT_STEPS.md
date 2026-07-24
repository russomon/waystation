# Next Steps

Repo: waystation

Use this file for the short forward-looking queue, not the full project
history.

## Now

- **Demo video**: record against `docs/demo-script.md` (≤3:00 shot list). The
  Plan B manual-event path is no longer needed — Backblaze Event
  Notifications are enabled and proven, so the demo can show B2 firing the
  event for real. Start `scripts/live-event-run.sh`, run
  `scripts/b2-register-events.sh` to point the rule at the current tunnel,
  then upload and let B2 drive the pipeline.
- **Devpost**: re-paste the updated "What it does" and "What's next" sections
  from `docs/devpost-about.md`; the repo URL is
  `https://github.com/russomon/waystation`.
- **Optional host-run demo polish**: install `mediainfo` if the recording
  machine runs the worker directly and should show the new MXF OP1a / AS-11 /
  HDR metadata cross-checks. The Docker worker includes it.
- **Live agentic-report capture**: run one representative master through real
  GMI before recording and retain its `qc_report.json` for the demo. Confirm
  the independent/informed/critic passes, prompt hash, and residual review
  list render cleanly with real model output.

## Soon

- Dolby Vision dynamic-metadata canvas verification via `dovi_tool` (currently
  an explicit `REVIEW_REQUIRED` registry item; Venera Pulsar ships this, so it
  remains a real specialist-tool gap).
- Per-customer billing on the metering ledger (Stripe/Lago meters).

## Later

- Queue between gateway and workers, then autoscaling on backlogged
  media-minutes (the metering ledger is already the right signal).
- Deeper ABR support: segment/ladder playback rather than manifest lint.
- Full-timeline dead-pixel tracking and dedicated click/pop/test-tone
  classifiers. The agentic reporter now samples scene/anomaly frames and audio
  windows and requests more evidence, but does not claim exhaustive timeline
  clearance.
- Measured lip-sync: DONE and proven end-to-end. The SyncNet AV-sync analyzer
  (`qc/avsync.py`) is wired into the `lip_sync` risk and now runs for real in
  the worker image: on SyncNet's own `data/example.avi` it measured
  **AV offset 3 frames @25fps = +120 ms, confidence 8.3**, which the wrapper
  turned into an `avsync_offset` ISSUE and coverage escalated to
  `lip_sync: SUSPECTED / ASSESSED` — off its former permanent REVIEW_REQUIRED.
  Enable with `INSTALL_SYNCNET=1 docker compose build worker`, or on a host with
  `scripts/fetch-syncnet.sh`. Without it, Waystation still emits an honest FYI
  (never a silent pass) and the container/envelope proxy plus the perceptual
  hybrid catch gross drift. A general VLM is deliberately NOT used to JUDGE lip
  sync (proven to confabulate); the hybrid uses it for per-frame PERCEPTION only
  (see DECISIONS 2026-07-23).
- SyncNet as a Docker remote worker: DONE — `pipeline/Dockerfile` takes an
  opt-in `INSTALL_SYNCNET=1` build arg (micromamba-supplied Python 3.10 + pip
  CPU torch 2.5.1 + weights), exposed as
  `INSTALL_SYNCNET=1 docker compose build worker`. CPU-only; no GPU needed.
  The default image stays lean and still reports an honest FYI without it.
- Hybrid framework, next specs: `qc/hybrid.py` (perceive-then-compute) now
  makes logo/watermark **persistence** (is the bug present in every window, or
  intermittent → `persistence` reducer) and shot-content **continuity**
  straightforward new `HybridCheck` instances. Also validate the lip-sync
  instance on a REAL-face clip — the cartoon stimulus proved the mechanism but
  real mouths are subtler — before leaning on it for any certification-adjacent
  claim.

## Blockers

- None. Backblaze Event Notifications were enabled on 2026-07-19 and the
  B2-fired reactive loop is proven end to end. No technical work is blocked.
