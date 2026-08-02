#!/usr/bin/env bash
# Calibration intake proof; no policy files are read or modified.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc.calibration import calibration_candidate, validate_record


def record(index, label, value, source_kind="real_delivery", evidenced=True, split="training"):
    return {
        "asset_id": f"proof-{label}-{index}", "asset_sha256": f"{index + 1:064x}"[-64:],
        "label": label, "source_kind": source_kind,
        "independence_group": f"master-{index}", "split": split,
        "strata": {"content_class": "live_action", "codec_generation": "first_generation",
                   "cadence": "30000/1001", "audio_layout": "stereo"},
        "network_acceptance_evidence": evidenced,
        "decision_provenance": {"source": "proof label", "recorded_at": "2026-08-02T00:00:00Z"},
        "metrics": {"block_p95": value},
    }


validated = validate_record(record(0, "accepted", 4.0))
assert len(validated["record_sha256"]) == 64
synthetic = record(1, "rejected", 30.0, "synthetic_fixture", False)
validate_record(synthetic)
synthetic["network_acceptance_evidence"] = True
try:
    validate_record(synthetic)
    raise AssertionError("synthetic network-acceptance claim must fail")
except ValueError:
    pass

missing_stratum = record(7777, "accepted", 5.0)
del missing_stratum["strata"]["audio_layout"]
try:
    validate_record(missing_stratum)
    raise AssertionError("required strata must be enforced")
except ValueError:
    pass

small = calibration_candidate([record(0, "accepted", 4.0), record(1, "rejected", 30.0)],
                              "block_p95")
assert small["state"] == "insufficient_training_corpus"
assert small["candidate_threshold"] is None and not small["automatic_policy_change"]

records = ([record(i, "accepted", 4.0 + i / 20) for i in range(20)]
           + [record(100 + i, "rejected", 20.0 + i / 20) for i in range(20)]
           + [record(1000 + i, "accepted", 5.0, split="holdout") for i in range(100)]
           + [record(2000 + i, "rejected", 21.0, split="holdout") for i in range(100)])
candidate = calibration_candidate(records, "block_p95")
assert candidate["state"] == "candidate_ready_for_policy_review", candidate
assert 4.0 < candidate["candidate_threshold"] < 20.0
assert candidate["authority"] == "calibration_candidate_only"
assert candidate["holdout_validation"]["false_positive_wilson95"][1] <= 0.05
assert candidate["holdout_validation"]["false_negative_wilson95"][1] <= 0.10
assert candidate["strata"]["complete"] and not candidate["automatic_policy_change"]

duplicate = record(9999, "accepted", 5.0)
duplicate["asset_sha256"] = records[0]["asset_sha256"]
try:
    calibration_candidate([*records, duplicate], "block_p95")
    raise AssertionError("duplicate assets must fail")
except ValueError:
    pass

same_master = record(9998, "accepted", 5.0)
same_master["independence_group"] = records[0]["independence_group"]
try:
    calibration_candidate([*records, same_master], "block_p95")
    raise AssertionError("shared source-master groups must not count as independent")
except ValueError:
    pass

weak = calibration_candidate(records[:40] + [record(3000 + i, "accepted", 5.0, split="holdout")
                                             for i in range(20)]
                             + [record(4000 + i, "rejected", 5.0, split="holdout")
                                for i in range(20)], "block_p95")
assert weak["state"] == "holdout_error_limits_exceeded"
print("PASS independent stratified holdout + Wilson error gates + no automatic promotion")
PYEOF
