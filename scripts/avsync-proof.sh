#!/usr/bin/env bash
# AV-sync analyzer proof (SyncNet optional analyzer). Self-contained; only
# needs ffmpeg + the pipeline venv. Two modes:
#   - SyncNet NOT installed (default/CI): asserts the honest-absence contract —
#     avsync_offset is an explicit FYI (never a silent pass), the lip_sync risk
#     stays disclosed, and the AI model CANNOT clear lip_sync.
#   - SyncNet installed (SYNCNET_DIR set): additionally runs it on an in-sync
#     and a deliberately offset clip and asserts the offset is measured/flagged.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
command -v ffmpeg >/dev/null || { echo "SKIP — ffmpeg not installed"; exit 0; }

# in-sync + 400ms-offset fixtures (audio delayed in the container)
ffmpeg -y -f lavfi -i "testsrc2=duration=4:size=320x240:rate=25" -f lavfi -i "sine=frequency=440:duration=4" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/insync.mp4" >/dev/null 2>&1
ffmpeg -y -i "$WORK/insync.mp4" -itsoffset 0.4 -i "$WORK/insync.mp4" -map 0:v:0 -map 1:a:0 -c copy \
  "$WORK/offset.mp4" >/dev/null 2>&1

echo "=== assertions ==="
"$PY" -W ignore - "$WORK" "$WEB/pipeline" <<'PYEOF'
import json, subprocess, sys
sys.path.insert(0, sys.argv[2])
from qc import avsync, agentic
WORK = sys.argv[1]
ok = True
def need(c, m):
    global ok
    if not c: print(f"  FAIL: {m}"); ok = False
def probe(p):
    return json.loads(subprocess.run(["ffprobe","-v","quiet","-print_format","json",
        "-show_format","-show_streams",p],capture_output=True,text=True).stdout)

meta = probe(f"{WORK}/insync.mp4")
installed = bool(__import__("os").environ.get("SYNCNET_DIR"))

# The AI model must NOT be able to clear lip_sync (proven-unreliable at sync).
agentic_out = {"passes": {"critic": {"status": "complete", "findings": [],
    "risk_dispositions": [{"risk_id": "lip_sync", "status": "CLEAR", "reason": "looks fine"}]}}}
checks = [{"name": "avsync_offset", "status": "info", "detail": "x", "source": "deterministic"},
          {"name": "lip_sync_container_offset", "status": "pass", "detail": "x", "source": "deterministic"},
          {"name": "lip_sync_drift_proxy", "status": "info", "detail": "x", "source": "deterministic"}]
cov = agentic.build_coverage(meta, "transfers/t/insync.mp4", checks, agentic_out, "complete")
ls = next(r for r in cov["risks"] if r["risk_id"] == "lip_sync")
print(f"  model tries to CLEAR lip_sync -> coverage {ls['status']}")
need(ls["status"] != "CLEAR", "AI model must not be able to clear lip_sync")
lc = next(r for r in agentic.RISK_REGISTRY if r["id"] == "lip_sync")
need(lc.get("model_unreliable") is True and "avsync_offset" in lc["checks"],
     "lip_sync must be model_unreliable and wired to avsync_offset")

if not installed:
    c = avsync.checks(f"{WORK}/insync.mp4", meta)
    print(f"  SyncNet absent -> avsync_offset: {c[0]['status']} — {c[0]['detail'][:60]}")
    need(len(c) == 1 and c[0]["name"] == "avsync_offset" and c[0]["status"] == "info"
         and "unavailable" in c[0]["detail"].lower(),
         "absent SyncNet must emit an explicit FYI, never a silent pass")
    print("PASS ✓  AV-sync honest-absence contract + model cannot clear lip_sync"
          if ok else "FAIL")
else:
    ins = avsync.checks(f"{WORK}/insync.mp4", meta)[0]
    off = avsync.checks(f"{WORK}/offset.mp4", meta)[0]
    print(f"  SyncNet in-sync clip: {ins['status']} — {ins['detail'][:70]}")
    print(f"  SyncNet offset clip:  {off['status']} — {off['detail'][:70]}")
    need(off["status"] in {"warn", "info"} and ("offset" in off["detail"].lower()),
         "offset clip must be measured/flagged by SyncNet")
    print("PASS ✓  SyncNet measured AV sync on real clips" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
