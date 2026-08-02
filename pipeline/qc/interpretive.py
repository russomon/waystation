"""Pure reducer for the opt-in AI Interpretive Pass shadow response."""
from __future__ import annotations

import copy
import hashlib
import json
import math

from . import prompt_compiler


SCHEMA_VERSION = "waystation-ai-interpretive-shadow/1.2"


def input_hash(packets: list[dict]) -> str:
    body = json.dumps(packets, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(body).hexdigest()


def normalize(data: dict | None, packets: list[dict], *, model: str,
              prompt_sha256: str, evidence: list[dict]) -> tuple[dict, list[dict]]:
    detached_packets = copy.deepcopy(packets)
    detached_evidence = copy.deepcopy(evidence)
    by_id = {packet["packet_id"]: packet for packet in detached_packets
             if prompt_compiler.validate_packet(packet)}
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
        if not math.isfinite(confidence):
            confidence = 0.0
        packet_evidence = {str(item.get("id")) for item in by_id[packet_id].get("evidence") or []
                           if isinstance(item, dict) and item.get("id")}
        media_evidence = {str(item.get("evidence_id")) for item in detached_evidence
                          if isinstance(item, dict) and item.get("packet_id") == packet_id
                          and item.get("evidence_id")}
        allowed = packet_evidence | media_evidence
        raw_ids = row.get("evidence_ids")
        requested = [str(value)[:120] for value in raw_ids[:8]] if isinstance(raw_ids, list) else []
        cited = [value for value in requested if value in allowed]
        rejected = [value for value in requested if value not in allowed]
        finding = {
            "packet_id": packet_id,
            "outcome": outcome,
            "confidence": round(confidence, 3),
            "uncertainty": str(row.get("uncertainty") or "not stated")[:400],
            "detail": str(row.get("detail") or "no detail returned")[:800],
            "evidence_ids": cited,
            "rejected_evidence_ids": rejected,
            "evidence_constraint": "satisfied" if not rejected else "unsupported_citations_removed",
            "advisory_only": True,
        }
        findings.append(finding)
        status = "warn" if outcome == "concern" else "info"
        observation_id = "shadow-observation-" + hashlib.sha256(json.dumps(
            {"packet_id": packet_id, "finding": finding}, sort_keys=True,
            separators=(",", ":"), default=str).encode()).hexdigest()[:16]
        observations.append({
            "observation_id": observation_id,
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
        "input_sha256": input_hash(list(by_id.values())),
        "prompt_sha256": prompt_sha256,
        "packet_ids": list(by_id),
        "evidence": detached_evidence,
        "findings": findings,
    }
    return report, observations
