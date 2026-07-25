# Next Steps

Repo: waystation

Use this file for the short forward-looking queue, not the full project
history.

## Now

- **Publish the citable proficiency manifest + demo wiring**: after this
  commit lands (clean worktree), run a full live proficiency session and
  publish the WORM record, then point the demo stack at it:
  `GMI_JURY_MODEL=google/gemini-3.6-flash scripts/proficiency.sh --class
  rendered_text_mutation --publish` (real GMI + real B2 +
  `MANIFEST_LOCK_DAYS>0`), download the manifest locally, set
  `PROFICIENCY_MANIFEST_PATH` + `GMI_JURY_MODEL` + `WAYSTATION_COMMIT` in the
  demo environment so the recipient page renders a full passport
  (reproducibility + EXACT-match proficiency + Wilson CIs).

- **Live-calibrate the expanded generated-media lane**: run a representative
  generated clip and its `.genblaze.json` through real GMI. Inspect the
  asset-specific assertion plan, scene-ledger track keys, coarse-to-fine
  candidate selection, repeated-finding stability, native-resolution text
  tracks, 14-risk accounting, latency, and report readability. The complete
  integration is mock-proven; live model behavior for these new schemas is the
  remaining verification before recording. Tune prompts/normalizers only if
  the capture exposes a concrete failure, and add that failure to
  `scripts/synthetic-qc-proof.sh`.
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
