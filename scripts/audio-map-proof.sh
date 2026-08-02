#!/usr/bin/env bash
# Pure declared audio-track mapping proof.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc import broadcast, profiles

profile = profiles.get("us_broadcast_xdcam_hd_422_v1")
good = {"streams": [{"index": 1, "codec_type": "audio", "codec_name": "pcm_s24le",
                     "channels": 2, "channel_layout": "stereo", "sample_rate": "48000",
                     "bits_per_raw_sample": "24", "tags": {}}]}
item = broadcast.declared_audio_map_check(good, profile)[0]
assert item["status"] == "pass" and not item["observation"]["value"]["mismatches"]
assert item["policy"]["version"] == "1.4.0"

missing = {"streams": [{"index": 1, "codec_type": "audio", "channels": 2, "tags": {}}]}
item = broadcast.declared_audio_map_check(missing, profile)[0]
assert item["status"] == "info" and item["observation"]["state"] == "not_checked"
assert item["observation"]["value"]["unavailable"][0]["field"] == "channel_layout"

bad = {"streams": [{"index": 1, "codec_type": "audio", "channels": 1,
                    "channel_layout": "mono", "tags": {"language": "spa"}}]}
item = broadcast.declared_audio_map_check(bad, profile)[0]
assert item["status"] == "fail" and item["decision"]["authority"] == "deterministic_policy"
fields = {mismatch["field"] for mismatch in item["observation"]["value"]["mismatches"]}
assert {"channels", "channel_layout"} <= fields

declared = profiles.get("us_broadcast_xdcam_hd_422_v1", {
    "audio": {"track_map": {"tracks": [{"ordinal": 0, "channels": 2,
        "channel_layout": "stereo", "language": "eng", "title": "Full Mix",
        "role": "program", "dispositions": ["original"]}]}}
})
tagged = {"streams": [{"index": 1, "codec_type": "audio", "channels": 2,
                        "channel_layout": "stereo",
                        "tags": {"language": "eng", "title": "Full Mix", "role": "program"},
                        "disposition": {"default": 1, "original": 1}}]}
assert broadcast.declared_audio_map_check(tagged, declared)[0]["status"] == "pass"
tagged["streams"][0]["tags"]["language"] = "spa"
assert broadcast.declared_audio_map_check(tagged, declared)[0]["status"] == "fail"

assert broadcast.declared_audio_map_check(good, profiles.get("standard")) == []
assert broadcast.declared_audio_map_check(good, profiles.get("netflix")) == []
print("PASS explicit audio-map policy + observable metadata + no-map compatibility")
PYEOF
