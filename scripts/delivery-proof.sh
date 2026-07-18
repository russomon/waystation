#!/usr/bin/env bash
# Delivery page proof: run the full loop, then exercise the recipient
# endpoint (/api/transfers/:id) and the provenance verify (re-hash the
# original + derivatives, compare to the manifest) — exactly what the
# browser's "Verify provenance" button does.
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

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ minio + gateway + pipeline up"

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
print("✓ uploaded original")
PYEOF

# fire the pipeline (signed event), wait for completion
curl -N -s "http://localhost:8787/api/progress/$TID" > /tmp/sse.log 2>&1 &
until grep -q subscribed /tmp/sse.log; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
for i in $(seq 1 120); do grep -q pipeline_complete /tmp/sse.log && break; sleep 0.5; done
echo "✓ pipeline complete"

echo "=== delivery endpoint + provenance verify (what the recipient page does) ==="
$PY - <<PYEOF
import json, hashlib, urllib.request, sys
g="http://localhost:8787"
t=json.load(urllib.request.urlopen(f"{g}/api/transfers/$TID"))
print("  GET /api/transfers/$TID:")
print("    original:", t["original"]["filename"], t["original"]["size"], "bytes")
print("    derivatives:", [d["key"].split("/")[-1] for d in t["derivatives"]])
print("    manifestUrl:", "present" if t["manifestUrl"] else "MISSING")
assert t["original"]["filename"]=="test.mp4"
assert t["manifestUrl"]
assert any(d["mime"]=="image/jpeg" for d in t["derivatives"]), "no thumbnail"
man=json.load(urllib.request.urlopen(t["manifestUrl"]))
def sha(url):
    h=hashlib.sha256(); h.update(urllib.request.urlopen(url).read()); return h.hexdigest()
# Genblaze manifest (genblaze-core): run.steps[].inputs/assets, s3:// asset urls
from genblaze_core.models import parse_manifest
gb = parse_manifest(man)
print(f"    genblaze schema v{gb.schema_version}, canonical hash ok: {gb.verify_hash()}")
assert gb.verify_hash(), "SDK hash verification failed"
steps = man["run"]["steps"]
ok = sha(t["original"]["url"])==steps[0]["inputs"][0]["sha256"]
print(f"    verify original  sha256 == manifest: {'✓' if ok else '✗'}")
thumb=[d for d in t["derivatives"] if d["mime"]=="image/jpeg"][0]
tstep=[s for s in steps if s["step_id"]=="thumbnail"][0]
ok2 = sha(thumb["url"])==tstep["assets"][0]["sha256"]
print(f"    verify thumbnail sha256 == manifest: {'✓' if ok2 else '✗'}")
sys.exit(0 if ok and ok2 and gb.verify_hash() else 1)
PYEOF
RC=$?
echo "================================================================"
[ $RC -eq 0 ] && echo "PASS ✓  delivery endpoint serves original+derivatives+manifest; provenance re-hash verifies" || { echo FAIL; exit 1; }
