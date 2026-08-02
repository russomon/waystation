"""Bounded advisory evidence for MXF package structure and HDR/Dolby labels.

These reducers inventory facts exposed by the existing tools. They do not
claim AS-profile, HDR, or Dolby conformance and never create a hard failure.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from functools import lru_cache

from .report import policy_check
from .util import run


SCHEMA_VERSION = "waystation-deep-package-evidence/1.0"
_HDR_TRANSFERS = {"arib-std-b67", "smpte2084", "smpte-st-2084", "pq", "hlg"}


@lru_cache(maxsize=8)
def _version(tool: str) -> str | None:
    executable = shutil.which(tool)
    if not executable:
        return None
    try:
        result = run([executable, "-version"], timeout=15)
        return (result.stdout or result.stderr).splitlines()[0][:160] or None
    except Exception:
        return None


def _policy(profile: dict) -> dict:
    pack = profile.get("policy_pack") or {}
    return {
        "id": pack.get("id") or profile.get("name") or "unversioned_profile",
        "version": pack.get("version") or "unversioned",
        "profile": profile.get("name") or "unknown",
        "effective_sha256": pack.get("effective_sha256"),
    }


def _finding(name: str, status: str, detail: str, category: str, profile: dict,
             *, expected: object, observed: object, evidence: list[dict],
             method: str, not_checked: bool = False) -> dict:
    observation = {"state": "not_checked" if not_checked else "observed", "value": observed}
    return policy_check(
        name, status, detail, category, policy=_policy(profile),
        expectation={"value": expected}, observation=observation, evidence=evidence,
        provenance={"tool": "waystation+ffprobe+mediainfo", "version": {
            "ffprobe": _version("ffprobe"), "mediainfo": _version("mediainfo"),
        }, "method": method, "schema_version": SCHEMA_VERSION},
        authority="deterministic_advisory",
    )


def _format_is_mxf(meta: dict) -> bool:
    value = str((meta.get("format") or {}).get("format_name") or "").lower()
    return "mxf" in value


def _selected_tags(tags: object) -> dict:
    if not isinstance(tags, dict):
        return {}
    keep = re.compile(r"(?:umid|operational|package|timecode|company|product|generation|material)", re.I)
    return {str(key)[:120]: str(value)[:500] for key, value in list(tags.items())[:128]
            if keep.search(str(key))}


def mxf_checks(meta: dict, prior_checks: list[dict], profile: dict) -> list[dict]:
    if not _format_is_mxf(meta):
        return []
    fmt = meta.get("format") or {}
    streams = meta.get("streams") or []
    inventory = {
        "format_name": fmt.get("format_name"),
        "format_long_name": fmt.get("format_long_name"),
        "format_tags": _selected_tags(fmt.get("tags")),
        "streams": [{
            "index": stream.get("index"), "id": stream.get("id"),
            "codec_type": stream.get("codec_type"), "codec_name": stream.get("codec_name"),
            "codec_tag_string": stream.get("codec_tag_string"),
            "start_time": stream.get("start_time"), "duration": stream.get("duration"),
            "tags": _selected_tags(stream.get("tags")),
        } for stream in streams[:64]],
        "independent_sources": sorted({
            "ffprobe",
            *("mediainfo" for item in prior_checks if item.get("name") == "mediainfo_wrapper"
              and item.get("facts")),
            *("mediaconch" for item in prior_checks
              if item.get("name") == "broadcast_mediaconch_policy"
              and ((item.get("observation") or {}).get("value") or {}).get("tests")),
        }),
    }
    encoded = json.dumps(inventory, sort_keys=True, separators=(",", ":"), default=str).encode()
    findings = [_finding(
        "mxf_deep_fact_inventory", "info",
        f"bounded MXF wrapper/package inventory from {len(inventory['independent_sources'])} source(s); "
        "facts are evidence, not AS-profile conformance",
        "structural", profile,
        expected="auditable MXF wrapper, package, essence, and timeline facts",
        observed=inventory,
        evidence=[{"id": "ffprobe:mxf-format-streams", "kind": "metadata_report",
                   "sha256": hashlib.sha256(encoded).hexdigest(),
                   "hash_scope": "normalized_bounded_inventory",
                   "bounded_streams": 64}],
        method="bounded ffprobe inventory with existing MediaInfo/MediaConch source visibility",
    )]
    deferred = [
        "header/body/footer partition graph", "index-table segment integrity",
        "random-index-pack integrity", "KLV fill/alignment", "SMPTE 436 ancillary payload decode",
        "AS-10/AS-11/AS-12 application-profile rule conformance",
    ]
    findings.append(_finding(
        "mxf_deep_unsupported_facts", "info",
        "deep MXF facts not exposed by the qualified local analyzers remain not checked",
        "structural", profile,
        expected="qualified analyzer evidence for each deep MXF structure",
        observed={"not_checked": deferred},
        evidence=[{"id": "waystation:mxf-capability-boundary", "kind": "capability_disclosure"}],
        method="explicit analyzer capability boundary", not_checked=True,
    ))
    return findings


def _mediainfo_facts(prior_checks: list[dict]) -> dict:
    item = next((row for row in prior_checks if row.get("name") == "mediainfo_wrapper"), {})
    return item.get("facts") or {}


def _norm_color(field: str, value: object) -> str | None:
    if value in (None, ""):
        return None
    compact = "".join(character for character in str(value).lower() if character.isalnum())
    if field == "color_range":
        if compact in {"tv", "limited", "limitedrange", "mpeg"}:
            return "limited"
        if compact in {"pc", "full", "fullrange", "jpeg"}:
            return "full"
    aliases = {
        "bt709": "bt709", "rec709": "bt709", "bt2020nc": "bt2020nc",
        "bt2020ncl": "bt2020nc", "bt2020c": "bt2020c",
        "smpte2084": "smpte2084", "smpte2084pq": "smpte2084",
        "aribstdb67": "arib-std-b67", "hlg": "arib-std-b67",
    }
    return aliases.get(compact, compact)


def metadata_checks(meta: dict, prior_checks: list[dict], profile: dict) -> list[dict]:
    video = next((stream for stream in meta.get("streams", [])
                  if stream.get("codec_type") == "video"), {})
    audio = [stream for stream in meta.get("streams", []) if stream.get("codec_type") == "audio"]
    media = _mediainfo_facts(prior_checks)
    side_data = video.get("side_data_list") if isinstance(video.get("side_data_list"), list) else []
    ffprobe = {
        "color_transfer": video.get("color_transfer"),
        "color_primaries": video.get("color_primaries"),
        "color_space": video.get("color_space"),
        "color_range": video.get("color_range"),
        "side_data": [{str(k)[:80]: str(v)[:300] for k, v in item.items()}
                      for item in side_data[:16] if isinstance(item, dict)],
    }
    combined = " ".join(str(value).lower() for value in [
        video.get("codec_name"), video.get("codec_long_name"), video.get("profile"),
        video.get("codec_tag_string"), json.dumps(side_data, default=str),
        *(stream.get("codec_name") for stream in audio),
        *(stream.get("codec_long_name") for stream in audio),
        *(stream.get("profile") for stream in audio),
        media.get("hdr_format"), media.get("hdr_format_profile"), media.get("hdr_compatibility"),
    ] if value is not None)
    transfer = str(video.get("color_transfer") or "").lower()
    hdr_visible = transfer in _HDR_TRANSFERS or bool(media.get("hdr_format"))
    dolby_markers = sorted({marker for marker in
        ("dolby vision", "dovi", "dvhe", "dvh1", "dolby e", "atmos", "e-ac-3 joc")
        if marker in combined})
    if not (_format_is_mxf(meta) or hdr_visible or dolby_markers):
        return []

    out = [_finding(
        "hdr_metadata_discovery", "info",
        "HDR-related labels observed; compliance and display behavior are not inferred"
        if hdr_visible else "no HDR marker observed; SDR versus missing HDR metadata is not inferred",
        "structural", profile,
        expected="discover and retain observable HDR transfer, colorimetry, and static metadata labels",
        observed={"ffprobe": ffprobe, "mediainfo": {k: media.get(k) for k in (
            "color_transfer", "color_primaries", "color_space", "color_range",
            "hdr_format", "hdr_format_profile", "hdr_compatibility")},
                  "hdr_marker_observed": hdr_visible},
        evidence=[{"id": "ffprobe:hdr-stream-fields", "kind": "metadata_report"},
                  {"id": "mediainfo:hdr-fields", "kind": "metadata_report"}],
        method="metadata label discovery without bitstream conformance inference",
        not_checked=not hdr_visible,
    )]

    comparisons = []
    mismatches = []
    for ff_key, mi_key in (("color_transfer", "color_transfer"),
                           ("color_primaries", "color_primaries"),
                           ("color_space", "color_space"),
                           ("color_range", "color_range")):
        values = {"ffprobe": ffprobe.get(ff_key), "mediainfo": media.get(mi_key)}
        present = {key: _norm_color(ff_key, value) for key, value in values.items()
                   if value not in (None, "")}
        state = "not_checked" if len(present) < 2 else "agree" if len(set(present.values())) == 1 else "mismatch"
        comparison = {"field": ff_key, "values": values, "state": state}
        comparisons.append(comparison)
        if state == "mismatch":
            mismatches.append(comparison)
    comparable = any(item["state"] != "not_checked" for item in comparisons)
    out.append(_finding(
        "hdr_metadata_cross_validation", "warn" if mismatches else "info",
        f"{len(mismatches)} HDR/color metadata contradiction(s)"
        if mismatches else "cross-tool HDR/color labels agree where comparable"
        if comparable else "independent HDR/color metadata sources are incomplete",
        "structural", profile,
        expected="independent metadata sources agree where both expose a field",
        observed={"comparisons": comparisons, "mismatches": mismatches},
        evidence=[{"id": "ffprobe:hdr-stream-fields", "kind": "metadata_report"},
                  {"id": "mediainfo:hdr-fields", "kind": "metadata_report"}],
        method="normalized field-by-field metadata comparison",
        not_checked=not comparable and not mismatches,
    ))
    out.append(_finding(
        "dolby_metadata_discovery", "info",
        f"observable Dolby-related marker(s): {', '.join(dolby_markers)}; specialized conformance not checked"
        if dolby_markers else "no Dolby-related marker observed; bitstream conformance not checked",
        "structural", profile,
        expected="retain observable Dolby identifiers without claiming Dolby conformance",
        observed={"markers": dolby_markers},
        evidence=[{"id": "ffprobe:dolby-stream-markers", "kind": "metadata_report"},
                  {"id": "mediainfo:dolby-fields", "kind": "metadata_report"}],
        method="bounded stream-label marker discovery", not_checked=not dolby_markers,
    ))
    return out


def template_check(profile: dict) -> list[dict]:
    template = profile.get("delivery_template")
    if not template:
        return []
    return [_finding(
        "delivery_template_provenance", "info",
        f"selected {template['id']} v{template['version']} ({template['kind']}); "
        "house template, not a broadcaster specification",
        "policy", profile,
        expected="versioned template identity, source hash, effective policy hash, and explicit scope",
        observed=template,
        evidence=[{"id": "waystation:delivery-template", "kind": "policy_template",
                   "sha256": template.get("sha256")}],
        method="strict local template load plus versioned policy merge",
    )]
