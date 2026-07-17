#!/usr/bin/env bash
# The demo driver: a full REAL-cloud, REAL-AI run against YOUR B2 bucket.
#   master + captions → B2 → pipeline (AV QC + caption QC + GMI summary)
#   → derivatives + provenance manifest in B2 → delivery page.
# Leaves gateway + pipeline + client running so you can browse the result.
# Ctrl-C stops everything. Requires .env with B2 + GMI keys (see SETUP.md).
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d)

[ -f "$WEB/.env" ] || { echo "✗ no .env — see SETUP.md"; exit 1; }
set -a; source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$WEB/.env"); set +a
for v in B2_S3_ENDPOINT B2_REGION B2_BUCKET B2_KEY_ID B2_APP_KEY GMI_API_KEY; do
  [ -n "${!v:-}" ] || { echo "✗ $v not set in .env"; exit 1; }
done
unset B2_FORCE_PATH_STYLE                          # B2 = virtual-hosted style
export GMI_MODEL="${GMI_MODEL:-google/gemini-3.5-flash}"
export GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787
export PIPELINE_URL="${PIPELINE_URL:-http://localhost:8000}"
trap '{ lsof -ti:8787; lsof -ti:8000; lsof -ti:5173; } 2>/dev/null | xargs kill -9 2>/dev/null; rm -rf "$WORK"' INT TERM
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:5173; } 2>/dev/null | xargs kill -9 2>/dev/null || true

( cd "$WEB/gateway" && npx tsx src/server.ts >/tmp/wp-gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/wp-pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
( cd "$WEB/client" && npm run dev >/tmp/wp-client.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:5173/; do sleep 0.5; done
echo "✓ gateway + pipeline + client up   (bucket: $B2_BUCKET · model: $GMI_MODEL)"

ffmpeg -y -f lavfi -i testsrc2=duration=5:size=640x360:rate=24 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/master.mp4" >/tmp/wp-ff.log 2>&1
cat > "$WORK/captions.srt" <<'SRT'
1
00:00:00,300 --> 00:00:02,000
Welcome to the Waystation demo

2
00:00:02,300 --> 00:00:04,500
Delivered, QC'd, and provable
SRT

TID=$(uuidgen | tr 'A-Z' 'a-z'); KEY="transfers/$TID/master.mp4"
"$PY" - <<PYEOF
import boto3, os
s3=boto3.client("s3",endpoint_url=os.environ["B2_S3_ENDPOINT"],region_name=os.environ["B2_REGION"],
  aws_access_key_id=os.environ["B2_KEY_ID"],aws_secret_access_key=os.environ["B2_APP_KEY"])
B=os.environ["B2_BUCKET"]
s3.upload_file("$WORK/captions.srt",B,"transfers/$TID/captions.srt")
s3.upload_file("$WORK/master.mp4",B,"$KEY",ExtraArgs={"ContentType":"video/mp4"})
print("✓ master + captions uploaded to",B)
try:
    s3.put_bucket_cors(Bucket=B,CORSConfiguration={"CORSRules":[
      {"AllowedOrigins":["http://localhost:5173"],"AllowedMethods":["GET","PUT","HEAD"],
       "AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]})
    print("✓ bucket CORS applied for http://localhost:5173")
except Exception as e:
    print("note: bucket CORS not settable via S3 API ("+type(e).__name__+") — page basics still work; add CORS in the B2 UI for full fetches")
PYEOF

curl -N -s "http://localhost:8787/api/progress/$TID" > /tmp/wp-sse.log 2>&1 &
until grep -q subscribed /tmp/wp-sse.log; do sleep 0.2; done
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$KEY\",\"bucketName\":\"$B2_BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$B2_EVENT_SIGNING_SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
echo "✓ event fired — pipeline running against real B2 + GMI…"
for i in $(seq 1 240); do grep -q pipeline_complete /tmp/wp-sse.log && break; sleep 1; done
grep -q pipeline_complete /tmp/wp-sse.log || { echo "✗ pipeline did not complete — log tail:"; tail -20 /tmp/wp-pipe.log; }

echo; echo "════════ live progress stream ════════"
sed 's/^data: //' /tmp/wp-sse.log | grep -v '^$' | grep -v '"type":"subscribed"'
echo; echo "════════ results (from your B2 bucket) ════════"
"$PY" - <<PYEOF
import boto3, os, json, urllib.request
s3=boto3.client("s3",endpoint_url=os.environ["B2_S3_ENDPOINT"],region_name=os.environ["B2_REGION"],
  aws_access_key_id=os.environ["B2_KEY_ID"],aws_secret_access_key=os.environ["B2_APP_KEY"])
B=os.environ["B2_BUCKET"]
qc=json.loads(s3.get_object(Bucket=B,Key="derivatives/$TID/qc_report.json")["Body"].read())
man=json.loads(s3.get_object(Bucket=B,Key="derivatives/$TID/manifest.json")["Body"].read())
print(f"QC: {qc['status'].upper()}")
for c in qc["checks"]:
    icon={"pass":"✓","warn":"⚠"}.get(c["status"],"✗")
    print(f"  {icon} {c['name']}" + (f" — {c['detail']}" if c.get("detail") else ""))
summ=[s for s in man.get("steps",[]) if s.get("step")=="summarize"]
print("\nAI summary (GMI):", summ[0]["text"] if summ else "(none — check GMI step in stream above)")
u=json.load(urllib.request.urlopen("http://localhost:8787/api/transfers/$TID/usage"))
print("usage ledger:", {k:f'{v["units"]} {v["unit"]}' for k,v in u["totals"].items()})
PYEOF
echo
echo "  🚀 delivery page →  http://localhost:5173/?t=$TID"
echo "  (services stay up; Ctrl-C stops everything)"
while true; do sleep 3600; done
