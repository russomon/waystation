"""Pure dual-key delivery authority reducer for deterministic and AI gates."""
from __future__ import annotations

import hashlib
import json
import os
from copy import deepcopy
from typing import Any


SCHEMA_VERSION = "waystation-dual-key-delivery/1.0"
POLICY_PATH = os.path.join(os.path.dirname(__file__), "..", "policies",
                           "ai_interpretive_authority_v1.json")
MODES = {"shadow", "hold", "enforce"}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()


def load_policy(path: str = POLICY_PATH) -> dict:
    with open(path, encoding="utf-8") as handle:
        policy = json.load(handle)
    if policy.get("schema_version") != "waystation-ai-authority-policy/1.0":
        raise ValueError("unsupported AI authority policy schema")
    policy = deepcopy(policy)
    policy["sha256"] = hashlib.sha256(_canonical(policy)).hexdigest()
    return policy


def normalize_mode(value: str | None) -> str:
    mode = str(value or "shadow").strip().lower()
    return mode if mode in MODES else "shadow"


def _deterministic_gate(status: str | None) -> tuple[str, str]:
    if status == "fail":
        return "REJECT", "deterministic policy reported a blocking failure"
    if status == "warn":
        return "HOLD", "deterministic policy reported unresolved warnings"
    if status == "pass":
        return "READY", "deterministic policy passed"
    return "HOLD", "deterministic policy was not completed"


def _qualified_findings(stage_observations: dict[str, list[dict]], policy: dict) -> list[dict]:
    defaults = policy.get("defaults") or {}
    grouped: dict[str, list[dict]] = {}
    synthesis_by_risk: dict[str, list[dict]] = {}
    for stage, observations in (stage_observations or {}).items():
        for observation in observations or []:
            if observation.get("finding_state") != "concern":
                continue
            risk_id = str(observation.get("risk_id") or "")
            if risk_id not in (policy.get("risks") or {}):
                continue
            if not observation.get("evidence_ids"):
                continue
            item = deepcopy(observation)
            item["stage"] = stage
            if stage == "synthesis" or item.get("review_role") == "synthesis":
                synthesis_by_risk.setdefault(risk_id, []).append(item)
            else:
                grouped.setdefault(risk_id, []).append(item)

    qualified = []
    for risk_id in sorted(set(grouped) | set(synthesis_by_risk)):
        observations = grouped.get(risk_id, [])
        rule = policy["risks"][risk_id]
        minimum_confidence = float(rule.get("minimum_confidence",
                                            defaults.get("minimum_confidence", 1.0)))
        minimum_evidence = int(rule.get("minimum_evidence",
                                        defaults.get("minimum_evidence", 1)))
        minimum_sources = int(rule.get(
            "minimum_independent_sources",
            rule.get("minimum_corroborating_stages",
                     defaults.get("minimum_independent_sources",
                                  defaults.get("minimum_corroborating_stages", 2)))))
        authority = rule.get("authority", "hold")
        required_severity = rule.get("required_severity") if authority == "enforce" else None
        required_intent = rule.get("required_intent_state") if authority == "enforce" else None
        minimum_transcriptions = int(rule.get("minimum_transcriptions", 0))
        require_text_transition = bool(rule.get("require_text_transition", False))

        def eligible(item: dict) -> bool:
            if not item.get("authority_source_id"):
                return False
            if float(item.get("confidence", 0.0)) < minimum_confidence:
                return False
            if required_severity and item.get("severity") != required_severity:
                return False
            if required_intent and item.get("intent_state") != required_intent:
                return False
            transcription_ids = {str(value.get("evidence_id"))
                                 for value in item.get("evidence_transcriptions") or []
                                 if isinstance(value, dict) and value.get("evidence_id")}
            if len(transcription_ids) < minimum_transcriptions:
                return False
            if require_text_transition and not item.get("text_transition_observed"):
                return False
            return True

        accepted = [item for item in observations if eligible(item)]
        synthesis = [item for item in synthesis_by_risk.get(risk_id, []) if eligible(item)]
        stages = sorted({item["stage"] for item in accepted})
        source_ids = sorted({str(item["authority_source_id"]) for item in accepted})
        evidence = sorted({evidence_id for item in accepted
                           for evidence_id in item.get("evidence_ids") or []})
        synthesis_agreement = bool(synthesis)
        qualified.append({
            "risk_id": risk_id,
            "label": rule.get("label", risk_id),
            "policy_authority": authority,
            "qualified": (len(source_ids) >= minimum_sources
                          and len(evidence) >= minimum_evidence
                          and synthesis_agreement),
            "corroborating_stages": stages,
            "independent_sources": source_ids,
            "synthesis_agreement": synthesis_agreement,
            "evidence_ids": evidence,
            "maximum_confidence": max((float(item.get("confidence", 0.0))
                                       for item in observations + synthesis_by_risk.get(risk_id, [])),
                                      default=0.0),
            "requirements": {"minimum_confidence": minimum_confidence,
                             "minimum_evidence": minimum_evidence,
                             "minimum_independent_sources": minimum_sources,
                             "synthesis_agreement": True,
                             "required_severity": required_severity,
                             "required_intent_state": required_intent,
                             "minimum_transcriptions": minimum_transcriptions,
                             "require_text_transition": require_text_transition},
        })
    return qualified


