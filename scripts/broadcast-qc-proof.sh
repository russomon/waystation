#!/usr/bin/env bash
# U.S. broadcast XDCAM baseline proof: real integration fixtures + pure reducers.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ffmpeg >/dev/null || { echo "SKIP - ffmpeg not installed"; exit 0; }
command -v ffprobe >/dev/null || { echo "SKIP - ffprobe not installed"; exit 0; }

echo "- constructing known-good XDCAM-style MXF -"
ffmpeg -y -v error \
  -f lavfi -i "color=c=black:s=1920x1080:r=30000/1001:d=1.2" \
  -f lavfi -i "testsrc2=s=1920x1080:r=30000/1001:d=2.6" \
  -f lavfi -i "color=c=black:s=1920x1080:r=30000/1001:d=1.2" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=5" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,setfield=tff[v];[3:a]volume=0.7[a]" \
  -map "[v]" -map "[a]" \
  -c:v mpeg2video -profile:v 0 -level:v 2 -pix_fmt yuv422p \
  -flags +ildct+ilme -top 1 -b:v 50M -minrate 50M -maxrate 50M \
  -bufsize 17825792 -g 15 -bf 2 -sc_threshold 1000000000 \
  -c:a pcm_s24le -ar 48000 -ac 2 -timecode "01:00:00;00" \
  -metadata title="WAYSTATION BASELINE FIXTURE" -f mxf "$WORK/good.mxf"
printf '1\n00:00:01,300 --> 00:00:03,600\nBaseline caption.\n' > "$WORK/good.srt"

echo "- constructing known-bad delivery shape -"
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=s=1280x720:r=25:d=3" \
  -f lavfi -i "sine=frequency=1000:sample_rate=44100:duration=3" \
  -c:v libx264 -pix_fmt yuv420p -b:v 3M -g 50 \
  -c:a aac -ar 44100 -ac 2 -shortest "$WORK/bad.mp4"

PIPELINE_SHARED_SECRET=x B2_BUCKET=b B2_S3_ENDPOINT=http://x \
B2_KEY_ID=x B2_APP_KEY=x B2_REGION=x \
GOOD="$WORK/good.mxf" BAD="$WORK/bad.mp4" CAPS="$WORK/good.srt" \
"$PY" - <<'PYEOF'
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.getcwd(), "pipeline"))
import worker
from qc import broadcast, profiles

ok = True

def need(condition, message):
    global ok
    if not condition:
        print(f"  FAIL: {message}")
        ok = False

def by_name(checks):
    return {item["name"]: item for item in checks}

profile = profiles.get("us_broadcast_xdcam_hd_422_v1")
need(profile["policy_pack"]["version"] == "1.0.0", "policy pack version")
need("not a universal network" in profile["policy_pack"]["scope"].lower(),
     "scope must reject universal-network claim")

with tempfile.TemporaryDirectory() as tmp:
    good_meta = worker.ffprobe(os.environ["GOOD"])
    good = worker.run_qc(
        os.environ["GOOD"], good_meta, captions_path=os.environ["CAPS"],
        profile=profile, key="good.mxf", tmp=tmp,
    )
    bad_meta = worker.ffprobe(os.environ["BAD"])
    bad = worker.run_qc(
        os.environ["BAD"], bad_meta, profile=profile,
        key="bad.mp4", tmp=tmp,
    )

print(f"  good integration: status={good['status']} tiers={good['tiers']}")
need(good["status"] == "pass" and good["tiers"]["BLOCKER"] == 0
     and good["tiers"]["ISSUE"] == 0,
     "known-good fixture must have no blockers/issues")
need(good.get("policy_pack", {}).get("effective_sha256") == profile["policy_pack"]["effective_sha256"],
     "report must retain effective policy identity")
good_checks = by_name(good["checks"])
for name in (
    "broadcast_full_decode", "broadcast_wrapper", "broadcast_mxf_op1a",
    "broadcast_video_tracks", "broadcast_audio_tracks",
    "broadcast_video_codec_profile", "broadcast_frame_rate", "broadcast_raster",
    "broadcast_scan_field_order", "broadcast_bit_depth_chroma",
    "broadcast_video_bitrate", "broadcast_audio_layout", "broadcast_audio_format",
    "broadcast_required_metadata", "broadcast_duration_consistency",
    "broadcast_timestamp_continuity", "broadcast_gop", "broadcast_black_head",
    "broadcast_black_tail", "broadcast_program_black", "broadcast_freeze_runs",
    "broadcast_silence_runs", "broadcast_loudness", "broadcast_true_peak",
    "broadcast_captions_present", "video_legal_range",
):
    item = good_checks.get(name)
    need(item is not None and item["status"] == "pass", f"good {name} must pass")
    if item:
        for field in ("policy", "expectation", "observation", "evidence",
                      "provenance", "decision"):
            need(field in item, f"{name} missing structured {field}")

print(f"  bad integration: status={bad['status']} tiers={bad['tiers']}")
bad_checks = by_name(bad["checks"])
for name in (
    "broadcast_wrapper", "broadcast_mxf_op1a", "broadcast_video_codec_profile",
    "broadcast_frame_rate", "broadcast_raster", "broadcast_scan_field_order",
    "broadcast_bit_depth_chroma", "broadcast_video_bitrate",
    "broadcast_audio_format", "broadcast_required_metadata",
    "broadcast_captions_present",
):
    need(bad_checks.get(name, {}).get("status") == "fail", f"bad {name} must fail")

