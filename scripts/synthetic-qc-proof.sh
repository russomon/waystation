#!/usr/bin/env bash
# Synthetic QC lane proof (mock GMI, zero spend):
#   S  qc_synthetic ON + .genblaze.json sidecar (prompt: "a red ball…")
#      → ai_synthetic_artifacts (anatomy defect surfaced), ai_origin_assessment,
#        ai_temporal_coherence (identity drift), ai_prompt_adherence (low score
#        → warn), metering qc_synthetic in frames
#   T  qc_synthetic OFF → no synthetic checks, step_skipped
#   R  manifest sidecar with REDACTED prompt → adherence reports "not scorable"
# Plus: sidecar-url accepts source.genblaze.json (200), a signed event for the
# sidecar key does NOT trigger a pipeline run.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; lsof -ti:8009; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; lsof -ti:8009; } 2>/dev/null | xargs kill -9 2>/dev/null || true

# ── mock GMI: routes on prompt keywords ──
"$PY" - <<'PYEOF' >/tmp/mockgmi.log 2>&1 &
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = body["messages"][0]["content"]
        kinds = [p.get("type") for p in content] if isinstance(content, list) else []
        texts = " ".join(p.get("text", "") for p in content if isinstance(p, dict)) \
            if isinstance(content, list) else str(content)
        if "input_audio" in kinds:
            text = "hello world"
        elif "RECORDED GENERATION" in texts:
            text = json.dumps({"adherence_score": 35,
                               "matches": ["outdoor setting"],
                               "mismatches": ["no red ball visible", "nothing bounces"],
                               "summary": "video does not depict the prompt"})
        elif "TEMPORAL COHERENCE" in texts:
            text = json.dumps({"issues": [{"issue": "subject's jacket changes color between bursts",
                                           "kind": "identity"}],
                               "verdict": "incoherent", "summary": "identity drift"})
        elif "AI-GENERATED video" in texts:
            text = json.dumps({"findings": [{"issue": "six fingers on left hand",
                                             "category": "anatomy", "frames": [2]}],
                               "appears_generated": True, "confidence": "high",
                               "summary": "synthetic content with anatomy defects"})
        elif "Adjudicate" in texts:
            text = json.dumps({"verdicts": []})
        elif "image_url" in kinds:
            text = json.dumps({"findings": [], "summary": "clean synthetic test frames"})
        elif "compliance" in texts.lower():
            text = json.dumps({"profanity_count": 0, "flags": []})
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
   GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8009 GMI_MULTIMODAL_MODEL=mock-mm GMI_MODEL=mock-text \
   ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ stack up (mock GMI)"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF

ffmpeg -y -f lavfi -i testsrc2=duration=5:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=5 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/tmp/ff.log 2>&1
cat > "$WORK/source.genblaze.json" <<'JSON'
{"schema_version":"1.5","run":{"run_id":"gen-1","steps":[
  {"step_id":"generate","provider":"gmicloud","model":"video-gen",
   "prompt":"a red ball bouncing on a wooden floor in slow motion"}]}}
JSON
cat > "$WORK/redacted.genblaze.json" <<'JSON'
{"schema_version":"1.5","run":{"run_id":"gen-2","steps":[
  {"step_id":"generate","provider":"gmicloud","model":"video-gen"}]}}
JSON

run_job() { # $1=tid $2=optionsJSON $3=genManifest-or-""
  local tid=$1 opts=$2 gen=$3
  "$PY" - "$tid" "$gen" <<'PYEOF'
import boto3, os, sys; from botocore.config import Config
tid, gen = sys.argv[1], sys.argv[2]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
if gen:
    s3.upload_file(gen, "waystation-test", f"transfers/{tid}/source.genblaze.json")
s3.upload_file(os.environ["CLIP"], "waystation-test", f"transfers/{tid}/clip.mp4", ExtraArgs={"ContentType":"video/mp4"})
PYEOF
  curl -N -s "http://localhost:8787/api/progress/$tid" > "/tmp/sse-$tid.log" 2>&1 &
  until grep -q subscribed "/tmp/sse-$tid.log"; do sleep 0.2; done
  curl -sS -o /dev/null -X POST http://localhost:8000/jobs -H "content-type: application/json" -H "authorization: Bearer $SHARED" \
    --data "{\"bucket\":\"$BUCKET\",\"key\":\"transfers/$tid/clip.mp4\",\"transferId\":\"$tid\",\"gatewayUrl\":\"http://localhost:8787\",\"options\":$opts}"
  for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$tid.log" 2>/dev/null && return 0; sleep 0.5; done
  echo "TIMEOUT $tid"; tail -5 /tmp/pipe.log; return 1
}
export CLIP="$WORK/clip.mp4"

