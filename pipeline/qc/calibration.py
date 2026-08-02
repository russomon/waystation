"""Offline calibration-corpus intake and holdout decision gates.

This module never edits a policy pack or promotes an advisory measurement.
Synthetic fixtures may prove reducer behavior, but are excluded from network-
acceptance calibration and statistical decisions.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict

from .jury import wilson_interval


SCHEMA_VERSION = "waystation-qc-calibration/2.0"
MINIMUM_PER_CLASS = 20
REQUIRED_STRATA = ("content_class", "codec_generation", "cadence", "audio_layout")
DEFAULT_MAX_FALSE_POSITIVE_RATE = 0.05
DEFAULT_MAX_FALSE_NEGATIVE_RATE = 0.10


def validate_record(record: dict) -> dict:
    required = {"asset_id", "asset_sha256", "label", "source_kind", "metrics",
                "decision_provenance", "independence_group", "split", "strata"}
    missing = sorted(required - record.keys())
    if missing:
        raise ValueError(f"missing calibration fields: {', '.join(missing)}")
    if record["label"] not in {"accepted", "rejected"}:
        raise ValueError("label must be accepted or rejected")
    if record["source_kind"] not in {"real_delivery", "synthetic_fixture"}:
        raise ValueError("source_kind must be real_delivery or synthetic_fixture")
    if record["split"] not in {"training", "holdout"}:
        raise ValueError("split must be training or holdout")
    if not str(record["independence_group"]).strip():
        raise ValueError("independence_group must identify an independent source master")
    digest = str(record["asset_sha256"])
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest.lower()):
        raise ValueError("asset_sha256 must be a 64-character hexadecimal digest")
    if not isinstance(record["metrics"], dict):
        raise ValueError("metrics must be an object")
    provenance = record["decision_provenance"]
    if not isinstance(provenance, dict) or not provenance.get("source") or not provenance.get("recorded_at"):
        raise ValueError("decision_provenance requires source and recorded_at")
    strata = record["strata"]
    if not isinstance(strata, dict):
        raise ValueError("strata must be an object")
    missing_strata = [field for field in REQUIRED_STRATA if not str(strata.get(field) or "").strip()]
    if missing_strata:
        raise ValueError(f"missing calibration strata: {', '.join(missing_strata)}")
    if record["source_kind"] == "synthetic_fixture" and record.get("network_acceptance_evidence"):
        raise ValueError("synthetic fixtures cannot claim network-acceptance evidence")
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str).encode()
    return {"schema_version": SCHEMA_VERSION,
            "record_sha256": hashlib.sha256(canonical).hexdigest(), **record}


def _stratum(record: dict) -> tuple[str, ...]:
    return tuple(str(record["strata"][field]) for field in REQUIRED_STRATA)


def _deduplicate(records: list[dict]) -> list[dict]:
    hashes: dict[str, str] = {}
    groups: dict[str, str] = {}
    for record in records:
        digest = str(record["asset_sha256"]).lower()
        group = str(record["independence_group"])
        if digest in hashes:
            raise ValueError(f"duplicate asset_sha256 for {hashes[digest]} and {record['asset_id']}")
        if group in groups:
            raise ValueError(
                f"non-independent records share independence_group {group}: "
                f"{groups[group]} and {record['asset_id']}")
        hashes[digest] = str(record["asset_id"])
        groups[group] = str(record["asset_id"])
    return records


def _counts(records: list[dict]) -> dict[str, int]:
    counts = Counter(record["label"] for record in records)
    return {"accepted": counts["accepted"], "rejected": counts["rejected"]}


def _strata_audit(training: list[dict], holdout: list[dict]) -> dict:
    def grouped(rows: list[dict]) -> dict[tuple[str, ...], Counter]:
        result: dict[tuple[str, ...], Counter] = defaultdict(Counter)
        for row in rows:
            result[_stratum(row)][row["label"]] += 1
        return result

    train, test = grouped(training), grouped(holdout)
    missing = sorted(set(train) - set(test))
    single_label = sorted(key for key, counts in test.items()
                          if not counts["accepted"] or not counts["rejected"])
    render = lambda key: dict(zip(REQUIRED_STRATA, key))
    return {
        "dimensions": list(REQUIRED_STRATA),
        "training_strata": len(train),
        "holdout_strata": len(test),
        "missing_from_holdout": [render(key) for key in missing],
        "holdout_single_label_strata": [render(key) for key in single_label],
        "complete": not missing and not single_label,
    }


def _classify(value: float, threshold: float, higher_is_worse: bool) -> str:
    rejected = value >= threshold if higher_is_worse else value <= threshold
    return "rejected" if rejected else "accepted"


def calibration_candidate(records: list[dict], metric: str, *,
                          higher_is_worse: bool = True,
                          minimum_per_class: int = MINIMUM_PER_CLASS,
                          max_false_positive_rate: float = DEFAULT_MAX_FALSE_POSITIVE_RATE,
                          max_false_negative_rate: float = DEFAULT_MAX_FALSE_NEGATIVE_RATE) -> dict:
    if minimum_per_class < 1:
        raise ValueError("minimum_per_class must be positive")
    if not 0 <= max_false_positive_rate <= 1 or not 0 <= max_false_negative_rate <= 1:
        raise ValueError("false-positive and false-negative targets must be between 0 and 1")
    validated = _deduplicate([validate_record(record) for record in records])
    usable = [record for record in validated
              if record["source_kind"] == "real_delivery"
              and record.get("network_acceptance_evidence") is True
              and isinstance(record["metrics"].get(metric), (int, float))]
    training = [record for record in usable if record["split"] == "training"]
    holdout = [record for record in usable if record["split"] == "holdout"]
    training_counts, holdout_counts = _counts(training), _counts(holdout)
    strata = _strata_audit(training, holdout)
    base = {
        "schema_version": SCHEMA_VERSION,
        "metric": metric,
        "authority": "calibration_candidate_only",
        "automatic_policy_change": False,
        "synthetic_records_used": 0,
        "excluded_records": len(validated) - len(usable),
        "independence": {"deduplicated": True, "unique_assets": len(validated),
                         "unique_groups": len(validated)},
        "counts": {"training": training_counts, "holdout": holdout_counts},
        "minimum_per_class_per_split": minimum_per_class,
        "strata": strata,
        "acceptance_targets": {
            "maximum_false_positive_rate": max_false_positive_rate,
            "maximum_false_negative_rate": max_false_negative_rate,
            "confidence_interval": "Wilson 95% upper bound",
        },
        "candidate_threshold": None,
        "required_next_step": (
            "documented engineering and editorial review plus an explicit versioned policy change"
        ),
    }
    if min(training_counts.values()) < minimum_per_class:
        return {**base, "state": "insufficient_training_corpus", "holdout_validation": None}

    accepted = [float(record["metrics"][metric]) for record in training
                if record["label"] == "accepted"]
    rejected = [float(record["metrics"][metric]) for record in training
                if record["label"] == "rejected"]
    accepted_edge = max(accepted) if higher_is_worse else min(accepted)
    rejected_edge = min(rejected) if higher_is_worse else max(rejected)
    separated = accepted_edge < rejected_edge if higher_is_worse else accepted_edge > rejected_edge
    if not separated:
        return {**base, "state": "training_classes_overlap", "accepted_edge": accepted_edge,
                "rejected_edge": rejected_edge, "holdout_validation": None}
    threshold = (accepted_edge + rejected_edge) / 2
    threshold_fields = {"candidate_threshold": threshold, "accepted_edge": accepted_edge,
                        "rejected_edge": rejected_edge}
    if min(holdout_counts.values()) < minimum_per_class:
        return {**base, **threshold_fields, "state": "insufficient_holdout_corpus",
                "holdout_validation": None}
    if not strata["complete"]:
        return {**base, **threshold_fields, "state": "incomplete_stratified_holdout",
                "holdout_validation": None}

    confusion = {"true_accepted": 0, "false_rejected": 0,
                 "true_rejected": 0, "false_accepted": 0}
    for record in holdout:
        predicted = _classify(float(record["metrics"][metric]), threshold, higher_is_worse)
        if record["label"] == "accepted":
            confusion["true_accepted" if predicted == "accepted" else "false_rejected"] += 1
        else:
            confusion["true_rejected" if predicted == "rejected" else "false_accepted"] += 1
    fp = confusion["false_rejected"]
    fn = confusion["false_accepted"]
    accepted_n, rejected_n = holdout_counts["accepted"], holdout_counts["rejected"]
    fp_ci = wilson_interval(fp, accepted_n)
    fn_ci = wilson_interval(fn, rejected_n)
    validation = {
        "confusion": confusion,
        "false_positive_rate": fp / accepted_n,
        "false_negative_rate": fn / rejected_n,
        "false_positive_wilson95": fp_ci,
        "false_negative_wilson95": fn_ci,
        "passes_false_positive_target": bool(fp_ci and fp_ci[1] <= max_false_positive_rate),
        "passes_false_negative_target": bool(fn_ci and fn_ci[1] <= max_false_negative_rate),
    }
    passed = (validation["passes_false_positive_target"]
              and validation["passes_false_negative_target"])
    return {**base, **threshold_fields,
            "state": "candidate_ready_for_policy_review" if passed
            else "holdout_error_limits_exceeded",
            "holdout_validation": validation}
