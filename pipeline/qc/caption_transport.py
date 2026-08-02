"""Bounded CEA-608/708 transport visibility and continuity screening.

FFmpeg can demux several caption transports and reduce decodable text to SRT,
but that reduction does not expose every CEA-708 service or prove SMPTE 436
ANC conformance. Findings here are therefore deterministic advisories.
"""
from __future__ import annotations

import os
import subprocess
from functools import lru_cache

from .report import policy_check
from .text import parse_caption_cues


SCHEMA_VERSION = "waystation-caption-transport/1.0"
SUPPORTED_SIDECARS = {".scc": "SCC/CEA-608", ".mcc": "MCC/CEA-608/708", ".rcwt": "RCWT"}
MAX_DECODE_SECONDS = 300.0
MAX_REPORTED_EVENTS = 100


@lru_cache(maxsize=1)
def _ffmpeg_version() -> str:
    try:
        result = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    return (result.stdout.splitlines() or ["ffmpeg version unavailable"])[0][:160]


def _policy(profile: dict) -> dict:
    rules = _rules(profile)
    return {
        "id": "cea_caption_transport_baseline",
        "version": "1.0.0",
        "profile": profile.get("name", "unknown"),
        "authority": "deterministic_advisory",
        "full_cea_608_708_conformance": False,
        "smpte_436_anc_conformance": False,
        "rules": rules,
    }


def _rules(profile: dict) -> dict:
    configured = (profile.get("broadcast_policy") or {}).get("caption_transport") or {}
    return {"max_decode_seconds": float(configured.get("max_decode_seconds", MAX_DECODE_SECONDS)),
            "long_gap_advisory_seconds": float(configured.get("long_gap_advisory_seconds", 15.0)),
            "max_reported_events": int(configured.get("max_reported_events", MAX_REPORTED_EVENTS)),
            "authority": "advisory"}


def _finding(name: str, status: str, detail: str, profile: dict, expectation: object,
             observation: object, evidence: list[dict], *, not_checked: bool = False,
             time_range: dict | None = None) -> dict:
    observed = ({"state": "not_checked", "value": observation}
                if not_checked else {"state": "observed", "value": observation})
    return policy_check(
        name, status, detail, "text", policy=_policy(profile), expectation={"value": expectation},
        observation=observed, evidence=evidence,
        provenance={"tool": "ffmpeg", "tool_version": _ffmpeg_version(),
                    "adapter": SCHEMA_VERSION,
                    "bounded_seconds": _rules(profile)["max_decode_seconds"]},
        time_range=time_range, authority="deterministic_advisory")


def transport_kind(meta: dict, captions_path: str | None) -> tuple[str | None, str]:
    if captions_path:
        extension = os.path.splitext(captions_path)[1].lower()
        return extension, SUPPORTED_SIDECARS.get(extension, "text subtitle sidecar")
    subtitle_codecs = {str(stream.get("codec_name") or "").lower()
                       for stream in meta.get("streams", [])
                       if stream.get("codec_type") == "subtitle"}
    if subtitle_codecs & {"eia_608", "cea_608", "eia_708", "cea_708"}:
        return "embedded_caption_stream", ", ".join(sorted(subtitle_codecs))
    if any(int(stream.get("closed_captions", 0) or 0) > 0
           for stream in meta.get("streams", []) if stream.get("codec_type") == "video"):
        return "embedded_a53", "embedded A53 closed-caption side data"
    return None, "no CEA-608/708 transport observed"


