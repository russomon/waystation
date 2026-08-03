#!/usr/bin/env bash
# Pure proof for the versioned dual-key delivery authority reducer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from copy import deepcopy

from qc import ai_authority

policy = ai_authority.load_policy()
evidence = ["interpretive-evidence-01"]

def observation(stage, risk="perceptual_visual_defect", confidence=0.96,
                evidence_ids=evidence, state="concern", source="gmicloud:primary",
                severity="reject", intent="confirmed_defect", role="specialist",
                transcriptions=None):
    return {"observation_id": f"{stage}-1", "stage": stage,
            "risk_id": risk, "finding_state": state, "severity": severity,
            "confidence": confidence, "evidence_ids": list(evidence_ids),
            "intent_state": intent, "authority_source_id": source,
            "evidence_transcriptions": list(transcriptions or []),
            "text_transition_observed": len({item["text"] for item in (transcriptions or [])}) > 1,
            "review_role": role,
            "status": "fail", "tier": "BLOCKER"}

circular = {
    "gmi_visual_analysis": [observation("gmi_visual_analysis")],
    "synthesis": [observation("synthesis", role="synthesis")],
}
independent = {
    **circular,
    "gmi_independent_jury": [observation(
        "gmi_independent_jury", source="gmicloud:independent")],
}
before = deepcopy(independent)

# A deterministic rejection cannot be cleared by an AI no-concern result.
no_concern = {"synthesis": [observation("synthesis", state="no_concern")]}
decision = ai_authority.decide(
    deterministic_status="fail", interpretive_state="complete",
    stage_observations=no_concern, mode="enforce", policy=policy)
assert decision["disposition"] == "REJECT"
assert decision["deterministic_gate"]["can_be_cleared_by_ai"] is False

# Shadow records the AI rejection proposal without changing release disposition.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=independent, mode="shadow", policy=policy)
assert decision["disposition"] == "READY"
assert decision["ai_interpretive_gate"]["disposition"] == "SHADOW"
assert decision["ai_interpretive_gate"]["proposed_disposition"] == "REJECT"

# Hold mode can stop release but cannot reject solely from AI.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=independent, mode="hold", policy=policy)
assert decision["disposition"] == "HOLD"

# Enforce mode grants rejection only to evidence-backed, confidence-qualified,
# independently corroborated risks with separate synthesis adjudication.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=independent, mode="enforce", policy=policy)
assert decision["disposition"] == "REJECT"
assert decision["qualified_ai_findings"][0]["qualified"] is True
assert len(decision["qualified_ai_findings"][0]["independent_sources"]) == 2

# Exact planted typography needs two retained frames, two distinct model
# identities, resolved intent, and synthesis. An unchanged twin stays clear.
typo_evidence = ["frame-before", "frame-after"]
typo = {
    "gmi_visual_analysis": [observation(
        "gmi_visual_analysis", risk="typography_defect", evidence_ids=typo_evidence,
        transcriptions=[{"evidence_id": "frame-before", "text": "TICKETS"},
                        {"evidence_id": "frame-after", "text": "TICKET5"}])],
    "gmi_independent_jury": [observation(
        "gmi_independent_jury", risk="typography_defect", evidence_ids=typo_evidence,
        source="gmicloud:independent",
        transcriptions=[{"evidence_id": "frame-before", "text": "TICKETS"},
                        {"evidence_id": "frame-after", "text": "TICKET5"}])],
    "synthesis": [observation(
        "synthesis", risk="typography_defect", evidence_ids=typo_evidence,
        role="synthesis",
        transcriptions=[{"evidence_id": "frame-before", "text": "TICKETS"},
                        {"evidence_id": "frame-after", "text": "TICKET5"}])],
}
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=typo, mode="shadow", policy=policy,
    required_risk_ids=["typography_defect"])
assert decision["ai_interpretive_gate"]["proposed_disposition"] == "REJECT"
# Citations without exact per-frame transcriptions cannot reject typography.
missing_transcription = deepcopy(typo)
for values in missing_transcription.values():
    values[0]["evidence_transcriptions"] = []
    values[0]["text_transition_observed"] = False
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=missing_transcription, mode="enforce", policy=policy,
    required_risk_ids=["typography_defect"])
