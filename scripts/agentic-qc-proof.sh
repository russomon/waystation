#!/usr/bin/env bash
# Fast contract proof for the read-only agentic QC reporter. No cloud or media
# services are required; the integration proof lives in ai-qc-proof.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc import agentic
from qc import profiles
from qc import report

meta = {
    "format": {"duration": "60.0", "format_name": "mov,mp4"},
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p"},
        {"codec_type": "audio", "codec_name": "aac", "channels": 2},
    ],
}
key = "transfers/proof/master.mp4"
duration = 60.0

prompt = agentic.independent_prompt(meta, key, [{"evidence_id": "timeline-frame-1", "type": "frame"}])
assert "No deterministic findings are supplied" in prompt
assert "Never repair" in prompt
assert "untrusted" in prompt

raw = {
    "summary": "A possible hot pixel was observed.",
    "findings": [{
        "title": "Possible hot pixel",
        "description": "One bright pixel persists in the supplied crop.",
        "risk_id": "dead_stuck_pixels",
        "severity": "issue",
        "confidence": "medium",
        "timecodes": [-5, 4.2, 999],
        "evidence_ids": ["timeline-frame-1"],
    }],
    "risk_dispositions": [{
        "risk_id": "certified_pse",
        "status": "CLEAR",
        "reason": "No flash was visible in the sample.",
        "evidence_ids": ["timeline-frame-1"],
    }],
    "requests": [
        {"type": "frame_burst", "start_seconds": 3, "duration_seconds": 2,
         "purpose": "Confirm persistence"},
        {"type": "shell", "command": "rm -rf /", "purpose": "not allowed"},
        {"type": "pixel_crop", "time_seconds": 999, "x": -2, "y": 0.5,
         "width": 9, "height": 9, "purpose": "Inspect the pixel"},
    ],
}
normalized = agentic.normalize_response(raw, "independent", meta, key, duration)
assert len(normalized["requests"]) == 2
assert all(r["type"] in agentic.REQUEST_TYPES for r in normalized["requests"])
assert "command" not in str(normalized["requests"])
assert normalized["findings"][0]["timecodes"] == [0.0, 4.2, 60.0]

agent_run = {
    "model": "proof-model",
    "prompt": agentic.prompt_identity(),
    "mode": "read_only_no_repair",
    "passes": {
        "independent": normalized,
        "informed": {"findings": [], "risk_dispositions": [], "requests": []},
        "critic": normalized,
    },
    "evidence": [{"evidence_id": "timeline-frame-1", "type": "frame"}],
    "requests": normalized["requests"],
}
checks = [
    report.check("decode", "pass", "decoded without error"),
    report.check("pse_flash_risk", "pass", "screening threshold not exceeded"),
] + agentic.checks_from_findings(agent_run)
qc = report.finalize({"checks": checks}, profiles.get("standard"))
qc = agentic.finalize_report(qc, meta, key, agent_run, "complete")

assert qc["schema_version"] == agentic.REPORT_SCHEMA_VERSION
assert qc["reporter_mode"] == "read_only_no_repair"
assert len(qc["coverage"]["risks"]) == len(agentic.RISK_REGISTRY) == 18
assert qc["coverage"]["accounting_complete"] is True
assert qc["coverage"]["assessment_complete"] is False
assert qc["coverage"]["model_disposition_complete"] is False
assert qc["verdict"]["separate_from_coverage"] is True
assert qc["residual_human_review"]

pse = next(r for r in qc["coverage"]["risks"] if r["risk_id"] == "certified_pse")
assert pse["status"] == "REVIEW_REQUIRED", pse
pixel = next(r for r in qc["coverage"]["risks"] if r["risk_id"] == "dead_stuck_pixels")
assert pixel["status"] in {"CONFIRMED", "SUSPECTED", "REVIEW_REQUIRED"}, pixel
assert not any(r["status"] == "NOT_APPLICABLE" and r["applicable"] for r in qc["coverage"]["risks"])

# Instruments decide, the model annotates: an `unregistered_observation` sits
# outside the registry and is measured by no instrument, so it may never carry
# BLOCKER. Observed live 2026-07-23: the informed pass restated three MEASURED
# instrument failures as "novel" blockers, reporting 6 BLOCKERs for 3 defects.
capped = agentic.checks_from_findings({"passes": {"critic": {"status": "complete", "findings": [
    {"title": "restated", "description": "The integrated loudness is -10.9 LKFS.",
     "risk_id": "unregistered_observation", "severity": "blocker", "confidence": "high"},
    {"title": "real", "description": "Burned-in slate visible.",
     "risk_id": "subtle_visual_artifacts", "severity": "blocker", "confidence": "high"}]}}})
unreg = next(c for c in capped if c["risk_id"] == "unregistered_observation")
registered = next(c for c in capped if c["risk_id"] == "subtle_visual_artifacts")
assert unreg["status"] == "warn", unreg          # capped: never auto-rejects
assert registered["status"] == "fail", registered  # registry-mapped keeps blocker
print(f"  unregistered_observation blocker -> {unreg['status']} (capped); "
      f"registered risk blocker -> {registered['status']}")

print("PASS: agentic charter + allowlisted evidence + 18-risk accounting + no-repair report")
print(f"  prompt {qc['agentic']['prompt']['version']} {qc['agentic']['prompt']['sha256'][:16]}...")
print(f"  coverage {qc['coverage']['assessed_risks']}/{qc['coverage']['applicable_risks']} assessed; "
      f"{qc['coverage']['unresolved_risks']} disclosed")
PYEOF
