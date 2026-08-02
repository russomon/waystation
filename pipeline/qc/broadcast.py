"""Deterministic U.S. broadcast XDCAM HD 4:2:2 baseline checks.

This is a versioned Waystation house baseline, not a claim of universal U.S.
network acceptance. Reducers keep observations separate from policy decisions.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import statistics
import xml.etree.ElementTree as ET
from functools import lru_cache

from . import audio as qaudio
from .report import policy_check
from .util import parse_fraction, run


PROFILE_NAME = "us_broadcast_xdcam_hd_422_v1"


def active(profile: dict) -> bool:
    return profile.get("name") == PROFILE_NAME


def _policy_ref(profile: dict) -> dict:
    pack = profile["policy_pack"]
    return {
        "id": pack["id"],
        "version": pack["version"],
        "effective_sha256": pack["effective_sha256"],
    }


@lru_cache(maxsize=None)
def _tool_version(tool: str, args: tuple[str, ...]) -> str:
    executable = shutil.which(tool)
    if not executable:
        return "unavailable"
    result = run([executable, *args], timeout=10)
    output = "\n".join(filter(None, [result.stdout, result.stderr]))
    return next((line.strip() for line in output.splitlines() if line.strip()), "unknown")[:240]


def _prov(tool: str, method: str, *, version_args: tuple[str, ...] = ("-version",)) -> dict:
    return {"tool": tool, "version": _tool_version(tool, version_args), "method": method}


def _finding(name: str, status: str, detail: str, category: str, profile: dict, *,
             expected: object, observed: object, evidence: list[dict],
             provenance: dict, time_range: dict | None = None,
             advisory: bool = False, not_checked: bool = False) -> dict:
    observation = {"value": observed}
    if not_checked:
        observation["state"] = "not_checked"
    return policy_check(
        name, status, detail, category,
        policy=_policy_ref(profile),
        expectation={"value": expected},
        observation=observation,
        evidence=evidence,
        provenance=provenance,
        time_range=time_range,
        authority="deterministic_advisory" if advisory else None,
    )


def policy_disclosure(profile: dict) -> list[dict]:
    pack = profile["policy_pack"]
    return [_finding(
        "broadcast_policy_scope", "info",
        f"{profile['label']}; {pack['scope']}", "policy", profile,
        expected="apply only the documented baseline assumptions",
        observed={"assumptions": pack["assumptions"], "overrides": pack["overrides"]},
        evidence=[{"id": "policy:pack", "kind": "policy_pack", "source": pack["source"],
                   "sha256": pack["sha256"]}],
        provenance={"tool": "waystation", "method": "versioned policy load"},
        advisory=True,
    )]


def metadata_checks(meta: dict, profile: dict) -> list[dict]:
    """Pure reducers over the ffprobe document: wrapper, streams, and metadata."""
    rules = profile["broadcast_policy"]
    fmt = meta.get("format") or {}
    streams = meta.get("streams") or []
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    tags = fmt.get("tags") or {}
    out = policy_disclosure(profile)
    probe = _prov("ffprobe", "-show_format -show_streams JSON")

    wrapper = rules["wrapper"]
    format_names = set(str(fmt.get("format_name") or "").lower().split(","))
    wrapper_ok = bool(format_names.intersection(wrapper["format_names"]))
    out.append(_finding(
        "broadcast_wrapper", "pass" if wrapper_ok else "fail",
        f"ffprobe format {fmt.get('format_name') or 'unknown'}; expected MXF", "structural", profile,
        expected=wrapper["format_names"], observed=sorted(format_names),
        evidence=[{"id": "ffprobe:format", "kind": "probe_field", "field": "format.format_name"}],
        provenance=probe,
    ))

    actual_ul = str(tags.get("operational_pattern_ul") or "").lower()
    op_ok = actual_ul.replace("0x", "") == wrapper["op1a_ul"].lower()
    out.append(_finding(
        "broadcast_mxf_op1a", "pass" if op_ok else "fail",
        f"operational pattern UL {actual_ul or 'missing'}; expected OP1a", "structural", profile,
        expected=wrapper["op1a_ul"], observed=actual_ul or None,
        evidence=[{"id": "ffprobe:op-ul", "kind": "probe_field",
                   "field": "format.tags.operational_pattern_ul"}],
        provenance=probe,
    ))

    min_video = int(rules["video"]["min_tracks"])
    out.append(_finding(
        "broadcast_video_tracks", "pass" if len(videos) >= min_video else "fail",
        f"{len(videos)} video track(s); minimum {min_video}", "structural", profile,
        expected={"minimum": min_video}, observed=len(videos),
        evidence=[{"id": "ffprobe:streams", "kind": "probe_collection", "field": "streams"}],
        provenance=probe,
    ))
    min_audio = int(rules["audio"]["min_tracks"])
    out.append(_finding(
        "broadcast_audio_tracks", "pass" if len(audios) >= min_audio else "fail",
        f"{len(audios)} audio track(s); minimum {min_audio}", "audio", profile,
        expected={"minimum": min_audio}, observed=len(audios),
        evidence=[{"id": "ffprobe:streams", "kind": "probe_collection", "field": "streams"}],
        provenance=probe,
    ))

    if videos:
        video = videos[0]
        vrules = rules["video"]
        codec_observed = {"codec": video.get("codec_name"), "profile": video.get("profile")}
        codec_ok = (video.get("codec_name") in vrules["codec_names"]
                    and video.get("profile") in vrules["profiles"])
        out.append(_finding(
            "broadcast_video_codec_profile", "pass" if codec_ok else "fail",
            f"{video.get('codec_name') or 'unknown'} / {video.get('profile') or 'unknown'}", "structural", profile,
            expected={"codecs": vrules["codec_names"], "profiles": vrules["profiles"]},
            observed=codec_observed,
            evidence=[{"id": "ffprobe:video-0-codec", "kind": "probe_fields",
                       "fields": ["streams[video:0].codec_name", "streams[video:0].profile"]}],
            provenance=probe,
        ))

        rate = vrules["frame_rate"]
        expected_rate = (int(rate["numerator"]), int(rate["denominator"]))
        avg_rate = parse_fraction(str(video.get("avg_frame_rate") or ""))
        real_rate = parse_fraction(str(video.get("r_frame_rate") or ""))
        rate_ok = avg_rate == expected_rate and real_rate == expected_rate
        out.append(_finding(
            "broadcast_frame_rate", "pass" if rate_ok else "fail",
            f"average {avg_rate[0]}/{avg_rate[1]}, declared {real_rate[0]}/{real_rate[1]}",
            "structural", profile,
            expected={"numerator": expected_rate[0], "denominator": expected_rate[1]},
            observed={"average": list(avg_rate), "declared": list(real_rate)},
            evidence=[{"id": "ffprobe:video-0-rate", "kind": "probe_fields",
                       "fields": ["avg_frame_rate", "r_frame_rate"]}], provenance=probe,
        ))

        raster = {"width": int(video.get("width", 0) or 0),
                  "height": int(video.get("height", 0) or 0)}
        raster_ok = raster == vrules["raster"]
        out.append(_finding(
            "broadcast_raster", "pass" if raster_ok else "fail",
            f"{raster['width']}x{raster['height']}", "structural", profile,
            expected=vrules["raster"], observed=raster,
            evidence=[{"id": "ffprobe:video-0-raster", "kind": "probe_fields",
                       "fields": ["width", "height"]}], provenance=probe,
        ))

        field_order = str(video.get("field_order") or "unknown").lower()
        scan_ok = field_order in vrules["field_orders"]
        out.append(_finding(
            "broadcast_scan_field_order", "pass" if scan_ok else "fail",
            f"field order {field_order}", "structural", profile,
            expected=vrules["field_orders"], observed=field_order,
            evidence=[{"id": "ffprobe:video-0-scan", "kind": "probe_field", "field": "field_order"}],
            provenance=probe,
        ))

        pix_fmt = str(video.get("pix_fmt") or "")
        bits = int(video.get("bits_per_raw_sample") or video.get("bits_per_sample") or
                   (10 if "10" in pix_fmt else 8 if pix_fmt else 0))
        pixel_ok = pix_fmt in vrules["pixel_formats"] and bits == int(vrules["bit_depth"])
        out.append(_finding(
            "broadcast_bit_depth_chroma", "pass" if pixel_ok else "fail",
            f"pixel format {pix_fmt or 'unknown'}, {bits or 'unknown'}-bit", "signal", profile,
            expected={"pixel_formats": vrules["pixel_formats"], "bit_depth": vrules["bit_depth"]},
            observed={"pixel_format": pix_fmt or None, "bit_depth": bits or None},
            evidence=[{"id": "ffprobe:video-0-pixel", "kind": "probe_fields",
                       "fields": ["pix_fmt", "bits_per_raw_sample", "bits_per_sample"]}],
            provenance=probe,
        ))

        rate_value = int(video.get("bit_rate", 0) or 0)
        target = int(vrules["bit_rate"]["target"])
        tolerance = int(vrules["bit_rate"]["tolerance"])
        if rate_value:
            bitrate_ok = abs(rate_value - target) <= tolerance
            out.append(_finding(
                "broadcast_video_bitrate", "pass" if bitrate_ok else "fail",
                f"{rate_value} b/s; target {target} +/-{tolerance}", "signal", profile,
                expected={"target": target, "tolerance": tolerance}, observed=rate_value,
                evidence=[{"id": "ffprobe:video-0-bitrate", "kind": "probe_field", "field": "bit_rate"}],
                provenance=probe,
            ))
        else:
            out.append(_finding(
                "broadcast_video_bitrate", "info", "bitrate not reported; policy value not checked",
                "signal", profile, expected={"target": target, "tolerance": tolerance}, observed=None,
                evidence=[{"id": "ffprobe:video-0-bitrate", "kind": "probe_field", "field": "bit_rate"}],
                provenance=probe, not_checked=True,
            ))

    if audios:
        arules = rules["audio"]
        total_channels = sum(int(a.get("channels", 0) or 0) for a in audios)
        layout_ok = total_channels == int(arules["total_channels"])
        out.append(_finding(
            "broadcast_audio_layout", "pass" if layout_ok else "fail",
            f"{len(audios)} track(s), {total_channels} total channel(s)", "audio", profile,
            expected={"tracks_min": arules["min_tracks"], "total_channels": arules["total_channels"]},
            observed={"tracks": len(audios), "total_channels": total_channels,
                      "layouts": [a.get("channel_layout") for a in audios]},
            evidence=[{"id": "ffprobe:audio-layout", "kind": "probe_fields",
                       "fields": ["channels", "channel_layout"]}], provenance=probe,
        ))
        audio_values = [{"codec": a.get("codec_name"),
                         "sample_rate": int(a.get("sample_rate", 0) or 0),
                         "bit_depth": int(a.get("bits_per_raw_sample") or a.get("bits_per_sample") or 0)}
                        for a in audios]
        audio_ok = all(v["codec"] in arules["codecs"]
                       and v["sample_rate"] == int(arules["sample_rate"])
                       and v["bit_depth"] == int(arules["bit_depth"])
                       for v in audio_values)
        out.append(_finding(
            "broadcast_audio_format", "pass" if audio_ok else "fail",
            "; ".join(f"{v['codec']} {v['sample_rate']} Hz {v['bit_depth']}-bit" for v in audio_values),
            "audio", profile,
            expected={"codecs": arules["codecs"], "sample_rate": arules["sample_rate"],
                      "bit_depth": arules["bit_depth"]}, observed=audio_values,
            evidence=[{"id": "ffprobe:audio-format", "kind": "probe_fields",
                       "fields": ["codec_name", "sample_rate", "bits_per_raw_sample"]}], provenance=probe,
        ))

    required = rules["wrapper"]["required_metadata_tags"]
    observed_metadata = {key: tags.get(key) for key in required}
    missing = [key for key, value in observed_metadata.items() if not value]
    out.append(_finding(
        "broadcast_required_metadata", "pass" if not missing else "fail",
        "required MXF metadata present" if not missing else f"missing: {', '.join(missing)}",
        "structural", profile, expected={"required_tags": required}, observed=observed_metadata,
        evidence=[{"id": "ffprobe:mxf-tags", "kind": "probe_fields",
                   "fields": [f"format.tags.{key}" for key in required]}], provenance=probe,
    ))

    format_duration = _float(fmt.get("duration"))
    stream_durations = [_float(s.get("duration")) for s in videos + audios]
    measured = [d for d in stream_durations if d is not None]
    tolerance = float(rules["video"]["duration_tolerance_seconds"])
    if format_duration is None or not measured:
        out.append(_finding(
            "broadcast_duration_consistency", "info", "duration values unavailable; not checked",
            "structural", profile, expected={"max_delta_seconds": tolerance},
            observed={"format": format_duration, "streams": stream_durations},
            evidence=[{"id": "ffprobe:durations", "kind": "probe_fields",
                       "fields": ["format.duration", "streams[].duration"]}], provenance=probe,
            not_checked=True,
        ))
    else:
        max_delta = max(abs(format_duration - d) for d in measured)
        out.append(_finding(
            "broadcast_duration_consistency", "pass" if max_delta <= tolerance else "fail",
            f"maximum wrapper/stream duration delta {max_delta:.3f}s", "structural", profile,
            expected={"max_delta_seconds": tolerance},
            observed={"format": format_duration, "streams": stream_durations,
                      "max_delta_seconds": round(max_delta, 6)},
            evidence=[{"id": "ffprobe:durations", "kind": "probe_fields",
                       "fields": ["format.duration", "streams[].duration"]}], provenance=probe,
        ))
    return out


def _float(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def timestamp_gop_from_frames(frames: list[dict], profile: dict) -> list[dict]:
    """Pure timestamp/GOP reducers; ffprobe collection is kept separate."""
    vrules = profile["broadcast_policy"]["video"]
    timestamps = []
    key_indices = []
    for index, frame in enumerate(frames):
        value = frame.get("best_effort_timestamp_time", frame.get("pkt_dts_time"))
        parsed = _float(value)
        if parsed is not None:
            timestamps.append(parsed)
        if int(frame.get("key_frame", 0) or 0) == 1 or frame.get("pict_type") == "I":
            key_indices.append(index)
    probe = _prov("ffprobe", "bounded frame timestamp/key-frame scan")
    evidence = [{"id": "ffprobe:frame-scan", "kind": "frame_probe",
                 "sampled_frames": len(frames), "configured_limit": vrules["gop"]["scan_frames"]}]
    out = []
    if len(timestamps) < 2:
        out.append(_finding(
            "broadcast_timestamp_continuity", "info", "fewer than two timestamps; not checked",
            "structural", profile, expected="monotonic timestamps without large gaps",
            observed=timestamps, evidence=evidence, provenance=probe, not_checked=True,
        ))
    else:
        deltas = [b - a for a, b in zip(timestamps, timestamps[1:])]
        positives = [d for d in deltas if d > 0]
        median = statistics.median(positives) if positives else 0.0
        backwards = sum(1 for d in deltas if d < 0)
        gap_mult = float(vrules["timestamp_gap_multiplier"])
        gaps = sum(1 for d in deltas if median and d > gap_mult * median)
        ok = backwards == 0 and gaps == 0
        out.append(_finding(
            "broadcast_timestamp_continuity", "pass" if ok else "fail",
            f"{len(timestamps)} timestamps; {backwards} backwards, {gaps} gap(s)",
            "structural", profile,
            expected={"backwards": 0, "gaps": 0, "gap_multiplier": gap_mult},
            observed={"count": len(timestamps), "backwards": backwards, "gaps": gaps,
                      "median_delta": median}, evidence=evidence, provenance=probe,
            time_range={"start_seconds": timestamps[0], "end_seconds": timestamps[-1]},
        ))
    distances = [b - a for a, b in zip(key_indices, key_indices[1:])]
    max_allowed = int(vrules["gop"]["max_frames"])
    if not distances:
        out.append(_finding(
            "broadcast_gop", "info", "fewer than two key frames in bounded scan; not checked",
            "structural", profile, expected={"max_frames": max_allowed},
            observed={"key_frame_indices": key_indices}, evidence=evidence, provenance=probe,
            not_checked=True,
        ))
    else:
        max_observed = max(distances)
        out.append(_finding(
            "broadcast_gop", "pass" if max_observed <= max_allowed else "fail",
            f"maximum sampled GOP {max_observed} frames; limit {max_allowed}",
            "structural", profile, expected={"max_frames": max_allowed},
            observed={"max_frames": max_observed, "distances": distances[:120]},
            evidence=evidence, provenance=probe,
            time_range={"start_seconds": timestamps[0], "end_seconds": timestamps[-1]}
            if timestamps else None,
        ))
    return out


def timestamp_gop_checks(src: str, profile: dict) -> list[dict]:
    limit = int(profile["broadcast_policy"]["video"]["gop"]["scan_frames"])
    result = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "frame=key_frame,pict_type,best_effort_timestamp_time,pkt_dts_time",
        "-of", "json", "-read_intervals", f"%+#{limit}", src,
    ])
    if result.returncode != 0:
        return [_finding(
            "broadcast_timestamp_gop_probe", "warn",
            f"ffprobe frame scan failed: {(result.stderr or 'unknown error').strip()[:160]}",
            "engine", profile, expected="bounded frame scan", observed={"returncode": result.returncode},
            evidence=[], provenance=_prov("ffprobe", "bounded frame timestamp/key-frame scan"),
            advisory=True,
        )]
    try:
        frames = json.loads(result.stdout or "{}").get("frames") or []
    except json.JSONDecodeError as exc:
        return [_finding(
            "broadcast_timestamp_gop_probe", "warn", f"ffprobe JSON parse failed: {exc}",
            "engine", profile, expected="valid frame JSON", observed=None, evidence=[],
            provenance=_prov("ffprobe", "bounded frame timestamp/key-frame scan"), advisory=True,
        )]
    return timestamp_gop_from_frames(frames, profile)


def signal_segment_checks(segments: dict, duration: float, profile: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["signal"]
    blacks = [tuple(map(float, x)) for x in segments.get("black", [])]
    freezes = [tuple(map(float, x)) for x in segments.get("freeze", [])]
    silences = [tuple(map(float, x)) for x in segments.get("silence", [])]
    prov = _prov("ffmpeg", "blackdetect/freezedetect/silencedetect")
    out = []
    head = next(((a, b) for a, b in blacks if a <= 0.25), None)
    tail = next(((a, b) for a, b in reversed(blacks) if duration and b >= duration - 0.25), None)
    for name, segment, spec in (
        ("broadcast_black_head", head, rules["black_head"]),
        ("broadcast_black_tail", tail, rules["black_tail"]),
    ):
        measured = (segment[1] - segment[0]) if segment else 0.0
        tolerance = float(rules.get("boundary_detection_tolerance_seconds", 0.0))
        ok = (float(spec["min_seconds"]) - tolerance <= measured
              <= float(spec["max_seconds"]) + tolerance)
        out.append(_finding(
            name, "pass" if ok else "fail",
            f"{measured:.3f}s detected; expected {spec['min_seconds']}..{spec['max_seconds']}s",
            "signal", profile,
            expected={**spec, "detection_tolerance_seconds": tolerance},
            observed={"duration_seconds": measured},
            evidence=[{"id": f"ffmpeg:{name}", "kind": "detected_segment",
                       "time_range": list(segment) if segment else None}], provenance=prov,
            time_range={"start_seconds": segment[0], "end_seconds": segment[1]} if segment else None,
        ))
    boundary_ids = {head, tail}
    unexpected = [(a, b) for a, b in blacks if (a, b) not in boundary_ids
                  and b - a >= float(rules["unexpected_black_min_seconds"])]
    out.append(_finding(
        "broadcast_program_black", "warn" if unexpected else "pass",
        f"{len(unexpected)} unexpected programme black segment(s)", "signal", profile,
        expected={"unexpected_segments": 0}, observed=[list(x) for x in unexpected],
        evidence=[{"id": "ffmpeg:blackdetect", "kind": "detected_segments",
                   "time_ranges": [list(x) for x in unexpected]}], provenance=prov, advisory=True,
    ))
    long_freezes = [(a, b) for a, b in freezes if b - a >= float(rules["freeze_min_seconds"])]
    out.append(_finding(
        "broadcast_freeze_runs", "warn" if long_freezes else "pass",
        f"{len(long_freezes)} freeze run(s) at least {rules['freeze_min_seconds']}s", "signal", profile,
        expected={"runs": 0, "minimum_reported_seconds": rules["freeze_min_seconds"]},
        observed=[list(x) for x in long_freezes],
        evidence=[{"id": "ffmpeg:freezedetect", "kind": "detected_segments",
                   "time_ranges": [list(x) for x in long_freezes]}], provenance=prov, advisory=True,
    ))
    long_silences = [(a, b) for a, b in silences if b - a >= float(rules["silence_min_seconds"])]
    out.append(_finding(
        "broadcast_silence_runs", "warn" if long_silences else "pass",
        f"{len(long_silences)} silence run(s) at least {rules['silence_min_seconds']}s", "audio", profile,
        expected={"runs": 0, "minimum_reported_seconds": rules["silence_min_seconds"]},
        observed=[list(x) for x in long_silences],
        evidence=[{"id": "ffmpeg:silencedetect", "kind": "detected_segments",
                   "time_ranges": [list(x) for x in long_silences]}], provenance=prov, advisory=True,
    ))
    return out


def decode_finding(error_lines: list[str], profile: dict) -> dict:
    return _finding(
        "broadcast_full_decode", "pass" if not error_lines else "fail",
        f"full decode produced {len(error_lines)} error line(s)"
        + (f"; first: {error_lines[0][:120]}" if error_lines else ""),
        "signal", profile, expected={"decode_error_lines": 0},
        observed={"decode_error_lines": len(error_lines),
                  "first_error": error_lines[0][:240] if error_lines else None},
        evidence=[{"id": "ffmpeg:full-decode", "kind": "full_program_decode",
                   "error_lines": len(error_lines)}],
        provenance=_prov("ffmpeg", "full decode to null sink"),
    )


def audio_measurement_checks(measurement: dict, profile: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["audio"]
    loud = rules["loudness"]
    peak = rules["true_peak"]
    prov = _prov("ffmpeg", "ebur128=peak=true full-program measurement")
    out = []
    integrated = measurement.get("i")
    if integrated is None:
        out.append(_finding(
            "broadcast_loudness", "info", "integrated loudness unavailable; not checked",
            "audio", profile, expected=loud, observed=None,
            evidence=[{"id": "ffmpeg:ebur128", "kind": "measurement", "metric": "integrated_lkfs"}],
            provenance=prov, not_checked=True,
        ))
    else:
        drift = abs(float(integrated) - float(loud["target_lkfs"]))
        out.append(_finding(
            "broadcast_loudness", "pass" if drift <= float(loud["tolerance_lu"]) else "fail",
            f"integrated {integrated} LKFS; target {loud['target_lkfs']} +/-{loud['tolerance_lu']} LU",
            "audio", profile, expected=loud, observed={"integrated_lkfs": integrated, "drift_lu": drift},
            evidence=[{"id": "ffmpeg:ebur128", "kind": "measurement", "metric": "integrated_lkfs"}],
            provenance=prov,
        ))
    true_peak = measurement.get("tp")
    if true_peak is None:
        out.append(_finding(
            "broadcast_true_peak", "info", "true peak unavailable; not checked", "audio", profile,
            expected=peak, observed=None,
            evidence=[{"id": "ffmpeg:ebur128", "kind": "measurement", "metric": "true_peak_dbtp"}],
            provenance=prov, not_checked=True,
        ))
    else:
        out.append(_finding(
            "broadcast_true_peak", "pass" if float(true_peak) <= float(peak["max_dbtp"]) else "fail",
            f"true peak {true_peak} dBTP; maximum {peak['max_dbtp']} dBTP", "audio", profile,
            expected=peak, observed={"true_peak_dbtp": true_peak},
            evidence=[{"id": "ffmpeg:ebur128", "kind": "measurement", "metric": "true_peak_dbtp"}],
            provenance=prov,
        ))
    return out


def audio_checks(src: str, profile: dict) -> list[dict]:
    return audio_measurement_checks(qaudio.measure_loudness(src), profile)


def caption_presence_check(present: bool, source: str, profile: dict,
                           checked: bool = True) -> list[dict]:
    required = bool(profile["broadcast_policy"]["captions"]["required"])
    if not checked:
        return [_finding(
            "broadcast_captions_present", "info",
            "caption QC disabled by sender; baseline requirement not checked",
            "text", profile, expected={"required": required}, observed=None,
            evidence=[{"id": "delivery:caption-discovery", "kind": "service_toggle"}],
            provenance={"tool": "waystation", "method": "sender service selection"},
            not_checked=True,
        )]
    ok = present or not required
    return [_finding(
        "broadcast_captions_present", "pass" if ok else "fail",
        f"caption source: {source}" if present else "no embedded caption stream or SRT/VTT sidecar",
        "text", profile, expected={"required": required},
        observed={"present": present, "source": source if present else None},
        evidence=[{"id": "delivery:caption-discovery", "kind": "sidecar_or_stream_inventory"}],
        provenance={"tool": "waystation", "method": "embedded stream + sidecar discovery"},
    )]


def legal_range_finding(profile: dict, status: str, detail: str, facts: dict,
                        windows: list, analyzed_seconds: float) -> dict:
    """Attach auditable signalstats evidence without granting hard-reject authority."""
    return _finding(
        "video_legal_range", status, detail, "signal", profile,
        expected={"y_transient_codes_8bit": [5, 246],
                  "chroma_transient_codes_8bit": [5, 251],
                  "maximum_out_of_tolerance_fraction": 0.001},
        observed=facts,
        evidence=[{"id": "ffmpeg:signalstats-legal-range", "kind": "tiled_measurement",
                   "windows": [[float(start), float(length)] for start, length in windows],
                   "analyzed_seconds": analyzed_seconds}],
        provenance=_prov("ffmpeg", "tiled signalstats + explicit violation mask"),
        advisory=True,
    )


def mediaconch_policy_checks(src: str, profile: dict) -> list[dict]:
    """Apply the v1 policy reducer to MediaConch's MAXML metadata facts.

    MediaConch's implementation checker is strongest for Matroska/FFV1/LPCM,
    so MXF use is deliberately limited to MediaInfo-backed metadata fields.
    """
    executable = shutil.which("mediaconch")
    prov = _prov("mediaconch", "MAXML metadata + Waystation v1 pure policy reducer",
                 version_args=("--Version",))
    expected = {"policy": profile["policy_pack"]["id"], "outcome": "pass"}
    if not executable:
        return [_finding(
            "broadcast_mediaconch_policy", "info", "MediaConch unavailable; policy not checked",
            "structural", profile, expected=expected, observed=None, evidence=[], provenance=prov,
            not_checked=True,
        )]
    if profile["policy_pack"]["overrides"]:
        return [_finding(
            "broadcast_mediaconch_policy", "info",
            "effective policy has overrides; fixed MediaConch metadata assertions intentionally not applied",
            "structural", profile, expected=expected,
            observed={"overrides": profile["policy_pack"]["overrides"]}, evidence=[], provenance=prov,
            not_checked=True,
        )]
    result = run([executable, "--Mediainfo", "--Format=maxml", "--Full", src], timeout=900)
    raw = result.stdout or ""
    digest = hashlib.sha256(raw.encode()).hexdigest()
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return [_finding(
            "broadcast_mediaconch_policy", "warn",
            f"MediaConch MAXML unavailable: {str(exc)[:140]}; media not cleared by this tool",
            "structural", profile, expected=expected,
            observed={"returncode": result.returncode, "stderr": result.stderr.strip()[:160]},
            evidence=[{"id": "mediaconch:maxml", "kind": "metadata_report",
                       "sha256": digest}], provenance=prov, advisory=True,
        )]
    tracks: dict[str, list[dict[str, str]]] = {}
    for elem in root.iter():
        if elem.tag.split("}")[-1] != "track":
            continue
        kind = elem.attrib.get("type", "")
        values = {child.tag.split("}")[-1]: (child.text or "").strip()
                  for child in elem if child.text is not None}
        tracks.setdefault(kind, []).append(values)
    general = (tracks.get("General") or [{}])[0]
    video = (tracks.get("Video") or [{}])[0]
    audio = (tracks.get("Audio") or [{}])[0]
    assertions = [
        ("General format is MXF", general, "Format", "MXF"),
        ("MXF operational pattern is OP-1a", general, "Format_Profile", "OP-1a"),
        ("Video is MPEG Video", video, "Format", "MPEG Video"),
        ("Video profile is 4:2:2", video, "Format_Profile", "4:2:2"),
        ("Video raster width is 1920", video, "Width", "1920"),
        ("Video raster height is 1080", video, "Height", "1080"),
        ("Video frame-rate numerator is 30000", video, "FrameRate_Num", "30000"),
        ("Video frame-rate denominator is 1001", video, "FrameRate_Den", "1001"),
        ("Video scan type is interlaced", video, "ScanType", "Interlaced"),
        ("Video scan order is TFF", video, "ScanOrder", "TFF"),
        ("Video chroma is 4:2:2", video, "ChromaSubsampling", "4:2:2"),
        ("Video bit depth is 8", video, "BitDepth", "8"),
        ("Audio format is PCM", audio, "Format", "PCM"),
        ("Audio sampling rate is 48000", audio, "SamplingRate", "48000"),
        ("Audio bit depth is 24", audio, "BitDepth", "24"),
        ("Audio channels total is 2", audio, "Channels", "2"),
    ]
    tests = [{"name": name, "field": field, "expected": value,
              "actual": source.get(field),
              "outcome": "pass" if source.get(field) == value else "fail"}
             for name, source, field, value in assertions]
    if not tracks:
        return [_finding(
            "broadcast_mediaconch_policy", "warn",
            "MediaConch returned no MAXML tracks; media not cleared by this tool",
            "structural", profile, expected=expected,
            observed={"returncode": result.returncode},
            evidence=[{"id": "mediaconch:maxml", "kind": "metadata_report", "sha256": digest}],
            provenance=prov, advisory=True,
        )]
    failed = [test for test in tests if test["outcome"] != "pass"]
    detail = (f"{len(tests)} policy assertion(s) passed"
              if not failed else f"{len(failed)}/{len(tests)} policy assertion(s) failed: "
              + ", ".join(test["name"] for test in failed[:5]))
    return [_finding(
        "broadcast_mediaconch_policy", "pass" if not failed else "fail", detail,
        "structural", profile, expected=expected,
        observed={"returncode": result.returncode, "tests": tests},
        evidence=[{"id": "mediaconch:maxml", "kind": "metadata_report",
                   "sha256": digest, "assertions": len(tests)}], provenance=prov,
    )]
