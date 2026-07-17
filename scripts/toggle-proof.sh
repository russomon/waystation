#!/usr/bin/env bash
# Service-toggle proof: the sender's checkboxes actually gate the waystation.
#   T1  all services OFF  → pipeline_skipped (transfer-only), zero derivatives,
#       and the signed B2 event for the same key is ALSO skipped (stored options)
#   T2  caption QC only   → qc_report has caption checks but NO AV checks,
#       thumbnail + summary steps report step_skipped, no thumb/summary objects
#   T3  no options sent   → everything runs (back-compat default)
# Plus: /uploads/sidecar-url rejects non-.srt/.vtt filenames.
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
   DEV_TRIGGER_ON_COMPLETE=true \
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
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/tmp/ff.log 2>&1
cat > "$WORK/caps.srt" <<'SRT'
1
00:00:00,200 --> 00:00:01,400
Hello world

2
00:00:01,600 --> 00:00:02,800
A fine master
SRT

# Upload through the REAL gateway flow (initiate → presigned PUT → complete
# with options), i.e. exactly what client/src/uploader.ts does.
send() { # $1=tid-logfile-tag $2=optionsJSON-or-"null" $3=sidecar-or-""
  "$PY" - "$1" "$2" "$3" <<'PYEOF'
import json, sys, urllib.request, subprocess
tag, opts_json, sidecar = sys.argv[1], sys.argv[2], sys.argv[3]
GW = "http://localhost:8787/api"
def post(p, body):
    r = urllib.request.urlopen(urllib.request.Request(GW+p, json.dumps(body).encode(), {"content-type":"application/json"}))
    return json.loads(r.read())
data = open(f"/tmp/toggle-work/clip.mp4","rb").read()
up = post("/uploads", {"filename":"clip.mp4","contentType":"video/mp4","size":len(data)})
key, uid = up["key"], up["uploadId"]
tid = key.split("/")[1]
open(f"/tmp/sse-cmd-{tag}","w").write(tid)
# subscribe to SSE before completing
sse = subprocess.Popen(["curl","-N","-s",f"{GW}/progress/{tid}"], stdout=open(f"/tmp/sse-{tag}.log","w"))
import time
for _ in range(50):
    if "subscribed" in open(f"/tmp/sse-{tag}.log").read(): break
    time.sleep(0.2)
urls = post("/uploads/parts", {"key":key,"uploadId":uid,"partNumbers":[1]})["urls"]
req = urllib.request.Request(urls["1"], data, method="PUT"); urllib.request.urlopen(req)
if sidecar:
    sc = post("/uploads/sidecar-url", {"key":key,"filename":sidecar.split("/")[-1]})
    req = urllib.request.Request(sc["url"], open(sidecar,"rb").read(), method="PUT"); urllib.request.urlopen(req)
body = {"key":key,"uploadId":uid,"blake3Root":"deadbeef"}
opts = json.loads(opts_json)
if opts is not None: body["options"] = opts
post("/uploads/complete", body)
print(tid)
PYEOF
}
rm -rf /tmp/toggle-work; mkdir -p /tmp/toggle-work; cp "$WORK/clip.mp4" /tmp/toggle-work/

wait_sse() { # $1=tag $2=needle
  for i in $(seq 1 120); do grep -q "$2" "/tmp/sse-$1.log" && return 0; sleep 0.5; done; return 1
}

echo "— T1: transfer only (all off) —"
T1=$(send t1 '{"qc_av":false,"qc_captions":false,"thumbnail":false,"summarize":false}' "")
wait_sse t1 pipeline_skipped || { echo "FAIL: no pipeline_skipped"; exit 1; }
# fire the signed B2 event for the same object: stored options must ALSO skip it
KEY1="transfers/$T1/clip.mp4"
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY1\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
sleep 2
echo "✓ T1 skipped ($(grep -c pipeline_skipped /tmp/sse-t1.log) skips, $(grep -c pipeline_started /tmp/sse-t1.log || true) starts)"