TID_S=$(uuidgen | tr 'A-Z' 'a-z'); TID_T=$(uuidgen | tr 'A-Z' 'a-z'); TID_R=$(uuidgen | tr 'A-Z' 'a-z')
run_job "$TID_S" '{"qc_synthetic":true,"qc_captions":false,"summarize":false}' "$WORK/source.genblaze.json" || exit 1
echo "✓ S processed (synthetic ON + gen manifest)"
run_job "$TID_T" '{"qc_synthetic":false,"qc_captions":false,"summarize":false,"qc_ai":false}' "" || exit 1
echo "✓ T processed (synthetic OFF)"
run_job "$TID_R" '{"qc_synthetic":true,"qc_captions":false,"summarize":false,"qc_ai":false}' "$WORK/redacted.genblaze.json" || exit 1
echo "✓ R processed (redacted prompt)"

echo "— sidecar + event-filter validation —"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8787/api/uploads/sidecar-url \
  -H 'content-type: application/json' --data '{"key":"transfers/x/a.mp4","filename":"source.genblaze.json"}')
[ "$CODE" = "200" ] && echo "✓ source.genblaze.json accepted (200)" || { echo "FAIL: sidecar-url $CODE"; exit 1; }
GENKEY="transfers/$TID_S/source.genblaze.json"
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$GENKEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
sleep 2
RUNS=$(grep -c pipeline_started "/tmp/sse-$TID_S.log")
[ "$RUNS" = "1" ] && echo "✓ .genblaze.json event ignored (1 run)" || { echo "FAIL: sidecar event ran pipeline ($RUNS)"; exit 1; }

echo "=== synthetic-lane assertions ==="
"$PY" - "$TID_S" "$TID_T" "$TID_R" <<'PYEOF'
import boto3, json, sys, urllib.request; from botocore.config import Config
ts, tt, tr = sys.argv[1:4]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid): return json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def usage(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
def ck(r, n):
    h = [c for c in r["checks"] if c["name"] == n]
    return h[0] if h else None
ok = True
def need(cond, msg):
    global ok
    if not cond: print(f"  FAIL: {msg}"); ok = False

s, t, r = qc(ts), qc(tt), qc(tr)
art = ck(s, "ai_synthetic_artifacts")
print(f"  S artifacts: {art['status']} — {art['detail'][:80]}")
need(art and art["status"] == "warn" and "anatomy" in art["detail"], "anatomy defect not surfaced")
org = ck(s, "ai_origin_assessment")
need(org and "True" in org["detail"], f"origin assessment missing ({org})")
tc = ck(s, "ai_temporal_coherence")
print(f"  S temporal: {tc['status']} — {tc['detail'][:80]}")
need(tc and tc["status"] == "warn" and "identity" in tc["detail"], "identity drift not surfaced")
adh = ck(s, "ai_prompt_adherence")
print(f"  S adherence: {adh['status']} — {adh['detail'][:90]}")
need(adh and adh["status"] == "warn" and "35" in adh["detail"] and "red ball" in adh["detail"],
     "low adherence vs recorded prompt not surfaced")
need(s.get("synthetic", {}).get("prompt_reference") is True, "synthetic block missing prompt_reference")
us = usage(ts)["totals"]
need("qc_synthetic" in us and us["qc_synthetic"]["unit"] == "frames", "qc_synthetic frames not metered")
print(f"  S metering: qc_synthetic = {us['qc_synthetic']['units']} frames")

need(not [c for c in t["checks"] if c["name"].startswith("ai_synthetic") or
          c["name"] in ("ai_temporal_coherence", "ai_prompt_adherence", "ai_origin_assessment")],
     "T (off) still produced synthetic checks")
sse_t = open(f"/tmp/sse-{tt}.log").read()
need('"step":"qc_synthetic"' in sse_t.replace(" ", "") and "step_skipped" in sse_t,
     "T skip event missing")
print("  T: no synthetic checks, step_skipped ✓")

radh = ck(r, "ai_prompt_adherence")
print(f"  R adherence: {radh['status']} — {radh['detail'][:80]}")
need(radh and radh["status"] == "info" and "not scorable" in radh["detail"],
     "redacted prompt should report not-scorable")

print("PASS ✓  synthetic lane: artifacts + coherence + prompt adherence + gating + metering" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
