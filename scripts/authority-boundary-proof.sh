#!/usr/bin/env bash
# Deterministic delivery authority + advisory PSE proof. No network or media I/O.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PIPELINE_SHARED_SECRET=proof B2_BUCKET=proof B2_S3_ENDPOINT=http://127.0.0.1:9 \
B2_KEY_ID=proof B2_APP_KEY=proof GMI_API_KEY=mock \
PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import tempfile

import worker
from qc import profiles, report, video

ai_sources = ["agentic_ai", "ai_support", "synthetic_ai", "hybrid", "ai_triage"]
for profile_name in ("standard", "netflix", "us_broadcast_xdcam_hd_422_v1"):
    profile = profiles.get(profile_name)
    injected = [
        {"name": f"hostile_{source}", "status": "fail", "tier": "BLOCKER",
         "category": "agentic", "source": source, "detail": "censor mosaic bleep"}
        for source in ai_sources
    ]
    clean = report.finalize({"checks": [report.check("instrument", "pass"), *injected]}, profile)
    assert clean["status"] == "pass" and clean["tiers"]["BLOCKER"] == 0, clean
    assert clean["advisory_tiers"] == {"BLOCKER": 0, "ISSUE": len(ai_sources), "FYI": 0}
    assert all(item["status"] == "warn" and item["tier"] == "ISSUE" for item in injected)
    failed = report.finalize({"checks": [report.check("instrument", "fail"), *injected]}, profile)
    assert failed["status"] == "fail" and failed["tiers"]["BLOCKER"] == 1, failed

# Prove the former Netflix censorship exception stays advisory at its producer.
worker.run_agentic_inspection = lambda *_args, **_kwargs: (
    {}, [{"name": "agentic_unregistered_observation", "status": "warn",
          "tier": "ISSUE", "category": "agentic", "source": "agentic_ai",
          "detail": "Visible censor mosaic and bleep patch"}],
    {"frames": 0, "requested_frames": 0, "requested_audio_seconds": 0, "model_passes": 1},
)
worker.load_caption_cues = lambda *_args, **_kwargs: []
worker.ai_language_check = lambda *_args, **_kwargs: None
worker.run_hybrid_qc = lambda *_args, **_kwargs: ([], {"hybrid_frames": 0, "hybrid_audio_seconds": 0})
checks, _units, _agentic = worker.run_ai_qc(
    "unused", {"format": {"duration": 0}, "streams": []}, None,
    tempfile.mkdtemp(), profile=profiles.get("netflix"))
censor = next(item for item in checks if item["name"] == "ai_censorship")
assert censor["status"] == "warn" and censor["source"] == "agentic_ai", censor

# The YDIF screen can identify a candidate but cannot pass or block delivery.
original = video.metadata_print_tiled
calls = 0
def candidate(*_args, **_kwargs):
    global calls
    calls += 1
    if calls == 1:
        lines = ["lavfi.signalstats.YMIN=16", "lavfi.signalstats.YMAX=235",
                 "lavfi.signalstats.UMIN=16", "lavfi.signalstats.UMAX=240",
                 "lavfi.signalstats.VMIN=16", "lavfi.signalstats.VMAX=240"]
        lines += ["lavfi.signalstats.YDIF=50"] * 25
        return lines, [(0.0, 1.0)], 1.0
    return ["lavfi.signalstats.YAVG=0", "lavfi.signalstats.UAVG=0",
            "lavfi.signalstats.VAVG=0"], [(0.0, 1.0)], 1.0
video.metadata_print_tiled = candidate
pse = next(item for item in video.range_and_pse("unused", 1.0, profiles.get("netflix"))
           if item["name"] == "pse_flash_risk")
assert pse["status"] == "warn" and pse["decision"]["authority"] == "deterministic_advisory"
assert pse["expectation"]["compliance_grade"] is False and pse["evidence"]
tiered = report.finalize({"checks": [report.check("instrument", "pass"), pse]}, profiles.get("netflix"))
assert tiered["status"] == "warn" and tiered["tiers"]["BLOCKER"] == 0

# Discontiguous tiled excerpts must never be joined into a synthetic one-second
# flash window at their boundary.
calls = 0
def discontiguous(*_args, **_kwargs):
    global calls
    calls += 1
    if calls == 1:
        lines = ["lavfi.signalstats.YMIN=16", "lavfi.signalstats.YMAX=235",
                 "lavfi.signalstats.UMIN=16", "lavfi.signalstats.UMAX=240",
                 "lavfi.signalstats.VMIN=16", "lavfi.signalstats.VMAX=240"]
        lines += [f"lavfi.signalstats.YDIF={value}" for value in
                  ([0] * 7 + [50] * 3 + [50] * 3 + [0] * 7)]
        return lines, [(0.0, 1.0), (100.0, 1.0)], 2.0
    return ["lavfi.signalstats.YAVG=0", "lavfi.signalstats.UAVG=0",
            "lavfi.signalstats.VAVG=0"], [(0.0, 1.0), (100.0, 1.0)], 2.0
video.metadata_print_tiled = discontiguous
split = next(item for item in video.range_and_pse("unused", 101.0, profiles.get("netflix"))
             if item["name"] == "pse_flash_risk")
assert split["status"] == "info" and not split["observation"]["candidate_events"], split

video.metadata_print_tiled = lambda *_args, **_kwargs: ([], [], 0.0)
missing = next(item for item in video.range_and_pse("unused", 1.0, profiles.get("netflix"))
               if item["name"] == "pse_flash_risk")
assert missing["status"] == "info" and missing["observation"]["state"] == "not_checked"
video.metadata_print_tiled = original

print("PASS deterministic-only delivery authority + advisory PSE boundary")
PYEOF
