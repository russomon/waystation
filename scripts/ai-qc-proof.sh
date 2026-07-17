#!/usr/bin/env bash
# AI-assisted QC lane proof — deterministic, no cloud spend. A mock GMI server
# (OpenAI-compatible /v1/chat/completions) answers vision requests with a
# canned finding and audio requests with a canned transcript, so we can assert:
#   clip A + captions MATCHING the "speech" → ai_caption_accuracy PASS (100%)
#   clip B + unrelated captions           → ai_caption_accuracy WARN (low match)
#   both clips                            → ai_visual WARN ("test pattern" finding)
#   metering                              → qc_ai (frames) + qc_ai_asr (seconds)
#   qc_ai disabled                        → no ai_* checks, step_skipped
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=orbitxfer-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; lsof -ti:8009; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; lsof -ti:8009; } 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── mock GMI: vision → canned finding; audio → canned transcript ──
"$PY" - <<'PYEOF' >/tmp/mockgmi.log 2>&1 &
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = body["messages"][0]["content"]
        kinds = [p.get("type") for p in content] if isinstance(content, list) else []
        if "input_audio" in kinds:
            text = "hello world a fine master"
        elif "image_url" in kinds:
            text = json.dumps({"findings": [{"issue": "SMPTE color bars test pattern", "frames": [1, 2]}],
                               "summary": "synthetic test pattern frames"})
        else:
            text = "A short synthetic test clip."
        data = json.dumps({"choices": [{"message": {"content": text}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 8009), H).serve_forever()
PYEOF
until curl -s -o /dev/null -X POST http://localhost:8009/v1/chat/completions -H 'content-type: application/json' --data '{"messages":[{"content":"ping"}]}'; do sleep 0.3; done

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED \
   GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8009 GMI_MULTIMODAL_MODEL=mock-multimodal GMI_MODEL=mock-text \
   ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ stack up (mock GMI on :8009)"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF

ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/tmp/ff.log 2>&1

cat > "$WORK/match.srt" <<'SRT'
1
00:00:00,200 --> 00:00:01,400
Hello world

2
00:00:01,600 --> 00:00:02,800
A fine master
SRT
cat > "$WORK/mismatch.srt" <<'SRT'
1
00:00:00,200 --> 00:00:01,400
Completely different dialogue here

2
00:00:01,600 --> 00:00:02,800
Nothing like the actual audio content
SRT

fire_event() {
  local BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$1\",\"bucketName\":\"$BUCKET\"}]}"
  local SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
  curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
}

run_clip() { # $1=tid $2=sidecar
  local tid=$1 sidecar=$2
  local key="transfers/$tid/clip.mp4" capkey="transfers/$tid/$(basename $2)"
  "$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$sidecar","$BUCKET","$capkey")
s3.upload_file("$WORK/clip.mp4","$BUCKET","$key",ExtraArgs={"ContentType":"video/mp4"})
PYEOF
  curl -N -s "http://localhost:8787/api/progress/$tid" > "/tmp/sse-$tid.log" 2>&1 &
  until grep -q subscribed "/tmp/sse-$tid.log"; do sleep 0.2; done
  fire_event "$key"
  for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$tid.log" && break; sleep 0.5; done
}

TID_A=$(uuidgen | tr 'A-Z' 'a-z'); TID_B=$(uuidgen | tr 'A-Z' 'a-z')
run_clip "$TID_A" "$WORK/match.srt";    echo "✓ clip A (matching captions) processed"
run_clip "$TID_B" "$WORK/mismatch.srt"; echo "✓ clip B (mismatched captions) processed"

# clip C: qc_ai explicitly OFF via a direct worker job (options plumb-through)
TID_C=$(uuidgen | tr 'A-Z' 'a-z')
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$WORK/clip.mp4","$BUCKET","transfers/$TID_C/clip.mp4",ExtraArgs={"ContentType":"video/mp4"})
PYEOF
curl -N -s "http://localhost:8787/api/progress/$TID_C" > "/tmp/sse-$TID_C.log" 2>&1 &
until grep -q subscribed "/tmp/sse-$TID_C.log"; do sleep 0.2; done
curl -sS -o /dev/null -X POST http://localhost:8000/jobs -H "content-type: application/json" -H "authorization: Bearer $SHARED" \
  --data "{\"bucket\":\"$BUCKET\",\"key\":\"transfers/$TID_C/clip.mp4\",\"transferId\":\"$TID_C\",\"gatewayUrl\":\"http://localhost:8787\",\"options\":{\"qc_ai\":false}}"
for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$TID_C.log" && break; sleep 0.5; done
echo "✓ clip C (qc_ai off) processed"

echo "=== AI QC assertions ==="
"$PY" - "$TID_A" "$TID_B" "$TID_C" <<'PYEOF'
import boto3, json, sys, urllib.request; from botocore.config import Config
ta, tb, tc = sys.argv[1:4]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid): return json.loads(s3.get_object(Bucket="orbitxfer-test", Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def usage(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
def ck(r, n):
    hits = [c for c in r["checks"] if c["name"] == n]
    return hits[0] if hits else None
ok = True
a, b, c = qc(ta), qc(tb), qc(tc)

v = ck(a, "ai_visual")
print(f"  A ai_visual: {v['status']} — {v['detail']}")
if v["status"] != "warn" or "test pattern" not in v["detail"]: print("  FAIL: vision finding missing"); ok = False
acc = ck(a, "ai_caption_accuracy")
print(f"  A ai_caption_accuracy: {acc['status']} — {acc['detail']}")
if acc["status"] != "pass" or "100" not in acc["detail"]: print("  FAIL: matching captions should pass at 100%"); ok = False
if not ck(a, "captions_valid"): print("  FAIL: deterministic checks missing from merged report"); ok = False
if a["status"] != "warn": print("  FAIL: overall should be warn (vision finding)"); ok = False
if a.get("ai", {}).get("model") != "mock-multimodal": print("  FAIL: ai provenance block missing"); ok = False

accb = ck(b, "ai_caption_accuracy")
print(f"  B ai_caption_accuracy: {accb['status']} — {accb['detail']}")
if accb["status"] != "warn": print("  FAIL: mismatched captions should warn"); ok = False

if any(x["name"].startswith("ai_") for x in c["checks"]): print("  FAIL: qc_ai=false still produced ai checks"); ok = False
sse_c = open(f"/tmp/sse-{tc}.log").read()
if '"step":"qc_ai"' not in sse_c or "step_skipped" not in sse_c: print("  FAIL: qc_ai skip event missing"); ok = False
print("  C: no ai_* checks, qc_ai step_skipped ✓")

ua = usage(ta)["totals"]
print("  metering (A):", {k: f'{v["units"]} {v["unit"]}' for k, v in ua.items()})
if "qc_ai" not in ua or ua["qc_ai"]["unit"] != "frames": print("  FAIL: qc_ai frames not metered"); ok = False
if "qc_ai_asr" not in ua or ua["qc_ai_asr"]["unit"] != "seconds": print("  FAIL: ASR seconds not metered"); ok = False

print("PASS ✓  AI QC lane: vision + caption accuracy + gating + metering" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
