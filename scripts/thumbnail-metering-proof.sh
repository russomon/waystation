#!/usr/bin/env bash
# Poster billing contract, end to end, with a LOCAL mock GMI (no real key, no paid
# provider, no external network). The worker bills the AI poster-selection step only
# when a GMI call was actually made (pipeline/worker.py, create_ai_thumbnail and the
# thumbnail step); the gateway meters an event only when it carries a `billable`
# block (gateway/src/routes.ts, /internal/progress). Three transfers, one mock mode each:
#
#   valid     the mock selects an allowlisted candidate
#             -> selection_method gmi_ai, gmi_model_calls 1, billable {run, 1},
#                ledger: thumbnail = 1 run, the selected candidate IS the poster
#   invalid   the mock answers with something that is not an allowlisted selection
#             -> the paid call is still billed (gmi_model_calls 1, ledger 1 run) while
#                the poster is the deterministic fallback (current contract)
#   error     the mock fails (HTTP 500), so no response exists
#             -> deterministic fallback, gmi_model_calls 0, no billable block,
#                NO ledger charge
#
# The free no-key fallback is asserted by scripts/qc-proof.sh. Together they catch a
# change in either direction: billing a free fallback, or not billing an AI call.
set -u
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX"); WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true

OWNED=()
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null || true; }
# Only processes THIS script started are signalled, never "whatever listens on the port".
cleanup(){ for p in ${OWNED[@]+"${OWNED[@]}"}; do killtree "$p"; done; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT

command -v minio >/dev/null || { echo "SKIP - minio not installed"; exit 0; }
command -v ffmpeg >/dev/null || { echo "SKIP - ffmpeg not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP - pipeline venv not built"; exit 0; }
for p in 8787 8000 9000 8009; do
  if lsof -ti:$p >/dev/null 2>&1; then echo "SKIP - port $p is in use; not touching whatever owns it"; exit 0; fi
done

# ── local mock GMI: answers ONLY the poster-selector prompt; mode comes from a file ──
cat > "$WORK/mock.py" <<'PYEOF'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE, LOG = sys.argv[1], sys.argv[2]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = body["messages"][0]["content"]
        texts = " ".join(p.get("text", "") for p in content if isinstance(p, dict)) if isinstance(content, list) else str(content)
        if "poster selector" not in texts:
            self.send_response(404); self.end_headers(); return          # nothing else may call the model
        open(LOG, "a").write("poster-request\n")
        mode = open(MODE).read().strip()
        if mode == "error":
            self.send_response(500); self.end_headers(); self.wfile.write(b"mock failure"); return
        if mode == "valid":
            text = json.dumps({"selected_candidate_id": "poster-candidate-03", "reason": "sharp, well exposed", "confidence": 0.9})
        else:
            text = "I cannot choose a frame."
        data = json.dumps({"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8009), H).serve_forever()
PYEOF
echo valid > "$WORK/mode"; : > "$WORK/requests.log"
( exec "$PY" "$WORK/mock.py" "$WORK/mode" "$WORK/requests.log" ) >"$TT/thumb-mock.log" 2>&1 &
OWNED+=($!)
until curl -s -o /dev/null -X POST http://localhost:8009/v1/chat/completions -H 'content-type: application/json' --data '{"messages":[{"content":"ping"}]}'; do sleep 0.3; done

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >"$TT/minio.log" 2>&1 &
OWNED+=($!)
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && exec env CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   DEV_TRIGGER_ON_COMPLETE=true PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED \
   GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 npx tsx src/server.ts ) >"$TT/gw.log" 2>&1 &
OWNED+=($!)
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && exec env PIPELINE_SHARED_SECRET=$SHARED GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8009 \
   GMI_MULTIMODAL_MODEL=mock-multimodal GMI_MODEL=mock-text AI_QC_MIN_INTERVAL=0 \
   ./.venv/bin/uvicorn worker:app --port 8000 ) >"$TT/pipe.log" 2>&1 &
OWNED+=($!)
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ stack up (local mock GMI on :8009, no real key)"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >"$TT/ff.log" 2>&1

# Real gateway flow with ONLY the poster lane on: initiate -> PUT -> complete(options).
send() { # $1=tag
  "$PY" - "$1" "$WORK/clip.mp4" <<'PYEOF'
TT = __import__("os").environ["TT"]
import json, subprocess, sys, time, urllib.request
tag, clip = sys.argv[1], sys.argv[2]
GW = "http://localhost:8787/api"
def post(p, body):
    r = urllib.request.urlopen(urllib.request.Request(GW+p, json.dumps(body).encode(), {"content-type":"application/json"}))
    return json.loads(r.read())
data = open(clip, "rb").read()
up = post("/uploads", {"filename":"clip.mp4","contentType":"video/mp4","size":len(data)})
key, uid = up["key"], up["uploadId"]; tid = key.split("/")[1]
subprocess.Popen(["curl","-N","-s",f"{GW}/progress/{tid}"], stdout=open(f"{TT}/sse-{tag}.log","w"))
for _ in range(50):
    if "subscribed" in open(f"{TT}/sse-{tag}.log").read(): break
    time.sleep(0.2)
urls = post("/uploads/parts", {"key":key,"uploadId":uid,"partNumbers":[1]})["urls"]
urllib.request.urlopen(urllib.request.Request(urls["1"], data, method="PUT"))
post("/uploads/complete", {"key":key,"uploadId":uid,"blake3Root":"deadbeef",
     "options":{"qc_av":False,"qc_captions":False,"qc_ai":False,"thumbnail":True,"summarize":False}})
print(tid)
PYEOF
}
run_case() { # $1=mode
  echo "$1" > "$WORK/mode"
  local tid; tid=$(send "$1")
  for i in $(seq 1 120); do grep -q pipeline_complete "$TT/sse-$1.log" 2>/dev/null && break; sleep 0.5; done
  grep -q pipeline_complete "$TT/sse-$1.log" || { echo "FAIL: $1 run incomplete"; tail -5 "$TT/pipe.log"; exit 1; }
  printf '%s' "$tid"
}
T_VALID=$(run_case valid)
T_INVALID=$(run_case invalid)
T_ERROR=$(run_case error)
echo "✓ three transfers processed (valid / invalid / error mock answers)"

"$PY" - "$T_VALID" "$T_INVALID" "$T_ERROR" "$WORK/requests.log" <<'PYEOF'
TT = __import__("os").environ["TT"]
import boto3, json, sys, urllib.request; from botocore.config import Config
tv, ti, te, reqlog = sys.argv[1:5]
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1", aws_access_key_id="minioadmin",
                  aws_secret_access_key="minioadmin", config=Config(s3={"addressing_style": "path"}))
