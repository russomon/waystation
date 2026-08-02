#!/usr/bin/env bash
# Pure Phase 2 reducer fixtures. Synthetic data proves reducer behavior only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
from qc import phase2, profiles, prompt_compiler

profile = profiles.get("broadcast_xdcam")
assert profile["policy_pack"]["version"] == "1.2.0"


def stat(value):
    return {"samples": 10, "nonfinite": 0, "minimum": value,
            "maximum": value, "mean": value, "p95": value}


def visual(**overrides):
    sample = {
        "time_range": {"start_seconds": 10.0, "end_seconds": 14.0},
        "returncode": 0, "block": stat(4.0), "blur": stat(4.0),
        "entropy_y": stat(0.85), "y_bit_depth": stat(8.0),
        "y_min": stat(16.0), "y_max": stat(235.0),
        "tout": stat(0.0), "vrep": stat(0.0), "crop": [1920, 1080, 0, 0],
    }
    sample.update(overrides)
    return sample


meta = {"streams": [{"codec_type": "video", "width": 1920, "height": 1080}]}
good_visual = {x["name"]: x for x in phase2.visual_quality_from_samples(
    [visual()], [{"location": "head", "time_seconds": 0.5,
                  "transitions": 1, "rgb_spread": 20, "bars_candidate": False}],
    meta, profile)}
for name in ("broadcast_blockiness", "broadcast_blur", "broadcast_banding",
             "broadcast_temporal_outliers", "broadcast_active_picture_layout"):
    assert good_visual[name]["status"] == "pass", (name, good_visual[name])

bad_visual = {x["name"]: x for x in phase2.visual_quality_from_samples([
    visual(block=stat(30.0), blur=stat(24.0), entropy_y=stat(0.3),
           y_bit_depth=stat(4.0), tout=stat(0.2), vrep=stat(0.2),
           crop=[1600, 800, 160, 140])
], [{"location": "tail", "time_seconds": 99.5, "transitions": 8,
     "rgb_spread": 400, "bars_candidate": True}], meta, profile)}
for name in ("broadcast_blockiness", "broadcast_blur", "broadcast_banding",
             "broadcast_temporal_outliers", "broadcast_active_picture_layout"):
    assert bad_visual[name]["status"] == "warn", (name, bad_visual[name])
assert bad_visual["broadcast_color_bars"]["status"] == "info"
assert bad_visual["broadcast_color_bars"]["observation"]["value"]["candidates"]


def frame(at, tags):
    return {"time_seconds": at, "tags": tags}


def audio(phase, peak, rms, difference, flat, channel_rms, silences=None):
    tags = {
        "lavfi.astats.Overall.Peak_level": peak,
        "lavfi.astats.Overall.RMS_level": rms,
        "lavfi.astats.Overall.Max_difference": difference,
        "lavfi.astats.Overall.Flat_factor": flat,
    }
    tags.update({f"lavfi.astats.{index}.RMS_level": value
                 for index, value in enumerate(channel_rms, 1)})
    return {
        "time_range": {"start_seconds": 20.0, "end_seconds": 28.0},
        "phase_frames": [frame(20.0, {"lavfi.aphasemeter.phase": phase})],
        "astats_frames": [frame(20.0, tags)], "silences": silences or [],
    }


good_audio = {x["name"]: x for x in phase2.audio_quality_from_samples(
    [audio(0.8, -6.0, -18.0, 0.1, 0.0, [-18.0, -18.5])], 2, profile)}
for name in ("broadcast_audio_phase", "broadcast_audio_clipping",
             "broadcast_audio_clicks_pops", "broadcast_audio_dropouts",
             "broadcast_audio_channel_consistency"):
    assert good_audio[name]["status"] == "pass", (name, good_audio[name])

bad_audio = {x["name"]: x for x in phase2.audio_quality_from_samples([
    audio(-1.0, 0.0, -40.0, 1.0, 4.0, [-12.0, -90.0],
          [{"start_seconds": 22.0, "end_seconds": 22.2, "duration_seconds": 0.2}])
], 2, profile)}
for name in ("broadcast_audio_phase", "broadcast_audio_clipping",
             "broadcast_audio_clicks_pops", "broadcast_audio_dropouts",
             "broadcast_audio_channel_consistency"):
    assert bad_audio[name]["status"] == "warn", (name, bad_audio[name])
assert bad_audio["broadcast_audio_dropouts"]["observation"]["value"]["events"][0]["start_seconds"] == 22.0

good_caption = {x["name"]: x for x in phase2.caption_quality_checks(
    [(1.0, 2.0, "one"), (3.0, 4.0, "two")], 10.0, "proof.srt", profile)}
