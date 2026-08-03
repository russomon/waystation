# Waystation — demo video shot list (target ≤ 3:00)

The through-line: **one bad master, sent twice.** Standard says "review
these"; Netflix strict says "rejected." Both reports also disclose what still
requires human or specialist review.
Everything on screen is real: real B2 bucket, real GMI inference, real
Object Lock.

> **This records against the HOSTED PRODUCTION deployment.** There is no local
> stack, no quick-tunnel, and nothing to register before recording.
>
> | | |
> |---|---|
> | Portal | `https://orbitolive.com/waystation/` |
> | API | `https://api.orbitolive.com/api` |
> | Upload path | browser → **Backblaze B2 directly** (presigned multipart PUT) |
> | Trigger | **B2 Event Notifications** → the running production gateway through the Cloudflare Tunnel |
> | Compute | pinned `cloud`; the Local/Cloud selector is hidden in the hosted build |
>
> Do **not** run `scripts/live-event-run.sh`, start a `cloudflared` quick-tunnel,
> or repoint the production B2 event rule. The rule (`waystation-pipeline`,
> prefix `transfers/`) is already live and pointed at the production gateway;
> repointing it would break the deployment mid-recording.

> **Explicit AI Interpretive Analysis release gate:** the source-ready
> Genblaze/GMI timeline and green recipient panel are not in the currently
> recorded production image. Before recording that beat, complete the reversible
> checklist in `docs/AI_INTERPRETIVE_RUN.md` and retain one bounded credentialed
> result. Until then, this document's older AI QC beats describe the live system;
> do not narrate the new explicit mode as deployed.

### Revised interpretive beat after release

On the sender page select deterministic QC plus **AI Interpretive Analysis**;
turn AI QC, Synthetic QC, and AI Summary off for this first take. Hold on the
live stage line through deterministic grounding, B2 evidence selection,
parallel GMI visual/audio analysis, synthesis, and artifact storage. On the
recipient page show the deterministic badge first, then the green AI panel:
Genblaze run ID, provider/models, stage timing, advisory observations,
uncertainty, cited B2 evidence, and selected frames. Finish by verifying the
canonical provenance manifest. The narration must call AI advisory and
deterministic policy the sole delivery authority.

## ⚠ Never on camera

Recording publishes whatever is on screen. Before you hit record:

- **The judge access code.** Type it with the capture paused, or authenticate
  before recording starts. The field is `type="password"`, but the clipboard,
  a password manager overlay, or a typo shown in plaintext all leak it.
- **The session cookie**, any devtools Application/Storage panel, and any
  request headers view.
- **API keys and tokens** — `.env`, the B2 or Cloudflare dashboards, `docker
  compose config`, the tunnel token.
- **Complete recipient URLs.** A recipient transfer id is a **bearer
  capability**: anyone who reads it off the video owns that delivery forever.
  Blur, crop, or truncate the address bar for every share-link shot, and
  **revoke the demo transfer afterwards** (see "After recording" below).
- The terminal `worm-demo.sh` shot prints a transfer id — frame it so only the
  Object Lock response is legible, or blur the id in post.

## Prep checklist (before recording)

1. Confirm the hosted deployment is healthy — nothing to start:
   ```bash
   curl -s https://api.orbitolive.com/healthz          # -> {"ok":true}
   curl -s https://orbitolive.com/waystation/release-manifest.json | head -c 120
   ```
   If the manifest does not parse as JSON, Cloudflare Pages is still serving its
   fallback page; wait and retry rather than trusting a `200`.
2. Demo master on the Desktop (regenerate any time):
   ```bash
   say -o /tmp/demo.aiff "Hello and welcome to the Waystation demo. This master was delivered through the cloud waystation. Quality control has built an issue report."
   ffmpeg -y -f lavfi -i "testsrc2=duration=12:size=640x360:rate=30" -i /tmp/demo.aiff \
     -af "volume=14dB,apad" -t 10 -c:v libx264 -crf 26 -pix_fmt yuv420p -c:a aac ~/Desktop/demo-master.mp4
   ```
   Caption sidecar `~/Desktop/demo-captions.srt`:
   ```
   1
   00:00:00,300 --> 00:00:03,000
   Hello and welcome
   to the Waystation demo.

   2
   00:00:03,300 --> 00:00:06,600
   This master was delivered
   through the cloud waystation.

   3
   00:00:06,900 --> 00:00:09,500
   Quality control has
   built an issue report.
   ```
   (This master is deliberately illegal: 30 fps, ≈ −10.7 LKFS, +8.1 dBTP.)
