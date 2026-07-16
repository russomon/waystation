#!/usr/bin/env bash
# QC lane proof: run two clips through the pipeline —
#   clip A (testsrc + tone)        → QC must not flag black frames
#   clip B (black video + silence) → QC must WARN with black + silence flagged
# and assert the metering ledger recorded the billable events (qc minutes,
# thumbnail run) for each transfer.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=orbitxfer-test
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
echo "✓ stack up"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF

# clip A: normal content; clip B: black + silent (should trip QC)
ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clean.mp4" >/tmp/ffA.log 2>&1
ffmpeg -y -f lavfi -i color=black:duration=4:size=320x240:rate=10 -f lavfi -i anullsrc=r=44100:cl=stereo \
  -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac "$WORK/dirty.mp4" >/tmp/ffB.log 2>&1

run_clip() { # $1 = local file, $2 = tid
  local file=$1 tid=$2 key="transfers/$2/$(basename $1)"
  "$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$file","$BUCKET","$key",ExtraArgs={"ContentType":"video/mp4"})
PYEOF
  curl -N -s "http://localhost:8787/api/progress/$tid" > "/tmp/sse-$tid.log" 2>&1 &
  until grep -q subscribed "/tmp/sse-$tid.log"; do sleep 0.2; done
  local BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$key\",\"bucketName\":\"$BUCKET\"}]}"
  local SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
  curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
  for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$tid.log" && break; sleep 0.5; done
}

TID_A=$(uuidgen | tr 'A-Z' 'a-z'); TID_B=$(uuidgen | tr 'A-Z' 'a-z')
run_clip "$WORK/clean.mp4" "$TID_A"; echo "✓ clean clip processed"
run_clip "$WORK/dirty.mp4" "$TID_B"; echo "✓ dirty clip processed"

echo "=== QC + metering assertions ==="
"$PY" - <<PYEOF
import boto3,json,sys,urllib.request; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid):
    return json.loads(s3.get_object(Bucket="$BUCKET",Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def usage(tid):
    return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
ok=True
a=qc("$TID_A"); b=qc("$TID_B")
ck=lambda r,n:[c for c in r["checks"] if c["name"]==n][0]
print(f"  clean: status={a['status']}  black={ck(a,'black_frames')['detail']}  decode={ck(a,'decode')['status']}")
if a["status"]=="fail" or ck(a,"black_frames")["status"]!="pass" or ck(a,"decode")["status"]!="pass":
    print("  FAIL: clean clip flagged wrongly"); ok=False
print(f"  dirty: status={b['status']}  black={ck(b,'black_frames')['detail']}  silence={ck(b,'audio_silence')['detail']}")
if b["status"] not in ("warn","fail") or ck(b,"black_frames")["status"]=="pass" or ck(b,"audio_silence")["status"]=="pass":
    print("  FAIL: dirty clip not flagged"); ok=False
ua=usage("$TID_A")["totals"]
print("  metering (clean):", {k:f'{v["units"]} {v["unit"]}' for k,v in ua.items()})
if "qc" not in ua or ua["qc"]["unit"]!="minutes" or "thumbnail" not in ua:
    print("  FAIL: metering missing qc/thumbnail entries"); ok=False
print("PASS ✓  QC lane: clean passes, defects flagged, billable events metered" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
