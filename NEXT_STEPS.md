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
- True lip-sync (mouth-shape vs phoneme) beyond the current envelope/container
  proxy — needs a face/mouth-aware model. The proxy catches gross drift only.

## Blockers

- None. Backblaze Event Notifications were enabled on 2026-07-19 and the
  B2-fired reactive loop is proven end to end. No technical work is blocked.
