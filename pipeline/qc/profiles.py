"""QC profiles. A profile decides which checks run, their thresholds, and
whether a violation escalates to a hard failure (BLOCKER) or stays a
review-level warning (ISSUE).

"standard" is Waystation's default lane — permissive thresholds, nothing
blocks. "netflix" is the strict single-toggle profile: the verbatim
constraint block below is enforced wherever our toolchain can genuinely
measure it, and surfaced as an explicit FYI finding where it can't
(Photon without a JVM, Dolby Vision canvas tracking without dovi_tool)."""
from __future__ import annotations

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
        "pse_compliance_standard": "ITU-R_BT_1702-2_2023",
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
        "heal": {"target_i": -23.0, "target_tp": -1.5},
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
        "pse": {"enabled": True, "escalate": True},   # Rule 7
        "censorship": {"escalate": True},             # Rule 3
        "photon_required": True,                      # Rule 4
        "heal": {"target_i": -24.0, "target_tp": -2.0},
    },
}


def get(name: str) -> dict:
    return PROFILES.get(str(name or "standard").lower(), PROFILES["standard"])
