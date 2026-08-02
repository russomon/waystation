"""Versioned deterministic-finding to AI review-packet compiler."""
from __future__ import annotations

import hashlib
import json
import math


COMPILER_VERSION = "waystation-ai-review-packet/1.1"
MAX_PACKETS = 8
MAX_EVIDENCE = 8
MAX_PACKET_BYTES = 16_000

_QUESTIONS = {
    "broadcast_program_black": "Does the cited in-program interval appear unintentionally black?",
    "broadcast_freeze_runs": "Does the cited interval contain an unintended frozen or repeated image run?",
    "broadcast_silence_runs": "Does the cited interval contain unintended programme silence?",
    "broadcast_timestamp_continuity": "Is there a visible or audible discontinuity near the cited timestamp event?",
    "video_legal_range": "Do the cited signal excursions correspond to a visible picture defect?",
    "qctools_analytics": "Do the cited advisory measurements indicate a visible signal anomaly worth human review?",
    "qctools_signal_anomalies": "Do the cited QCTools candidates correspond to a visible signal defect?",
    "broadcast_blockiness": "Does the cited sample show objectionable macroblocking or mosquito noise?",
    "broadcast_blur": "Does the cited sample show unintended loss of focus or sharpness?",
    "broadcast_banding": "Does the cited sample show visible banding or contouring?",
    "broadcast_temporal_outliers": "Does the cited sample show a visible temporal discontinuity or repeated-region defect?",
    "broadcast_active_picture_layout": "Does the cited sample show unintended crop, matte, or active-picture layout?",
    "broadcast_audio_phase": "Does the cited audio exhibit an audible phase or polarity problem?",
    "broadcast_audio_clipping": "Does the cited audio contain audible clipping distortion?",
    "broadcast_audio_clicks_pops": "Does the cited audio contain a click, pop, or impulse defect?",
    "broadcast_audio_dropouts": "Does the cited audio contain an unintended dropout?",
    "broadcast_audio_channel_consistency": "Does the cited audio show an unintended missing or imbalanced channel?",
    "broadcast_caption_continuity": "Do the cited caption events represent unintended overlaps, ordering errors, or long gaps?",
    "broadcast_metadata_cross_validation": "Does the cited cross-tool metadata contradiction require delivery review?",
    "hdr_metadata_cross_validation": "Does the cited HDR/color metadata contradiction indicate a visible presentation risk?",
}

_AUDIO_FINDINGS = {
    "broadcast_silence_runs", "broadcast_audio_phase", "broadcast_audio_clipping",
    "broadcast_audio_clicks_pops", "broadcast_audio_dropouts",
    "broadcast_audio_channel_consistency",
}

_NO_MEDIA_FINDINGS = {"broadcast_metadata_cross_validation", "hdr_metadata_cross_validation"}


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()


def _packet_payload(packet: dict) -> dict:
    return {key: value for key, value in packet.items()
            if key not in {"packet_id", "input_sha256"}}


def packet_hash(packet: dict) -> str:
    return hashlib.sha256(_canonical(_packet_payload(packet))).hexdigest()


def validate_packet(packet: object) -> bool:
    if not isinstance(packet, dict) or packet.get("compiler_version") != COMPILER_VERSION:
        return False
    digest = packet.get("input_sha256")
    if not isinstance(digest, str) or digest != packet_hash(packet):
        return False
    if packet.get("packet_id") != f"review-{digest[:16]}":
        return False
    if len(_canonical(packet)) > MAX_PACKET_BYTES:
        return False
    finding = packet.get("finding")
    if not isinstance(finding, dict) or finding.get("name") not in _QUESTIONS:
        return False
    requests = packet.get("media_requests")
    if not isinstance(requests, list) or len(requests) > 2:
        return False
    for request in requests:
        if not isinstance(request, dict) or request.get("type") not in {"still", "audio_clip"}:
            return False
        try:
            if request["type"] == "audio_clip":
                duration = float(request.get("duration_seconds", 0))
                start = float(request.get("start_seconds", -1))
                if not (math.isfinite(duration) and math.isfinite(start)
                        and 0 < duration <= 6.0 and start >= 0):
                    return False
            if request["type"] == "still":
                at = float(request.get("time_seconds"))
                if not math.isfinite(at) or at < 0:
                    return False
        except (TypeError, ValueError):
            return False
    return True


def _compact(value: object, depth: int = 0) -> object:
    """Bound untrusted report detail before it reaches a model payload."""
    if depth > 5:
        return "truncated"
    if isinstance(value, str):
        return value[:600]
    if isinstance(value, float) and not math.isfinite(value):
        return "nonfinite"
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
    policy_context = _compact({key: context.get(key) for key in
                               ("profile", "policy", "delivery_template", "duration_seconds")
                               if context.get(key) is not None})
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
            if name in _NO_MEDIA_FINDINGS:
                continue
            if name in _AUDIO_FINDINGS:
                media_requests.append({"id": f"audio-{index}", "type": "audio_clip",
                                       "start_seconds": max(0.0, span["start_seconds"] - 0.5),
                                       "duration_seconds": min(6.0, max(1.0, span["end_seconds"] - span["start_seconds"] + 1.0))})
            else:
                media_requests.append({"id": f"frame-{index}", "type": "still",
                                       "time_seconds": round(midpoint, 3)})
        payload = {
            "compiler_version": COMPILER_VERSION,
            "packet_type": "targeted_advisory_review",
            "finding": _compact({k: check.get(k) for k in
                        ("name", "status", "category", "detail", "expectation", "observation", "decision", "policy")}),
            "policy_context": policy_context,
            "evidence": evidence,
            "time_ranges": ranges,
            "review_question": _QUESTIONS[name],
            "constraints": [
                "Advisory interpretation only.",
                "Do not change, clear, or override the deterministic delivery verdict.",
                "Describe uncertainty and cite only supplied evidence IDs and time ranges.",
                "Return not_checked when the supplied media is insufficient.",
                "Do not infer compliance, acceptance, intent, or missing evidence.",
            ],
            "media_requests": media_requests,
            "authority": {"lane": "ai_advisory", "canonical_report_mutable": False,
                          "deterministic_delivery_outcome_unchanged": True},
        }
        digest = hashlib.sha256(_canonical(payload)).hexdigest()
        packet = {"packet_id": f"review-{digest[:16]}", "input_sha256": digest, **payload}
        if validate_packet(packet):
            packets.append(packet)
        if len(packets) >= MAX_PACKETS:
            break
    return packets
