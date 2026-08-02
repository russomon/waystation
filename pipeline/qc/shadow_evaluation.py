"""Offline human disposition and evaluation for AI shadow observations.

Reviewer feedback is evaluation/calibration evidence only. It cannot promote
an AI observation or modify deterministic policy authority.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter

from .jury import wilson_interval


SCHEMA_VERSION = "waystation-ai-shadow-review/1.0"
DISPOSITIONS = {"agree", "disagree", "needs_review", "false_positive"}
HUMAN_LABELS = {"concern", "no_concern", "not_determinable"}
MODEL_OUTCOMES = {"concern", "no_concern_observed", "not_checked"}


def validate_record(record: dict) -> dict:
    required = {
        "review_id", "packet_id", "observation_id", "source_kind", "split",
        "model_outcome", "human_label", "disposition", "rationale",
        "evidence_references", "reviewer", "provenance",
    }
    missing = sorted(required - record.keys())
    if missing:
        raise ValueError(f"missing shadow-review fields: {', '.join(missing)}")
    for key in ("review_id", "packet_id", "observation_id"):
        if not str(record[key]).strip():
            raise ValueError(f"{key} is required")
    if record["source_kind"] not in {"human_review", "synthetic_fixture"}:
        raise ValueError("source_kind must be human_review or synthetic_fixture")
    if record["split"] not in {"development", "holdout"}:
        raise ValueError("split must be development or holdout")
    if record["model_outcome"] not in MODEL_OUTCOMES:
        raise ValueError("model_outcome is invalid")
    if record["human_label"] not in HUMAN_LABELS:
        raise ValueError("human_label is invalid")
    if record["disposition"] not in DISPOSITIONS:
        raise ValueError("disposition is invalid")
    if record["disposition"] == "false_positive" and not (
            record["model_outcome"] == "concern" and record["human_label"] == "no_concern"):
        raise ValueError("false_positive requires model concern and human no_concern")
    matches = ((record["model_outcome"] == "concern" and record["human_label"] == "concern")
               or (record["model_outcome"] == "no_concern_observed"
                   and record["human_label"] == "no_concern"))
    if record["disposition"] == "agree" and not matches:
        raise ValueError("agree requires matching model and human labels")
    if record["disposition"] == "disagree" and (
            matches or record["model_outcome"] == "not_checked"
            or record["human_label"] == "not_determinable"):
        raise ValueError("disagree requires conflicting determinate labels")
    if record["disposition"] == "needs_review" and not (
            record["model_outcome"] == "not_checked"
            or record["human_label"] == "not_determinable"):
        raise ValueError("needs_review requires unavailable or indeterminate evidence")
    if not str(record["rationale"]).strip():
        raise ValueError("rationale is required")
    refs = record["evidence_references"]
    if not isinstance(refs, list) or not refs or not all(str(value).strip() for value in refs):
        raise ValueError("evidence_references must be a non-empty array")
    reviewer = record["reviewer"]
    if not isinstance(reviewer, dict) or not reviewer.get("reviewer_id") or not reviewer.get("recorded_at"):
        raise ValueError("reviewer requires reviewer_id and recorded_at")
    provenance = record["provenance"]
    required_provenance = {"model", "prompt_sha256", "packet_input_sha256", "schema_version"}
    if (not isinstance(provenance, dict) or not required_provenance <= provenance.keys()
            or not str(provenance.get("model") or "").strip()
            or not str(provenance.get("schema_version") or "").strip()):
        raise ValueError("provenance requires model, prompt, packet hash, and schema version")
    for key in ("prompt_sha256", "packet_input_sha256"):
        digest = str(provenance[key]).lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise ValueError(f"provenance.{key} must be a SHA-256 digest")
    body = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str).encode()
    return {**record,
            "schema_version": SCHEMA_VERSION,
            "record_sha256": hashlib.sha256(body).hexdigest(),
            "authority": "offline_evaluation_only",
            "automatic_policy_change": False}


def evaluate(records: list[dict], *, split: str = "holdout") -> dict:
    if split not in {"development", "holdout"}:
        raise ValueError("split must be development or holdout")
    validated = [validate_record(record) for record in records]
    selected = [record for record in validated if record["split"] == split]
    review_ids: set[str] = set()
    observation_ids: set[str] = set()
    evaluation_rows = [record for record in selected if record["source_kind"] == "human_review"]
    for record in selected:
        if record["review_id"] in review_ids:
            raise ValueError(f"duplicate review_id: {record['review_id']}")
        if record["observation_id"] in observation_ids:
            raise ValueError(f"duplicate observation review: {record['observation_id']}")
        review_ids.add(record["review_id"])
        observation_ids.add(record["observation_id"])

    confusion = {"true_positive": 0, "false_positive": 0,
                 "true_negative": 0, "false_negative": 0}
    excluded = Counter({"synthetic_fixture": len(selected) - len(evaluation_rows)})
    for record in evaluation_rows:
        model, human = record["model_outcome"], record["human_label"]
        if model == "not_checked" or human == "not_determinable":
            excluded["not_determinable_or_not_checked"] += 1
            continue
        if model == "concern" and human == "concern":
            confusion["true_positive"] += 1
        elif model == "concern":
            confusion["false_positive"] += 1
        elif human == "concern":
            confusion["false_negative"] += 1
        else:
            confusion["true_negative"] += 1
    predicted_concern = confusion["true_positive"] + confusion["false_positive"]
    actual_concern = confusion["true_positive"] + confusion["false_negative"]
    actual_clear = confusion["true_negative"] + confusion["false_positive"]
    precision = confusion["true_positive"] / predicted_concern if predicted_concern else None
    recall = confusion["true_positive"] / actual_concern if actual_concern else None
    false_positive_rate = confusion["false_positive"] / actual_clear if actual_clear else None
    dispositions = Counter(record["disposition"] for record in selected)
    source_kinds = Counter(record["source_kind"] for record in selected)
    return {
        "schema_version": SCHEMA_VERSION,
        "state": ("observed" if evaluation_rows else
                  "synthetic_fixture_only" if selected else "not_checked"),
        "split": split,
        "records": len(selected),
        "human_evaluation_records": len(evaluation_rows),
        "confusion": confusion,
        "precision": precision,
        "precision_wilson95": wilson_interval(confusion["true_positive"], predicted_concern),
        "recall": recall,
        "recall_wilson95": wilson_interval(confusion["true_positive"], actual_concern),
        "false_positive_rate": false_positive_rate,
        "false_positive_wilson95": wilson_interval(confusion["false_positive"], actual_clear),
        "dispositions": dict(sorted(dispositions.items())),
        "source_kinds": dict(sorted(source_kinds.items())),
        "excluded": dict(sorted(excluded.items())),
        "authority": "offline_evaluation_only",
        "automatic_policy_change": False,
        "deterministic_delivery_outcome_unchanged": True,
        "required_next_step": (
            "human review of errors and evidence constraints; no AI result automatically changes policy"
        ),
    }
