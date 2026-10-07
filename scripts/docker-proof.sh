#!/usr/bin/env bash
# Containerized-deployment proof: the SAME images you'd ship to a VPS / Fly.io / Fargate
# run the full loop: gateway + worker + MinIO all in containers, a signed
# b2:ObjectCreated event drives the pipeline, and the derivatives + SDK-verified
# Genblaze manifest land in the bucket. Also asserts ffmpeg, MediaInfo, headless
# QCTools/MediaConch, and Netflix Photon are baked into the worker image.
#
# ISOLATION (scripts/lib/docker-isolation.sh). The Docker daemon is shared, so this proof
# no longer uses `docker compose` (whose default project name, shared image tags,
# `env_file: .env` and project-wide `down -v` could touch other workloads or load real
# credentials). It creates ONE labelled network and three labelled containers named for
# this run, passes only the synthetic variables below (no .env, no env file, no host
# mounts), publishes only to 127.0.0.1 on free ports, caps resources, and removes only the
# objects carrying this run's label. It never builds, pulls or tags unless separately
# authorized, and it refuses an existing image whose application files differ from this
# working tree. Equivalence with docker-compose.yml's wiring (service names, PIPELINE_URL,
# GATEWAY_PUBLIC_URL, PHOTON_JAR, WORKER_LABEL) is by construction here, not exercised via
# the compose file itself.
set -u
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Source the isolation library BEFORE touching PATH: it pins the docker executable once, so the
# Homebrew prepend below cannot swap in a different `docker`.
# shellcheck source=lib/docker-isolation.sh
. "$WEB/scripts/lib/docker-isolation.sh"
export PATH="/opt/homebrew/bin:$PATH"
PY="$WEB/pipeline/.venv/bin/python"

ws_dk_begin dockerloop
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
cleanup(){ ws_dk_cleanup; rm -rf "$WORK"; }
trap cleanup EXIT
SECRET=evsecretevsecretevsecretevsecret
BUCKET=waystation-test

ws_dk_obtain_image worker;  WORKER_IMAGE="$WS_DK_IMAGE_ID"
ws_dk_obtain_image gateway; GATEWAY_IMAGE="$WS_DK_IMAGE_ID"
export WS_PROOF_MINIO_IMAGE="${WS_PROOF_MINIO_IMAGE:-minio/minio:latest}"
ws_dk_resolve_image WS_PROOF_MINIO_IMAGE minio; MINIO_IMAGE="$WS_DK_IMAGE_ID"

if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then GWP=18787; MINP=19000; else GWP=$(ws_dk_free_port); MINP=$(ws_dk_free_port); fi
NET="${WS_DK_RUN_ID}-net"
COMMON=(--label "$WS_DK_LABEL" "${WS_DK_LIMITS[@]}" --network "$NET")
B2ENV=(-e B2_S3_ENDPOINT=http://minio:9000 -e B2_REGION=us-east-1 -e B2_KEY_ID=minioadmin -e B2_APP_KEY=minioadmin
       -e "B2_BUCKET=$BUCKET" -e B2_FORCE_PATH_STYLE=true -e PIPELINE_SHARED_SECRET=ps)

echo "— starting this run's containers (network $NET) —"
ws_dk network create --label "$WS_DK_LABEL" "$NET" >/dev/null || { echo "FAIL: network"; exit 1; }
ws_dk run -d --name "${WS_DK_RUN_ID}-minio" "${COMMON[@]}" --network-alias minio -p "127.0.0.1:${MINP}:9000" \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin "$MINIO_IMAGE" server /data >/dev/null || { echo "FAIL: minio"; exit 1; }
ws_dk run -d --name "${WS_DK_RUN_ID}-worker" "${COMMON[@]}" --memory 2g --memory-swap 2g --tmpfs /tmp:rw,size=2g --network-alias worker \
  "${B2ENV[@]}" -e GMI_API_KEY= -e MANIFEST_LOCK_DAYS=0 -e PHOTON_JAR=/opt/photon -e WORKER_LABEL=cloud-docker \
  -e PYTHONDONTWRITEBYTECODE=1 "$WORKER_IMAGE" >/dev/null || { echo "FAIL: worker"; exit 1; }
ws_dk run -d --name "${WS_DK_RUN_ID}-gateway" "${COMMON[@]}" --network-alias gateway -p "127.0.0.1:${GWP}:8787" \
  "${B2ENV[@]}" -e PORT=8787 -e PIPELINE_URL=http://worker:8000 -e PIPELINE_URL_CLOUD=http://worker:8000 \
  -e GATEWAY_PUBLIC_URL=http://gateway:8787 -e "B2_EVENT_SIGNING_SECRET=$SECRET" -e CDN_BASE=https://cdn.test -e CDN_TOKEN_SECRET=dev \
  "$GATEWAY_IMAGE" >/dev/null || { echo "FAIL: gateway"; exit 1; }

if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then
  ws_dk exec "${WS_DK_RUN_ID}-worker" sh -c 'ffmpeg -version | head -1'
  ws_dk_cleanup
  echo "PLAN-ONLY: nothing executed"; exit 0
