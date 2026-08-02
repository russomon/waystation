#!/usr/bin/env bash
# Docker proof: pinned MediaConch runs the checked-in broadcast policy.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="waystation-broadcast-qc-proof:local"

command -v docker >/dev/null || { echo "SKIP - docker not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP - docker daemon not running"; exit 0; }

echo "- building worker image -"
docker build -t "$IMAGE" "$WEB/pipeline" || { echo "FAIL: worker image build"; exit 1; }

echo "- exercising MediaConch baseline policy in the worker -"
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -eu
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=s=1920x1080:r=30000/1001:d=2" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=2" \
    -vf setfield=tff -c:v mpeg2video -profile:v 0 -level:v 2 \
    -pix_fmt yuv422p -flags +ildct+ilme -top 1 \
    -b:v 50M -minrate 50M -maxrate 50M -bufsize 17825792 \
    -g 15 -bf 2 -sc_threshold 1000000000 \
    -c:a pcm_s24le -ar 48000 -ac 2 -timecode "01:00:00;00" \
    -f mxf /tmp/good.mxf
  ffmpeg -y -v error \
    -f lavfi -i "testsrc2=s=1280x720:r=25:d=2" \
    -f lavfi -i "sine=frequency=1000:sample_rate=44100:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /tmp/bad.mp4
  python - <<"PY"
from qc import broadcast, profiles
p = profiles.get("us_broadcast_xdcam_hd_422_v1")
good = broadcast.mediaconch_policy_checks("/tmp/good.mxf", p)[0]
bad = broadcast.mediaconch_policy_checks("/tmp/bad.mp4", p)[0]
assert good["status"] == "pass", good
assert bad["status"] == "fail", bad
assert len(good["observation"]["value"]["tests"]) == 16, good
assert good["evidence"][0]["sha256"], good
assert good["provenance"]["version"].endswith("25.04"), good
print("  good:", good["detail"])
print("  bad:", bad["detail"])
PY
' || { echo "FAIL: Docker MediaConch policy outcomes"; exit 1; }

echo "PASS ✓  Docker MediaConch policy good/bad outcomes"
