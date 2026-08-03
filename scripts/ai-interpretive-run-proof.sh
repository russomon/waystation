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
import subprocess
import tempfile
import threading
import time
from copy import deepcopy
from types import SimpleNamespace

import worker
from genblaze_core.exceptions import ProviderError
from genblaze_core.models import Run
from genblaze_core.models.enums import ProviderErrorCode
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
worker.AI_INTERPRETIVE_JURY_MODEL = "proof/jury"
worker.AI_INTERPRETIVE_MAX_CONCURRENCY = 3

events = []
worker.progress = lambda _job, event: events.append(deepcopy(event))

class FakeS3:
    def upload_file(self, path, bucket, key, ExtraArgs=None):
        assert bucket == "proof" and os.path.getsize(path) > 0
        assert (key.startswith("derivatives/proof-transfer/ai-interpretive/evidence/")
                or key == "derivatives/proof-transfer/thumb.jpg")
    def put_object(self, Bucket, Key, Body, ContentType):
        assert Bucket == "proof" and Key.endswith("thumbnail_selection.json") and Body
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
real_gmi_chat_response = worker._gmi_chat_response

active = 0
peak = 0
lock = threading.Lock()
calls = []
prompts = {}
token_limits = []
response_formats = []
failed_visual_primary = False
def chat(content, *, model, **kwargs):
    global active, peak, failed_visual_primary
    prompt = content[0]["text"]
    token_limits.append(kwargs.get("max_tokens"))
    response_formats.append(kwargs.get("response_format"))
    if "AI review planner" in prompt:
        calls.append(("ai_review_planning", model))
        payload = {"review_objective": "Inspect bounded human-perception risks",
                   "risk_targets": [{"risk_id": "perceptual_visual_defect",
                                      "review_question": "Is a visible artifact present?"}],
                   "evidence_requests": [
                       {"type": "frame", "time_seconds": 3,
                        "start_seconds": None, "duration_seconds": None,
                        "risk_ids": ["perceptual_visual_defect"],
                        "reason": "review target", "review_question": "Visible artifact?"},
                       {"type": "audio", "time_seconds": None,
                        "start_seconds": 3, "duration_seconds": 4,
                        "risk_ids": ["audible_defect"],
                        "reason": "audio review target", "review_question": "Audible defect?"}],
                   "coverage_limits": ["bounded sample"]}
        return SimpleNamespace(text=json.dumps(payload), model=model,
                               finish_reason="stop", tokens_in=80, tokens_out=20,
                               tokens_cached=0, cost_usd=None)
    stage = next(name for name in ("gmi_visual_analysis", "gmi_audio_analysis",
                                   "gmi_independent_jury", "synthesis")
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
    risks = list(ai_authority.load_policy()["risks"]) if stage in {
        "gmi_independent_jury", "synthesis"} else [
        "perceptual_visual_defect" if stage == "gmi_visual_analysis" else "audible_defect"]
    observations = []
    for risk in risks:
        concern = risk == "perceptual_visual_defect"
        observations.append({"risk_id": risk,
                             "finding_state": "concern" if concern else "no_concern",
                             "severity": "reject" if concern else "info",
                             "issue_description": f"{stage} review target", "context": "sample only",
                             "confidence": 1.0, "uncertainty": "bounded evidence",
                             "evidence_ids": evidence_ids,
                             "evidence_location": "interior",
                             "intent_state": "confirmed_defect",
                             "evidence_transcriptions": [],
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
                 options={"ai_interpretive": True,
                          "review_brief": "Approved text must remain TICKETS."})
cloud_request = job.model_copy(update={"options": {"compute": "cloud"}})
assert worker.compute_route(cloud_request) == {
    "requested": "cloud", "actual": "local", "request_honored": False}

with tempfile.TemporaryDirectory() as tmp:
    source = os.path.join(tmp, "master.mov")
    open(source, "wb").write(b"source")
    result, derivatives = worker.run_explicit_interpretive(
        job, source, tmp, meta, canonical, "a" * 64,
        {"name": "proof", "policy_pack": {"version": "1.0"}})
    thumb_derivatives, thumb_report = worker.create_ai_thumbnail(
        job, source, tmp, meta, "a" * 64, result)
    assert thumb_report["selection_method"] == "interpretive_reuse"
    assert thumb_report["candidate_policy"]["reused_interpretive_evidence"] is True
    assert thumb_report["usage"]["billable_events"] == 0
    assert thumb_report["error"] is None
    assert len(thumb_derivatives) == 2

assert canonical == before, "explicit run mutated canonical report"
assert result["raw_model_output_direct_authority"] is False
assert result["deterministic_verdict_unchanged"] is True
assert result["delivery_authority"] == "dual_key_deterministic_and_ai_policy"
assert result["authority_mode"] == "shadow"
assert result["delivery_decision"]["disposition"] == "HOLD"
assert result["delivery_decision"]["ai_interpretive_gate"]["proposed_disposition"] == "REJECT"
assert [stage["name"] for stage in result["timeline"]] == list(interpretive_run.STAGE_ORDER)
assert result["spend_accounting"]["explicit_gmi_model_calls"] == 5
assert result["review_plan"]["source"] == "ai_planner"
assert result["consolidated_capabilities"]["legacy_ai_qc_model_calls"] == 0
assert result["caption_context"]["state"] == "not_available"
assert peak == 3, "visual, audio, and independent jury analysis did not overlap"
assert response_formats[0] is interpretive_run.ReviewPlanPayload
assert all(value is interpretive_run.InterpretiveObservationsPayload
           for value in response_formats[1:])
assert result["review_context"]["provided"] is True
assert result["review_context"]["characters"] == len("Approved text must remain TICKETS.")
assert "brief" not in result["review_context"]
visual = next(stage for stage in result["timeline"] if stage["name"] == "gmi_visual_analysis")
planner = next(stage for stage in result["timeline"] if stage["name"] == "ai_review_planning")
assert planner["response_schema_version"] == interpretive_run.PLANNER_RESPONSE_SCHEMA_VERSION
assert visual["response_schema_version"] == interpretive_run.OBSERVATION_RESPONSE_SCHEMA_VERSION
assert len(planner["response_schema_sha256"]) == 64
assert len(visual["response_schema_sha256"]) == 64
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
assert '"risk_id": "typography_defect"' in prompts["gmi_visual_analysis"]
assert '"risk_id": "perceptual_visual_defect"' not in prompts["gmi_audio_analysis"]
assert '"risk_id": "audible_defect"' in prompts["gmi_audio_analysis"]
assert "blind independent juror" in prompts["gmi_independent_jury"]
assert result["interpretive_observations"]
assert result["state"] == "complete"
assert len(result["interpretive_observations"]) == len(ai_authority.load_policy()["risks"])
for observation in result["interpretive_observations"]:
    assert observation["authority"] == "eligible_for_versioned_policy_reducer"
    assert observation["raw_model_output_direct_authority"] is False
    if observation["risk_id"] == "temporal_continuity_defect":
        assert observation["finding_state"] == "not_checked"
        assert observation["confidence"] == 0.0
        assert observation["temporal_sampling_suppressed"] is True
    else:
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
assert visual_step.metadata["response_schema_version"] == interpretive_run.OBSERVATION_RESPONSE_SCHEMA_VERSION
assert result["prompt_packet"]["planner_response_schema"]["response_schema_version"] == \
       interpretive_run.PLANNER_RESPONSE_SCHEMA_VERSION
assert any(event["type"] == "ai_interpretive_started" for event in events)
assert any(event["type"] == "ai_interpretive_complete" for event in events)
assert sum(1 for event in events if event.get("billable") == {"unit": "run", "units": 1}) == 5

# The installed Genblaze adapter receives the real JSON-schema class rather
# than relying only on prose that asks a model to return JSON.
schema = interpretive_run.InterpretiveObservationsPayload.model_json_schema()
assert schema["additionalProperties"] is False
assert schema["properties"]["observations"]["maxItems"] == 12
wire = {}
worker.gb_gmi_chat = lambda *args, **kwargs: (
    wire.update(kwargs) or SimpleNamespace(text='{"observations":[]}', model="proof/wire",
                                           finish_reason="stop", tokens_in=1, tokens_out=1,
                                           tokens_cached=0, cost_usd=None))
worker.AI_QC_MIN_INTERVAL = 0
real_gmi_chat_response([{"type": "text", "text": "structured"}], max_attempts=1,
                       response_format=interpretive_run.InterpretiveObservationsPayload)
assert wire["response_format"] is interpretive_run.InterpretiveObservationsPayload

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

# Temporal requests become bounded sequential evidence, not isolated stills.
sequence_plan = interpretive_run.sanitize_review_plan({
    "review_objective": "temporal review",
    "risk_targets": [{"risk_id": "temporal_continuity_defect",
                      "review_question": "Is motion continuous?"}],
    "evidence_requests": [{"type": "frame", "time_seconds": 6,
                           "risk_ids": ["temporal_continuity_defect"],
                           "reason": "freeze target", "review_question": "Frozen?"}],
}, meta, policy, max_frames=1, max_audio=0)
sequence_evidence = interpretive_run.build_evidence_plan(
    meta, interpretive_run.detached_grounding(canonical), sequence_plan,
    max_frames=1, max_audio=0)
assert sequence_evidence[0]["type"] == "frame_sequence"

# Caption context is bounded and hash-identified; audio evidence records
# deterministic signal facts that models must reconcile with perception.
with tempfile.TemporaryDirectory() as support_tmp:
    captions = os.path.join(support_tmp, "captions.srt")
    open(captions, "w").write("1\n00:00:01,000 --> 00:00:02,000\nHello world\n")
    caption_context = worker._bounded_caption_context("unused", captions, support_tmp)
    assert caption_context["state"] == "available"
    assert caption_context["cue_count"] == 1 and len(caption_context["source_sha256"]) == 64
    wav = os.path.join(support_tmp, "tone.wav")
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-ac", "1", "-ar", "16000", wav], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    signal = worker._audio_signal_metrics(wav, 10.0)
    assert signal["state"] == "measured" and signal["continuous_above_threshold"] is True
assert set(item["risk_id"] for item in compact_plan["risk_targets"]) == set(policy["risks"])

# Planner priority cannot leave evidence or specialist risks out of timeline
# order. All visual risks remain available whenever frame evidence exists.
chronological = interpretive_run.build_evidence_plan(meta, {}, {
    "evidence_requests": [
        {"type": "frame", "time_seconds": 9, "risk_ids": ["perceptual_visual_defect"]},
        {"type": "frame", "time_seconds": 1, "risk_ids": ["typography_defect"]},
        {"type": "frame", "time_seconds": 5, "risk_ids": []},
    ]}, max_frames=4, max_audio=0)
times = [item["time_seconds"] for item in chronological]
assert times == sorted(times)
scoped = interpretive_run.stage_review_plan("gmi_visual_analysis", compact_plan, [{
    "evidence_id": "frame-1", "type": "frame", "time_seconds": 2,
    "risk_ids": ["perceptual_visual_defect"]}])
assert {item["risk_id"] for item in scoped["risk_targets"]} == interpretive_run.VISUAL_RISK_IDS
comparison_prompt, _ = interpretive_run.build_prompt(
    "gmi_visual_analysis", {"review_context": {"brief": "Expected TICKETS"}},
    [{"evidence_id": "late", "type": "frame", "time_seconds": 4.5},
     {"evidence_id": "early", "type": "frame", "time_seconds": 1.5}],
    review_plan=compact_plan)
assert comparison_prompt.index('"evidence_id": "early"') < comparison_prompt.index('"evidence_id": "late"')
assert "transcribe its exact characters" in comparison_prompt

# Nullable fields for the other evidence kind are genuinely optional on the
# provider wire; a valid frame request must not be rejected for omitting audio fields.
planner_wire = interpretive_run.ReviewPlanPayload.model_validate({
    "review_objective": "inspect title",
    "risk_targets": [{"risk_id": "typography_defect", "review_question": "Did text mutate?"}],
    "evidence_requests": [{"type": "frame", "time_seconds": 1.0,
                           "risk_ids": ["typography_defect"],
                           "reason": "title sample", "review_question": "Exact title?"}],
    "coverage_limits": ["sampled evidence"],
})
assert planner_wire.evidence_requests[0].start_seconds is None

# Contradictory exact transcriptions cannot be accepted as a clean typography
# result, and unresolved intent cannot retain reject severity.
text_conflict = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "typography_defect", "finding_state": "no_concern", "severity": "info",
    "issue_description": "No mutation; the same text remains unchanged.",
    "confidence": 0.9, "evidence_ids": ["early", "late"],
    "evidence_transcriptions": [{"evidence_id": "late", "text": "TICKET5"},
                                {"evidence_id": "early", "text": "TICKETS"}],
}]}, {"early", "late"}, "gmi_visual_analysis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog={"early": {"time_seconds": 1.5}, "late": {"time_seconds": 4.5}})
assert text_conflict[0]["finding_state"] == "not_checked"
assert text_conflict[0]["text_transition_observed"] is True
assert text_conflict[0]["output_inconsistency"] is True
assert [item["evidence_id"] for item in text_conflict[0]["evidence_transcriptions"]] == ["early", "late"]
different_cards = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "typography_defect", "finding_state": "no_concern", "severity": "info",
    "issue_description": "Different title cards are legible and properly rendered.",
    "confidence": 0.9, "evidence_ids": ["early", "late"],
    "evidence_transcriptions": [{"evidence_id": "early", "text": "November, 2014"},
                                {"evidence_id": "late", "text": "Jack Nance"}],
}]}, {"early", "late"}, "gmi_visual_analysis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog={"early": {"time_seconds": 1.5}, "late": {"time_seconds": 4.5}})
assert different_cards[0]["finding_state"] == "no_concern"
assert different_cards[0]["output_inconsistency"] is False
ambiguous = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "perceptual_visual_defect", "finding_state": "concern", "severity": "reject",
    "issue_description": "Potential freeze; unsure if intentional.", "confidence": 0.99,
    "evidence_ids": ["early"], "intent_state": "confirmed_defect",
}]}, {"early"}, "gmi_visual_analysis", allowed_risk_ids=set(policy["risks"]))
assert ambiguous[0]["severity"] == "hold"
assert ambiguous[0]["intent_state"] == "ambiguous"