def decide(*, deterministic_status: str | None, interpretive_state: str,
           stage_observations: dict[str, list[dict]], mode: str,
           policy: dict | None = None, required: bool = True,
           required_risk_ids: list[str] | None = None) -> dict:
    """Return a canonical release decision without modifying either input gate."""
    policy = deepcopy(policy or load_policy())
    mode = normalize_mode(mode)
    deterministic_disposition, deterministic_reason = _deterministic_gate(deterministic_status)
    findings = _qualified_findings(stage_observations, policy)
    enforceable = [item for item in findings
                   if item["qualified"] and item["policy_authority"] == "enforce"]
    holds = [item for item in findings
             if item["qualified"] and item["policy_authority"] in {"enforce", "hold"}]
    unqualified_concerns = [item for item in findings if not item["qualified"]]
    ai_complete = interpretive_state == "complete"
    required_risks = sorted({risk_id for risk_id in (required_risk_ids or [])
                             if risk_id in (policy.get("risks") or {})})
    synthesis = (stage_observations or {}).get("synthesis") or []
    observed_states = {item.get("risk_id"): item.get("finding_state") for item in synthesis
                       if item.get("risk_id") in required_risks}
    missing_risks = [risk_id for risk_id in required_risks if risk_id not in observed_states]
    unresolved_risks = [risk_id for risk_id, state in observed_states.items()
                        if state == "not_checked"]

    proposed = "READY"
    ai_gate = "READY"
    reasons: list[str] = []
    if required and not ai_complete:
        proposed = ai_gate = "HOLD"
        reasons.append("required AI interpretive gate was not completed")
    elif enforceable:
        proposed = ai_gate = "REJECT"
        reasons.append(f"{len(enforceable)} corroborated enforceable AI finding(s)")
    elif holds:
        proposed = ai_gate = "HOLD"
        reasons.append(f"{len(holds)} corroborated AI finding(s) require a hold")
    elif missing_risks or unresolved_risks:
        proposed = ai_gate = "HOLD"
        reasons.append(
            f"AI risk coverage incomplete: {len(missing_risks)} missing and {len(unresolved_risks)} not checked")
    elif unqualified_concerns:
        proposed = ai_gate = "HOLD"
        reasons.append(
            f"{len(unqualified_concerns)} AI concern(s) require review because authority requirements were not met")
    else:
        reasons.append("AI interpretive gate completed without a qualified authority finding")

    if mode == "shadow":
        ai_gate = "SHADOW"
        disposition = deterministic_disposition
        reasons.append(f"AI authority is shadow-only; proposed AI disposition was {proposed}")
    elif mode == "hold":
        ai_gate = "HOLD" if proposed in {"HOLD", "REJECT"} else "READY"
        disposition = "REJECT" if deterministic_disposition == "REJECT" else (
            "HOLD" if deterministic_disposition == "HOLD" or ai_gate == "HOLD" else "READY")
        if proposed == "REJECT":
            reasons.append("hold mode converted the AI rejection to a release hold")
    else:
        disposition = "REJECT" if "REJECT" in {deterministic_disposition, proposed} else (
            "HOLD" if "HOLD" in {deterministic_disposition, proposed} else "READY")

    return {
        "schema_version": SCHEMA_VERSION,
        "disposition": disposition,
        "authority_mode": mode,
        "deterministic_gate": {"disposition": deterministic_disposition,
                               "status": deterministic_status,
                               "reason": deterministic_reason,
                               "can_be_cleared_by_ai": False},
        "ai_interpretive_gate": {"disposition": ai_gate,
                                 "proposed_disposition": proposed,
                                 "state": interpretive_state,
                                 "required": required},
        "qualified_ai_findings": findings,
        "risk_coverage": {"required": required_risks,
                          "observed_states": observed_states,
                          "missing": missing_risks,
                          "not_checked": unresolved_risks,
                          "complete": not missing_risks and not unresolved_risks},
        "corroboration_basis": "distinct_provider_model_sources_plus_non_independent_synthesis_adjudication",
        "reasons": reasons,
        "policy": {"policy_id": policy["policy_id"], "version": policy["version"],
                   "schema_version": policy["schema_version"], "sha256": policy["sha256"]},
        "no_composite_score": True,
    }