assert good_caption["broadcast_caption_continuity"]["status"] == "pass"
assert good_caption["broadcast_caption_runtime_coverage"]["status"] == "info"
bad_caption = {x["name"]: x for x in phase2.caption_quality_checks(
    [(5.0, 7.0, "one"), (6.0, 8.0, "overlap"), (2.0, 1.0, "invalid"),
     (130.0, 131.0, "late")], 140.0, "proof.vtt", profile)}
assert bad_caption["broadcast_caption_continuity"]["status"] == "warn"
assert bad_caption["broadcast_caption_continuity"]["observation"]["value"]["invalid"]


def conch_test(name, actual):
    return {"name": name, "actual": actual, "outcome": "pass"}


ffprobe = {"format": {"format_name": "mxf"}, "streams": [
    {"codec_type": "video", "width": 1920, "height": 1080,
     "avg_frame_rate": "30000/1001", "field_order": "tt",
     "pix_fmt": "yuv422p", "bits_per_raw_sample": "8"},
    {"codec_type": "audio", "sample_rate": "48000", "channels": 2},
]}
facts = {"format": "MXF", "width": "1920", "height": "1080",
         "frame_rate": "29.970", "scan": "TFF", "chroma": "4:2:2",
         "video_bit_depth": "8", "audio_sample_rate": "48000",
         "audio_channels": "2"}
tests = [
    conch_test("General format is MXF", "MXF"),
    conch_test("Video raster width is 1920", "1920"),
    conch_test("Video raster height is 1080", "1080"),
    conch_test("Video frame-rate numerator is 30000", "30000"),
    conch_test("Video frame-rate denominator is 1001", "1001"),
    conch_test("Video scan order is TFF", "TFF"),
    conch_test("Video chroma is 4:2:2", "4:2:2"),
    conch_test("Video bit depth is 8", "8"),
    conch_test("Audio sampling rate is 48000", "48000"),
    conch_test("Audio channels total is 2", "2"),
]
evidence = [
    {"name": "mediainfo_wrapper", "facts": facts, "report_sha256": "a" * 64},
    {"name": "broadcast_mediaconch_policy",
     "observation": {"value": {"tests": tests}},
     "evidence": [{"id": "mediaconch:maxml", "sha256": "b" * 64}]},
]
cross_good = phase2.metadata_cross_validation(ffprobe, evidence, profile)[0]
assert cross_good["status"] == "pass", cross_good["observation"]
bad_evidence = [{**evidence[0], "facts": {**facts, "width": "1280"}}, evidence[1]]
cross_bad = phase2.metadata_cross_validation(ffprobe, bad_evidence, profile)[0]
assert cross_bad["status"] == "warn"
assert cross_bad["observation"]["value"]["mismatches"][0]["field"] == "width"

not_checked = phase2.visual_quality_from_samples([], [], meta, profile)
assert all(item["decision"]["outcome"] == "not_checked"
           for item in not_checked if item["name"] != "broadcast_color_bars")
partial_visual = {x["name"]: x for x in phase2.visual_quality_from_samples(
    [visual(returncode=1, crop_returncode=1)], [], meta, profile)}
for name in ("broadcast_blockiness", "broadcast_blur", "broadcast_banding",
             "broadcast_temporal_outliers", "broadcast_active_picture_layout"):
    assert partial_visual[name]["status"] == "info", (name, partial_visual[name])
    assert partial_visual[name]["decision"]["outcome"] == "not_checked"
partial_audio_sample = audio(0.8, -6.0, -18.0, 0.1, 0.0, [-18.0, -18.5])
partial_audio_sample["silence_returncode"] = 1
partial_audio = {x["name"]: x for x in phase2.audio_quality_from_samples(
    [partial_audio_sample], 2, profile)}
assert partial_audio["broadcast_audio_dropouts"]["status"] == "info"
assert partial_audio["broadcast_audio_dropouts"]["decision"]["outcome"] == "not_checked"
for finding in [*bad_visual.values(), *bad_audio.values(), *bad_caption.values(), cross_bad]:
    for key in ("policy", "expectation", "observation", "evidence", "provenance", "decision"):
        assert key in finding, (finding["name"], key)
    assert finding["decision"]["authority"] == "deterministic_advisory"

packets = prompt_compiler.compile_packets({"checks": list(bad_audio.values())})
assert packets and all(request["type"] == "audio_clip"
                       for packet in packets for request in packet["media_requests"])
print("PASS Phase 2 visual/audio/caption/metadata reducers + advisory authority")
PYEOF