def continuity_observation(cues: list[tuple], duration: float,
                           long_gap_seconds: float = 15.0,
                           max_reported_events: int = MAX_REPORTED_EVENTS) -> dict:
    overlaps, ordering, invalid, gaps = [], [], [], []
    for index, cue in enumerate(cues):
        start, end, _text = cue
        if end <= start or start < 0 or (duration and end > duration + 1.0):
            invalid.append({"cue": index + 1, "start_seconds": start, "end_seconds": end})
        if index:
            previous = cues[index - 1]
            if start < previous[0]:
                ordering.append({"cue": index + 1, "previous_start_seconds": previous[0],
                                 "start_seconds": start})
            if start < previous[1]:
                overlaps.append({"left_cue": index, "right_cue": index + 1,
                                 "start_seconds": start, "end_seconds": previous[1]})
            gap = start - previous[1]
            if gap >= long_gap_seconds:
                gaps.append({"left_cue": index, "right_cue": index + 1,
                             "start_seconds": previous[1], "end_seconds": start,
                             "duration_seconds": gap})
    return {"cue_count": len(cues), "invalid_events": invalid[:max_reported_events],
            "ordering_events": ordering[:max_reported_events],
            "overlap_events": overlaps[:max_reported_events],
            "long_gap_candidates": gaps[:max_reported_events],
            "event_count": len(invalid) + len(ordering) + len(overlaps) + len(gaps)}


def checks(meta: dict, captions_path: str | None, decoded_text: str | None,
           duration: float, profile: dict) -> list[dict]:
    kind, label = transport_kind(meta, captions_path)
    rules = _rules(profile)
    if kind is None or kind in {".srt", ".vtt"}:
        return [_finding(
            "caption_cea_transport_visibility", "info",
            f"{label}; CEA-608/708 transport checks not applicable",
            profile, {"supported_sidecars": sorted(SUPPORTED_SIDECARS),
                      "embedded_visibility": True},
            {"transport": kind, "label": label}, [], not_checked=True)]

    evidence = [{"id": "ffmpeg:caption-bounded-decode", "kind": "bounded_decode",
                 "transport": kind, "maximum_seconds": rules["max_decode_seconds"]}]
    out = [_finding(
        "caption_cea_transport_visibility", "info", f"observed {label}", profile,
        {"supported_sidecars": sorted(SUPPORTED_SIDECARS), "embedded_visibility": True},
        {"transport": kind, "label": label}, evidence)]
    if not decoded_text:
        out.append(_finding(
            "caption_cea_decode_integrity", "info",
            "caption transport was visible but bounded text decode was unavailable; not checked",
            profile, "bounded decode to canonical cue text", None, evidence, not_checked=True))
        out.append(_finding(
            "caption_cea_continuity", "info", "no decoded cues; continuity not checked",
            profile, {"ordering_events": 0, "overlap_events": 0}, None, evidence,
            not_checked=True))
    else:
        cues = parse_caption_cues(decoded_text)
        if not cues:
            out.append(_finding(
                "caption_cea_decode_integrity", "warn",
                "bounded transport decode returned no parseable cues", profile,
                {"parseable_cues_minimum": 1}, {"cue_count": 0}, evidence))
            out.append(_finding(
                "caption_cea_continuity", "info", "no parseable cues; continuity not checked",
                profile, {"ordering_events": 0, "overlap_events": 0}, None, evidence,
                not_checked=True))
        else:
            out.append(_finding(
                "caption_cea_decode_integrity", "info",
                f"{len(cues)} cue(s) decoded in the bounded transport sample; not full conformance",
                profile, {"parseable_cues_minimum": 1, "full_conformance": False},
                {"cue_count": len(cues)}, evidence))
            observed = continuity_observation(
                cues, duration, long_gap_seconds=rules["long_gap_advisory_seconds"],
                max_reported_events=rules["max_reported_events"])
            out.append(_finding(
                "caption_cea_continuity", "warn" if observed["event_count"] else "info",
                f"{observed['event_count']} ordering/overlap/gap/invalid candidate event(s); advisory",
                profile, {"ordering_events": 0, "overlap_events": 0,
                          "invalid_events": 0, "long_gap_candidates": 0},
                observed, [{**evidence[0], "events": [
                    *observed["invalid_events"], *observed["ordering_events"],
                    *observed["overlap_events"], *observed["long_gap_candidates"]]}],
                time_range={"start_seconds": min(cue[0] for cue in cues),
                            "end_seconds": max(cue[1] for cue in cues)}))
    out.append(_finding(
        "caption_cea_service_visibility", "info",
        "service numbers, 708 windows, and SMPTE 436 ANC structure are not preserved by this decode; not checked",
        profile, "service and ANC conformance from a qualified analyzer", None, evidence,
        not_checked=True))
    return out