echo "— T2: caption QC only —"
T2=$(send t2 '{"qc_av":false,"qc_captions":true,"thumbnail":false,"summarize":false}' "$WORK/caps.srt")
wait_sse t2 pipeline_complete || { echo "FAIL: T2 never completed"; tail -5 /tmp/pipe.log; exit 1; }
echo "✓ T2 completed"

echo "— T3: no options (default = all on) —"
T3=$(send t3 'null' "")
wait_sse t3 pipeline_complete || { echo "FAIL: T3 never completed"; tail -5 /tmp/pipe.log; exit 1; }
echo "✓ T3 completed"

echo "— sidecar-url validation —"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8787/api/uploads/sidecar-url \
  -H 'content-type: application/json' --data '{"key":"transfers/x/a.mp4","filename":"evil.txt"}')
[ "$CODE" = "400" ] && echo "✓ .txt sidecar rejected (400)" || { echo "FAIL: expected 400, got $CODE"; exit 1; }

echo "=== assertions ==="
"$PY" - "$T1" "$T2" "$T3" <<'PYEOF'
import boto3, json, sys; from botocore.config import Config
t1, t2, t3 = sys.argv[1:4]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def derivs(tid):
    r = s3.list_objects_v2(Bucket="orbitxfer-test", Prefix=f"derivatives/{tid}/")
    return sorted(o["Key"].split("/")[-1] for o in r.get("Contents", []))
ok = True
# T1: transfer-only → nothing derived, and the event path never started a run
d1 = derivs(t1); print(f"  T1 derivatives: {d1 or '(none)'}")
if d1: print("  FAIL: transfer-only produced derivatives"); ok = False
sse1 = open("/tmp/sse-t1.log").read()
if "pipeline_started" in sse1: print("  FAIL: transfer-only pipeline ran"); ok = False
if sse1.count("pipeline_skipped") < 2: print("  FAIL: event path did not skip via stored options"); ok = False
# T2: caption QC only
d2 = derivs(t2); print(f"  T2 derivatives: {d2}")
if "thumb.jpg" in d2 or "summary.txt" in d2: print("  FAIL: disabled steps produced artifacts"); ok = False
if "qc_report.json" not in d2 or "manifest.json" not in d2: print("  FAIL: caption QC missing outputs"); ok = False
qc = json.loads(s3.get_object(Bucket="orbitxfer-test", Key=f"derivatives/{t2}/qc_report.json")["Body"].read())
names = {c["name"] for c in qc["checks"]}
av = {"has_video","has_audio","decode","black_frames","freeze_frames","audio_silence","loudness"}
caps = {"captions_present","caption_timing","caption_readability"}
print(f"  T2 checks: {sorted(names)}")
if names & av: print("  FAIL: AV checks ran while qc_av=false"); ok = False
if not caps <= names: print("  FAIL: caption checks missing"); ok = False
sse2 = open("/tmp/sse-t2.log").read()
skipped = [json.loads(l[6:])["step"] for l in sse2.splitlines() if l.startswith("data:") and '"step_skipped"' in l]
print(f"  T2 steps skipped: {skipped}")
if not {"thumbnail","summarize"} <= set(skipped): print("  FAIL: skip events missing"); ok = False
# T3: default → thumbnail runs (summary needs GMI key; absent here → its own step degrades, that's fine)
d3 = derivs(t3); print(f"  T3 derivatives: {d3}")
if "thumb.jpg" not in d3 or "qc_report.json" not in d3: print("  FAIL: defaults did not run everything"); ok = False
qc3 = json.loads(s3.get_object(Bucket="orbitxfer-test", Key=f"derivatives/{t3}/qc_report.json")["Body"].read())
if not av <= {c["name"] for c in qc3["checks"]}: print("  FAIL: T3 missing AV checks"); ok = False
print("PASS ✓  toggles gate the pipeline end to end" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