# Bounded timestamp/GOP reducers: exact good cadence versus gaps/backwards/long GOP.
good_frames = [
    {"best_effort_timestamp_time": f"{i * 1001 / 30000:.6f}",
     "key_frame": 1 if i % 15 == 0 else 0,
     "pict_type": "I" if i % 15 == 0 else "P"}
    for i in range(46)
]
bad_frames = [dict(frame) for frame in good_frames]
bad_frames[20]["best_effort_timestamp_time"] = "0.100000"
bad_frames[30]["best_effort_timestamp_time"] = "2.000000"
for frame in bad_frames:
    frame["key_frame"] = 0
    frame["pict_type"] = "P"
bad_frames[0].update({"key_frame": 1, "pict_type": "I"})
bad_frames[30].update({"key_frame": 1, "pict_type": "I"})
good_timing = by_name(broadcast.timestamp_gop_from_frames(good_frames, profile))
bad_timing = by_name(broadcast.timestamp_gop_from_frames(bad_frames, profile))
need(good_timing["broadcast_timestamp_continuity"]["status"] == "pass",
     "good timestamp construction")
need(good_timing["broadcast_gop"]["status"] == "pass", "good GOP construction")
need(bad_timing["broadcast_timestamp_continuity"]["status"] == "fail",
     "bad timestamp construction")
need(bad_timing["broadcast_gop"]["status"] == "fail", "bad GOP construction")
need("time_range" in bad_timing["broadcast_timestamp_continuity"],
     "timestamp evidence time range")

# Signal boundaries and artifact advisories are separate from hard policy facts.
good_segments = {"black": [(0.0, 1.2), (8.8, 10.0)], "freeze": [], "silence": []}
bad_segments = {"black": [(2.0, 3.0)], "freeze": [(3.0, 6.0)], "silence": [(4.0, 7.0)]}
good_signal = by_name(broadcast.signal_segment_checks(good_segments, 10.0, profile))
bad_signal = by_name(broadcast.signal_segment_checks(bad_segments, 10.0, profile))
need(good_signal["broadcast_black_head"]["status"] == "pass", "good head black")
need(good_signal["broadcast_black_tail"]["status"] == "pass", "good tail black")
need(bad_signal["broadcast_black_head"]["status"] == "fail", "missing head black")
need(bad_signal["broadcast_black_tail"]["status"] == "fail", "missing tail black")
for name in ("broadcast_program_black", "broadcast_freeze_runs", "broadcast_silence_runs"):
    need(bad_signal[name]["status"] == "warn", f"{name} must remain advisory")
    need(bad_signal[name]["decision"]["authority"] == "deterministic_advisory",
         f"{name} authority")

good_audio = by_name(broadcast.audio_measurement_checks({"i": -24.0, "tp": -3.0}, profile))
bad_audio = by_name(broadcast.audio_measurement_checks({"i": -18.0, "tp": -0.5}, profile))
missing_audio = by_name(broadcast.audio_measurement_checks({"i": None, "tp": None}, profile))
need(good_audio["broadcast_loudness"]["status"] == "pass", "good loudness")
need(good_audio["broadcast_true_peak"]["status"] == "pass", "good true peak")
need(bad_audio["broadcast_loudness"]["status"] == "fail", "bad loudness")
need(bad_audio["broadcast_true_peak"]["status"] == "fail", "bad true peak")
for item in missing_audio.values():
    need(item["status"] == "info" and item["decision"]["outcome"] == "not_checked",
         "missing audio measurement must be FYI/not_checked")

need(broadcast.caption_presence_check(True, "sidecar", profile)[0]["status"] == "pass",
     "caption present")
need(broadcast.caption_presence_check(False, "", profile)[0]["status"] == "fail",
     "caption missing")
disabled = broadcast.caption_presence_check(False, "", profile, checked=False)[0]
need(disabled["status"] == "info" and disabled["decision"]["outcome"] == "not_checked",
     "caption toggle must be explicit not_checked")

# Policy overrides change only the effective rules/hash; pack identity stays fixed.
override = profiles.get("broadcast_xdcam", {"video": {"raster": {"width": 1280, "height": 720}}})
need(override["broadcast_policy"]["video"]["raster"] == {"width": 1280, "height": 720},
     "nested policy override")
need(override["policy_pack"]["effective_sha256"] != profile["policy_pack"]["effective_sha256"],
     "override must change effective policy hash")
need(override["policy_pack"]["id"] == profile["policy_pack"]["id"],
     "override must retain pack identity")
try:
    profiles.get("broadcast_xdcam", {"video": {"typo_field": 1}})
    need(False, "unknown override must fail closed")
except ValueError:
    pass

# Optional MediaConch absence can never become a pass.
real_which = broadcast.shutil.which
try:
    broadcast.shutil.which = lambda _tool: None
    broadcast._tool_version.cache_clear()
    missing = broadcast.mediaconch_policy_checks(os.environ["GOOD"], profile)[0]
finally:
    broadcast.shutil.which = real_which
    broadcast._tool_version.cache_clear()
need(missing["status"] == "info" and missing["decision"]["outcome"] == "not_checked",
     "missing MediaConch must be FYI/not_checked")

print("PASS ✓  versioned U.S. broadcast XDCAM baseline + evidence fixtures" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
