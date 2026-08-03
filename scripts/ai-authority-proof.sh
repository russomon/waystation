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
                evidence_ids=evidence, state="concern"):
    return {"observation_id": f"{stage}-1", "stage": stage,
            "risk_id": risk, "finding_state": state, "severity": "reject",
            "confidence": confidence, "evidence_ids": list(evidence_ids),
            "status": "fail", "tier": "BLOCKER"}

corroborated = {
    "gmi_visual_analysis": [observation("gmi_visual_analysis")],
    "synthesis": [observation("synthesis")],
}
before = deepcopy(corroborated)

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
    stage_observations=corroborated, mode="shadow", policy=policy)
assert decision["disposition"] == "READY"
assert decision["ai_interpretive_gate"]["disposition"] == "SHADOW"
assert decision["ai_interpretive_gate"]["proposed_disposition"] == "REJECT"

# Hold mode can stop release but cannot reject solely from AI.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=corroborated, mode="hold", policy=policy)
assert decision["disposition"] == "HOLD"

# Enforce mode grants rejection only to evidence-backed, confidence-qualified,
# cross-stage corroborated risks listed as enforceable in the policy.
decision = ai_authority.decide(
    deterministic_status="pass", interpretive_state="complete",
    stage_observations=corroborated, mode="enforce", policy=policy)
assert decision["disposition"] == "REJECT"
assert decision["qualified_ai_findings"][0]["qualified"] is True

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
assert corroborated == before, "authority reducer mutated provider observations"

print("PASS dual-key authority: immutable deterministic gate, shadow/hold/enforce, fail-closed evidence rules")
PYEOF