fi

for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$GWP/" && break; sleep 1; done
curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$GWP/" || { echo "FAIL: gateway never came up"; ws_dk logs --tail 10 "${WS_DK_RUN_ID}-gateway"; exit 1; }
for i in $(seq 1 60); do curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$MINP/minio/health/live" && break; sleep 1; done
echo "✓ gateway + worker + minio containers up (loopback ports $GWP / $MINP)"

echo "— toolchain baked into the worker image —"
ws_dk exec "${WS_DK_RUN_ID}-worker" sh -c '
  set -eu
  ffmpeg -version 2>/dev/null | head -1
  mediainfo --Version | head -1
  qcli -v 2>&1 | grep -F "29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2"
  mediaconch --Version 2>&1 | grep -F "25.04"
  ! command -v qctools >/dev/null
  ! command -v mediaconch-gui >/dev/null
  java -version 2>&1 | head -1
  test "$(find /opt/photon -name "*.jar" | wc -l)" -gt 0
  python - <<"PY"
from qc import ai_authority, benchmark, caption_transport, deep_package, interpretive_run, profiles, shadow_evaluation
assert profiles.get("us_broadcast_xdcam_hd_422_v1")["policy_pack"]["version"] == "1.4.0"
assert caption_transport.SCHEMA_VERSION == "waystation-caption-transport/1.0"
assert deep_package.SCHEMA_VERSION == "waystation-deep-package-evidence/1.0"
assert benchmark.SCHEMA_VERSION == "waystation-commercial-qc-benchmark/1.0"
assert shadow_evaluation.SCHEMA_VERSION == "waystation-ai-shadow-review/1.0"
assert interpretive_run.SCHEMA_VERSION == "waystation-ai-interpretive-run/1.8"
assert ai_authority.load_policy()["version"] == "1.2.0"
print("policy 1.4.0 + deep package/caption/benchmark/shadow + consolidated interpretive 1.8 adapters")
PY
' || { echo "FAIL: worker toolchain assertion"; exit 1; }

"$PY" - "$MINP" "$BUCKET" <<'PYEOF'
import boto3, sys; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{sys.argv[1]}", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
try: s3.create_bucket(Bucket=sys.argv[2])
except Exception: pass
PYEOF

ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/dev/null 2>&1
TID=$(uuidgen | tr 'A-Z' 'a-z'); KEY="transfers/$TID/clip.mp4"
"$PY" - "$WORK/clip.mp4" "$KEY" "$MINP" "$BUCKET" <<'PYEOF'
import boto3, sys; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{sys.argv[3]}", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
s3.upload_file(sys.argv[1], sys.argv[4], sys.argv[2], ExtraArgs={"ContentType": "video/mp4"})
print("✓ master uploaded to containerized bucket")
PYEOF

curl -N -s "http://127.0.0.1:$GWP/api/progress/$TID" > "$WORK/sse.log" 2>&1 &
SSE_PID=$!
until grep -q subscribed "$WORK/sse.log"; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST "http://127.0.0.1:$GWP/api/events/b2" \
  -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
echo "✓ signed event accepted by containerized gateway"
for i in $(seq 1 180); do grep -q pipeline_complete "$WORK/sse.log" && break; sleep 1; done
kill "$SSE_PID" 2>/dev/null || true
grep -q pipeline_complete "$WORK/sse.log" || { echo "FAIL: pipeline did not complete"; ws_dk logs --tail 15 "${WS_DK_RUN_ID}-worker"; exit 1; }
echo "✓ containerized pipeline complete"

"$PY" - "$TID" "$MINP" "$BUCKET" <<'PYEOF'
import boto3, json, sys; from botocore.config import Config
tid, port, bucket = sys.argv[1:4]
s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{port}", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
keys = sorted(o["Key"].split("/")[-1] for o in
              s3.list_objects_v2(Bucket=bucket, Prefix=f"derivatives/{tid}/").get("Contents", []))
print(f"  derivatives: {keys}")
assert "qc_report.json" in keys and "manifest.json" in keys and "thumb.jpg" in keys, "derivatives missing"
man = json.loads(s3.get_object(Bucket=bucket, Key=f"derivatives/{tid}/manifest.json")["Body"].read())
from genblaze_core.models import parse_manifest
gb = parse_manifest(man)
assert gb.verify_hash(), "genblaze manifest failed SDK verification"
print(f"  genblaze manifest v{gb.schema_version}, SDK verify_hash: {gb.verify_hash()}")
qc = json.loads(s3.get_object(Bucket=bucket, Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
print(f"  qc: {qc['status']} tiers={qc['tiers']} ({len(qc['checks'])} checks)")
assert qc["delivery_authority"] == "deterministic_policy_only"
assert qc["advisory_tiers"]["BLOCKER"] == 0
assert qc["ai_interpretive_shadow"]["enabled"] is False
assert "ai_interpretive_analysis" not in qc
assert any(item["name"] == "caption_cea_transport_visibility" for item in qc["checks"])
print("PASS ✓  the shipped containers run the full waystation loop")
PYEOF