# Isolated stills can show a text transition but cannot prove a freeze or
# timeline defect. Such a model claim is retained only as not_checked.
still_only = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "temporal_continuity_defect", "finding_state": "concern",
    "severity": "hold", "issue_description": "Static sequence indicates a freeze.",
    "confidence": 0.95, "evidence_ids": ["early", "late"],
}]}, {"early", "late"}, "synthesis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog={"early": {"type": "frame", "time_seconds": 1.5},
                      "late": {"type": "frame", "time_seconds": 4.5}})
assert still_only[0]["finding_state"] == "not_checked"
assert still_only[0]["temporal_sampling_suppressed"] is True
assert "isolated still frames" in still_only[0]["authority_downgrade_reason"]
assert still_only[0]["issue_description"] == \
       "Timeline continuity cannot be established from isolated still frames."
still_only_clean = interpretive_run.sanitize_observations({"observations": [{
    "risk_id": "temporal_continuity_defect", "finding_state": "no_concern",
    "severity": "info", "issue_description": "No sampled continuity concern.",
    "confidence": 0.9, "evidence_ids": ["early", "late"],
}]}, {"early", "late"}, "synthesis", allowed_risk_ids=set(policy["risks"]),
    evidence_catalog={"early": {"type": "frame"}, "late": {"type": "frame"}})
