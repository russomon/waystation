"""Offline calibration-corpus intake helpers.

This module summarizes labelled evidence. It never edits a policy pack or
promotes an advisory measurement to delivery authority.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter


SCHEMA_VERSION = "waystation-qc-calibration/1.0"
MINIMUM_PER_CLASS = 20


def validate_record(record: dict) -> dict:
    required = {"asset_id", "asset_sha256", "label", "source_kind", "metrics",
                "decision_provenance"}
    missing = sorted(required - record.keys())
    if missing:
        raise ValueError(f"missing calibration fields: {', '.join(missing)}")
    if record["label"] not in {"accepted", "rejected"}:
        raise ValueError("label must be accepted or rejected")
    if record["source_kind"] not in {"real_delivery", "synthetic_fixture"}:
        raise ValueError("source_kind must be real_delivery or synthetic_fixture")
    digest = str(record["asset_sha256"])
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest.lower()):
        raise ValueError("asset_sha256 must be a 64-character hexadecimal digest")
    if not isinstance(record["metrics"], dict):
        raise ValueError("metrics must be an object")
    if record["source_kind"] == "synthetic_fixture" and record.get("network_acceptance_evidence"):
        raise ValueError("synthetic fixtures cannot claim network-acceptance evidence")
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str).encode()
    return {"schema_version": SCHEMA_VERSION,
            "record_sha256": hashlib.sha256(canonical).hexdigest(), **record}


def calibration_candidate(records: list[dict], metric: str, *,
                          higher_is_worse: bool = True,
                          minimum_per_class: int = MINIMUM_PER_CLASS) -> dict:
    validated = [validate_record(record) for record in records]
    usable = [record for record in validated
              if record["source_kind"] == "real_delivery"
              and record.get("network_acceptance_evidence") is True
              and isinstance(record["metrics"].get(metric), (int, float))]
    counts = Counter(record["label"] for record in usable)
    base = {
        "schema_version": SCHEMA_VERSION, "metric": metric,
        "authority": "calibration_candidate_only",
        "automatic_policy_change": False,
        "counts": {"accepted": counts["accepted"], "rejected": counts["rejected"]},
        "minimum_per_class": minimum_per_class,
    }
    if min(counts["accepted"], counts["rejected"]) < minimum_per_class:
        return {**base, "state": "insufficient_real_corpus", "candidate_threshold": None}
    accepted = [float(record["metrics"][metric]) for record in usable if record["label"] == "accepted"]
    rejected = [float(record["metrics"][metric]) for record in usable if record["label"] == "rejected"]
    accepted_edge = max(accepted) if higher_is_worse else min(accepted)
    rejected_edge = min(rejected) if higher_is_worse else max(rejected)
    separated = accepted_edge < rejected_edge if higher_is_worse else accepted_edge > rejected_edge
    candidate = (accepted_edge + rejected_edge) / 2 if separated else None
    return {
        **base, "state": "candidate_ready_for_human_review" if separated else "classes_overlap",
        "accepted_edge": accepted_edge, "rejected_edge": rejected_edge,
        "candidate_threshold": candidate,
        "required_next_step": "documented engineering and editorial review plus versioned policy change",
    }
