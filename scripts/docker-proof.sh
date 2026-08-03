#!/usr/bin/env bash
# Containerized-deployment proof: the SAME images you'd ship to a VPS /
# Fly.io / Fargate run the full loop — gateway + worker + MinIO all in
# containers, a signed b2:ObjectCreated event drives the pipeline, and the
# derivatives + SDK-verified Genblaze manifest land in the bucket.
# Also asserts ffmpeg, MediaInfo, headless QCTools/MediaConch, and Netflix
# Photon are baked into the worker image.
set -u
export PATH="/opt/homebrew/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
COMPOSE=(docker compose -f "$WEB/docker-compose.yml" -f "$WEB/scripts/docker-proof.override.yml")

command -v docker >/dev/null || { echo "SKIP — docker not installed"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP — docker daemon not running (colima start)"; exit 0; }
docker compose version >/dev/null 2>&1 || { echo "SKIP — docker compose plugin missing"; exit 0; }

cleanup(){ "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; rm -rf "$WORK"; }
WORK=$(mktemp -d); trap cleanup EXIT
SECRET=evsecretevsecretevsecretevsecret

echo "— building + starting containers —"
"${COMPOSE[@]}" up -d --build --quiet-pull 2>&1 | tail -2 || { echo "FAIL: compose up"; exit 1; }
for i in $(seq 1 90); do curl -sf -o /dev/null --max-time 2 http://localhost:8787/ && break; sleep 1; done
curl -sf -o /dev/null --max-time 2 http://localhost:8787/ || { echo "FAIL: gateway never came up"; "${COMPOSE[@]}" logs --tail 10 gateway; exit 1; }
for i in $(seq 1 60); do curl -sf -o /dev/null --max-time 2 http://localhost:9000/minio/health/live && break; sleep 1; done
echo "✓ gateway + worker + minio containers up"

echo "— toolchain baked into the worker image —"
docker exec "$( "${COMPOSE[@]}" ps -q worker )" sh -c '
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
assert interpretive_run.SCHEMA_VERSION == "waystation-ai-interpretive-run/1.3"
assert ai_authority.load_policy()["version"] == "1.1.0"
print("policy 1.4.0 + deep package/caption/benchmark/shadow + dual-key interpretive 1.3 adapters")
PY
' || { echo "FAIL: worker toolchain assertion"; exit 1; }

"$PY" - <<'PYEOF'
import boto3; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
try: s3.create_bucket(Bucket="waystation-test")
except Exception: pass
PYEOF

ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/dev/null 2>&1
TID=$(uuidgen | tr 'A-Z' 'a-z'); KEY="transfers/$TID/clip.mp4"
"$PY" - "$WORK/clip.mp4" "$KEY" <<'PYEOF'
import boto3, sys; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
s3.upload_file(sys.argv[1], "waystation-test", sys.argv[2], ExtraArgs={"ContentType": "video/mp4"})
print("✓ master uploaded to containerized bucket")
PYEOF

curl -N -s "http://localhost:8787/api/progress/$TID" > "$WORK/sse.log" 2>&1 &
until grep -q subscribed "$WORK/sse.log"; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"waystation-test\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 \
  -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
echo "✓ signed event accepted by containerized gateway"
for i in $(seq 1 180); do grep -q pipeline_complete "$WORK/sse.log" && break; sleep 1; done
grep -q pipeline_complete "$WORK/sse.log" || { echo "FAIL: pipeline did not complete"; "${COMPOSE[@]}" logs --tail 15 worker; exit 1; }
echo "✓ containerized pipeline complete"

"$PY" - "$TID" <<'PYEOF'
import boto3, json, sys; from botocore.config import Config
sys.path.insert(0, __import__("os").path.join(__import__("os").path.dirname(__file__) or ".", ))
tid = sys.argv[1]
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
keys = sorted(o["Key"].split("/")[-1] for o in
              s3.list_objects_v2(Bucket="waystation-test", Prefix=f"derivatives/{tid}/").get("Contents", []))
print(f"  derivatives: {keys}")
assert "qc_report.json" in keys and "manifest.json" in keys and "thumb.jpg" in keys, "derivatives missing"
man = json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/manifest.json")["Body"].read())
from genblaze_core.models import parse_manifest
gb = parse_manifest(man)
assert gb.verify_hash(), "genblaze manifest failed SDK verification"
print(f"  genblaze manifest v{gb.schema_version}, SDK verify_hash: {gb.verify_hash()}")
qc = json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
print(f"  qc: {qc['status']} tiers={qc['tiers']} ({len(qc['checks'])} checks)")
assert qc["delivery_authority"] == "deterministic_policy_only"
assert qc["advisory_tiers"]["BLOCKER"] == 0
assert qc["ai_interpretive_shadow"]["enabled"] is False
assert "ai_interpretive_analysis" not in qc
assert any(item["name"] == "caption_cea_transport_visibility" for item in qc["checks"])
print("PASS ✓  the shipped containers run the full waystation loop")
PYEOF
