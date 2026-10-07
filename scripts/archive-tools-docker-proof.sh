#!/usr/bin/env bash
# Assert exact headless QCTools/MediaConch tooling inside an EXISTING worker image.
# Isolation: see scripts/lib/docker-isolation.sh. This proof never builds, pulls, tags or
# removes a shared image; it needs WS_PROOF_WORKER_IMAGE to name a local image whose
# application files match this working tree (or an authorized --docker-build), and it runs
# one ephemeral, labelled, resource-capped, network-less container.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QCOMMIT="29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2"
# shellcheck source=lib/docker-isolation.sh
. "$WEB/scripts/lib/docker-isolation.sh"
ws_dk_begin archive
trap ws_dk_cleanup EXIT
ws_dk_obtain_image worker

echo "- verifying headless CLI versions and image provenance -"
ws_dk run --rm --name "${WS_DK_RUN_ID}-archive" --label "$WS_DK_LABEL" "${WS_DK_LIMITS[@]}" --network none \
  -e PYTHONDONTWRITEBYTECODE=1 --entrypoint sh "$WS_DK_IMAGE_ID" -c '
  set -eu
  command -v qcli >/dev/null
  command -v mediaconch >/dev/null
  qcli -v 2>&1 | grep -F "29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2"
  mediaconch --Version 2>&1 | grep -F "25.04"
  ffmpeg -v error -f lavfi -i testsrc=duration=1:size=160x90:rate=5 \
    -f lavfi -i sine=duration=1 -c:v ffv1 -c:a pcm_s16le -shortest /tmp/probe.mkv
  cd /tmp
  qcli -i probe.mkv >/dev/null
  test -s probe.mkv.qctools.mkv
  cd /app
  python -c "from qc import archive_tools as a; i=a.inventory(); c=a.checks(i); assert all(x[\"available\"] and x[\"state\"] == \"available_not_active\" for x in i); assert all(x[\"status\"] == \"info\" and \"not checked\" in x[\"detail\"].lower() for x in c)"
  mkdir -p /tmp/qctools-proof
  python - <<"PY"
from qc import profiles, qctools
p = profiles.get("broadcast_xdcam")
checks, report = qctools.analyze("/tmp/probe.mkv", "/tmp/qctools-proof", 1.0, p)
assert checks[0]["status"] == "info", checks
assert checks[0]["decision"]["authority"] == "deterministic_advisory", checks
assert report["state"] == "measured_advisory", report
assert report["artifacts"][0]["sha256"], report
assert report["windows"][0]["metrics"]["lavfi.signalstats.YAVG"], report
print("  bounded qcli reducer:", checks[0]["detail"])
PY
  ! command -v qctools >/dev/null
  ! command -v mediaconch-gui >/dev/null
' || { echo "FAIL: in-container assertions"; exit 1; }

[ "${WS_DOCKER_PLAN:-0}" = 1 ] && { ws_dk image inspect "$WS_DK_IMAGE_ID" --format '{{ index .Config.Labels "org.opencontainers.image.waystation.qctools.revision" }}'; echo "PLAN-ONLY: nothing executed"; exit 0; }
[ "$(ws_dk image inspect "$WS_DK_IMAGE_ID" --format '{{ index .Config.Labels "org.opencontainers.image.waystation.qctools.revision" }}')" = "$QCOMMIT" ] \
  || { echo "FAIL: QCTools revision label mismatch"; exit 1; }
[ "$(ws_dk image inspect "$WS_DK_IMAGE_ID" --format '{{ index .Config.Labels "org.opencontainers.image.waystation.mediaconch.package-version" }}')" = "25.04-2" ] \
  || { echo "FAIL: MediaConch package label mismatch"; exit 1; }

echo "PASS ✓  worker image contains pinned headless qcli + MediaConch CLIs only"
