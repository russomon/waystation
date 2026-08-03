#!/usr/bin/env bash
# AI poster selection proof. Uses an SDK-shaped mock; no network or spend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PIPELINE_SHARED_SECRET=proof B2_BUCKET=proof B2_S3_ENDPOINT=http://127.0.0.1:9 \
B2_KEY_ID=proof B2_APP_KEY=proof GMI_API_KEY=mock AI_QC_MIN_INTERVAL=0 \
PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import json
import os
import tempfile
from types import SimpleNamespace

import worker
from qc import poster


class FakeS3:
    def __init__(self):
        self.uploads = {}
        self.objects = {}

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        assert bucket == "proof" and ExtraArgs == {"ContentType": "image/jpeg"}
        self.uploads[key] = open(path, "rb").read()

    def put_object(self, *, Bucket, Key, Body, ContentType):
        assert Bucket == "proof" and ContentType == "application/json"
        self.objects[Key] = Body


fake = FakeS3()
worker.s3 = fake
scene_scans = []
def scene_cuts(*_args, **_kwargs):
    scene_scans.append(True)
    return [2.0, 6.0]
worker._scene_cuts = scene_cuts


def frame(_src, tmp, evidence_id, at, **_kwargs):
    path = os.path.join(tmp, evidence_id + ".jpg")
    body = (evidence_id + ":" + str(at)).encode() * (10 + int(at))
    open(path, "wb").write(body)
    return ({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}},
            {"evidence_id": evidence_id, "type": "frame", "time_seconds": at})


worker._frame_evidence = frame
seen = {}


def select(content, *, model, max_tokens, **kwargs):
    prompt = content[0]["text"]
    seen["prompt"] = prompt
    seen["parts"] = content
    assert max_tokens == 500
    assert kwargs["max_attempts"] == 1
    return SimpleNamespace(
        text=json.dumps({"selected_candidate_id": "poster-candidate-03",
                         "reason": "Clear representative subject and composition.",
                         "confidence": 0.93}),
        model=model, finish_reason="stop", tokens_in=100, tokens_out=24,
        tokens_cached=0, cost_usd=None)


worker._gmi_chat_response = select
job = worker.Job(bucket="proof", key="transfers/poster/master.mp4",
                 transferId="poster", gatewayUrl="http://unused")
meta = {"format": {"duration": "10.0"}, "streams": [{"codec_type": "video"}]}

with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, "master.mp4")
    open(src, "wb").write(b"source")
    derivatives, report = worker.create_ai_thumbnail(job, src, tmp, meta, "a" * 64)

assert report["selection_method"] == "gmi_ai"
assert report["selected_candidate_id"] == "poster-candidate-03"
assert report["finish_reason"] == "stop"
assert report["usage"]["billable_events"] == 1
assert report["generated_image"] is False
assert 3 <= len(report["candidates"]) <= worker.AI_THUMBNAIL_CANDIDATES
assert all(item["sha256"] and item["time_seconds"] >= 0 for item in report["candidates"])
assert len([part for part in seen["parts"] if part.get("type") == "image_url"]) == len(report["candidates"])
assert derivatives[0]["key"].endswith("thumb.jpg")
assert derivatives[1]["key"].endswith("thumbnail_selection.json")
stored = json.loads(fake.objects[derivatives[1]["key"]])
assert stored["selected_sha256"] == derivatives[0]["sha256"]
assert stored["prompt_version"] == poster.PROMPT_VERSION
assert "Never invent an ID" in seen["prompt"]

# An invented candidate cannot control the selected frame and is disclosed as fallback.
worker._gmi_chat_response = lambda *_args, **_kwargs: SimpleNamespace(
    text='{"selected_candidate_id":"invented-frame","confidence":1}',
    model="proof/model", finish_reason="stop", tokens_in=1, tokens_out=1,
    tokens_cached=0, cost_usd=None)
job.transferId = "poster-hostile"
with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, "master.mp4")
    open(src, "wb").write(b"source")
    _derivatives, fallback = worker.create_ai_thumbnail(job, src, tmp, meta, "b" * 64)
assert fallback["selection_method"] == "deterministic_fallback"
assert fallback["selected_candidate_id"] != "invented-frame"
assert fallback["usage"]["billable_events"] == 1
assert fallback["error"] == "GMI returned no valid allowlisted poster selection"

# No credential still produces a real preview but never implies an AI pass.
worker.GMI_API_KEY = None
job.transferId = "poster-no-key"
with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, "master.mp4")
    open(src, "wb").write(b"source")
    _derivatives, no_key = worker.create_ai_thumbnail(job, src, tmp, meta, "c" * 64)
assert no_key["selection_method"] == "deterministic_fallback"
assert no_key["provider"] == "waystation"
assert no_key["usage"]["billable_events"] == 0
assert no_key["error"] == "GMI_API_KEY is not configured"

# Large assets use distributed seeks without an unbounded scene-detection pass.
scans_before = len(scene_scans)
job.transferId = "poster-long"
long_meta = {"format": {"duration": "3600.0"}, "streams": [{"codec_type": "video"}]}
with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, "master.mp4")
    open(src, "wb").write(b"source")
    _derivatives, long_run = worker.create_ai_thumbnail(job, src, tmp, long_meta, "d" * 64)
assert len(scene_scans) == scans_before
assert long_run["candidate_policy"]["scene_cut_enrichment"] is False
assert len(long_run["candidates"]) <= worker.AI_THUMBNAIL_CANDIDATES

# Pure planner remains bounded and sanitizer is allowlist-only.
times = poster.candidate_times(120, list(range(1, 100)), maximum=6)
assert len(times) == 6 and times == sorted(times)
assert poster.sanitize_selection({"selected_candidate_id": "bad"}, report["candidates"]) is None

print("PASS AI thumbnail: bounded real frames, allowlisted GMI choice, fallback, hashes, provenance")
PYEOF
