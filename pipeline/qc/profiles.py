"""QC profiles. A profile decides which checks run, their thresholds, and
whether a violation escalates to a hard failure (BLOCKER) or stays a
review-level warning (ISSUE).

"standard" is Waystation's default lane — permissive thresholds, nothing
blocks. "netflix" is the strict single-toggle profile: the verbatim
constraint block below is enforced wherever our toolchain can genuinely
measure it, and surfaced as an explicit FYI finding where it can't
(Photon without a JVM, Dolby Vision canvas tracking without dovi_tool)."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path

NETFLIX_CONSTRAINTS = {
    "profile_name": "Netflix_Delivery_Specification_Strict",
    "constraints": {
        "allow_multipart_deliveries": False,
        "enforce_native_framerate": True,
        "allowed_framerates": ["23.976p", "24p", "25p", "29.97p", "50p", "59.94p"],
        "allow_32_pulldown_flags": False,
        "allow_censorship_elements": False,
        "imf_specification": "SMPTE_ST_2067-21_App_2E",
        "photon_validation_required": True,
        "hdr_metadata_tracking": "Dolby_Vision_Dynamic_Canvas_Match",
        "target_integrated_loudness_lkfs": -24.0,
        "loudness_tolerance_lkfs": 1.0,
        "max_true_peak_dbtp": -2.0,
        "pse_screen_reference": "ITU-R_BT_1702-3_(11/2023)_guidance",
    },
}

PROFILES = {
    "standard": {
        "name": "standard",
        "label": "Waystation Standard",
        # loudness: broad delivery range, warn-only (matches the original lane)
        "loudness": {"min": -30.0, "max": -10.0, "target": None, "tolerance": None, "escalate": False},
        "true_peak": {"max": None, "escalate": False},   # measured + reported, never judged
        "framerates": None,                               # any rate accepted
        "allow_vfr": True,
        "allow_pulldown": True,
        "allow_interlaced": True,
        "allow_multipart": True,
        "video_range": {"escalate": False},
        "pse": {"enabled": False, "escalate": False},
        "censorship": {"escalate": False},
        "photon_required": False,
    },
    "netflix": {
        "name": "netflix",
        "label": NETFLIX_CONSTRAINTS["profile_name"],
        "constraints": NETFLIX_CONSTRAINTS["constraints"],
        "loudness": {"min": None, "max": None, "target": -24.0, "tolerance": 1.0, "escalate": True},
        "true_peak": {"max": -2.0, "escalate": True},
        "framerates": ["23.976p", "24p", "25p", "29.97p", "50p", "59.94p"],
        "allow_vfr": False,          # Rule 2: no frame-rate conversions
        "allow_pulldown": False,     # Rule 2: no 3:2 pulldown cadence
        "allow_interlaced": False,   # allowed list is progressive-only
        "allow_multipart": False,    # Rule 1: single long-play asset
        "video_range": {"escalate": True},
        "pse": {"enabled": True, "escalate": False,
                "authority": "advisory_heuristic"},
        "censorship": {"escalate": False, "authority": "ai_advisory"},
        "photon_required": True,                      # Rule 4
    },
}

_BROADCAST_POLICY_PATH = (
    Path(__file__).resolve().parent.parent
    / "policies" / "us_broadcast_xdcam_hd_422_v1.json"
)
_DELIVERY_TEMPLATE_DIR = (
    Path(__file__).resolve().parent.parent / "policies" / "delivery_templates"
)


def _deep_merge(base: dict, override: dict, *, strict: bool = False,
                prefix: str = "") -> dict:
    for key, value in override.items():
        path = f"{prefix}.{key}" if prefix else key
        if strict and key not in base:
            raise ValueError(f"unknown broadcast policy override: {path}")
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value, strict=strict, prefix=path)
        else:
            base[key] = copy.deepcopy(value)
    return base


def _broadcast_profile(overrides: dict | None = None) -> dict:
    pack = json.loads(_BROADCAST_POLICY_PATH.read_text(encoding="utf-8"))
    env_text = os.environ.get("WAYSTATION_BROADCAST_POLICY_OVERRIDES", "").strip()
    env_overrides = json.loads(env_text) if env_text else {}
    if not isinstance(env_overrides, dict) or (overrides is not None and not isinstance(overrides, dict)):
        raise ValueError("broadcast policy overrides must be a JSON object")
    merged_overrides = _deep_merge(copy.deepcopy(env_overrides), overrides or {})
    rules = _deep_merge(copy.deepcopy(pack["rules"]), merged_overrides, strict=True)
    effective = json.dumps(rules, sort_keys=True, separators=(",", ":"))
    rate = rules["video"]["frame_rate"]
    rate_label = f"{rate['numerator'] / rate['denominator']:.3f}".rstrip("0").rstrip(".")
    target = rules["audio"]["loudness"]
    peak = rules["audio"]["true_peak"]
    profile = {
        "name": pack["profile_name"],
        "label": pack["label"],
        "broadcast_policy": rules,
        "policy_pack": {
            "id": pack["policy_id"],
            "version": pack["version"],
            "scope": pack["scope"],
            "assumptions": pack["assumptions"],
            "source": "pipeline/policies/us_broadcast_xdcam_hd_422_v1.json",
            "sha256": hashlib.sha256(_BROADCAST_POLICY_PATH.read_bytes()).hexdigest(),
            "effective_sha256": hashlib.sha256(effective.encode()).hexdigest(),
            "overrides": merged_overrides,
        },
        # Existing analyzers consume these profile keys.
        "loudness": {"min": None, "max": None,
                     "target": target["target_lkfs"],
                     "tolerance": target["tolerance_lu"], "escalate": True},
        "true_peak": {"max": peak["max_dbtp"], "escalate": True},
        "framerates": [f"{rate_label}i"],
        "allow_vfr": False,
        "allow_pulldown": False,
        "allow_interlaced": True,
        "allow_multipart": False,
        # Signal heuristics stay advisory until calibrated against a corpus.
        "video_range": {"escalate": False},
        "pse": {"enabled": False, "escalate": False},
        "censorship": {"escalate": False},
        "photon_required": False,
    }
    return profile


def _template_profile(template_id: str, overrides: dict | None = None) -> dict:
    if not template_id.replace("_", "").isalnum():
        raise ValueError("invalid delivery template id")
    path = _DELIVERY_TEMPLATE_DIR / f"{template_id}.json"
    template = json.loads(path.read_text(encoding="utf-8"))
    if template.get("template_id") != template_id:
        raise ValueError("delivery template id does not match its filename")
    if template.get("kind") != "house_profile":
        raise ValueError("only documented house_profile templates are supported")
    if template.get("base_profile") != "us_broadcast_xdcam_hd_422_v1":
        raise ValueError("unsupported delivery template base profile")
    if overrides is not None and not isinstance(overrides, dict):
        raise ValueError("delivery template overrides must be a JSON object")
    template_overrides = template.get("policy_overrides") or {}
    if not isinstance(template_overrides, dict):
        raise ValueError("delivery template policy_overrides must be an object")
    merged = _deep_merge(copy.deepcopy(template_overrides), overrides or {})
    profile = _broadcast_profile(merged)
    profile["delivery_template"] = {
        "schema_version": template.get("schema_version"),
        "id": template_id,
        "version": template.get("version"),
        "kind": template.get("kind"),
        "label": template.get("label"),
        "scope": template.get("scope"),
        "source": f"pipeline/policies/delivery_templates/{path.name}",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "effective_policy_sha256": profile["policy_pack"]["effective_sha256"],
        "overrides": merged,
    }
    profile["label"] = str(template.get("label") or profile["label"])
    return profile


def get(name: str, overrides: dict | None = None) -> dict:
    key = str(name or "standard").lower()
    if key == "waystation_house_xdcam_hd_422_v1":
        return _template_profile(key, overrides)
    if key in ("us_broadcast_xdcam_hd_422_v1", "broadcast_xdcam"):
        return _broadcast_profile(overrides)
    return copy.deepcopy(PROFILES.get(key, PROFILES["standard"]))
