#!/usr/bin/env bash
# Cost-aware AI triage proof. No B2, Docker, ffmpeg, or cloud spend: monkeypatch
# GMI and frame extraction, then assert the router only changes spend decisions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PIPELINE_SHARED_SECRET=proof \
B2_BUCKET=proof \
B2_S3_ENDPOINT=http://127.0.0.1:9 \
B2_KEY_ID=proof \
B2_APP_KEY=proof \
GMI_API_KEY=mock \
PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import json
import tempfile

import worker

meta = {
    "format": {"duration": "30.0", "format_name": "mov,mp4"},
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720},
        {"codec_type": "audio", "codec_name": "aac", "channels": 2},
    ],
}
requested = {"qc_ai": True, "qc_synthetic": True, "summarize": False}
deterministic = {"checks": [{"name": "decode", "status": "pass", "detail": "decoded"}]}


def fake_frame(_src, _tmp, evidence_id, at, scale=640, crop=None):
    return (
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}},
        {"evidence_id": evidence_id, "type": "frame", "time_seconds": round(at, 3)},
    )


worker._frame_evidence = fake_frame


def triage_reply(_content, max_tokens=2000, model=None):
    return json.dumps({
        "run_ai_qc": True,
        "run_synthetic_qc": False,
        "run_typography": False,
        "run_critic": False,
        "synthetic_likelihood": "low",
        "visible_text": False,
        "priority_timecodes": [2.5, "bad", 12],
        "reasons": ["no source manifest", "no visible text in triage frames"],
    })


worker._gmi_chat = triage_reply
with tempfile.TemporaryDirectory() as tmp:
    triage, units = worker.run_ai_triage("unused.mp4", meta, None, tmp, deterministic, None, requested)
assert triage["status"] == "complete"
assert triage["run_ai_qc"] is True
assert triage["run_synthetic_qc"] is False
assert triage["run_typography"] is False
assert triage["run_critic"] is False
assert triage["priority_timecodes"] == [2.5, 12.0]
assert units["frames"] > 0

# A generation manifest is an explicit reference, so triage cannot skip the
# sender-requested synthetic lane merely because the sampled frames look plain.
with tempfile.TemporaryDirectory() as tmp:
    triage_with_manifest, _ = worker.run_ai_triage(
        "unused.mp4", meta, None, tmp, deterministic, "/tmp/source.genblaze.json", requested)
assert triage_with_manifest["run_synthetic_qc"] is True


def broken_gmi(_content, max_tokens=2000, model=None):
    raise RuntimeError("mock GMI down")


worker._gmi_chat = broken_gmi
with tempfile.TemporaryDirectory() as tmp:
    fallback, _ = worker.run_ai_triage("unused.mp4", meta, None, tmp, deterministic, None, requested)
assert fallback["status"] == "fallback"
assert fallback["run_ai_qc"] is True
assert fallback["run_synthetic_qc"] is True
assert fallback["run_typography"] is True
assert fallback["run_critic"] is True

# Typography skip must be explicit and must not call the native-crop extractor.
worker._sample_frames = lambda *_args, **_kwargs: [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}}]
worker._generated_evidence = lambda *_args, **_kwargs: (
    [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}}],
    [{"evidence_id": "generated-coarse-1", "type": "frame", "time_seconds": 1.0, "shot_hint": "shot-1"}],
    [],
)
worker._fine_generated_evidence = lambda *_args, **_kwargs: ([], [])


def synthetic_reply(content, max_tokens=2000, model=None):
    prompt = str(content[0].get("text", ""))
    if "COMPILE A READ-ONLY QC BLUEPRINT" in prompt:
        return json.dumps({"summary": "proof plan", "assertions": []})
    if "AI-GENERATED video" in prompt:
        return json.dumps({"findings": [], "appears_generated": False, "confidence": "low", "summary": "clean"})
    if "BUILD A SCENE-GRAPH LEDGER" in prompt:
        return json.dumps({"snapshots": [{"evidence_id": "generated-coarse-1", "shot_id": "shot-1"}]})
    return json.dumps({})


def fail_typography(*_args, **_kwargs):
    raise AssertionError("typography extraction should be skipped")


worker._gmi_chat = synthetic_reply
worker._typography_evidence = fail_typography
with tempfile.TemporaryDirectory() as tmp:
    checks, frames, report = worker.run_synthetic_qc("unused.mp4", meta, tmp, None, run_typography=False)
assert frames > 0
assert report["typography"]["skipped_by_triage"] is True
assert any(c["name"] == "ai_rendered_text_integrity" and "skipped by cost-aware AI triage" in c["detail"]
           for c in checks)

print("PASS cost-aware AI triage proof")
PYEOF
