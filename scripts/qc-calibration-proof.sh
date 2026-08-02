#!/usr/bin/env bash
# Calibration intake proof; no policy files are read or modified.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc.calibration import calibration_candidate, validate_record


def record(index, label, value, source_kind="real_delivery", evidenced=True):
    return {
        "asset_id": f"proof-{label}-{index}", "asset_sha256": f"{index + 1:064x}"[-64:],
        "label": label, "source_kind": source_kind,
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

small = calibration_candidate([record(0, "accepted", 4.0), record(1, "rejected", 30.0)],
                              "block_p95")
assert small["state"] == "insufficient_real_corpus"
assert small["candidate_threshold"] is None and not small["automatic_policy_change"]

records = ([record(i, "accepted", 4.0 + i / 20) for i in range(20)]
           + [record(100 + i, "rejected", 20.0 + i / 20) for i in range(20)])
candidate = calibration_candidate(records, "block_p95")
assert candidate["state"] == "candidate_ready_for_human_review"
assert 4.0 < candidate["candidate_threshold"] < 20.0
assert candidate["authority"] == "calibration_candidate_only"
print("PASS calibration intake + real-corpus gate + no automatic policy promotion")
PYEOF
