#!/usr/bin/env bash
# Versioned prompt compiler + opt-in shadow reducer proof. No network spend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PIPELINE_SHARED_SECRET=proof B2_BUCKET=proof B2_S3_ENDPOINT=http://127.0.0.1:9 \
B2_KEY_ID=proof B2_APP_KEY=proof GMI_API_KEY=mock \
PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import json
import tempfile

import worker
from qc import interpretive, prompt_compiler, profiles, report as qreport

assert worker.AI_INTERPRETIVE_SHADOW is False

finding = {
    "name": "broadcast_freeze_runs", "status": "warn", "category": "signal",
    "detail": "one repeated-frame run", "source": "deterministic",
    "expectation": {"value": {"runs": 0}},
    "observation": {"value": {"events": [{"start_seconds": 4.0, "end_seconds": 7.0}]}},
    "evidence": [{"id": "ffmpeg:freezedetect", "time_ranges": [[4.0, 7.0]]}],
    "decision": {"authority": "deterministic_advisory", "outcome": "warn"},
}
packets = prompt_compiler.compile_packets({"checks": [finding]}, {"profile": "proof"})
assert len(packets) == 1
packet = packets[0]
assert packet["media_requests"] == [{"id": "frame-1", "type": "still", "time_seconds": 5.5}]
assert packet["input_sha256"]
assert "Do not change, clear, or override" in " ".join(packet["constraints"])
assert len(json.dumps(packet)) < 12000
assert prompt_compiler.compile_packets({"checks": [{**finding, "status": "pass"}]}) == []

worker._frame_evidence = lambda *_args, **_kwargs: (
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}},
    {"evidence_id": _args[2], "type": "frame", "time_seconds": 5.5},
)
worker._gmi_chat = lambda *_args, **_kwargs: json.dumps({"findings": [{
    "packet_id": packet["packet_id"], "outcome": "concern", "confidence": 0.72,
    "uncertainty": "sampled still cannot establish the whole interval",
    "detail": "the supplied still is consistent with a freeze target",
    "evidence_ids": [f"{packet['packet_id']}-frame-1"],
}]})
with tempfile.TemporaryDirectory() as tmp:
    report, checks, units = worker.run_interpretive_shadow("unused", tmp, packets)
assert report["state"] == "complete" and report["shadow"] is True
assert report["deterministic_verdict_unchanged"] is True
assert checks[0]["decision"]["authority"] == "ai_advisory"
assert checks[0]["status"] == "warn"
assert report["input_sha256"] == interpretive.input_hash(packets)
assert units == {"model_passes": 1, "packets": 1, "frames": 1, "audio_seconds": 0}

canonical = qreport.finalize({"checks": [{"name": "proof", "status": "pass"}]},
                             profiles.get("standard"))
before = (canonical["status"], dict(canonical["tiers"]))
canonical["ai_interpretive_shadow"] = {**report, "checks": checks}
canonical = qreport.finalize(canonical, profiles.get("standard"))
assert (canonical["status"], canonical["tiers"]) == before

not_checked, empty_checks = interpretive.normalize(
    {"findings": [{"packet_id": "unknown", "outcome": "concern"}]}, packets,
    model="proof", prompt_sha256="abc", evidence=[])
assert not_checked["state"] == "not_checked"
assert len(empty_checks) == 1 and empty_checks[0]["status"] == "info"
assert empty_checks[0]["observation"]["outcome"] == "not_checked"
print("PASS versioned targeted prompt compiler + advisory shadow reducer")
PYEOF
