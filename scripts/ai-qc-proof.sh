#!/usr/bin/env bash
# Agentic AI QC integration proof — deterministic, no cloud spend. A mock GMI
# server answers the three inspection passes, one adaptive frame-burst request,
# and focused audio requests so we can assert:
#   clip A + captions MATCHING the "speech" → ai_caption_accuracy PASS (100%)
#   clip B + unrelated captions           → ai_caption_accuracy WARN (low match)
#   both clips                            → agentic visual finding
#   report                                → all 18 registry risks accounted
#   metering                              → qc_ai (frames) + qc_ai_asr (seconds)
#   qc_ai disabled                        → no ai_* checks, step_skipped
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

# ── mock GMI: agent passes + audio transcript + targeted escalation ──
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
        dispositions = [
            {"risk_id": "certified_pse", "status": "REVIEW_REQUIRED", "reason": "certified test required"},
            {"risk_id": "lip_sync", "status": "REVIEW_REQUIRED", "reason": "speech-bearing evidence required"},
            {"risk_id": "dead_stuck_pixels", "status": "CLEAR", "reason": "none seen in sampled frames"},
            {"risk_id": "subtle_visual_artifacts", "status": "CONFIRMED", "reason": "color bars visible",
             "evidence_ids": ["timeline-frame-1"]},
            {"risk_id": "creative_vs_defect", "status": "REVIEW_REQUIRED", "reason": "intent not supplied"},
            {"risk_id": "color_trim_intent", "status": "REVIEW_REQUIRED", "reason": "approved reference not supplied"},
            {"risk_id": "audio_transients", "status": "CLEAR", "reason": "no defect in supplied audio evidence"},
            {"risk_id": "channel_assignment", "status": "REVIEW_REQUIRED", "reason": "semantic stems not supplied"},
            {"risk_id": "spoken_language", "status": "REVIEW_REQUIRED", "reason": "language not declared"},
            {"risk_id": "caption_localization", "status": "REVIEW_REQUIRED", "reason": "localization brief not supplied"},
            {"risk_id": "editorial_continuity", "status": "REVIEW_REQUIRED", "reason": "approved cut not supplied"},
            {"risk_id": "encrypted_proprietary_streams", "status": "CLEAR", "reason": "file decoded"},
        ]
        finding = {"title": "SMPTE color bars test pattern", "description": "Color bars are visible in sampled evidence.",
                   "risk_id": "subtle_visual_artifacts", "severity": "issue", "confidence": "high",
                   "timecodes": [0.2], "evidence_ids": ["timeline-frame-1"]}
        if "PASS: INDEPENDENT SWEEP" in texts:
            text = json.dumps({"summary": "Color bars observed", "findings": [finding],
                               "risk_dispositions": dispositions,
                               "requests": [{"type": "frame_burst", "start_seconds": 0.1,
                                             "duration_seconds": 1.0, "purpose": "confirm persistence"}]})
        elif "PASS: INSTRUMENT-INFORMED SWEEP" in texts:
            text = json.dumps({"summary": "Instrument evidence does not negate the visible bars",
                               "findings": [finding], "risk_dispositions": dispositions, "requests": []})
        elif "PASS: INDEPENDENT CRITIC" in texts:
            text = json.dumps({"summary": "Confirmed reportable test pattern",
                               "findings": [finding], "risk_dispositions": dispositions,
                               "residual_review": ["creative intent was not supplied"]})
        elif "input_audio" in kinds:
            text = "hello world a fine master"
        elif "Adjudicate" in texts:   # AI-targeted escalation prompt
            text = json.dumps({"verdicts": [{"segment": 1, "verdict": "defect",
                                             "reason": "same shot continues after the black insert"}]})
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
   GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8009 GMI_MULTIMODAL_MODEL=mock-multimodal GMI_MODEL=mock-text \
   AI_QC_FRAMES=4 AI_QC_MIN_INTERVAL=0 \
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

# clip E: a black hole spliced mid-content → blackdetect flags the segment →
# AI-targeted escalation sends before/inside/after frames for adjudication
ffmpeg -y -f lavfi -i "testsrc2=duration=5:size=640x360:rate=15" -f lavfi -i sine=frequency=440:duration=5 \
  -vf "drawbox=enable='between(t,2,3)':x=0:y=0:w=iw:h=ih:color=black:t=fill" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/blackhole.mp4" >/tmp/ffE.log 2>&1
TID_E=$(uuidgen | tr 'A-Z' 'a-z')
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
s3.upload_file("$WORK/blackhole.mp4","$BUCKET","transfers/$TID_E/blackhole.mp4",ExtraArgs={"ContentType":"video/mp4"})
PYEOF
curl -N -s "http://localhost:8787/api/progress/$TID_E" > "/tmp/sse-$TID_E.log" 2>&1 &
until grep -q subscribed "/tmp/sse-$TID_E.log"; do sleep 0.2; done
curl -sS -o /dev/null -X POST http://localhost:8000/jobs -H "content-type: application/json" -H "authorization: Bearer $SHARED" \
  --data "{\"bucket\":\"$BUCKET\",\"key\":\"transfers/$TID_E/blackhole.mp4\",\"transferId\":\"$TID_E\",\"gatewayUrl\":\"http://localhost:8787\",\"options\":{\"qc_captions\":false,\"summarize\":false}}"
