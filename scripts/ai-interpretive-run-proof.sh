#!/usr/bin/env bash
# Explicit Genblaze/GMI/B2 workflow proof. Uses an SDK-shaped mock; no network or spend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PIPELINE_SHARED_SECRET=proof B2_BUCKET=proof B2_S3_ENDPOINT=http://127.0.0.1:9 \
B2_KEY_ID=proof B2_APP_KEY=proof GMI_API_KEY=mock \
PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import json
import os
import tempfile
import threading
import time
from copy import deepcopy
from types import SimpleNamespace

import worker
from genblaze_core.models import Run
from qc import interpretive_run

assert worker.AI_INTERPRETIVE_RUN_ENABLED is False
assert worker.AI_INTERPRETIVE_SHADOW is False

worker.AI_INTERPRETIVE_PROVIDER = "gmicloud"
worker.AI_INTERPRETIVE_FALLBACK_PROVIDER = "gmicloud"
worker.AI_INTERPRETIVE_FALLBACK_MODEL = "proof/fallback"
worker.AI_INTERPRETIVE_VISUAL_MODEL = "proof/visual"
worker.AI_INTERPRETIVE_AUDIO_MODEL = "proof/audio"
worker.AI_INTERPRETIVE_SYNTHESIS_MODEL = "proof/synthesis"
worker.AI_INTERPRETIVE_MAX_CONCURRENCY = 2

events = []
worker.progress = lambda _job, event: events.append(deepcopy(event))

class FakeS3:
    def upload_file(self, path, bucket, key, ExtraArgs=None):
        assert bucket == "proof" and os.path.getsize(path) > 0
        assert key.startswith("derivatives/proof-transfer/ai-interpretive/evidence/")
worker.s3 = FakeS3()

