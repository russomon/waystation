"""Versioned deterministic-finding to AI review-packet compiler."""
from __future__ import annotations

import hashlib
import json


COMPILER_VERSION = "waystation-ai-review-packet/1.0"
MAX_PACKETS = 8
MAX_EVIDENCE = 8

_QUESTIONS = {
    "broadcast_program_black": "Does the cited in-program interval appear unintentionally black?",
    "broadcast_freeze_runs": "Does the cited interval contain an unintended frozen or repeated image run?",
    "broadcast_silence_runs": "Does the cited interval contain unintended programme silence?",
    "broadcast_timestamp_continuity": "Is there a visible or audible discontinuity near the cited timestamp event?",
    "video_legal_range": "Do the cited signal excursions correspond to a visible picture defect?",
    "qctools_analytics": "Do the cited advisory measurements indicate a visible signal anomaly worth human review?",
}


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()


def _compact(value: object, depth: int = 0) -> object:
    """Bound untrusted report detail before it reaches a model payload."""
    if depth > 5:
        return "truncated"
    if isinstance(value, str):
        return value[:600]
    if isinstance(value, list):
        return [_compact(item, depth + 1) for item in value[:8]]
    if isinstance(value, dict):
        return {str(key)[:80]: _compact(item, depth + 1)
                for key, item in list(value.items())[:24]}
    return value


def _ranges(check: dict) -> list[dict]:
    ranges = []
    for evidence in check.get("evidence") or []:
        value = evidence.get("time_range")
        if isinstance(value, dict):
            ranges.append(value)
        for raw in evidence.get("time_ranges") or []:
            if isinstance(raw, (list, tuple)) and len(raw) >= 2:
                ranges.append({"start_seconds": float(raw[0]), "end_seconds": float(raw[1])})
        for event in evidence.get("events") or []:
            if isinstance(event, dict):
                ranges.append(event)
        for raw in evidence.get("windows") or []:
            if isinstance(raw, (list, tuple)) and len(raw) >= 2:
                ranges.append({"start_seconds": float(raw[0]),
                               "end_seconds": float(raw[0]) + float(raw[1])})
    if isinstance(check.get("time_range"), dict):
        ranges.append(check["time_range"])
    out = []
    for item in ranges:
        try:
            start, end = float(item["start_seconds"]), float(item["end_seconds"])
        except (KeyError, TypeError, ValueError):
            continue
        normalized = {"start_seconds": round(max(start, 0.0), 3),
                      "end_seconds": round(max(end, start), 3)}
        if normalized not in out:
            out.append(normalized)
    return out[:4]


def compile_packets(report: dict, context: dict | None = None) -> list[dict]:
    """Compile only unresolved deterministic/advisory targets; never clean passes."""
    packets = []
    context = context or {}
    for check in report.get("checks") or []:
        name = str(check.get("name") or "")
        if check.get("source", "deterministic") != "deterministic":
            continue
        if check.get("status") not in {"warn", "fail"} or name not in _QUESTIONS:
            continue
        ranges = _ranges(check)
        evidence = _compact((check.get("evidence") or [])[:MAX_EVIDENCE])
        media_requests = []
        for index, span in enumerate(ranges[:2], 1):
            midpoint = (span["start_seconds"] + span["end_seconds"]) / 2
            if name == "broadcast_silence_runs":
                media_requests.append({"id": f"audio-{index}", "type": "audio_clip",
                                       "start_seconds": max(0.0, span["start_seconds"] - 0.5),
                                       "duration_seconds": min(6.0, max(1.0, span["end_seconds"] - span["start_seconds"] + 1.0))})
            else:
                media_requests.append({"id": f"frame-{index}", "type": "still",
                                       "time_seconds": round(midpoint, 3)})
        payload = {
            "compiler_version": COMPILER_VERSION,
            "finding": _compact({k: check.get(k) for k in
                        ("name", "status", "category", "detail", "expectation", "observation", "decision")}),
            "context": _compact(context),
            "evidence": evidence,
            "time_ranges": ranges,
            "review_question": _QUESTIONS[name],
            "constraints": [
                "Advisory interpretation only.",
                "Do not change, clear, or override the deterministic delivery verdict.",
                "Describe uncertainty and cite only supplied evidence IDs and time ranges.",
                "Return not_checked when the supplied media is insufficient.",
            ],
            "media_requests": media_requests,
        }
        digest = hashlib.sha256(_canonical(payload)).hexdigest()
        packets.append({"packet_id": f"review-{digest[:16]}", "input_sha256": digest, **payload})
        if len(packets) >= MAX_PACKETS:
            break
    return packets