for i in $(seq 1 120); do grep -q pipeline_complete "/tmp/sse-$TID_E.log" && break; sleep 0.5; done
echo "✓ clip E (black hole → escalation) processed"

echo "=== AI QC assertions ==="
"$PY" - "$TID_A" "$TID_B" "$TID_C" "$TID_E" <<'PYEOF'
import boto3, json, sys, urllib.request; from botocore.config import Config
ta, tb, tc, te = sys.argv[1:5]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid): return json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def manifest(tid): return json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/manifest.json")["Body"].read())
def usage(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
def ck(r, n):
    hits = [c for c in r["checks"] if c["name"] == n]
    return hits[0] if hits else None
ok = True
a, b, c = qc(ta), qc(tb), qc(tc)

v = ck(a, "agentic_subtle_visual_artifacts")
print(f"  A agentic finding: {v['status']} — {v['detail']}")
if v["status"] != "warn" or "Color bars" not in v["detail"]: print("  FAIL: agentic finding missing"); ok = False
acc = ck(a, "ai_caption_accuracy")
print(f"  A ai_caption_accuracy: {acc['status']} — {acc['detail']}")
if acc["status"] != "pass" or "100" not in acc["detail"]: print("  FAIL: matching captions should pass at 100%"); ok = False
if not ck(a, "captions_valid"): print("  FAIL: deterministic checks missing from merged report"); ok = False
if a["status"] != "pass": print("  FAIL: AI finding must not change deterministic delivery status"); ok = False
if a.get("advisory_status") != "warn" or a.get("advisory_tiers", {}).get("ISSUE", 0) < 1:
    print("  FAIL: AI concern must remain visible in advisory accounting"); ok = False
if any(c.get("tier") == "BLOCKER" for c in a["checks"] if c.get("source") != "deterministic"):
    print("  FAIL: AI-origin check became BLOCKER"); ok = False
if a.get("ai", {}).get("model") != "mock-multimodal": print("  FAIL: ai provenance block missing"); ok = False
agent = a.get("agentic", {})
if set(agent.get("passes", {})) != {"independent", "informed", "critic"}:
    print("  FAIL: three agentic passes missing"); ok = False
if not agent.get("requests") or agent["requests"][0].get("status") != "fulfilled":
    print("  FAIL: adaptive evidence request was not fulfilled"); ok = False
coverage = a.get("coverage", {})
print(f"  coverage: {coverage.get('assessed_risks')}/{coverage.get('applicable_risks')} assessed, "
      f"{coverage.get('unresolved_risks')} disclosed")
if len(coverage.get("risks", [])) != 18 or not coverage.get("accounting_complete"):
    print("  FAIL: mandatory risk registry not fully accounted"); ok = False
if not coverage.get("model_disposition_complete"):
    print("  FAIL: mock model dispositions should cover every applicable risk"); ok = False
if a.get("reporter_mode") != "read_only_no_repair": print("  FAIL: reporter-only mode missing"); ok = False
agent_steps = [s for s in manifest(ta)["run"]["steps"] if s["step_id"].startswith("qc-agent-")]
if [s["step_id"] for s in agent_steps] != ["qc-agent-independent", "qc-agent-informed", "qc-agent-critic"]:
    print("  FAIL: Genblaze agent pass steps missing"); ok = False
if any(s.get("metadata", {}).get("repairs_allowed") is not False for s in agent_steps):
    print("  FAIL: Genblaze no-repair metadata missing"); ok = False

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

# E: AI-targeted escalation — the black hole's timecodes were adjudicated
e = qc(te)
if "detections" not in e or not e["detections"].get("black"):
    print("  FAIL: E report missing detection timecodes"); ok = False
else:
    print(f"  E detections: {e['detections']}")
esc = ck(e, "ai_escalation")
if not esc: print("  FAIL: ai_escalation check missing"); ok = False
else:
    print(f"  E ai_escalation: {esc['status']} — {esc['detail'][:90]}")
    if esc["status"] != "warn" or "DEFECT" not in esc["detail"]:
        print("  FAIL: mock defect verdict not surfaced"); ok = False
ue = usage(te)["totals"]
if "qc_ai_escalation" not in ue or ue["qc_ai_escalation"]["unit"] != "frames":
    print("  FAIL: escalation frames not metered"); ok = False
else:
    print(f"  E metering: qc_ai_escalation = {ue['qc_ai_escalation']['units']} frames")
# escalation must NOT run when nothing was flagged (clean clip A)
if ck(a, "ai_escalation"): print("  FAIL: escalation ran with no flagged segments"); ok = False

print("PASS ✓  Agentic QC: blind/informed/critic + adaptive evidence + coverage + support checks" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