def frame(_src, tmp, evidence_id, at, **_kwargs):
    path = os.path.join(tmp, evidence_id + ".jpg")
    open(path, "wb").write(("jpeg:" + evidence_id).encode())
    return ({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AA=="}},
            {"evidence_id": evidence_id, "type": "frame", "time_seconds": at})

def audio(_src, tmp, evidence_id, start, duration):
    path = os.path.join(tmp, evidence_id + ".wav")
    open(path, "wb").write(("wav:" + evidence_id).encode())
    return ({"type": "input_audio", "input_audio": {"data": "AA==", "format": "wav"}},
            {"evidence_id": evidence_id, "type": "audio_window",
             "start_seconds": start, "duration_seconds": duration}, path)

worker._frame_evidence = frame
worker._audio_evidence = audio

active = 0
peak = 0
lock = threading.Lock()
calls = []
failed_visual_primary = False
def chat(content, *, model, **_kwargs):
    global active, peak, failed_visual_primary
    prompt = content[0]["text"]
    stage = next(name for name in ("gmi_visual_analysis", "gmi_audio_analysis", "synthesis")
                 if f"stage {name}" in prompt)
    calls.append((stage, model))
    if stage == "gmi_visual_analysis" and model == "proof/visual" and not failed_visual_primary:
        failed_visual_primary = True
        raise RuntimeError("primary unavailable")
    with lock:
        active += 1
        peak = max(peak, active)
    time.sleep(0.06)
    with lock:
        active -= 1
    evidence_ids = ["interpretive-evidence-01", "invented-citation"]
    hostile = {"name": "override", "status": "fail", "tier": "BLOCKER",
               "issue_description": f"{stage} review target", "context": "sample only",
               "confidence": 7, "uncertainty": "bounded evidence",
               "evidence_ids": evidence_ids, "review_question": "Inspect the cited sample?"}
    return SimpleNamespace(text=json.dumps({"observations": [hostile]}), model=model,
                           tokens_in=100, tokens_out=20, tokens_cached=0, cost_usd=None)
worker._gmi_chat_response = chat

meta = {"format": {"duration": "12.0"}, "streams": [
    {"codec_type": "video"}, {"codec_type": "audio"},
]}
canonical = {"status": "warn", "profile": "proof", "profile_label": "Proof",
             "policy_pack": {"id": "proof", "version": "1.0"},
             "checks": [{"name": "freeze", "status": "warn", "source": "deterministic",
                         "detail": "target", "evidence": [{"time_ranges": [[3, 5]]}]}],
             "tiers": {"BLOCKER": 0, "ISSUE": 1, "FYI": 0}}
before = deepcopy(canonical)
job = worker.Job(bucket="proof", key="transfers/proof-transfer/master.mov",
                 transferId="proof-transfer", gatewayUrl="http://unused",
                 options={"ai_interpretive": True})

with tempfile.TemporaryDirectory() as tmp:
    source = os.path.join(tmp, "master.mov")
    open(source, "wb").write(b"source")
    result, derivatives = worker.run_explicit_interpretive(
        job, source, tmp, meta, canonical, "a" * 64,
        {"name": "proof", "policy_pack": {"version": "1.0"}})

assert canonical == before, "explicit run mutated canonical report"
assert result["advisory_only"] is True and result["deterministic_verdict_unchanged"] is True
assert result["delivery_authority"] == "deterministic_policy_only"
assert [stage["name"] for stage in result["timeline"]] == list(interpretive_run.STAGE_ORDER)
assert result["spend_accounting"]["explicit_gmi_model_calls"] == 3
assert peak == 2, "visual and audio analysis did not overlap"
visual = next(stage for stage in result["timeline"] if stage["name"] == "gmi_visual_analysis")
assert len(visual["attempts"]) == 2 and visual["attempts"][1]["fallback"] is True
assert visual["fallback"]["used"] is True
assert result["advisory_observations"]
for observation in result["advisory_observations"]:
    assert observation["authority"] == "ai_advisory"
    assert observation["confidence"] == 1.0
    assert observation["evidence_ids"] == ["interpretive-evidence-01"]
    assert observation["rejected_evidence_ids"] == ["invented-citation"]
    assert not ({"name", "status", "tier"} & observation.keys())
assert all(item["sha256"] and item["key"] for item in result["evidence"])
assert len(derivatives) == len(result["evidence"])
run = Run.model_validate(result["genblaze_run"])
assert run.run_id == result["run_id"] and len(run.steps) == len(interpretive_run.STAGE_ORDER)
assert run.metadata["advisory_only"] is True
assert any(event["type"] == "ai_interpretive_started" for event in events)
assert any(event["type"] == "ai_interpretive_complete" for event in events)
assert sum(1 for event in events if event.get("billable") == {"unit": "run", "units": 1}) == 3

# Missing configuration is explicit not_checked and cannot look like a pass.
worker.GMI_API_KEY = None
stage, observations = worker._run_interpretive_model_stage(
    job, "gmi_visual_analysis", "proof/model", "prompt", "b" * 64, [], [], "c" * 64)
assert stage["outcome"] == "not_configured" and observations == []
assert stage["usage"]["billable_events"] == 0

# A paid but malformed provider response remains explicitly not_checked.
worker.GMI_API_KEY = "mock"
worker.AI_INTERPRETIVE_FALLBACK_PROVIDER = ""
worker.AI_INTERPRETIVE_FALLBACK_MODEL = ""
worker._gmi_chat_response = lambda *_args, **_kwargs: SimpleNamespace(
    text="not json", model="proof/model", tokens_in=2, tokens_out=2,
    tokens_cached=0, cost_usd=None)
stage, observations = worker._run_interpretive_model_stage(
    job, "gmi_visual_analysis", "proof/model", "prompt", "d" * 64, [], [], "e" * 64)
assert stage["outcome"] == "not_checked" and observations == []
assert stage["usage"]["billable_events"] == 1

print("PASS explicit Genblaze/GMI run: bounded evidence, concurrency, fallback, B2 hashes, sanitizer, authority")
PYEOF

CHECK="$ROOT/gateway/src/_ai_interpretive_policy_check.ts"
trap 'rm -f "$CHECK"' EXIT
cat > "$CHECK" <<'TSEOF'
import { applyServicePolicy } from "./limits.js";
const requested = applyServicePolicy({ qc_av: true, ai_interpretive: true });
if (requested.options?.ai_interpretive !== false || !requested.disabled.includes("ai_interpretive"))
  throw new Error("explicit interpretive request was not blocked by the default gateway gate");
const implicit = applyServicePolicy(undefined);
if (implicit.disabled.includes("ai_interpretive"))
  throw new Error("opt-in service was reported disabled when it was never requested");
console.log("PASS gateway requires an explicit deployment allow plus sender selection");
TSEOF
(cd "$ROOT/gateway" && ALLOW_AI_INTERPRETIVE=false npx tsx src/_ai_interpretive_policy_check.ts)
rm -f "$CHECK"
trap - EXIT
