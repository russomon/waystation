#!/usr/bin/env bash
# Pure QCTools report reducer and missing/malformed-state proof.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import gzip
import os
import tempfile

from qc import profiles, qctools

profile = profiles.get("broadcast_xdcam")
xml = b'''<?xml version="1.0"?><ffprobe><frames>
<frame media_type="video"><tag key="lavfi.signalstats.YMIN" value="16"/>
<tag key="lavfi.signalstats.YMAX" value="235"/><tag key="lavfi.signalstats.YDIF" value="2.5"/>
<tag key="lavfi.signalstats.YBITDEPTH" value="8"/><tag key="lavfi.signalstats.TOUT" value="0"/>
<tag key="lavfi.signalstats.VREP" value="0"/></frame>
<frame media_type="video"><tag key="lavfi.signalstats.YMIN" value="12"/>
<tag key="lavfi.signalstats.YMAX" value="240"/><tag key="lavfi.signalstats.YBITDEPTH" value="4"/>
<tag key="lavfi.signalstats.TOUT" value="0.2"/><tag key="lavfi.signalstats.VREP" value="0.2"/>
<tag key="unvalidated.metric" value="999"/></frame>
</frames></ffprobe>'''
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "proof.qctools.xml.gz")
    with gzip.open(path, "wb") as handle:
        handle.write(xml)
    reduced = qctools.parse_report(path)
    assert reduced["frames"] == 2
    assert reduced["metrics"]["lavfi.signalstats.YMIN"]["minimum"] == 12
    assert reduced["metrics"]["lavfi.signalstats.YBITDEPTH"]["minimum"] == 4
    assert "unvalidated.metric" not in reduced["metrics"]
    finding = qctools.quality_findings(
        [{"window": {"start_seconds": 0, "end_seconds": 8}, **reduced}],
        [{"id": "qctools:proof", "sha256": "a" * 64}],
        {"tool": "qcli", "version": "proof"}, profile)[0]
    assert finding["name"] == "qctools_signal_anomalies"
    assert finding["status"] == "warn"
    assert finding["decision"]["authority"] == "deterministic_advisory"
    assert set(finding["observation"]["value"]["candidates"][0]["reasons"]) == {
        "temporal_outlier", "vertical_repeat", "low_used_luma_bits"
    }
    malformed = os.path.join(tmp, "bad.qctools.xml.gz")
    with gzip.open(malformed, "wb") as handle:
        handle.write(b"not XML")
    try:
        qctools.parse_report(malformed)
        raise AssertionError("malformed report must fail")
    except Exception:
        pass

windows = qctools.analysis_windows(3600, 8, 3)
assert windows == [(0.0, 8.0), (1796.0, 8.0), (3592.0, 8.0)]
real_which = qctools.shutil.which
try:
    qctools.shutil.which = lambda _tool: None
    checks, report = qctools.analyze("unused", ".", 30, profile)
finally:
    qctools.shutil.which = real_which
assert checks[0]["status"] == "info"
assert checks[0]["decision"]["outcome"] == "not_checked"
assert report["state"] == "not_checked"

real_version = qctools._version
try:
    qctools.shutil.which = lambda _tool: "/proof/qcli"
    qctools._version = lambda: (_ for _ in ()).throw(OSError("version probe failed"))
    checks, report = qctools.analyze("unused", ".", 30, profile)
finally:
    qctools.shutil.which = real_which
    qctools._version = real_version
assert checks[0]["decision"]["outcome"] == "not_checked"
assert report["state"] == "not_checked"
print("PASS bounded QCTools reducer + explicit not_checked states")
PYEOF
