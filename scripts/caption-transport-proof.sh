#!/usr/bin/env bash
# Bounded SCC decode plus pure CEA transport continuity proofs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import tempfile
from pathlib import Path

from qc import caption_transport, profiles, report, text

profile = profiles.get("us_broadcast_xdcam_hd_422_v1")
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    scc = root / "good.scc"
    scc.write_text("""Scenarist_SCC V1.0

00:00:01:00    9420 9420 94ae 94ae 4865 6c6c 6f80 942f 942f
00:00:02:00    942c 942c
00:00:02:03    9420 9420 94ae 94ae 576f 726c 6480 942f 942f
00:00:03:00    942c 942c
""", encoding="ascii")
    decoded = text.load_caption_text("unused", str(scc), tmp)
    assert decoded and len(text.parse_caption_cues(decoded)) == 2
    checks = caption_transport.checks({}, str(scc), decoded, 4.0, profile)

by_name = {item["name"]: item for item in checks}
assert by_name["caption_cea_transport_visibility"]["observation"]["state"] == "observed"
assert by_name["caption_cea_decode_integrity"]["status"] == "info"
assert by_name["caption_cea_continuity"]["status"] == "info"
assert by_name["caption_cea_service_visibility"]["observation"]["state"] == "not_checked"
assert all(item["status"] != "fail" for item in checks)

bad_srt = """1
00:00:04,000 --> 00:00:06,000
Late

2
00:00:02,000 --> 00:00:05,000
Out of order and overlapping
"""
bad = caption_transport.checks({}, "bad.scc", bad_srt, 5.0, profile)
continuity = next(item for item in bad if item["name"] == "caption_cea_continuity")
assert continuity["status"] == "warn"
assert continuity["observation"]["value"]["ordering_events"]
assert continuity["observation"]["value"]["overlap_events"]

embedded = caption_transport.checks(
    {"streams": [{"codec_type": "video", "closed_captions": 1}]}, None, None, 60.0, profile)
decode = next(item for item in embedded if item["name"] == "caption_cea_decode_integrity")
assert decode["observation"]["state"] == "not_checked" and decode["status"] == "info"

real_run = caption_transport.subprocess.run
caption_transport._ffmpeg_version.cache_clear()
caption_transport.subprocess.run = lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError())
missing_tool = caption_transport.checks(
    {"streams": [{"codec_type": "video", "closed_captions": 1}]}, None, None, 60.0, profile)
assert all(item["provenance"]["tool_version"] == "unavailable" for item in missing_tool)
assert all(item["status"] == "info" for item in missing_tool)
caption_transport.subprocess.run = real_run
caption_transport._ffmpeg_version.cache_clear()

tiered = report.finalize({"checks": [report.check("instrument", "pass"), *bad]}, profile)
assert tiered["tiers"]["BLOCKER"] == 0 and tiered["status"] == "warn"
print("PASS bounded SCC decode + advisory CEA transport continuity + honest unsupported states")
PYEOF
