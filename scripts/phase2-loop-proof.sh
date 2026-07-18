#!/usr/bin/env bash
# Phase 2 vertical slice: B2 event → gateway → pipeline (real ffprobe+ffmpeg
# work) → progress → SSE, with derivatives + manifest landing back in storage.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
TID=$(uuidgen | tr 'A-Z' 'a-z'); KEY="transfers/$TID/test.mp4"
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── start MinIO, gateway, pipeline ──
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ minio + gateway + pipeline up"

# ── create bucket, make a REAL test video, upload it as the "original" ──
$PY - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception as e: print("bucket:",e)
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/test.mp4" >/tmp/ff.log 2>&1
$PY - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$WORK/test.mp4","$BUCKET","$KEY",ExtraArgs={"ContentType":"video/mp4"})
print("✓ uploaded original:","$KEY")
PYEOF

# ── subscribe to SSE, then fire a SIGNED B2 event ──
curl -N -s "http://localhost:8787/api/progress/$TID" > /tmp/sse.log 2>&1 &
until grep -q subscribed /tmp/sse.log; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -w "✓ signed B2 event POST → HTTP %{http_code}\n" -X POST http://localhost:8787/api/events/b2 \
  -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"

# ── wait for the loop to finish ──
for i in $(seq 1 120); do grep -q pipeline_complete /tmp/sse.log && break; sleep 0.5; done
echo "=== SSE progress stream (what the browser would see live) ==="
sed 's/^data: //' /tmp/sse.log | grep -v '^$'
echo "=== derivatives written back to storage ==="
$PY - <<PYEOF
import boto3,sys,json; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
ok=True
for k in ["derivatives/$TID/thumb.jpg","derivatives/$TID/manifest.json"]:
    try:
        h=s3.head_object(Bucket="$BUCKET",Key=k); print("  FOUND",k,"—",h["ContentLength"],"bytes")
    except Exception as e: print("  MISSING",k,e); ok=False
print("  manifest:",s3.get_object(Bucket="$BUCKET",Key="derivatives/$TID/manifest.json")["Body"].read().decode())
sys.exit(0 if ok else 1)
PYEOF
RC=$?
echo "================================================================"
if grep -q pipeline_complete /tmp/sse.log && [ $RC -eq 0 ]; then
  echo "PASS ✓  B2 event → gateway → pipeline (real ffprobe+ffmpeg) → SSE → derivatives+manifest in storage"
else
  echo "FAIL"; echo "--- pipeline log ---"; tail -20 /tmp/pipe.log; exit 1
fi
