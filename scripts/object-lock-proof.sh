#!/usr/bin/env bash
# Object Lock proof: run the loop with MANIFEST_LOCK_DAYS set against an
# Object-Lock-enabled bucket, then prove the manifest is WORM — it carries a
# COMPLIANCE retention and the locked version cannot be deleted.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=orbitxfer-locked
TID=$(uuidgen | tr 'A-Z' 'a-z'); KEY="transfers/$TID/test.mp4"
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
# pipeline with manifest Object Lock ON (1 day retention)
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED MANIFEST_LOCK_DAYS=1 ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ stack up (pipeline: MANIFEST_LOCK_DAYS=1)"

# Object-Lock-ENABLED bucket (must be set at creation; also enables versioning)
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET", ObjectLockEnabledForBucket=True); print("  Object-Lock bucket created")
except Exception as e: print("  bucket:",e)
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/test.mp4" >/tmp/ff.log 2>&1
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$WORK/test.mp4","$BUCKET","$KEY",ExtraArgs={"ContentType":"video/mp4"})
PYEOF

curl -N -s "http://localhost:8787/api/progress/$TID" > /tmp/sse.log 2>&1 &
until grep -q subscribed /tmp/sse.log; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
for i in $(seq 1 120); do grep -q pipeline_complete /tmp/sse.log && break; sleep 0.5; done
echo "✓ pipeline complete"; grep -o '"locked_until":"[^"]*"' /tmp/sse.log | head -1

echo "=== prove the manifest is WORM ==="
"$PY" - <<PYEOF
import boto3,sys; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
mkey="derivatives/$TID/manifest.json"
h=s3.head_object(Bucket="$BUCKET",Key=mkey)
mode=h.get("ObjectLockMode"); until=h.get("ObjectLockRetainUntilDate")
print("  manifest ObjectLockMode:",mode,"retainUntil:",until)
if mode!="COMPLIANCE" or not until: print("  FAIL: manifest not locked"); sys.exit(1)
vid=s3.list_object_versions(Bucket="$BUCKET",Prefix=mkey)["Versions"][0]["VersionId"]
try:
    s3.delete_object(Bucket="$BUCKET",Key=mkey,VersionId=vid)
    print("  FAIL: deleted a COMPLIANCE-locked version!"); sys.exit(1)
except Exception as e:
    print("  delete of locked version rejected:",type(e).__name__)
print("PASS ✓  manifest written under COMPLIANCE Object Lock and is immutable (WORM)")
PYEOF