assert still_only_clean[0]["finding_state"] == "not_checked"
assert still_only_clean[0]["temporal_sampling_suppressed"] is True

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

# A malformed provider response receives one compact, provenance-visible repair
# attempt. Both successful provider responses are metered.
worker.GMI_API_KEY = "mock"
worker.AI_INTERPRETIVE_FALLBACK_PROVIDER = ""
worker.AI_INTERPRETIVE_FALLBACK_MODEL = ""
malformed_calls = []
def malformed_then_repaired(content, **_kwargs):
    malformed_calls.append(content[0]["text"])
    if len(malformed_calls) == 1:
        return SimpleNamespace(text="not json", model="proof/model", tokens_in=2, tokens_out=2,
                               tokens_cached=0, cost_usd=None, finish_reason="length")
    return SimpleNamespace(text=json.dumps({"observations": [{
        "risk_id": "perceptual_visual_defect", "finding_state": "no_concern",
        "severity": "info", "issue_description": "No sampled concern",
        "context": "bounded evidence", "confidence": 0.9,
        "uncertainty": "sampled only", "evidence_ids": [],
        "evidence_location": "unknown", "intent_state": "not_applicable",
        "evidence_transcriptions": [], "review_question": "Review sample?",
    }]}), model="proof/model", tokens_in=3, tokens_out=3,
        tokens_cached=0, cost_usd=None, finish_reason="stop")
