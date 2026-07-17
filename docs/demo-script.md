# Waystation — demo video shot list (target ≤ 3:00)

The through-line: **one bad master, sent twice.** Standard says "review
these"; Netflix strict says "rejected — and here's the healed copy."
Everything on screen is real: real B2 bucket, real GMI inference, real
Object Lock.

## Prep checklist (before recording)

1. Stack up: `bash scripts/live-event-run.sh` (wait for "reactive stack ready").
   - If Backblaze has enabled Event Notifications: also run
     `bash scripts/b2-register-events.sh` → B2 fires the webhook itself.
   - If not yet: keep a second terminal ready with the signed-event curl
     (see "Plan B" at the bottom) — the on-screen flow is identical.
2. Demo master on the Desktop (regenerate any time):
   ```bash
   say -o /tmp/demo.aiff "Hello and welcome to the Waystation demo. This master was delivered through the cloud waystation. Quality control has reviewed every frame."
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
   reviewed every frame.
   ```
   (This master is deliberately illegal: 30 fps, ≈ −10.7 LKFS, +8.1 dBTP.)
3. Browser at `http://localhost:5173`, ~125 % zoom. Terminal with a big font.
4. Have one finished transfer id handy for the WORM shot (from a rehearsal run).

## Beats

**0:00 – 0:15 · Hook (delivery page of a rehearsal run, already open)**
> "This mastered video was uploaded to a Backblaze bucket. By the time the
> recipient opened the link, it had been QC'd against the Netflix delivery
> spec, reviewed by a vision model, auto-corrected, and sealed under an
> immutable provenance manifest. This is Waystation."

**0:15 – 0:45 · The send**
Sender page. Click through deliberately: pick `demo-master.mp4`, pick the
captions sidecar, open the profile dropdown → **Netflix strict**, tick
**Self-heal**. Hover the services list for a beat ("every service is the
sender's choice — all off, and this is a plain verified transfer tool").
Click **Send**.
> "Parallel multipart straight to B2, hashed with BLAKE3 as it uploads,
> resumable if the laptop dies."

**0:45 – 1:10 · The reactive moment**
Stay on the progress line. When the upload finishes: "the gateway does
nothing more — Backblaze itself fires an ObjectCreated event at our webhook"
(if Plan B: fire the signed event now, off-screen). Steps stream in live via
SSE: qc → qc_ai → heal → manifest.
> "No polling, no compute idling. The pipeline exists only while there's
> work."

**1:10 – 2:00 · The verdict (open the share link)**
Scroll slowly through the delivery page:
- "✗ QC failed · Netflix_Delivery_Specification_Strict" + chips —
  **3 BLOCKER**: wrong frame rate, loudness 13 LU hot, true peak +8 dBTP.
- The AI findings line: > "Gemini reviewed sampled frames — it spotted the
  burned-in timecode on its own. And it *listened*: caption accuracy,
  21 of 21 words, transcript versus captions."
- The self-heal line + **Download healed master** button:
  > "The waystation didn't just reject it. It normalized the audio to
  > −24 LKFS, re-measured itself, and delivered the corrected master
  > alongside the original."
- Click **Verify provenance** → green checks.

**2:00 – 2:25 · The WORM shot (terminal)**
```bash
bash scripts/worm-demo.sh <transferId>
```
> "The QC report is anchored by a manifest under B2 Object Lock in
> COMPLIANCE mode. This is the bucket owner's own key trying to delete
> it — Backblaze says no. The evidence outlives everyone's permissions."

**2:25 – 2:45 · The contrast (pre-recorded second send, fast cut)**
Same file, profile **Standard**: zero blockers, review-level issues only.
> "Same master, standard profile — advisory. Netflix profile — rejected.
> The spec is a toggle, not a consultancy engagement."

**2:45 – 3:00 · Close (sender page or usage ledger open)**
> "Every act — transfer gigabytes, QC minutes, AI frames, ASR seconds,
> heal runs — is metered against the manifest it produced. Waystation:
> send mastered video; it arrives QC'd, summarized, and provable.
> Built on Backblaze B2 and GMI Cloud."

## Plan B (until Backblaze enables Event Notifications)

Fire the production-shaped signed event yourself right after upload —
same payload, same HMAC header, same public tunnel URL B2 will use:

```bash
source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' .env)
TUNNEL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/we-tunnel.log | head -1)
KEY="transfers/<transferId>/demo-master.mp4"   # from the share link
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:MultipartUpload\",\"objectName\":\"$KEY\",\"bucketName\":\"$B2_BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$B2_EVENT_SIGNING_SECRET" | awk '{print $NF}')"
curl -sS -X POST "$TUNNEL/api/events/b2" -H "content-type: application/json" \
  -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
```

## Recording notes

- Rehearse once end-to-end; keep the rehearsal's transfer id for beat 4.
- GMI latency varies (5–40 s for the AI steps) — record the progress stream
  in real time once, and cut the wait in the edit rather than faking it.
- If Gemini's vision findings differ between takes (it's a model, not a
  filter), just read what's on screen — it's always been right so far.
