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
from qc import ai_authority, interpretive_run

assert worker.AI_INTERPRETIVE_RUN_ENABLED is False
assert worker.AI_INTERPRETIVE_SHADOW is False

worker.AI_INTERPRETIVE_PROVIDER = "gmicloud"
worker.AI_INTERPRETIVE_FALLBACK_PROVIDER = "gmicloud"
worker.AI_INTERPRETIVE_FALLBACK_MODEL = "proof/fallback"
worker.AI_INTERPRETIVE_PLANNER_MODEL = "proof/planner"
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
prompts = {}
token_limits = []
failed_visual_primary = False
def chat(content, *, model, **kwargs):
    global active, peak, failed_visual_primary
    prompt = content[0]["text"]
    token_limits.append(kwargs.get("max_tokens"))
    if "AI review planner" in prompt:
        calls.append(("ai_review_planning", model))
        payload = {"review_objective": "Inspect bounded human-perception risks",
                   "risk_targets": [{"risk_id": "perceptual_visual_defect",
                                      "hypothesis": "visible artifact",
                                      "review_question": "Is a visible artifact present?"}],
                   "evidence_requests": [
                       {"type": "frame", "time_seconds": 3,
                        "risk_ids": ["perceptual_visual_defect"],
                        "reason": "review target", "review_question": "Visible artifact?"},
                       {"type": "audio", "start_seconds": 3, "duration_seconds": 4,
                        "risk_ids": ["audible_defect"],
                        "reason": "audio review target", "review_question": "Audible defect?"}],
                   "coverage_limits": ["bounded sample"]}
        return SimpleNamespace(text=json.dumps(payload), model=model,
                               finish_reason="stop", tokens_in=80, tokens_out=20,
                               tokens_cached=0, cost_usd=None)
    stage = next(name for name in ("gmi_visual_analysis", "gmi_audio_analysis", "synthesis")
                 if f"stage {name}" in prompt)
    calls.append((stage, model))
    prompts[stage] = prompt
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
    risks = list(ai_authority.load_policy()["risks"]) if stage == "synthesis" else [
        "perceptual_visual_defect" if stage == "gmi_visual_analysis" else "audible_defect"]
    observations = []
    for risk in risks:
        concern = risk == "perceptual_visual_defect"
        observations.append({"name": "override", "status": "fail", "tier": "BLOCKER",
                             "risk_id": risk,
                             "finding_state": "concern" if concern else "no_concern",
                             "severity": "reject" if concern else "info",
                             "issue_description": f"{stage} review target", "context": "sample only",
                             "confidence": 7, "uncertainty": "bounded evidence",
                             "evidence_ids": evidence_ids,
                             "evidence_location": "interior",
                             "review_question": "Inspect the cited sample?"})
    return SimpleNamespace(text=json.dumps({"observations": observations}), model=model,
                           finish_reason="stop", tokens_in=100, tokens_out=20,
                           tokens_cached=0, cost_usd=None)
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
assert result["raw_model_output_direct_authority"] is False
assert result["deterministic_verdict_unchanged"] is True
assert result["delivery_authority"] == "dual_key_deterministic_and_ai_policy"
assert result["authority_mode"] == "shadow"
assert result["delivery_decision"]["disposition"] == "HOLD"
assert result["delivery_decision"]["ai_interpretive_gate"]["proposed_disposition"] == "REJECT"
assert [stage["name"] for stage in result["timeline"]] == list(interpretive_run.STAGE_ORDER)
assert result["spend_accounting"]["explicit_gmi_model_calls"] == 4
assert result["review_plan"]["source"] == "ai_planner"
assert peak == 2, "visual and audio analysis did not overlap"
visual = next(stage for stage in result["timeline"] if stage["name"] == "gmi_visual_analysis")
assert len(visual["attempts"]) == 2 and visual["attempts"][1]["fallback"] is True
assert visual["fallback"]["used"] is True
assert visual["finish_reason"] == "stop"
assert visual["output_token_limit"] == worker.AI_INTERPRETIVE_MAX_OUTPUT_TOKENS
assert visual["prompt_characters"] == len(prompts["gmi_visual_analysis"])
assert visual["truncated"] is False
assert all(limit in {worker.AI_INTERPRETIVE_PLANNER_MAX_OUTPUT_TOKENS,
                     worker.AI_INTERPRETIVE_MAX_OUTPUT_TOKENS,
                     worker.AI_INTERPRETIVE_SYNTHESIS_MAX_OUTPUT_TOKENS}
           for limit in token_limits)
assert '"risk_id": "audible_defect"' not in prompts["gmi_visual_analysis"]
assert '"risk_id": "perceptual_visual_defect"' not in prompts["gmi_audio_analysis"]
assert '"risk_id": "audible_defect"' in prompts["gmi_audio_analysis"]
assert result["interpretive_observations"]
assert result["state"] == "complete"
assert len(result["interpretive_observations"]) == len(ai_authority.load_policy()["risks"])
for observation in result["interpretive_observations"]:
    assert observation["authority"] == "eligible_for_versioned_policy_reducer"
    assert observation["raw_model_output_direct_authority"] is False
    assert observation["confidence"] == 1.0
    assert observation["evidence_ids"] == ["interpretive-evidence-01"]
    assert observation["rejected_evidence_ids"] == ["invented-citation"]
    assert not ({"name", "status", "tier"} & observation.keys())