assert decision["disposition"] == "HOLD"
clean_twin = {"synthesis": [observation(
    "synthesis", risk="typography_defect", state="no_concern", role="synthesis")]}
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=clean_twin, mode="enforce", policy=policy,
    required_risk_ids=["typography_defect"])
assert decision["disposition"] == "READY"

# Synthesis repeats the specialist's input and is not an independent source.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=circular, mode="enforce", policy=policy)
assert decision["disposition"] == "HOLD"
assert decision["qualified_ai_findings"][0]["synthesis_agreement"] is True
assert decision["qualified_ai_findings"][0]["qualified"] is False

# Two stages using the same provider/model identity are still one source.
same_model = deepcopy(independent)
same_model["gmi_independent_jury"][0]["authority_source_id"] = "gmicloud:primary"
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=same_model, mode="enforce", policy=policy)
assert decision["disposition"] == "HOLD"

# Missing provider/model provenance cannot fall back to a stage label.
unprovenanced = deepcopy(independent)
for values in unprovenanced.values():
    values[0].pop("authority_source_id", None)
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=unprovenanced, mode="enforce", policy=policy)
assert decision["disposition"] == "HOLD"

# Reject-grade authority requires resolved intent and reject severity.
for unsafe in (
    {**independent, "synthesis": [observation(
        "synthesis", role="synthesis", intent="ambiguous")]},
    {**independent, "synthesis": [observation(
        "synthesis", role="synthesis", severity="review")]},
):
    decision = ai_authority.decide(
        deterministic_status="pass", interpretive_state="complete",
        stage_observations=unsafe, mode="enforce", policy=policy)
    assert decision["disposition"] == "HOLD"

# One stage, low confidence, unknown risk, or unsupported evidence can never reject.
for findings in (
    {"gmi_visual_analysis": [observation("gmi_visual_analysis")]},
    {"gmi_visual_analysis": [observation("gmi_visual_analysis", confidence=0.2)]},
    {"gmi_visual_analysis": [observation("gmi_visual_analysis", risk="invented")]},
    {"gmi_visual_analysis": [observation("gmi_visual_analysis", evidence_ids=[])]},
):
    decision = ai_authority.decide(
        deterministic_status="pass", interpretive_state="complete",
        stage_observations=findings, mode="enforce", policy=policy)
    assert decision["disposition"] != "REJECT"

# Missing required interpretation is a hold in active modes, never a pass.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="not_checked",
    stage_observations={}, mode="enforce", policy=policy)
assert decision["disposition"] == "HOLD"

# Required-risk omission/not_checked is fail-closed; complete no-concern
# coverage can become READY without changing any deterministic reading.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations={"synthesis": [observation("synthesis", state="no_concern")]},
    mode="enforce", policy=policy,
    required_risk_ids=["perceptual_visual_defect", "audible_defect"])
assert decision["disposition"] == "HOLD"
assert decision["risk_coverage"]["missing"] == ["audible_defect"]

all_clear = [observation("synthesis", risk=risk_id, state="no_concern")
             for risk_id in policy["risks"]]
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations={"synthesis": all_clear}, mode="enforce", policy=policy,
    required_risk_ids=list(policy["risks"]))
assert decision["disposition"] == "READY"
assert decision["risk_coverage"]["complete"] is True

# Hold-only perceptual categories cannot independently reject in enforce mode.
timeline = {"gmi_visual_analysis": [observation(
    "gmi_visual_analysis", risk="temporal_continuity_defect")],
    "synthesis": [observation("synthesis", risk="temporal_continuity_defect")]}
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=timeline, mode="enforce", policy=policy)
assert decision["disposition"] == "HOLD"
assert decision["no_composite_score"] is True
assert independent == before, "authority reducer mutated provider observations"

print("PASS dual-key authority: independent sources, synthesis adjudication, intent-safe shadow/hold/enforce")
PYEOF
