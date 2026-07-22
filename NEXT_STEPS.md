# Next Steps

Repo: waystation

Use this file for the short forward-looking queue, not the full project
history.

## Now

- **Backblaze Event Notifications**: when the account feature is enabled, run
  `bash scripts/live-event-run.sh`, then `bash scripts/b2-register-events.sh`,
  and confirm a genuine B2-fired webhook drives the pipeline. This is the last
  unproven link in the reactive architecture.
- **Demo video**: record against `docs/demo-script.md` (≤3:00 shot list, with
  a Plan B that fires the signed event manually if enablement has not landed).
- **Devpost**: re-paste the updated "What it does" and "What's next" sections
  from `docs/devpost-about.md`; the repo URL is
  `https://github.com/russomon/waystation`.

## Soon

- Add `git@github.com:russomon/waystation.git` to the active-repo list in the
  shared-environment plan document, so other Macs clone it during setup.
- Dolby Vision dynamic-metadata canvas verification via `dovi_tool` (currently
  an honest FYI finding; Venera Pulsar ships this, so it is a real gap).
- Per-customer billing on the metering ledger (Stripe/Lago meters).

## Later

- Queue between gateway and workers, then autoscaling on backlogged
  media-minutes (the metering ledger is already the right signal).
- Deeper ABR support: segment/ladder playback rather than manifest lint.
- Dead-pixel tracking and audio click/pop/test-tone detection (incumbent
  checks we do not yet cover).

## Blockers

- Backblaze Event Notifications is not enabled on the account. Support request
  submitted 2026-07-17; quoted turnaround was up to one day. The API returns
  `400 bad_request: API not enabled` until then. Everything downstream of the
  webhook is already proven, so this blocks verification only, not the build.
