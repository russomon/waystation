#!/usr/bin/env bash
# QC lane proof: two clips through the pipeline —
#   clip A (testsrc + tone) + GOOD sidecar captions → QC passes, captions pass
#   clip B (black + silence) + BAD sidecar captions → warns: black, silence,
#     caption timing (overlap / past-EOF), caption readability (CPS / lines)
# Also proves: a .srt event never triggers its own pipeline run, and the
# metering ledger records the billable events.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
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

ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clean.mp4" >/tmp/ffA.log 2>&1
ffmpeg -y -f lavfi -i color=black:duration=4:size=320x240:rate=10 -f lavfi -i anullsrc=r=44100:cl=stereo \
  -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac "$WORK/dirty.mp4" >/tmp/ffB.log 2>&1

cat > "$WORK/good.srt" <<'SRT'
1
00:00:00,200 --> 00:00:01,400
Hello world

2
00:00:01,600 --> 00:00:02,800
A fine master
SRT
cat > "$WORK/bad.srt" <<'SRT'
1
00:00:00,000 --> 00:00:02,000
This caption line is deliberately far too long to pass the line length check
second line
third line means too many lines

2
00:00:01,000 --> 00:00:09,000
Overlapping cue that also runs way past the end of the video

3
00:00:09,100 --> 00:00:09,300
Far too many characters crammed into a tiny two hundred millisecond cue here
SRT

fire_event() { # $1=objectKey
  local BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$1\",\"bucketName\":\"$BUCKET\"}]}"
  local SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
  curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
}

run_clip() { # $1=videoFile $2=tid $3=sidecarFile
  local file=$1 tid=$2 sidecar=$3
  local key="transfers/$tid/$(basename $file)" capkey="transfers/$tid/$(basename $sidecar)"
  "$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$sidecar","$BUCKET","$capkey")
s3.upload_file("$file","$BUCKET","$key",ExtraArgs={"ContentType":"video/mp4"})
PYEOF
  curl -N -s "http://localhost:8787/api/progress/$tid" > "/tmp/sse-$tid.log" 2>&1 &
  until grep -q subscribed "/tmp/sse-$tid.log"; do sleep 0.2; done
  fire_event "$capkey"   # must be IGNORED (sidecar filter)
  fire_event "$key"
  for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$tid.log" && break; sleep 0.5; done
}

TID_A=$(uuidgen | tr 'A-Z' 'a-z'); TID_B=$(uuidgen | tr 'A-Z' 'a-z')
run_clip "$WORK/clean.mp4" "$TID_A" "$WORK/good.srt"; echo "✓ clean clip + good captions processed"
run_clip "$WORK/dirty.mp4" "$TID_B" "$WORK/bad.srt";  echo "✓ dirty clip + bad captions processed"

echo "=== QC + caption + metering assertions ==="
"$PY" - <<PYEOF
import boto3,json,sys,urllib.request; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid): return json.loads(s3.get_object(Bucket="$BUCKET",Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def usage(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
ck=lambda r,n:[c for c in r["checks"] if c["name"]==n][0]
ok=True
a=qc("$TID_A"); b=qc("$TID_B")
print(f"  clean: status={a['status']}")
for n in ("captions_present","captions_valid","caption_timing","caption_readability","caption_coverage"):
    c=ck(a,n); print(f"    {n}: {c['status']} — {c['detail']}")
    if c["status"]!="pass": print(f"  FAIL: clean clip {n} not pass"); ok=False
if a["status"]!="pass": print("  FAIL: clean overall not pass"); ok=False
print(f"  dirty: status={b['status']}")
for n in ("caption_timing","caption_readability"):
    c=ck(b,n); print(f"    {n}: {c['status']} — {c['detail']}")
    if c["status"]!="warn": print(f"  FAIL: dirty clip {n} not flagged"); ok=False
if ck(b,"black_frames")["status"]=="pass" or ck(b,"audio_silence")["status"]=="pass":
    print("  FAIL: dirty AV defects not flagged"); ok=False
# sidecar event filter: exactly ONE pipeline ran per transfer
for tid in ("$TID_A","$TID_B"):
    n=open(f"/tmp/sse-{tid}.log").read().count("pipeline_started")
    print(f"  pipeline runs for {tid[:8]}…: {n}")
    if n!=1: print("  FAIL: sidecar event triggered a pipeline run"); ok=False
ua=usage("$TID_A")["totals"]
print("  metering (clean):", {k:f'{v["units"]} {v["unit"]}' for k,v in ua.items()})
if "qc" not in ua or "thumbnail" not in ua: print("  FAIL: metering missing entries"); ok=False
print("PASS ✓  AV QC + caption QC + sidecar filter + metering" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