3. Browser at `https://orbitolive.com/waystation/`, ~125 % zoom, in a clean
   window (no bookmarks bar, no other tabs, no extensions visible). Terminal
   with a big font. **Authenticate with the judge code before recording starts**
   so the code never reaches the capture.
4. Have one finished transfer id handy for the WORM shot (from a prior run) —
   keep it in a scratch file, not in the repo, and frame the shot so it is not
   legible.
5. **Only if you want the measured-lip-sync beat** (see the optional beat below):
   build the SyncNet-enabled worker and prepare a REAL-FACE clip with a known
   injected offset — the demo master above is a test pattern with no face, so
   SyncNet correctly finds nothing to measure on it.
   ```bash
   INSTALL_SYNCNET=1 docker compose build worker      # ~2.95 GB image, CPU-only
   # a real face: record ~12 s of yourself speaking (macOS webcam + mic)
   ffmpeg -y -f avfoundation -framerate 30 -i "0:0" -t 12 \
     -c:v libx264 -pix_fmt yuv420p -c:a aac ~/Desktop/face-insync.mp4
   # then inject a KNOWN 200 ms A/V offset — this is what SyncNet should measure
   ffmpeg -y -i ~/Desktop/face-insync.mp4 -itsoffset 0.2 -i ~/Desktop/face-insync.mp4 \
     -map 0:v:0 -map 1:a:0 -c copy ~/Desktop/face-offset200.mp4
   ```
   Ground truth: 200 ms ≈ 5 frames @ 25 fps. (Fallback with no webcam: SyncNet's
   own bundled `data/example.avi` inside the image measures +120 ms — but say on
   camera that it's the tool's sample clip, not your master.)

## Beats

**0:00 – 0:15 · Hook (delivery page of a rehearsal run, already open)**
> "This mastered video was uploaded to a Backblaze bucket. By the time the
> recipient opened the link, it had been QC'd against the Netflix delivery
> spec, independently inspected by an AI agent, and sealed under an
> immutable provenance manifest. This is Waystation."

