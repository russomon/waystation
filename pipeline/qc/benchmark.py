"""Offline Waystation versus human/commercial-QC benchmark records.

The corpus preserves reference evidence and disagreement taxonomy. It does not
claim parity, alter a policy, or turn synthetic fixtures into commercial data.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter


SCHEMA_VERSION = "waystation-commercial-qc-benchmark/1.0"
REFERENCE_KINDS = {"human_review", "commercial_qc"}
OUTCOMES = {"pass", "review", "fail", "not_checked"}
DISAGREEMENTS = {
    "agreement", "waystation_only", "reference_only", "severity_difference",
    "category_mapping", "unsupported_capability", "inconclusive_evidence",
}


def _digest(record: dict) -> str:
    body = json.dumps(record, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(body).hexdigest()


def validate_record(record: dict) -> dict:
    required = {
        "asset_id", "asset_sha256", "source_kind", "independence_group",
        "reference", "waystation", "comparisons",
    }
    missing = sorted(required - record.keys())
    if missing:
        raise ValueError(f"missing benchmark fields: {', '.join(missing)}")
    digest = str(record["asset_sha256"]).lower()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("asset_sha256 must be a 64-character hexadecimal digest")
    if record["source_kind"] not in {"real_delivery", "synthetic_fixture"}:
        raise ValueError("source_kind must be real_delivery or synthetic_fixture")
    if not str(record["independence_group"]).strip():
        raise ValueError("independence_group is required")
    reference = record["reference"]
    if not isinstance(reference, dict) or reference.get("kind") not in REFERENCE_KINDS:
        raise ValueError("reference.kind must be human_review or commercial_qc")
    if reference.get("outcome") not in OUTCOMES:
        raise ValueError("reference.outcome is invalid")
    if not reference.get("recorded_at") or not reference.get("evidence_reference"):
        raise ValueError("reference requires recorded_at and evidence_reference")
    if record["source_kind"] == "synthetic_fixture" and reference.get("kind") == "commercial_qc":
        raise ValueError("synthetic fixtures cannot claim a commercial-QC result")
    waystation = record["waystation"]
    if not isinstance(waystation, dict) or waystation.get("outcome") not in OUTCOMES:
        raise ValueError("waystation.outcome is invalid")
    policy = waystation.get("policy")
    if not isinstance(policy, dict) or not policy.get("id") or not policy.get("version"):
        raise ValueError("waystation.policy requires id and version")
    report_digest = str(waystation.get("report_sha256") or "").lower()
    if len(report_digest) != 64 or any(char not in "0123456789abcdef" for char in report_digest):
        raise ValueError("waystation.report_sha256 is required")
    if not isinstance(waystation.get("tool_provenance"), list):
        raise ValueError("waystation.tool_provenance must be an array")
    comparisons = record["comparisons"]
    if not isinstance(comparisons, list) or not comparisons:
        raise ValueError("comparisons must contain at least one side-by-side result")
    for index, comparison in enumerate(comparisons):
        if not isinstance(comparison, dict):
            raise ValueError(f"comparison {index} must be an object")
        if comparison.get("taxonomy") not in DISAGREEMENTS:
            raise ValueError(f"comparison {index} has invalid disagreement taxonomy")
        if not comparison.get("category") or not comparison.get("evidence_reference"):
            raise ValueError(f"comparison {index} requires category and evidence_reference")
        if comparison.get("waystation_outcome") not in OUTCOMES:
            raise ValueError(f"comparison {index} has invalid Waystation outcome")
        if comparison.get("reference_outcome") not in OUTCOMES:
            raise ValueError(f"comparison {index} has invalid reference outcome")
    canonical = json.loads(json.dumps(record, default=str))
    canonical["schema_version"] = SCHEMA_VERSION
    canonical["record_sha256"] = _digest(record)
    canonical["authority"] = "offline_evaluation_only"
    canonical["automatic_policy_change"] = False
    canonical["commercial_parity_claim"] = False
    return canonical


def summarize(records: list[dict]) -> dict:
    validated = [validate_record(record) for record in records]
    hashes: set[str] = set()
    groups: set[str] = set()
    for record in validated:
        digest = record["asset_sha256"].lower()
        group = str(record["independence_group"])
        if digest in hashes:
            raise ValueError(f"duplicate benchmark asset_sha256: {digest}")
        if group in groups:
            raise ValueError(f"benchmark records are not independent: {group}")
        hashes.add(digest)
        groups.add(group)
    references = Counter(record["reference"]["kind"] for record in validated)
    outcomes = Counter((record["waystation"]["outcome"], record["reference"]["outcome"])
                       for record in validated)
    comparisons = [item for record in validated for item in record["comparisons"]]
    taxonomy = Counter(item["taxonomy"] for item in comparisons)
    categories = Counter(item["category"] for item in comparisons)
    policies = sorted({
        f"{record['waystation']['policy']['id']}@{record['waystation']['policy']['version']}"
        for record in validated
    })
    return {
        "schema_version": SCHEMA_VERSION,
        "state": "observed" if validated else "not_checked",
        "records": len(validated),
        "independence": {"unique_assets": len(hashes), "unique_source_groups": len(groups)},
        "reference_kinds": dict(sorted(references.items())),
        "outcome_pairs": [
            {"waystation": waystation, "reference": reference, "count": count}
            for (waystation, reference), count in sorted(outcomes.items())
        ],
        "disagreement_taxonomy": dict(sorted(taxonomy.items())),
        "categories": dict(sorted(categories.items())),
        "policy_versions": policies,
        "authority": "offline_evaluation_only",
        "automatic_policy_change": False,
        "commercial_parity_claim": False,
        "required_interpretation": (
            "review per-category disagreements and retained reference evidence; "
            "this summary is not an acceptance, quality, trust, or parity score"
        ),
    }