assert all(item["sha256"] and item["key"] for item in result["evidence"])
assert len(derivatives) == len(result["evidence"])
run = Run.model_validate(result["genblaze_run"])
assert run.run_id == result["run_id"] and len(run.steps) == len(interpretive_run.STAGE_ORDER)
assert run.metadata["raw_model_output_direct_authority"] is False
visual_step = next(step for step in run.steps if step.step_id == "gmi_visual_analysis")
assert visual_step.metadata["finish_reason"] == "stop"
assert visual_step.metadata["output_token_limit"] == worker.AI_INTERPRETIVE_MAX_OUTPUT_TOKENS
assert any(event["type"] == "ai_interpretive_started" for event in events)
assert any(event["type"] == "ai_interpretive_complete" for event in events)
assert sum(1 for event in events if event.get("billable") == {"unit": "run", "units": 1}) == 4

# Planner output is allowlisted, deduplicated, bounded to the media, and cannot
# omit policy-required risks or erase the mandatory sampled-coverage caveat.
policy = ai_authority.load_policy()
sanitized_plan = interpretive_run.sanitize_review_plan({
    "risk_targets": [
        {"risk_id": "perceptual_visual_defect"},
        {"risk_id": "perceptual_visual_defect"},
        {"risk_id": "invented_authority"},
    ],
    "evidence_requests": [
        {"type": "frame", "time_seconds": 999,
         "risk_ids": ["perceptual_visual_defect", "invented_authority"]},
    ],
}, meta, policy)
assert sanitized_plan is not None
assert sanitized_plan["evidence_requests"][0]["time_seconds"] == 11.95
assert set(item["risk_id"] for item in sanitized_plan["risk_targets"]) == set(policy["risks"])
assert "sampled evidence is not full-timeline clearance" in sanitized_plan["coverage_limits"]

# The compact planner may omit risk_targets because Waystation adds every
# policy-required target after validating the bounded evidence request.
compact_plan = interpretive_run.sanitize_review_plan({
    "review_objective": "bounded review",
    "evidence_requests": [{"type": "frame", "time_seconds": 2,
                           "risk_ids": ["perceptual_visual_defect"]}],
}, meta, policy)
assert compact_plan is not None
assert set(item["risk_id"] for item in compact_plan["risk_targets"]) == set(policy["risks"])

# An extraction-window boundary is not a source edit. A model claim about a
# truncated syllable at an interior sample edge is forced to not_checked.
audio_evidence = {"audio-1": {"type": "audio_window", "sampling_window": {
    "source_start_seconds": 2.0, "source_end_seconds": 8.0,
    "source_duration_seconds": 10.0, "begins_at_source_start": False,
    "ends_at_source_end": False, "sample_edges_are_not_source_edits": True}}}
boundary = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "audible_defect", "finding_state": "concern", "severity": "reject",
    "issue_description": "Audio begins with a truncated syllable.", "confidence": 0.99,
    "evidence_ids": ["audio-1"], "evidence_location": "start_boundary",
}]}, {"audio-1"}, "gmi_audio_analysis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog=audio_evidence)
assert boundary[0]["finding_state"] == "not_checked"
assert boundary[0]["boundary_artifact_suppressed"] is True
interior = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "audible_defect", "finding_state": "concern", "severity": "review",
    "issue_description": "A click occurs mid-window.", "confidence": 0.9,
    "evidence_ids": ["audio-1"], "evidence_location": "interior",
}]}, {"audio-1"}, "gmi_audio_analysis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog=audio_evidence)
assert interior[0]["finding_state"] == "concern"
assert interior[0]["boundary_artifact_suppressed"] is False

# JSON extraction accepts fences/prose but never repairs a truncated object.
assert worker._json_from('prefix ```json\n{"observations": []}\n``` suffix') == {"observations": []}
assert worker._json_from('{"observations": [') is None

# Missing configuration is explicit not_checked and cannot look like a pass.
worker.GMI_API_KEY = None
planner_stage, fallback_plan = worker._run_interpretive_planner_stage(
    job, meta, interpretive_run.detached_grounding(canonical), "f" * 64, policy)
assert planner_stage["outcome"] == "fallback"
assert planner_stage["usage"]["billable_events"] == 0
assert fallback_plan["source"] == "deterministic_fallback"
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
    tokens_cached=0, cost_usd=None, finish_reason="length")
stage, observations = worker._run_interpretive_model_stage(
    job, "gmi_visual_analysis", "proof/model", "prompt", "d" * 64, [], [], "e" * 64)
assert stage["outcome"] == "not_checked" and observations == []
assert stage["usage"]["billable_events"] == 1
assert stage["finish_reason"] == "length"
assert stage["truncated"] is True
assert "token limit" in stage["error"]

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
