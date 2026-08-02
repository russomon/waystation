#!/usr/bin/env bash
# Offline AI-shadow reviewer/evaluation proof. No model call or spend.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc.shadow_evaluation import evaluate, validate_record


def review(index, model, human, disposition):
    return {
        "review_id": f"review-{index}", "packet_id": f"packet-{index}",
        "observation_id": f"observation-{index}", "source_kind": "human_review",
        "split": "holdout", "model_outcome": model, "human_label": human,
        "disposition": disposition, "rationale": "retained reviewer rationale",
        "evidence_references": [f"evidence:{index}"],
        "reviewer": {"reviewer_id": "reviewer-proof", "recorded_at": "2026-08-02T00:00:00Z"},
        "provenance": {"model": "mock", "prompt_sha256": "a" * 64,
                       "packet_input_sha256": "b" * 64,
                       "schema_version": "waystation-ai-interpretive-shadow/1.2"},
    }


assert validate_record(review(1, "concern", "concern", "agree"))["automatic_policy_change"] is False
override = review(99, "concern", "concern", "agree")
override["authority"] = "delivery_policy"
override["automatic_policy_change"] = True
validated_override = validate_record(override)
assert validated_override["authority"] == "offline_evaluation_only"
assert validated_override["automatic_policy_change"] is False
records = [
    review(1, "concern", "concern", "agree"),
    review(2, "concern", "no_concern", "false_positive"),
    review(3, "no_concern_observed", "concern", "disagree"),
    review(4, "no_concern_observed", "no_concern", "agree"),
    review(5, "not_checked", "not_determinable", "needs_review"),
]
result = evaluate(records)
assert result["confusion"] == {"true_positive": 1, "false_positive": 1,
                               "true_negative": 1, "false_negative": 1}
assert result["precision"] == 0.5 and result["recall"] == 0.5
assert result["precision_wilson95"] and result["recall_wilson95"]
assert result["excluded"]["not_determinable_or_not_checked"] == 1
assert result["authority"] == "offline_evaluation_only"
assert result["deterministic_delivery_outcome_unchanged"] is True

synthetic = review(20, "concern", "concern", "agree")
synthetic["source_kind"] = "synthetic_fixture"
synthetic_only = evaluate([synthetic])
assert synthetic_only["state"] == "synthetic_fixture_only"
assert synthetic_only["human_evaluation_records"] == 0
assert synthetic_only["confusion"] == {"true_positive": 0, "false_positive": 0,
                                       "true_negative": 0, "false_negative": 0}

invalid = review(6, "no_concern_observed", "no_concern", "false_positive")
try:
    validate_record(invalid)
    raise AssertionError("false_positive disposition semantics must be enforced")
except ValueError:
    pass

print("PASS reviewer dispositions + holdout precision/recall/Wilson + no policy promotion")
PYEOF