worker._gmi_chat_response = malformed_then_repaired
stage, observations = worker._run_interpretive_model_stage(
    job, "gmi_visual_analysis", "proof/model", "prompt", "d" * 64, [], [], "e" * 64)
assert stage["outcome"] == "complete" and observations
assert stage["usage"]["billable_events"] == 2
assert stage["usage"]["tokens_in"] == 5 and stage["usage"]["tokens_out"] == 5
assert stage["finish_reason"] == "stop" and stage["truncated"] is False
assert [item["outcome"] for item in stage["attempts"]] == ["invalid_output", "complete"]
assert stage["attempts"][0]["retry_scheduled"] is True
assert "CORRECTION FOR THIS RETRY" in malformed_calls[1]

# Gemini uses provider-supported JSON-object mode, then the exact same strict
# schema is enforced locally. A transient 429 is retried and every attempt is
# retained instead of disappearing inside the SDK helper.
wire_format, wire_mode = worker._interpretive_response_format(
    "google/gemini-3.5-flash", interpretive_run.InterpretiveObservationsPayload)
assert wire_format == {"type": "json_object"}
assert wire_mode == "provider_json_object_plus_local_schema"
valid_payload = {"observations": [{
    "risk_id": "perceptual_visual_defect", "finding_state": "no_concern",
    "severity": "info", "issue_description": "No sampled concern",
    "context": "bounded evidence", "confidence": 0.9,
    "uncertainty": "sampled only", "evidence_ids": [],
    "evidence_location": "unknown", "intent_state": "not_applicable",
    "evidence_transcriptions": [], "review_question": "Review sample?",
}]}
validated, validation_error = worker._validate_interpretive_payload(
    json.dumps(valid_payload), interpretive_run.InterpretiveObservationsPayload)