ok = True
def need(cond, msg):
    global ok
    if not cond: print(f"  FAIL: {msg}"); ok = False
def events(tag):
    out = []
    for line in open(f"{TT}/sse-{tag}.log").read().splitlines():
        if line.startswith("data:"):
            try: out.append(json.loads(line[5:]))
            except ValueError: pass
    return out
def thumb(tag):
    t = [e for e in events(tag) if e.get("step") == "thumbnail" and e.get("type") == "step_done"]
    need(len(t) == 1, f"{tag}: expected one thumbnail step_done, got {len(t)}")
    return t[0] if t else {}
def ledger(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))["totals"]
def poster_exists(tid):
    try: s3.head_object(Bucket="waystation-test", Key=f"derivatives/{tid}/thumb.jpg"); return True
    except Exception: return False


# valid: AI-selected poster, billed once
t = thumb("valid"); led = ledger(tv)
need(t.get("selection_method") == "gmi_ai", f"valid: selection_method={t.get('selection_method')!r}")
need(t.get("gmi_model_calls") == 1, f"valid: gmi_model_calls={t.get('gmi_model_calls')!r}")
need(t.get("billable") == {"unit": "run", "units": 1}, f"valid: billable={t.get('billable')!r}")
need(led.get("thumbnail", {}).get("units") == 1 and led.get("thumbnail", {}).get("unit") == "run", f"valid: ledger thumbnail={led.get('thumbnail')!r}")
need(poster_exists(tv), "valid: selected poster object missing")
need(abs(float(t.get("selected_time_seconds", -1)) - 1.375) < 0.02,
     f"valid: poster-candidate-03 should be the ~1.375s frame, got {t.get('selected_time_seconds')!r}")
print(f"  valid  : gmi_ai, 1 model call, billable run x1, ledger thumbnail {led.get('thumbnail')}, poster present")

# invalid answer: the paid call is billed, the poster is the fallback
t = thumb("invalid"); led = ledger(ti)
need(t.get("selection_method") == "deterministic_fallback", f"invalid: selection_method={t.get('selection_method')!r}")
need(t.get("gmi_model_calls") == 1, f"invalid: gmi_model_calls={t.get('gmi_model_calls')!r}")
need(t.get("billable") == {"unit": "run", "units": 1}, f"invalid: billable={t.get('billable')!r}")
need(led.get("thumbnail", {}).get("units") == 1, f"invalid: ledger thumbnail={led.get('thumbnail')!r}")
need(poster_exists(ti), "invalid: fallback poster object missing")
print(f"  invalid: deterministic_fallback after a paid call, billed once, ledger thumbnail {led.get('thumbnail')}, poster present")

# provider error: no response, so nothing to bill
t = thumb("error"); led = ledger(te)
need(t.get("selection_method") == "deterministic_fallback", f"error: selection_method={t.get('selection_method')!r}")
need(t.get("gmi_model_calls") == 0, f"error: gmi_model_calls={t.get('gmi_model_calls')!r}")
need("billable" not in t, f"error: free fallback carries a billable block {t.get('billable')!r}")
need("thumbnail" not in led, f"error: ledger charges a thumbnail {led.get('thumbnail')!r}")
need(poster_exists(te), "error: fallback poster object missing")
print("  error  : deterministic_fallback, 0 model calls, no billable block, no ledger charge, poster present")

n = len(open(reqlog).read().split())
need(n == 3, f"the mock should have been asked to select a poster exactly 3 times (once per transfer), saw {n}")
print(f"  mock saw {n} poster-selection requests (one per transfer); no other prompt reached it")
print("PASS ✓  poster billing: a model call is billed once, a free fallback is never billed" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