**0:15 – 0:45 · The send**
Sender page. Click through deliberately: pick `demo-master.mp4`, pick the
captions sidecar, open the profile dropdown → **Netflix strict**, tick
**AI QC**. Hover the services list for a beat ("every service is the sender's
choice — all off, and this is a plain verified transfer tool").
Click **Send**.
> "Parallel multipart straight to B2, hashed with BLAKE3 as it uploads,
> resumable if the laptop dies."

**0:45 – 1:10 · The reactive moment**
Stay on the progress line. When the upload finishes: "the gateway does
nothing more — Backblaze itself fires an ObjectCreated event at our webhook"
. Steps stream in live via SSE: qc → qc_ai → qc_synthetic → manifest.
> "No polling, no compute idling. The pipeline exists only while there's
> work."

Measured in the 2026-07-28 rehearsal, if you want a number to quote: **832,124
bytes of media went browser→B2 directly, while the largest request that touched
our API was 416 bytes.** The media never crosses Cloudflare or our server.

**1:10 – 2:00 · The verdict (open the share link)**
Scroll slowly through the delivery page:
- "✗ QC failed · Netflix_Delivery_Specification_Strict" + chips —
  **3 BLOCKER**: wrong frame rate, loudness 13 LU hot, true peak +8 dBTP.
- **Agentic observations**:
  > "Gemini first inspected without seeing the instrument report, requested
  > extra evidence, reconciled that with the measured failures, and then a
  > critic audited the result. It also listened: caption accuracy is transcript
  > versus captions."
- **Coverage accounting** and **Residual human review**:
  > "A sampled AI review cannot honestly clear every frame. Waystation names
  > every applicable risk and exposes what remains unverified instead of
  > manufacturing an all-clear. It reports; it never changes the master."
  If `lip_sync` is visible in the list, it is a good one to point at — on this
  master (no face on screen) it stays disclosed rather than cleared:
  > "Lip sync is a good example. There's no face in this master, so the AV-sync
  > model has nothing to measure — and Waystation says exactly that instead of
  > passing it. A general vision model *will* confidently guess here; we tested
  > that and it was wrong, so it is not allowed to clear this risk."
- Click **Verify provenance** → green checks.

**2:00 – 2:25 · The WORM shot (terminal)**
```bash
bash scripts/worm-demo.sh <transferId>
```
> "The QC report is anchored by a manifest under B2 Object Lock in
> COMPLIANCE mode. This is the bucket owner's own key trying to delete
> it — Backblaze says no. The evidence outlives everyone's permissions."

**OPTIONAL · +0:20 · Measured lip sync (only with the prep-5 clip)**
This does not fit inside 3:00 as-is — buy the time by trimming the send beat
(0:15–0:45) to ~20 s, or cut it and keep lip-sync as the coverage line above.
Send `face-offset200.mp4` (pre-recorded, fast cut) through the SyncNet worker:
> "I shifted this audio by exactly 200 milliseconds. Waystation doesn't ask a
> chat model whether it looks off — it runs SyncNet, a purpose-built audio-visual
> model, over the tracked face."
Land on the `avsync_offset` finding — a real number in ms with a confidence, and
`lip_sync` moving to SUSPECTED in the coverage table.
> "Five frames out at 25 fps. Measured, not guessed."

**OPTIONAL · +0:25 · The passport beat (strongest innovation shot)**

> **Record what the deployment actually says.** On the current production
> deployment the Passport reads **`UNCALIBRATED · "no proficiency manifest for
> this configuration"`** and the jury reads **`SINGLE_SOURCE · no juror
> configured`**. The published WORM manifest is bound to commit `e85fd947`;
> production runs `578d37c`, so `citation_state()` correctly refuses to cite it.
>
> **Do not set `WAYSTATION_COMMIT` to the old sha to make the citation read
> EXACT.** That manufactures a binding for code that did not produce those
> numbers — precisely the failure the Passport exists to detect. Do not alter
> the production Passport configuration for the recording.

Two honest ways to shoot this beat:

**(a) Ship the refusal — recommended, and the stronger story.** Send a generated
clip with planted signage (render one with `pipeline/foundry_render.py`) with
Synthetic QC on, and open the **AI reliability passport** section:
> "Waystation's model caught the planted defect. Now watch what it says about
> *itself*. This configuration has no proficiency record published against it,
> so the passport reads UNCALIBRATED — it refuses to quote a catch rate it
> hasn't earned on this exact build. And with no second juror configured, it
> reports SINGLE_SOURCE rather than implying agreement it never obtained.
> Every other tool asks you to trust its AI. This one tells you when *not* to."

**(b) Earn a citable Passport first.** Publish a NEW proficiency manifest
against the exact deployed configuration — commit, model identities, prompts,
reducers, sampling config — from a clean worktree, then point
`PROFICIENCY_MANIFEST_PATH` at that new record and re-verify the citation reads
EXACT before recording. This is real work, not a config flag; do not attempt it
under time pressure. If it lands, add `PROVISIONAL · n=<N>` for one breath:
"small sample, and it says so — that's the point."

**2:25 – 2:45 · The contrast (pre-recorded second send, fast cut)**
Same file, profile **Standard**: zero blockers, review-level issues only.
> "Same master, standard profile — advisory. Netflix profile — rejected.
> The spec is a toggle, not a consultancy engagement."

**2:45 – 3:00 · Close (sender page or usage ledger open)**
> "Every act — transfer gigabytes, QC minutes, AI frames, ASR seconds,
> adaptive evidence — is metered against the manifest it produced. Waystation:
> send mastered video; it arrives QC'd, summarized, and provable.
> Built on Backblaze B2 and GMI Cloud."

## How to record (production plan)

**Approach: capture the screen silently, narrate separately, then cut.** Do NOT
try to talk and drive the app at the same time. Every beat here depends on
real cloud latency you cannot control, and a fluffed sentence at 2:40 would
otherwise mean re-running the whole pipeline. Silent captures + a separate
voiceover track means a bad line costs one retake of the line, not the take.

**One-time setup (before any capture)**

1. **Turn on Do Not Disturb / Focus.** One Slack or Mail banner mid-take kills
   an otherwise perfect run. Also quit anything with a dock badge.
2. **Use a clean browser window** — a fresh profile or guest window: no
   bookmarks bar, no extensions, no other tabs, no personal autofill.
3. **Set the display to a 16:9 scaled resolution** and record the whole screen
   or a fixed window region. Never resize mid-take. 1080p is the safe target;
   record higher and downscale rather than upscaling later.
4. **Big fonts:** terminal at a size readable on a phone, browser at ~125 %.
   Judges may watch on a laptop in a browser tab, not a cinema screen.
5. **Check what's on screen that shouldn't be** — see "⚠ Never on camera" at the
   top. Bucket names are fine; the judge code, session cookie, key IDs, tunnel
   token and complete recipient URLs are not. Never open `.env`.
6. **Authenticate before the capture starts.** The session cookie lasts 3600 s,
   so log in, confirm the sender panel is showing, then begin recording. If a
   take runs past the TTL you will be bounced to the code gate mid-shot — re-auth
   with capture paused, never on camera.
7. The passport beat needs **no** configuration change. Record what the
   deployment says (`UNCALIBRATED` / `SINGLE_SOURCE`) — see that beat above.
   Do not set `WAYSTATION_COMMIT` to an older sha to force an EXACT citation.

**Capture order** (each is a separate silent clip — do not try for one take)

1. Full rehearsal, recording everything. Keep it: it gives you the finished
   transfer id the WORM beat needs, and it is your safety net if a later run
   behaves oddly.
2. The send + live progress stream (beats 0:15–1:10). Record it ONCE in real
   time and trim the waits in the edit — never fake or speed-ramp a progress
   bar in a way that implies it was faster than it was.
3. The report scroll (1:10–2:00), slowly. Pause on each section for a beat
   longer than feels natural; you will be glad of the headroom when cutting.
4. The WORM terminal shot, the contrast send, and (optional) the passport beat
   as separate clips.

**Audio**

- Record the voiceover in one pass against the rough cut, reading the beat
  script. A USB mic or even AirPods beats a laptop mic in a hard-surfaced room.
- Speak ~15 % slower than feels right. Technical content read at conversational
  speed is hard to follow on first hearing.
- Leave a half-second of silence between beats — it gives the edit somewhere
  to breathe and makes trims invisible.

**Edit**

- Cut to the narration, not the other way round: lay the voiceover first, then
  trim the screen clips to fit.
- Keep the total under the Devpost limit (the shot list targets ≤ 3:00 —
  confirm the exact limit and required hosting on the hackathon's rules page
  before uploading, and upload as unlisted/public per those rules).
- No music bed under the technical beats, or add it very low: the report text
  is doing the work and judges may be watching at low volume.
- Burn in nothing you cannot defend. If a number is on screen, it must be the
  number the run produced.

**Tools:** macOS built-in screen recording (⇧⌘5) is sufficient for capture;
any editor that supports separate audio and video tracks will do. Nothing here
needs a paid tool.

## After recording — close the capability

Every transfer shown on camera should be treated as **exposed**, even if you
blurred the URL: a single legible frame is enough. Revoke it once the take is in
the can. The control is `transfers.revoked = 1` on the production control plane;
`/transfers/:id` and `/transfers/:id/download` then return a neutral 404 that is
byte-identical to an unknown id, so the link reveals nothing — not even that it
once existed.

```bash
ssh <vps> "cd ~/waystation && docker compose -f docker-compose.prod.yml \
  exec -T -e TID='<transfer-id>' gateway node -e '
    const {DatabaseSync}=require(\"node:sqlite\");
    const db=new DatabaseSync(\"/data/waystation.db\");
    console.log(db.prepare(\"update transfers set revoked = 1 where transfer_id = ?\")
      .run(process.env.TID).changes);
  '"
```

Then confirm: `curl -s -o /dev/null -w '%{http_code}\n' \
https://api.orbitolive.com/api/transfers/<id>` must print `404`.

Presigned B2 URLs carry their own 3600 s TTL and expire independently, so an
hour after the take the derivative URLs are dead regardless. Do **not** delete
the control volume or any WORM-locked provenance object to "clean up" — the
Object Lock evidence is the product, and revocation is the correct control.

## Recording notes

- Rehearse once end-to-end; keep the rehearsal's transfer id for beat 4 in a
  scratch file outside the repo — never commit a complete transfer id.
- GMI latency varies (5–40 s for the AI steps) — record the progress stream
  in real time once, and cut the wait in the edit rather than faking it.
- If Gemini's vision findings differ between takes (it's a model, not a
  filter), just read what's on screen — it's always been right so far.
- **The demo master has no face and is stereo**, so three recently-added checks
  stay quiet on it by design: measured lip-sync (SyncNet — no face track), the
  hybrid perceptual lip-sync (no mouth to perceive), and hybrid channel
  semantics (skipped for stereo; it needs a 5.1-style layout with a centre/LFE
  role to violate). Do not claim them over this master — either run the optional
  beat above on a real face, or point at the honest disclosure in coverage.
- The default worker image does NOT contain SyncNet (1.31 GB, reports an honest
  FYI). Only the `INSTALL_SYNCNET=1` build measures (2.95 GB). If the optional
  beat is in, make sure the running worker is the SyncNet one.
