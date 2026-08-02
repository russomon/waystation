"""Pure reducer for the opt-in AI Interpretive Pass shadow response."""
from __future__ import annotations

import hashlib
import json


SCHEMA_VERSION = "waystation-ai-interpretive-shadow/1.1"


def input_hash(packets: list[dict]) -> str:
    body = json.dumps(packets, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(body).hexdigest()


def normalize(data: dict | None, packets: list[dict], *, model: str,
              prompt_sha256: str, evidence: list[dict]) -> tuple[dict, list[dict]]:
    by_id = {packet["packet_id"]: packet for packet in packets}
    rows = data.get("findings") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        rows = []
    rows_by_id = {row.get("packet_id"): row for row in rows
                  if isinstance(row, dict) and row.get("packet_id") in by_id}
    findings = []
    observations = []
    for packet_id in by_id:
        row = rows_by_id.get(packet_id) or {
            "outcome": "not_checked", "confidence": 0,
            "uncertainty": "model returned no finding for this packet",
            "detail": "targeted evidence was not interpreted",
        }
        outcome = str(row.get("outcome") or "not_checked").lower()
        if outcome not in {"concern", "no_concern_observed", "not_checked"}:
            outcome = "not_checked"
        try:
            confidence = max(0.0, min(float(row.get("confidence")), 1.0))
        except (TypeError, ValueError):
            confidence = 0.0
        cited = [str(value)[:120] for value in (row.get("evidence_ids") or [])[:8]]
        finding = {
            "packet_id": packet_id,
            "outcome": outcome,
            "confidence": round(confidence, 3),
            "uncertainty": str(row.get("uncertainty") or "not stated")[:400],
            "detail": str(row.get("detail") or "no detail returned")[:800],
            "evidence_ids": cited,
            "advisory_only": True,
        }
        findings.append(finding)
        status = "warn" if outcome == "concern" else "info"
        observations.append({
            "observation_type": "ai_interpretive_shadow",
            "advisory_state": "concern" if status == "warn" else "informational",
            "review_priority": "review" if status == "warn" else "fyi",
            "category": by_id[packet_id]["finding"].get("category") or "signal",
            "source": "ai_interpretive_shadow",
            "detail": f"{packet_id}: {finding['detail']}",
            "packet_id": packet_id,
            "observation": finding,
            "provenance": {"model": model, "schema_version": SCHEMA_VERSION,
                           "prompt_sha256": prompt_sha256,
                           "packet_input_sha256": by_id[packet_id]["input_sha256"]},
            "decision": {"outcome": "advisory", "authority": "ai_advisory",
                         "deterministic_verdict_unchanged": True},
        })
    state = "complete" if rows_by_id else "not_checked"
    report = {
        "schema_version": SCHEMA_VERSION,
        "state": state,
        "shadow": True,
        "advisory_only": True,
        "deterministic_verdict_unchanged": True,
        "model": model,
        "input_sha256": input_hash(packets),
        "prompt_sha256": prompt_sha256,
        "packet_ids": list(by_id),
        "evidence": evidence,
        "findings": findings,
    }
    return report, observations
