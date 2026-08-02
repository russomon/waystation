#!/usr/bin/env bash
# Offline benchmark intake proof. No commercial result is fabricated or fetched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc.benchmark import summarize, validate_record


def record(index, *, kind="human_review", source="real_delivery", taxonomy="agreement"):
    return {
        "asset_id": f"asset-{index}", "asset_sha256": f"{index + 1:064x}"[-64:],
        "source_kind": source, "independence_group": f"master-{index}",
        "reference": {"kind": kind, "provider": "retained proof record",
                      "outcome": "review", "recorded_at": "2026-08-02T00:00:00Z",
                      "evidence_reference": f"vault://reference/{index}"},
        "waystation": {"outcome": "review", "report_sha256": f"{index + 100:064x}"[-64:],
                       "policy": {"id": "us_broadcast_xdcam_hd_422_baseline", "version": "1.4.0"},
                       "tool_provenance": [{"tool": "ffprobe", "version": "proof"}]},
        "comparisons": [{"category": "timeline", "waystation_outcome": "review",
                         "reference_outcome": "review", "taxonomy": taxonomy,
                         "evidence_reference": f"vault://comparison/{index}"}],
    }


validated = validate_record(record(1))
assert validated["authority"] == "offline_evaluation_only"
assert validated["automatic_policy_change"] is False
assert validated["commercial_parity_claim"] is False

try:
    validate_record(record(2, kind="commercial_qc", source="synthetic_fixture"))
    raise AssertionError("synthetic fixture must not claim a commercial-QC result")
except ValueError:
    pass

summary = summarize([record(3), record(4, kind="commercial_qc", taxonomy="reference_only")])
assert summary["records"] == 2
assert summary["reference_kinds"] == {"commercial_qc": 1, "human_review": 1}
assert summary["disagreement_taxonomy"]["reference_only"] == 1
assert summary["commercial_parity_claim"] is False
assert "not an acceptance, quality, trust, or parity score" in summary["required_interpretation"]

duplicate = record(5)
same = record(6)
same["asset_sha256"] = duplicate["asset_sha256"]
try:
    summarize([duplicate, same])
    raise AssertionError("duplicate assets must be rejected")
except ValueError:
    pass

print("PASS retained side-by-side benchmark provenance + disagreement taxonomy + no parity score")
PYEOF
