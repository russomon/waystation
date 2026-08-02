#!/usr/bin/env bash
# Detection-coverage proof: asserts the five coverage upgrades that widen what
# the QC lanes and the agentic reporter can see. Self-contained — needs only
# ffmpeg + the pipeline venv (no MinIO, no gateway, no GMI, no cloud creds).
#   #1 tiled signal analysis  — PSE catches a flash at the END of a long clip
#                               that a first-60s window would miss
#   #2 blind-pass audio       — initial agentic evidence includes audio windows
#   #3 scene+anomaly frames    — frames land on shot boundaries and at black gaps
#   #4 duration-scaled evidence— frame budget grows with runtime; higher res
#   #5 lip-sync proxy          — container A/V offset flips lip_sync to SUSPECTED
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
command -v ffmpeg >/dev/null || { echo "SKIP — ffmpeg not installed"; exit 0; }

echo "— building fixtures —"
# A: 80s clip, calm for 70s then a hard strobe in the LAST 10s (minute-45 analog)
ffmpeg -y -f lavfi -i "testsrc2=duration=70:size=320x240:rate=24" \
  -f lavfi -i "color=black:duration=10:size=320x240:rate=24" \
  -filter_complex "[1:v]geq=lum='if(mod(N,2),235,16)':cb=128:cr=128[s];[0:v][s]concat=n=2:v=1[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p "$WORK/flash-end.mp4" >/dev/null 2>&1
# B: three distinct scenes + tone + a 2s black gap (anomaly) + audio
ffmpeg -y -f lavfi -i "testsrc2=duration=8:size=320x240:rate=15" \
  -f lavfi -i "smptebars=duration=6:size=320x240:rate=15" \
  -f lavfi -i "color=black:duration=2:size=320x240:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=16" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1[v]" -map "[v]" -map 3:a \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/scenes.mp4" >/dev/null 2>&1
# C: same as B but audio delayed 400ms in the container (A/V offset)
ffmpeg -y -i "$WORK/scenes.mp4" -itsoffset 0.4 -i "$WORK/scenes.mp4" \
  -map 0:v:0 -map 1:a:0 -c copy "$WORK/offset.mp4" >/dev/null 2>&1
echo "✓ fixtures built"

echo "=== assertions ==="
PIPELINE_SHARED_SECRET=x B2_BUCKET=b B2_S3_ENDPOINT=http://x B2_KEY_ID=x B2_APP_KEY=x B2_REGION=x \
"$PY" -W ignore - "$WORK" "$WEB/pipeline" <<'PYEOF'
import json, subprocess, sys, tempfile
sys.path.insert(0, sys.argv[2])   # pipeline dir → import worker
import worker
from qc import agentic, audio, video, profiles
from qc.util import analysis_windows

WORK = sys.argv[1]
ok = True
def need(cond, msg):
    global ok
    if not cond:
        print(f"  FAIL: {msg}"); ok = False

def probe(p):
    return json.loads(subprocess.run(
        ["ffprobe","-v","quiet","-print_format","json","-show_format","-show_streams",p],
        capture_output=True, text=True).stdout)

# ── #1 tiled signal analysis: PSE catches the end-of-clip flash ──
src = f"{WORK}/flash-end.mp4"; meta = probe(src); dur = float(meta["format"]["duration"])
wins = analysis_windows(dur, 20.0, max_total=240.0)
need(dur > 70 and any(s >= 60 for s, _ in wins), f"windows must cover the clip end: {wins}")
pse = [c for c in video.range_and_pse(src, dur, profiles.get("netflix")) if c["name"] == "pse_flash_risk"][0]
print(f"  #1 pse_flash_risk on 80s clip (flash at 70-80s): {pse['status']}")
need(pse["status"] == "warn", "tiled PSE must flag an advisory candidate in the final window")
need(pse.get("decision", {}).get("authority") == "deterministic_advisory",
     "PSE screen must not have delivery authority")
# a first-60s-only window would analyze ~5-65s and miss the 70-80s flash:
old_lines = video.metadata_print(src, "signalstats", min(60.0, dur), min(dur*0.1, 5.0))
ydif = video.tag_values(old_lines, "lavfi.signalstats.YDIF")
fps = max(round(len(ydif)/60.0), 1)
old_worst = max((sum(1 for d in ydif[i:i+fps] if d > 40) for i in range(0, max(len(ydif)-fps,1), max(fps//2,1))), default=0)
print(f"     (first-60s-only worst flashes/sec: {old_worst} — would NOT flag)")
need(old_worst < 5, "control: the old single-window would have missed it")

# ── #2/#3/#4 richer blind evidence ──
src = f"{WORK}/scenes.mp4"; meta = probe(src); dur = float(meta["format"]["duration"])
det = {"black": [[14.0, 16.0]], "silence": []}
with tempfile.TemporaryDirectory() as tmp:
    parts, records, m = worker._initial_agentic_evidence(src, meta, tmp, det)
frames = [r for r in records if r["type"] == "frame"]
audios = [r for r in records if r["type"] == "audio_window"]
print(f"  #2 blind-pass audio windows: {len(audios)}")
need(len(audios) >= 1, "blind pass must include audio evidence")
print(f"  #3 shot boundaries: {m['shot_boundaries']}; frames at boundary: {sum(1 for r in frames if r.get('at_shot_boundary'))}")
need(len(m["shot_boundaries"]) >= 1, "scene detection must find shot cuts")
need(any(r.get("at_shot_boundary") for r in frames), "a frame must sit on a shot boundary")
need(any(abs(r["time_seconds"] - 15.0) < 1.0 for r in frames), "a frame must land in the black anomaly (~15s)")
need(m["selection"] == "scene+anomaly+anchor", "selection must be scene+anomaly+anchor")
# #4 duration scaling + resolution
need(worker._scaled_frame_count(30) == 8 and worker._scaled_frame_count(3600) > 8,
     "frame budget must scale with duration (floor 8, grows for long content)")
need(worker.AI_QC_FRAME_SCALE >= 1024, f"evidence resolution raised (is {worker.AI_QC_FRAME_SCALE})")
print(f"  #4 budget: 30s→{worker._scaled_frame_count(30)}, 1h→{worker._scaled_frame_count(3600)}; scale={worker.AI_QC_FRAME_SCALE}px")

# ── #5 lip-sync proxy ──
src = f"{WORK}/offset.mp4"; meta = probe(src); dur = float(meta["format"]["duration"])
ls_checks = audio.lip_sync_proxy(src, meta, dur)
names = {c["name"] for c in ls_checks}
need("lip_sync_container_offset" in names and "lip_sync_drift_proxy" in names, "both lip-sync proxy checks present")
offc = next(c for c in ls_checks if c["name"] == "lip_sync_container_offset")
print(f"  #5 lip_sync_container_offset (400ms A/V): {offc['status']}")
need(offc["status"] == "warn", "container A/V offset must flag")
with tempfile.TemporaryDirectory() as tmp:
    rep = worker.run_qc(src, meta, profile=profiles.get("standard"), key="transfers/t/offset.mp4", tmp=tmp)
cov = agentic.build_coverage(meta, "transfers/t/offset.mp4", rep["checks"], None, "complete")
ls = next(r for r in cov["risks"] if r["risk_id"] == "lip_sync")
print(f"     lip_sync coverage disposition: {ls['status']}")
need(ls["status"] == "SUSPECTED", "lip_sync must move from permanent REVIEW_REQUIRED to SUSPECTED")

print("PASS ✓  coverage upgrades: tiled PSE + blind audio + scene/anomaly frames + scaling + lip-sync proxy"
      if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
