"""Unified report model. Every check carries:
  status — pass | info | warn | fail   (drives the legacy badge + overall)
  tier   — FYI | ISSUE | BLOCKER       (Netflix-style triage, non-pass only)
Canonical overall report uses deterministic checks only: fail means a policy
BLOCKER and warn means deterministic review. AI rows are separately accounted
as advisories and cannot change delivery disposition."""
from __future__ import annotations

BLOCKER, ISSUE, FYI = "BLOCKER", "ISSUE", "FYI"
_TIER_OF = {"fail": BLOCKER, "warn": ISSUE, "info": FYI}

AI_ORIGIN_SOURCES = frozenset({
    "agentic_ai", "ai_support", "synthetic_ai", "hybrid",
    "ai_interpretive_shadow", "ai_triage",
})


def is_ai_origin(item: dict) -> bool:
    source = str(item.get("source") or "")
    authority = str((item.get("decision") or {}).get("authority") or "")
    return (source in AI_ORIGIN_SOURCES or source.startswith("ai_")
            or authority == "ai_advisory")


def _cap_ai_advisory(item: dict) -> None:
    if not is_ai_origin(item):
        return
    if item.get("status") == "fail":
        item["status"] = "warn"
    if item.get("tier") == BLOCKER:
        item["tier"] = ISSUE
    decision = item.setdefault("decision", {})
    decision["authority"] = "ai_advisory"
    decision["delivery_outcome_unchanged"] = True


def check(name: str, status: str, detail: str = "", category: str = "signal") -> dict:
    c = {"name": name, "status": status, "detail": detail, "category": category,
         "source": "deterministic"}
    tier = _TIER_OF.get(status)
    if tier:
        c["tier"] = tier
    return c


def violation(name: str, escalate: bool, detail: str, category: str = "signal") -> dict:
    """A threshold breach: BLOCKER when the profile escalates it, else ISSUE."""
    return check(name, "fail" if escalate else "warn", detail, category)


def policy_check(name: str, status: str, detail: str, category: str, *,
                 policy: dict, expectation: dict, observation: dict,
                 evidence: list[dict], provenance: dict,
                 time_range: dict | None = None,
                 authority: str | None = None) -> dict:
    """A policy finding with facts kept separate from the policy decision.

    Existing consumers still receive the normal check shape. The additive
    fields make the measurement, expected value, evidence reference, and
    decision authority independently auditable.
    """
    item = check(name, status, detail, category)
    item.update({
        "policy": policy,
        "expectation": expectation,
        "observation": observation,
        "evidence": evidence,
        "provenance": provenance,
        "decision": {
            "outcome": observation.get("state", "not_checked")
            if status == "info" and observation.get("state") == "not_checked"
            else status,
            "authority": authority or (
                "deterministic_policy" if status in ("pass", "fail")
                else "deterministic_advisory"
            ),
        },
    })
    if time_range is not None:
        item["time_range"] = time_range
    return item


def finalize(report: dict, profile: dict) -> dict:
    """Recompute deterministic delivery disposition and AI advisory accounting."""
    for item in report["checks"]:
        _cap_ai_advisory(item)
    canonical = [item for item in report["checks"] if not is_ai_origin(item)]
    advisory = [item for item in report["checks"] if is_ai_origin(item)]
    statuses = [c["status"] for c in canonical]
    report["status"] = ("fail" if "fail" in statuses
                        else "warn" if "warn" in statuses else "pass")
    tiers = {BLOCKER: 0, ISSUE: 0, FYI: 0}
    for c in canonical:
        t = _TIER_OF.get(c["status"])
        if t:
            c["tier"] = t
            tiers[t] += 1
        else:
            c.pop("tier", None)
    report["tiers"] = tiers
    advisory_tiers = {BLOCKER: 0, ISSUE: 0, FYI: 0}
    advisory_statuses = []
    for c in advisory:
        status = c.get("status", "info")
        advisory_statuses.append(status)
        tier = _TIER_OF.get(status)
        if tier:
            c["tier"] = tier
            advisory_tiers[tier] += 1
        else:
            c.pop("tier", None)
    advisory_tiers[BLOCKER] = 0
    report["advisory_status"] = (
        "warn" if "warn" in advisory_statuses else "info" if advisory_statuses else "none"
    )
    report["advisory_tiers"] = advisory_tiers
    report["delivery_authority"] = "deterministic_policy_only"
    report["profile"] = profile["name"]
    report["profile_label"] = profile["label"]
    return report
