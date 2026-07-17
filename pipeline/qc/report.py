"""Unified report model. Every check carries:
  status — pass | info | warn | fail   (drives the legacy badge + overall)
  tier   — FYI | ISSUE | BLOCKER       (Netflix-style triage, non-pass only)
Overall report: fail ⇒ automatic-rejection territory, warn ⇒ human review."""
from __future__ import annotations

BLOCKER, ISSUE, FYI = "BLOCKER", "ISSUE", "FYI"
_TIER_OF = {"fail": BLOCKER, "warn": ISSUE, "info": FYI}


def check(name: str, status: str, detail: str = "", category: str = "signal") -> dict:
    c = {"name": name, "status": status, "detail": detail, "category": category}
    tier = _TIER_OF.get(status)
    if tier:
        c["tier"] = tier
    return c


def violation(name: str, escalate: bool, detail: str, category: str = "signal") -> dict:
    """A threshold breach: BLOCKER when the profile escalates it, else ISSUE."""
    return check(name, "fail" if escalate else "warn", detail, category)


def finalize(report: dict, profile: dict) -> dict:
    """Recompute overall status + tier counts (idempotent; call after any append).
    Checks appended by other lanes (AI, heal) get tiers backfilled from status."""
    statuses = [c["status"] for c in report["checks"]]
    report["status"] = ("fail" if "fail" in statuses
                        else "warn" if "warn" in statuses else "pass")
    tiers = {BLOCKER: 0, ISSUE: 0, FYI: 0}
    for c in report["checks"]:
        t = c.get("tier") or _TIER_OF.get(c["status"])
        if t:
            c["tier"] = t
            tiers[t] += 1
    report["tiers"] = tiers
    report["profile"] = profile["name"]
    report["profile_label"] = profile["label"]
    return report