assert validated == valid_payload and validation_error is None
invalid = deepcopy(valid_payload)
invalid["observations"][0]["status"] = "fail"
validated, validation_error = worker._validate_interpretive_payload(
    json.dumps(invalid), interpretive_run.InterpretiveObservationsPayload)
assert validated is None and "failed local response schema" in validation_error

retry_calls = []
def retrying_chat(*_args, **kwargs):
    retry_calls.append(kwargs.get("response_format"))
    if len(retry_calls) == 1:
        raise ProviderError("overloaded", error_code=ProviderErrorCode.RATE_LIMIT,
                            retry_after=0)
    return SimpleNamespace(text=json.dumps(valid_payload), model="google/gemini-3.5-flash",
                           tokens_in=2, tokens_out=2, tokens_cached=0,
                           cost_usd=None, finish_reason="stop")
worker._gmi_chat_response = retrying_chat
worker.AI_INTERPRETIVE_STAGE_MAX_ATTEMPTS = 2
worker.AI_INTERPRETIVE_RETRY_DELAY_SECONDS = 0
stage, observations = worker._run_interpretive_model_stage(
    job, "gmi_visual_analysis", "google/gemini-3.5-flash", "prompt",
    "1" * 64, [], [], "2" * 64)
assert stage["outcome"] == "complete" and observations
assert len(stage["attempts"]) == 2 and stage["attempts"][0]["retry_scheduled"] is True
assert stage["response_format_mode"] == "provider_json_object_plus_local_schema"
assert stage["response_validation"] == "complete"
assert retry_calls == [{"type": "json_object"}, {"type": "json_object"}]

print("PASS explicit Genblaze/GMI run: bounded evidence, concurrency, fallback, B2 hashes, sanitizer, authority")
PYEOF

CHECK="$ROOT/gateway/src/_ai_interpretive_policy_check.ts"
trap 'rm -f "$CHECK"' EXIT
cat > "$CHECK" <<'TSEOF'
import { applyServicePolicy } from "./limits.js";
if (process.env.ALLOW_AI_INTERPRETIVE === "true") {
  const combined = applyServicePolicy({ qc_ai: true, ai_interpretive: true });
  if (combined.options?.ai_interpretive !== true || combined.options?.qc_ai !== false)
    throw new Error("combined request did not suppress the legacy AI QC lane");
  console.log("PASS explicit interpretation suppresses duplicate legacy AI QC spend");
  process.exit(0);
}
const requested = applyServicePolicy({ qc_av: true, ai_interpretive: true });
if (requested.options?.ai_interpretive !== false || !requested.disabled.includes("ai_interpretive"))
  throw new Error("explicit interpretive request was not blocked by the default gateway gate");
const implicit = applyServicePolicy(undefined);
if (implicit.disabled.includes("ai_interpretive"))
  throw new Error("opt-in service was reported disabled when it was never requested");
console.log("PASS gateway requires an explicit deployment allow plus sender selection");
TSEOF
(cd "$ROOT/gateway" && ALLOW_AI_INTERPRETIVE=false npx tsx src/_ai_interpretive_policy_check.ts)
(cd "$ROOT/gateway" && ALLOW_AI_INTERPRETIVE=true npx tsx src/_ai_interpretive_policy_check.ts)
rm -f "$CHECK"
trap - EXIT
