# Waystation — demo video shot list (target ≤ 3:00)

The through-line: **one bad master, sent twice.** Standard says "review
these"; Netflix strict says "rejected." Both reports also disclose what still
requires human or specialist review.
Everything on screen is real: real B2 bucket, real GMI inference, real
Object Lock.

## Prep checklist (before recording)

1. Stack up: `bash scripts/live-event-run.sh` (wait for "reactive stack ready").
   - Run `bash scripts/b2-register-events.sh` so the fresh quick-tunnel URL is
     registered and B2 fires the webhook itself.
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
3. Browser at `http://localhost:5173`, ~125 % zoom. Terminal with a big font.
4. Have one finished transfer id handy for the WORM shot (from a rehearsal run).
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
. Steps stream in live via SSE: qc → qc_ai → manifest.
> "No polling, no compute idling. The pipeline exists only while there's
> work."

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

**2:25 – 2:45 · The contrast (pre-recorded second send, fast cut)**
Same file, profile **Standard**: zero blockers, review-level issues only.
> "Same master, standard profile — advisory. Netflix profile — rejected.
> The spec is a toggle, not a consultancy engagement."

**2:45 – 3:00 · Close (sender page or usage ledger open)**
> "Every act — transfer gigabytes, QC minutes, AI frames, ASR seconds,
> adaptive evidence — is metered against the manifest it produced. Waystation:
> send mastered video; it arrives QC'd, summarized, and provable.
> Built on Backblaze B2 and GMI Cloud."

## Recording notes

- Rehearse once end-to-end; keep the rehearsal's transfer id for beat 4.
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
