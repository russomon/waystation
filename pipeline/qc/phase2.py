"""Phase 2 delivery-quality measurements for the broadcast house baseline.

The extractors are bounded. Reducers are pure and keep every new perceptual
threshold advisory until a representative accepted/rejected corpus supports a
policy promotion.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import statistics
import subprocess
from functools import lru_cache

from .report import policy_check
from .util import run


SCHEMA_VERSION = "waystation-delivery-quality/1.0"


def _policy(profile: dict) -> dict:
    pack = profile["policy_pack"]
    return {"id": pack["id"], "version": pack["version"],
            "effective_sha256": pack["effective_sha256"]}


@lru_cache(maxsize=None)
def _version(tool: str) -> str:
    if not shutil.which(tool):
        return "unavailable"
    args = [tool, "-version"] if tool != "mediaconch" else [tool, "--Version"]
    result = run(args, timeout=10)
    text = "\n".join(filter(None, [result.stdout, result.stderr]))
    return next((line.strip() for line in text.splitlines() if line.strip()), "unknown")[:240]


def _finding(name: str, status: str, detail: str, category: str, profile: dict, *,
             expected: object, observed: object, evidence: list[dict], method: str,
             time_range: dict | None = None, not_checked: bool = False,
             provenance: dict | None = None) -> dict:
    observation = {"value": observed}
    if not_checked:
        observation["state"] = "not_checked"
    return policy_check(
        name, status, detail, category, policy=_policy(profile),
        expectation={"value": expected}, observation=observation,
        evidence=evidence,
        provenance=provenance or {
            "tool": "waystation+ffmpeg", "version": _version("ffmpeg"),
            "method": method, "schema_version": SCHEMA_VERSION,
        },
        time_range=time_range, authority="deterministic_advisory",
    )


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(int(round((len(ordered) - 1) * fraction)), len(ordered) - 1)]


def _stats(values: list[float]) -> dict:
    finite = [value for value in values if math.isfinite(value)]
    return {
        "samples": len(values), "nonfinite": len(values) - len(finite),
        "minimum": round(min(finite), 6) if finite else None,
        "maximum": round(max(finite), 6) if finite else None,
        "mean": round(statistics.fmean(finite), 6) if finite else None,
        "p95": round(_percentile(finite, 0.95), 6) if finite else None,
    }


def _program_bounds(duration: float, segments: dict) -> tuple[float, float]:
    start, end = 0.0, max(float(duration or 0), 0.0)
    blacks = segments.get("black") or []
    for left, right in blacks:
        if left <= 0.25:
            start = max(start, float(right))
        if duration and right >= duration - 0.25:
            end = min(end, float(left))
    if end <= start:
        return 0.0, max(float(duration or 0), 0.0)
    return start, end


def _windows(duration: float, segments: dict, rules: dict) -> list[tuple[float, float]]:
    start, end = _program_bounds(duration, segments)
    span = max(end - start, 0.0)
    length = min(float(rules["window_seconds"]), span)
    count = max(1, int(rules["max_windows"]))
    if not span or not length:
        return []
    if span <= length or count == 1:
        return [(round(start, 3), round(length, 3))]
    return [(round(start + i * (span - length) / (count - 1), 3), round(length, 3))
            for i in range(count)]


def _metadata_blocks(text: str, absolute_start: float = 0.0) -> list[dict]:
    frames: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        if line.startswith("frame:"):
            match = re.search(r"pts_time:([-\d.]+)", line)
            current = {"time_seconds": round(absolute_start + float(match.group(1)), 6)
                       if match else absolute_start, "tags": {}}
            frames.append(current)
        elif current is not None and line.startswith("lavfi.") and "=" in line:
            key, value = line.split("=", 1)
            try:
                parsed = float(value)
            except ValueError:
                continue
            current["tags"][key] = parsed
    return frames


def _rgb_bar_observation(src: str, at: float, location: str) -> dict:
    width, height = 96, 54
    result = subprocess.run([
        "ffmpeg", "-v", "error", "-ss", f"{max(at, 0):.3f}", "-i", src,
        "-frames:v", "1", "-vf", f"scale={width}:{height}:flags=neighbor",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ], capture_output=True, timeout=30)
    expected = width * height * 3
    if result.returncode != 0 or len(result.stdout) != expected:
        return {"location": location, "time_seconds": at, "state": "not_checked"}
    pixels = result.stdout
    bands = []
    for index in range(12):
        left, right = index * width // 12, (index + 1) * width // 12
        sums = [0, 0, 0]
        count = 0
        for y in range(height // 4, height * 3 // 4):
            for x in range(left, right):
                pos = (y * width + x) * 3
                for channel in range(3):
                    sums[channel] += pixels[pos + channel]
                count += 1
        bands.append(tuple(value / max(count, 1) for value in sums))
    distances = [math.sqrt(sum((a[c] - b[c]) ** 2 for c in range(3)))
                 for a, b in zip(bands, bands[1:])]
    transitions = sum(value >= 55 for value in distances)
    spread = max(sum(color) for color in bands) - min(sum(color) for color in bands)
    return {"location": location, "time_seconds": round(at, 3),
            "transitions": transitions, "rgb_spread": round(spread, 3),
            "bars_candidate": transitions >= 5 and spread >= 180}


def visual_samples(src: str, duration: float, profile: dict, segments: dict) -> tuple[list[dict], list[dict]]:
    rules = profile["broadcast_policy"]["visual_quality"]
    samples = []
    for start, length in _windows(duration, segments, rules):
        vf = "blockdetect,blurdetect,entropy,signalstats=stat=tout+vrep,metadata=mode=print:file=-"
        result = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.3f}",
                      "-t", f"{length:.3f}", "-i", src, "-map", "0:v:0",
                      "-vf", vf, "-an", "-f", "null", "-"],
                     timeout=max(90, int(length * 20)))
        frames = _metadata_blocks(result.stdout, start) if result.returncode == 0 else []
        values = lambda key: [frame["tags"][key] for frame in frames if key in frame["tags"]]
        crop = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.3f}",
                    "-t", f"{length:.3f}", "-i", src, "-map", "0:v:0",
                    "-vf", "cropdetect=limit=24:round=2:reset=1", "-an", "-f", "null", "-"],
                   timeout=max(90, int(length * 20)))
        crops = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", crop.stderr)
        samples.append({
            "time_range": {"start_seconds": start, "end_seconds": round(start + length, 3)},
            "returncode": result.returncode,
            "crop_returncode": crop.returncode,
            "block": _stats(values("lavfi.block")),
            "blur": _stats(values("lavfi.blur")),
            "entropy_y": _stats(values("lavfi.entropy.normalized_entropy.normal.Y")),
            "y_bit_depth": _stats(values("lavfi.signalstats.YBITDEPTH")),
            "y_min": _stats(values("lavfi.signalstats.YMIN")),
            "y_max": _stats(values("lavfi.signalstats.YMAX")),
            "tout": _stats(values("lavfi.signalstats.TOUT")),
            "vrep": _stats(values("lavfi.signalstats.VREP")),
            "crop": list(map(int, crops[-1])) if crops else None,
        })
    bar_samples = []
    if duration:
        edge = min(0.5, duration / 4)
        bar_samples.append(_rgb_bar_observation(src, edge, "head"))
        bar_samples.append(_rgb_bar_observation(src, max(duration - edge, 0), "tail"))
    return samples, bar_samples


def visual_quality_from_samples(samples: list[dict], bar_samples: list[dict],
                                meta: dict, profile: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["visual_quality"]
    evidence = [{"id": f"ffmpeg:visual-window-{index}", "kind": "bounded_measurement",
                 "time_range": sample["time_range"]} for index, sample in enumerate(samples, 1)]
    overall_range = ({"start_seconds": samples[0]["time_range"]["start_seconds"],
                      "end_seconds": samples[-1]["time_range"]["end_seconds"]}
                     if samples else None)
    out = []
    visual_complete = bool(samples) and all(sample.get("returncode") == 0 for sample in samples)

    def metric(name: str, key: str, threshold: float, label: str) -> None:
        measured = [sample[key] for sample in samples if sample[key]["samples"]]
        if not measured:
            out.append(_finding(name, "info", f"{label} unavailable; not checked", "signal", profile,
                                expected={"advisory_threshold": threshold}, observed=None,
                                evidence=evidence, method="bounded visual filter metrics",
                                time_range=overall_range, not_checked=True))
            return
        worst = max([item["p95"] for item in measured if item["p95"] is not None] or [0.0])
        nonfinite = sum(item["nonfinite"] for item in measured)
        flagged = nonfinite > 0 or worst >= threshold
        complete = visual_complete and len(measured) == len(samples)
        out.append(_finding(
            name, "warn" if flagged else "pass" if complete else "info",
            f"{label} p95 {worst:.3f}; advisory threshold {threshold}"
            + (f"; {nonfinite} non-finite sample(s)" if nonfinite else "")
            + ("; one or more windows unavailable" if not complete else ""),
            "signal", profile, expected={"maximum_p95": threshold,
            "authority": rules["authority"], "calibration_state": rules["calibration_state"]},
            observed={"windows": measured, "worst_p95": worst, "nonfinite": nonfinite},
            evidence=evidence, method=f"bounded FFmpeg {key} reducer",
            time_range=overall_range, not_checked=not complete and not flagged,
        ))

    metric("broadcast_blockiness", "block", float(rules["blockiness_warn_p95"]), "block score")
    metric("broadcast_blur", "blur", float(rules["blur_warn_p95"]), "blur score")

    banding = []
    for sample in samples:
        bit_depth = sample["y_bit_depth"]["minimum"]
        entropy = sample["entropy_y"]["mean"]
        ymin, ymax = sample["y_min"]["minimum"], sample["y_max"]["maximum"]
        dynamic = (ymax - ymin) if ymin is not None and ymax is not None else None
        if (bit_depth is not None and entropy is not None and dynamic is not None
                and bit_depth <= rules["banding_max_used_bits"]
                and entropy <= rules["banding_max_entropy"]
                and dynamic >= rules["banding_min_luma_span"]):
            banding.append({"time_range": sample["time_range"], "used_bits": bit_depth,
                            "entropy": entropy, "luma_span": dynamic})
    banding_measured = any(sample["y_bit_depth"]["samples"] and sample["entropy_y"]["samples"]
                           for sample in samples)
    banding_complete = visual_complete and banding_measured and all(
        sample["y_bit_depth"]["samples"] and sample["entropy_y"]["samples"] for sample in samples)
    out.append(_finding(
        "broadcast_banding", "warn" if banding else "pass" if banding_complete else "info",
        (f"{len(banding)} contouring candidate window(s)"
         + ("; one or more windows unavailable" if not banding_complete else ""))
        if banding_measured else "banding metrics unavailable; not checked", "signal", profile,
        expected={"candidate_windows": 0, "maximum_used_bits": rules["banding_max_used_bits"],
                  "maximum_entropy": rules["banding_max_entropy"],
                  "minimum_luma_span": rules["banding_min_luma_span"]},
        observed={"events": banding} if banding_measured else None, evidence=evidence,
        method="bounded entropy + signalstats bit-depth candidate reducer",
        time_range=overall_range, not_checked=not banding_complete and not banding,
    ))

    temporal = []
    for sample in samples:
        tout = sample["tout"]["maximum"]
        vrep = sample["vrep"]["maximum"]
        if ((tout is not None and tout >= rules["temporal_outlier_warn_max"])
                or (vrep is not None and vrep >= rules["repeat_warn_max"])):
            temporal.append({"time_range": sample["time_range"], "tout_max": tout, "vrep_max": vrep})
    temporal_measured = any(sample["tout"]["samples"] or sample["vrep"]["samples"] for sample in samples)
    temporal_complete = visual_complete and temporal_measured and all(
        sample["tout"]["samples"] and sample["vrep"]["samples"] for sample in samples)
    out.append(_finding(
        "broadcast_temporal_outliers", "warn" if temporal else "pass" if temporal_complete else "info",
        (f"{len(temporal)} temporal-outlier/repeat candidate window(s)"
         + ("; one or more windows unavailable" if not temporal_complete else ""))
        if temporal_measured else "temporal metrics unavailable; not checked", "signal", profile,
        expected={"candidate_windows": 0, "tout_max": rules["temporal_outlier_warn_max"],
                  "vrep_max": rules["repeat_warn_max"]},
        observed={"events": temporal} if temporal_measured else None, evidence=evidence,
        method="bounded signalstats temporal-outlier/repeat reducer",
        time_range=overall_range, not_checked=not temporal_complete and not temporal,
    ))

    video = next((stream for stream in meta.get("streams", []) if stream.get("codec_type") == "video"), {})
    width, height = int(video.get("width", 0) or 0), int(video.get("height", 0) or 0)
    layouts = []
    for sample in samples:
        crop = sample.get("crop")
        if crop and width and height:
            cropped = max(1 - crop[0] / width, 1 - crop[1] / height)
            if cropped > rules["crop_max_fraction"]:
                layouts.append({"time_range": sample["time_range"], "crop": crop,
                                "cropped_fraction": round(cropped, 6)})
    crop_measured = any(sample.get("crop") for sample in samples)
    crop_complete = bool(samples) and crop_measured and all(
        sample.get("crop_returncode", 0) == 0 and sample.get("crop") for sample in samples)
    out.append(_finding(
        "broadcast_active_picture_layout", "warn" if layouts else "pass" if crop_complete else "info",
        (f"{len(layouts)} sampled layout/matte anomaly window(s)"
         + ("; one or more windows unavailable" if not crop_complete else ""))
        if crop_measured else "crop/layout measurements unavailable; not checked", "signal", profile,
        expected={"maximum_cropped_fraction": rules["crop_max_fraction"],
                  "declared_raster": {"width": width, "height": height}},
        observed={"events": layouts, "samples": [sample.get("crop") for sample in samples]}
        if crop_measured else None, evidence=evidence,
        method="bounded cropdetect active-picture reducer", time_range=overall_range,
        not_checked=not crop_complete and not layouts,
    ))

    checked_bars = [sample for sample in bar_samples if sample.get("state") != "not_checked"]
    candidates = [sample for sample in checked_bars if sample.get("bars_candidate")]
    out.append(_finding(
        "broadcast_color_bars", "info",
        f"{len(candidates)} color-bars candidate(s) in {len(checked_bars)} boundary sample(s)"
        if checked_bars else "boundary frames unavailable; color bars not checked",
        "signal", profile, expected="observe and disclose boundary color bars; no rejection rule",
        observed={"samples": checked_bars, "candidates": candidates} if checked_bars else None,
        evidence=[{"id": "ffmpeg:boundary-rgb-samples", "kind": "bounded_frame_measurements",
                   "samples": len(checked_bars)}], method="two-frame RGB vertical-band screen",
        not_checked=not checked_bars,
    ))
    return out


def visual_quality_checks(src: str, meta: dict, duration: float, profile: dict,
                          segments: dict) -> list[dict]:
    samples, bars = visual_samples(src, duration, profile, segments)
    return visual_quality_from_samples(samples, bars, meta, profile)


def audio_samples(src: str, duration: float, profile: dict, segments: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["audio_quality"]
    windows = _windows(duration, segments, rules)
    samples = []
    for start, length in windows:
        phase = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.3f}",
                     "-t", f"{length:.3f}", "-i", src, "-map", "0:a:0",
                     "-af", "aphasemeter=video=0,ametadata=mode=print:file=-",
                     "-f", "null", "-"], timeout=max(60, int(length * 10)))
        stats = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.3f}",
                     "-t", f"{length:.3f}", "-i", src, "-map", "0:a:0",
                     "-af", "aformat=sample_fmts=fltp,asetnsamples=n=4800:p=0,"
                     "astats=metadata=1:reset=1,ametadata=mode=print:file=-",
                     "-f", "null", "-"], timeout=max(60, int(length * 10)))
        silence = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start:.3f}",
                       "-t", f"{length:.3f}", "-i", src, "-map", "0:a:0",
                       "-af", f"silencedetect=noise={rules['silence_noise_db']}dB:"
                       f"d={rules['dropout_min_seconds']}", "-f", "null", "-"],
                      timeout=max(60, int(length * 10)))
        starts = [float(value) for value in re.findall(r"silence_start:\s*([\d.]+)", silence.stderr)]
        ends = [float(value) for value in re.findall(r"silence_end:\s*([\d.]+)", silence.stderr)]
        while len(ends) < len(starts):
            ends.append(length)
        samples.append({
            "time_range": {"start_seconds": start, "end_seconds": round(start + length, 3)},
            "phase_frames": _metadata_blocks(phase.stdout, start),
            "astats_frames": _metadata_blocks(stats.stdout, start),
            "silence_returncode": silence.returncode,
            "silences": [{"start_seconds": round(start + left, 6),
                          "end_seconds": round(start + right, 6),
                          "duration_seconds": round(right - left, 6)}
                         for left, right in zip(starts, ends)],
        })
    return samples


def audio_quality_from_samples(samples: list[dict], channels: int, profile: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["audio_quality"]
    evidence = [{"id": f"ffmpeg:audio-window-{index}", "kind": "bounded_measurement",
                 "time_range": sample["time_range"]} for index, sample in enumerate(samples, 1)]
    overall_range = ({"start_seconds": samples[0]["time_range"]["start_seconds"],
                      "end_seconds": samples[-1]["time_range"]["end_seconds"]}
                     if samples else None)
    out = []
    phase_points = []
    for sample in samples:
        phase_points.extend({"time_seconds": frame["time_seconds"],
                             "value": frame["tags"]["lavfi.aphasemeter.phase"]}
                            for frame in sample["phase_frames"]
                            if "lavfi.aphasemeter.phase" in frame["tags"])
    if channels < 2:
        out.append(_finding("broadcast_audio_phase", "info", "fewer than two channels; phase not applicable",
                            "audio", profile, expected="stereo phase correlation", observed={"channels": channels},
                            evidence=evidence, method="bounded aphasemeter", not_checked=True))
    elif not phase_points:
        out.append(_finding("broadcast_audio_phase", "info", "phase samples unavailable; not checked",
                            "audio", profile, expected={"minimum_mean": rules["phase_minimum_mean"]},
                            observed=None, evidence=evidence, method="bounded aphasemeter",
                            time_range=overall_range, not_checked=True))
    else:
        values = [point["value"] for point in phase_points]
        mean = statistics.fmean(values)
        negative = [point for point in phase_points if point["value"] < rules["phase_minimum_sample"]]
        flagged = mean < rules["phase_minimum_mean"] or len(negative) / len(values) > rules["phase_max_negative_fraction"]
        out.append(_finding(
            "broadcast_audio_phase", "warn" if flagged else "pass",
            f"mean phase correlation {mean:+.3f}; {len(negative)}/{len(values)} strongly negative sample(s)",
            "audio", profile,
            expected={"minimum_mean": rules["phase_minimum_mean"],
                      "minimum_sample": rules["phase_minimum_sample"],
                      "maximum_negative_fraction": rules["phase_max_negative_fraction"]},
            observed={"mean": round(mean, 6), "minimum": min(values),
                      "negative_events": negative[:rules["max_reported_events"]],
                      "sample_count": len(values)}, evidence=evidence,
            method="bounded aphasemeter correlation reducer", time_range=overall_range,
        ))

    astats = [frame for sample in samples for frame in sample["astats_frames"]]
    clipping, clicks = [], []
    channel_rms: dict[int, list[float]] = {index: [] for index in range(1, channels + 1)}
    for frame in astats:
        tags = frame["tags"]
        peak = tags.get("lavfi.astats.Overall.Peak_level")
        rms = tags.get("lavfi.astats.Overall.RMS_level")
        flat = tags.get("lavfi.astats.Overall.Flat_factor", 0.0)
        diff = tags.get("lavfi.astats.Overall.Max_difference")
        event = {"start_seconds": frame["time_seconds"],
                 "end_seconds": round(frame["time_seconds"] + 0.1, 6)}
        if peak is not None and peak >= rules["clipping_peak_dbfs"] and flat > rules["clipping_flat_factor"]:
            clipping.append({**event, "peak_dbfs": peak, "flat_factor": flat})
        if (peak is not None and rms is not None and diff is not None
                and peak >= rules["click_peak_dbfs"] and rms <= rules["click_max_rms_dbfs"]
                and diff >= rules["click_min_difference"]):
            clicks.append({**event, "peak_dbfs": peak, "rms_dbfs": rms, "max_difference": diff})
        for channel in channel_rms:
            value = tags.get(f"lavfi.astats.{channel}.RMS_level")
            if value is not None and math.isfinite(value):
                channel_rms[channel].append(value)

    def event_finding(name: str, events: list[dict], expectation: dict, label: str) -> dict:
        if not astats:
            return _finding(name, "info", f"{label} metrics unavailable; not checked", "audio", profile,
                            expected=expectation, observed=None, evidence=evidence,
                            method="bounded 100 ms astats reducer", time_range=overall_range, not_checked=True)
        return _finding(name, "warn" if events else "pass", f"{len(events)} {label} candidate event(s)",
                        "audio", profile, expected=expectation,
                        observed={"event_count": len(events),
                                  "events": events[:rules["max_reported_events"]],
                                  "truncated": len(events) > rules["max_reported_events"]},
                        evidence=evidence, method="bounded 100 ms astats reducer",
                        time_range=overall_range)

    out.append(event_finding("broadcast_audio_clipping", clipping,
                             {"events": 0, "peak_dbfs": rules["clipping_peak_dbfs"],
                              "flat_factor": rules["clipping_flat_factor"]}, "clipping"))
    out.append(event_finding("broadcast_audio_clicks_pops", clicks,
                             {"events": 0, "peak_dbfs": rules["click_peak_dbfs"],
                              "maximum_rms_dbfs": rules["click_max_rms_dbfs"],
                              "minimum_difference": rules["click_min_difference"]}, "click/pop"))

    dropouts = [event for sample in samples for event in sample["silences"]
                if rules["dropout_min_seconds"] <= event["duration_seconds"] < rules["persistent_silence_seconds"]]
    dropout_complete = bool(samples) and all(sample.get("silence_returncode", 0) == 0
                                             for sample in samples)
    out.append(_finding(
        "broadcast_audio_dropouts", "warn" if dropouts else "pass" if dropout_complete else "info",
        (f"{len(dropouts)} short silence/dropout candidate(s)"
         + ("; one or more windows unavailable" if not dropout_complete else ""))
        if samples else "dropout scan unavailable; not checked",
        "audio", profile,
        expected={"events": 0, "minimum_seconds": rules["dropout_min_seconds"],
                  "less_than_seconds": rules["persistent_silence_seconds"]},
        observed={"event_count": len(dropouts), "events": dropouts[:rules["max_reported_events"]]}
        if samples else None, evidence=evidence, method="bounded silencedetect dropout reducer",
        time_range=overall_range, not_checked=not dropout_complete and not dropouts,
    ))

    medians = {str(channel): round(statistics.median(values), 6)
               for channel, values in channel_rms.items() if values}
    if len(medians) < channels:
        out.append(_finding("broadcast_audio_channel_consistency", "info",
                            "per-channel RMS unavailable for every declared channel; not checked",
                            "audio", profile, expected={"channels": channels}, observed={"rms_dbfs": medians},
                            evidence=evidence, method="bounded per-channel astats reducer",
                            time_range=overall_range, not_checked=True))
    else:
        spread = max(medians.values()) - min(medians.values()) if medians else 0.0
        dead = [channel for channel, value in medians.items() if value <= rules["dead_channel_rms_dbfs"]]
        flagged = bool(dead) or spread > rules["channel_max_rms_spread_db"]
        out.append(_finding(
            "broadcast_audio_channel_consistency", "warn" if flagged else "pass",
            f"per-channel median RMS spread {spread:.2f} dB; dead-channel candidates {dead or 'none'}",
            "audio", profile,
            expected={"maximum_rms_spread_db": rules["channel_max_rms_spread_db"],
                      "dead_channel_rms_dbfs": rules["dead_channel_rms_dbfs"]},
            observed={"median_rms_dbfs": medians, "spread_db": round(spread, 6),
                      "dead_channel_candidates": dead}, evidence=evidence,
            method="bounded per-channel astats reducer", time_range=overall_range,
        ))
    return out


def audio_quality_checks(src: str, meta: dict, duration: float, profile: dict,
                         segments: dict) -> list[dict]:
    audio = next((stream for stream in meta.get("streams", []) if stream.get("codec_type") == "audio"), {})
    channels = int(audio.get("channels", 0) or 0)
    return audio_quality_from_samples(audio_samples(src, duration, profile, segments), channels, profile)


def caption_quality_checks(cues: list, duration: float, source: str,
                           profile: dict) -> list[dict]:
    rules = profile["broadcast_policy"]["caption_quality"]
    if not cues:
        return [_finding(
            "broadcast_caption_continuity", "info", "no parseable SRT/VTT cues; continuity not checked",
            "text", profile, expected="ordered, positive-duration, non-overlapping text cues",
            observed={"source": source, "cue_count": 0}, evidence=[],
            method="SRT/WebVTT cue timeline reducer", not_checked=True,
        ), _finding(
            "broadcast_caption_runtime_coverage", "info", "no parseable cues; runtime coverage not checked",
            "text", profile, expected="measure captioned runtime without inferring dialogue coverage",
            observed={"source": source, "cue_count": 0}, evidence=[],
            method="SRT/WebVTT interval-union reducer", not_checked=True,
        )]
    invalid, overlaps, out_of_order = [], [], []
    for index, cue in enumerate(cues):
        start, end, _text = cue
        if end <= start or start < 0 or (duration and end > duration + rules["eof_tolerance_seconds"]):
            invalid.append({"cue": index + 1, "start_seconds": start, "end_seconds": end})
        if index:
            previous = cues[index - 1]
            if start < previous[0]:
                out_of_order.append({"cue": index + 1, "start_seconds": start,
                                     "previous_start_seconds": previous[0]})
            if start < previous[1]:
                overlaps.append({"cue": index + 1, "start_seconds": start,
                                 "previous_end_seconds": previous[1],
                                 "overlap_seconds": round(previous[1] - start, 6)})
    gaps = [{"start_seconds": cues[index - 1][1], "end_seconds": cues[index][0],
             "duration_seconds": round(cues[index][0] - cues[index - 1][1], 6)}
            for index in range(1, len(cues)) if cues[index][0] >= cues[index - 1][1]]
    long_gaps = [gap for gap in gaps if gap["duration_seconds"] >= rules["long_gap_advisory_seconds"]]
    issues = invalid + overlaps + out_of_order + long_gaps
    cap = int(rules["max_reported_events"])
    evidence = [{"id": "captions:timeline", "kind": "parsed_text_cues",
                 "source": source, "cue_count": len(cues)}]
    continuity = _finding(
        "broadcast_caption_continuity", "warn" if issues else "pass",
        f"{len(invalid)} invalid, {len(overlaps)} overlap, {len(out_of_order)} out-of-order, "
        f"{len(long_gaps)} long-gap event(s)", "text", profile,
        expected={"invalid": 0, "overlaps": 0, "out_of_order": 0,
                  "long_gap_advisory_seconds": rules["long_gap_advisory_seconds"]},
        observed={"invalid": invalid[:cap], "overlaps": overlaps[:cap],
                  "out_of_order": out_of_order[:cap], "long_gaps": long_gaps[:cap],
                  "truncated": any(len(events) > cap for events in (invalid, overlaps, out_of_order, long_gaps))},
        evidence=evidence, method="SRT/WebVTT cue timeline reducer",
        time_range={"start_seconds": cues[0][0], "end_seconds": cues[-1][1]},
    )
    intervals = sorted((max(0.0, start), min(end, duration or end)) for start, end, _ in cues if end > start)
    merged = []
    for start, end in intervals:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    covered = sum(end - start for start, end in merged)
    coverage = covered / duration if duration else None
    coverage_finding = _finding(
        "broadcast_caption_runtime_coverage", "info",
        f"{covered:.3f}s captioned" + (f" ({coverage:.1%} of runtime)" if coverage is not None else ""),
        "text", profile,
        expected="measure timeline coverage only; speech/dialogue coverage requires separate evidence",
        observed={"captioned_seconds": round(covered, 6), "runtime_seconds": duration or None,
                  "runtime_fraction": round(coverage, 6) if coverage is not None else None,
                  "merged_intervals": merged[:cap]}, evidence=evidence,
        method="SRT/WebVTT interval-union reducer",
        time_range={"start_seconds": 0.0, "end_seconds": duration} if duration else None,
    )
    return [continuity, coverage_finding]


def _norm(field: str, value: object) -> str | int | float | None:
    if value in (None, "", "N/A"):
        return None
    text = str(value).strip().lower()
    compact = "".join(character for character in text if character.isalnum())
    if field == "format":
        return "mxf" if "mxf" in compact else compact
    if field in {"width", "height", "video_bit_depth", "audio_sample_rate", "audio_channels"}:
        match = re.search(r"\d+", text)
        return int(match.group()) if match else compact
    if field == "frame_rate":
        try:
            if "/" in text:
                numerator, denominator = text.split("/", 1)
                return round(float(numerator) / float(denominator), 3)
            return round(float(re.search(r"[\d.]+", text).group()), 3)
        except (AttributeError, ValueError, ZeroDivisionError):
            return compact
    if field == "scan":
        if compact in {"tt", "tff", "topfieldfirst", "interlacedtff"}:
            return "tff"
        if compact in {"bb", "bff", "bottomfieldfirst", "interlacedbff"}:
            return "bff"
        return compact
    if field == "chroma":
        if "422" in compact:
            return "422"
        if "420" in compact:
            return "420"
        if "444" in compact:
            return "444"
    return compact


def _conch_value(tests: list[dict], name: str) -> object:
    test = next((item for item in tests if item.get("name") == name), None)
    return test.get("actual") if test else None


def metadata_cross_validation(meta: dict, checks: list[dict], profile: dict) -> list[dict]:
    """Compare facts already collected by ffprobe, MediaInfo, and MediaConch."""
    video = next((stream for stream in meta.get("streams", []) if stream.get("codec_type") == "video"), {})
    audio = next((stream for stream in meta.get("streams", []) if stream.get("codec_type") == "audio"), {})
    ffprobe = {
        "format": (meta.get("format") or {}).get("format_name"), "width": video.get("width"),
        "height": video.get("height"), "frame_rate": video.get("avg_frame_rate"),
        "scan": video.get("field_order"), "chroma": video.get("pix_fmt"),
        "video_bit_depth": video.get("bits_per_raw_sample") or video.get("bits_per_sample"),
        "audio_sample_rate": audio.get("sample_rate"), "audio_channels": audio.get("channels"),
    }
    media_item = next((item for item in checks if item.get("name") == "mediainfo_wrapper"), {})
    mediainfo = media_item.get("facts") or {}
    conch_item = next((item for item in checks if item.get("name") == "broadcast_mediaconch_policy"), {})
    tests = ((conch_item.get("observation") or {}).get("value") or {}).get("tests") or []
    mediaconch = {
        "format": _conch_value(tests, "General format is MXF"),
        "width": _conch_value(tests, "Video raster width is 1920"),
        "height": _conch_value(tests, "Video raster height is 1080"),
        "frame_rate": (
            f"{_conch_value(tests, 'Video frame-rate numerator is 30000')}/"
            f"{_conch_value(tests, 'Video frame-rate denominator is 1001')}"
            if (_conch_value(tests, "Video frame-rate numerator is 30000")
                and _conch_value(tests, "Video frame-rate denominator is 1001")) else None
        ),
        "scan": (_conch_value(tests, "Video scan order is TFF")
                 or _conch_value(tests, "Video scan type is interlaced")),
        "chroma": _conch_value(tests, "Video chroma is 4:2:2"),
        "video_bit_depth": _conch_value(tests, "Video bit depth is 8"),
        "audio_sample_rate": _conch_value(tests, "Audio sampling rate is 48000"),
        "audio_channels": _conch_value(tests, "Audio channels total is 2"),
    }
    sources = {"ffprobe": ffprobe, "mediainfo": mediainfo, "mediaconch": mediaconch}
    comparisons, mismatches = [], []
    for field in ffprobe:
        values = {source: facts.get(field) for source, facts in sources.items() if facts.get(field) not in (None, "")}
        normalized = {source: _norm(field, value) for source, value in values.items()}
        comparable = {value for value in normalized.values() if value is not None}
        item = {"field": field, "values": values, "normalized": normalized,
                "state": "agree" if len(comparable) == 1 and len(values) >= 2
                else "mismatch" if len(comparable) > 1 else "not_checked"}
        comparisons.append(item)
        if item["state"] == "mismatch":
            mismatches.append(item)
    available = {source: any(value not in (None, "") for value in facts.values()) for source, facts in sources.items()}
    complete = all(available.values())
    status = "warn" if mismatches else "pass" if complete else "info"
    available_text = ", ".join(source for source, present in available.items() if present)
    detail = (f"{len(mismatches)} contradiction(s) across ffprobe, MediaInfo, and MediaConch"
              + (f"; available sources: {available_text}" if not complete else "")
              if mismatches else "three metadata sources available with no normalized contradictions"
              if complete else f"metadata cross-check incomplete; available sources: {available_text}")
    return [_finding(
        "broadcast_metadata_cross_validation", status,
        detail,
        "structural", profile,
        expected="independent tools agree on normalized wrapper/video/audio facts",
        observed={"available": available, "comparisons": comparisons, "mismatches": mismatches},
        evidence=[{"id": "ffprobe:format-streams", "kind": "metadata_report"},
                  {"id": "mediainfo:json", "kind": "metadata_report",
                   "sha256": media_item.get("report_sha256")},
                  {"id": "mediaconch:maxml", "kind": "metadata_report",
                   "sha256": next((e.get("sha256") for e in conch_item.get("evidence", [])
                                   if e.get("id") == "mediaconch:maxml"), None)}],
        method="field-aware normalized three-tool fact comparison",
        not_checked=not complete and not mismatches,
        provenance={
            "tool": "waystation+ffprobe+mediainfo+mediaconch",
            "version": {
                "ffprobe": _version("ffprobe"), "mediainfo": _version("mediainfo"),
                "mediaconch": _version("mediaconch"),
            },
            "method": "field-aware normalized three-tool fact comparison",
            "schema_version": SCHEMA_VERSION,
        },
    )]
