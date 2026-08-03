#!/usr/bin/env bash
# Hybrid-compute proof: the sender's "Cloud compute" checkbox routes each
# transfer to a different worker, and the provenance manifest records WHERE
# it was processed.
#   transfer L  compute=local  → host uvicorn worker  → manifest says "local"
#   transfer C  compute=cloud  → DOCKER worker        → manifest says "cloud-docker"
# Requires docker (self-skips without it). MinIO + gateway run on the host;
# the containerized worker reaches them via host.docker.internal.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true

grep -Eq 'id="opt_cloud" checked' "$WEB/client/index.html" \
  || { echo "FAIL: Cloud compute is not checked by default"; exit 1; }
! grep -Eq 'id="opt_qc_ai"' "$WEB/client/index.html" \
  || { echo "FAIL: legacy AI QC remains visible"; exit 1; }
grep -Fq 'Creative and delivery context' "$WEB/client/index.html" \
  || { echo "FAIL: interpretive context label is missing"; exit 1; }
echo "✓ sender defaults to Cloud compute and exposes only consolidated interpretive AI"

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "SKIP — docker not available"; exit 0; }

PIPELINE_FINGERPRINT=$(
  cd "$WEB"
  git ls-files -z pipeline \
    | xargs -0 shasum -a 256 \
    | shasum -a 256 \
    | cut -c1-12
)
CLOUD_IMAGE="waystation-worker:compute-proof-$PIPELINE_FINGERPRINT"
if ! docker image inspect "$CLOUD_IMAGE" >/dev/null 2>&1; then
  echo "▶ building current Docker worker for compute proof…"
  docker build -t "$CLOUD_IMAGE" "$WEB/pipeline" \
    || { echo "FAIL: current worker image did not build"; exit 1; }
fi

cleanup(){ docker rm -f ws-cloud-worker >/dev/null 2>&1 || true; { lsof -ti:8787; lsof -ti:8000; lsof -ti:8001; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
# clear leftovers WITHOUT nuking the fresh work dirs
docker rm -f ws-cloud-worker >/dev/null 2>&1 || true
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:8001; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done

# local worker (host python) on :8000
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED WORKER_LABEL=local \
   ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe-local.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done

# cloud worker (the SHIPPED docker image) on :8001
docker run -d --name ws-cloud-worker -p 8001:8000 \
  -e PIPELINE_SHARED_SECRET=$SHARED -e WORKER_LABEL=cloud-docker \
  -e B2_S3_ENDPOINT=http://host.docker.internal:9000 -e B2_REGION=us-east-1 \
  -e B2_KEY_ID=minioadmin -e B2_APP_KEY=minioadmin -e B2_BUCKET=$BUCKET \
  -e B2_FORCE_PATH_STYLE=true -e GATEWAY_URL=http://host.docker.internal:8787 \
  --add-host=host.docker.internal:host-gateway "$CLOUD_IMAGE" >/dev/null
until curl -sf -o /dev/null --max-time 1 http://localhost:8001/healthz; do sleep 0.5; done

# gateway with BOTH workers registered
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   DEV_TRIGGER_ON_COMPLETE=true \
   PIPELINE_URL=http://localhost:8000 PIPELINE_URL_CLOUD=http://localhost:8001 \
   PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
echo "✓ minio + local worker + DOCKER cloud worker + gateway up"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >/tmp/ff.log 2>&1

send() { # $1=tag $2=compute — real gateway flow: initiate → PUT → complete
  "$PY" - "$1" "$2" <<'PYEOF'
import json, subprocess, sys, time, urllib.request
tag, compute = sys.argv[1], sys.argv[2]
GW = "http://localhost:8787/api"
def post(p, body):
    r = urllib.request.urlopen(urllib.request.Request(GW+p, json.dumps(body).encode(), {"content-type":"application/json"}))
    return json.loads(r.read())
data = open("/tmp/compute-clip.mp4","rb").read()
up = post("/uploads", {"filename":"clip.mp4","contentType":"video/mp4","size":len(data)})
key, uid = up["key"], up["uploadId"]
tid = key.split("/")[1]
subprocess.Popen(["curl","-N","-s",f"{GW}/progress/{tid}"], stdout=open(f"/tmp/sse-{tag}.log","w"))
for _ in range(50):
    if "subscribed" in open(f"/tmp/sse-{tag}.log").read(): break
    time.sleep(0.2)
urls = post("/uploads/parts", {"key":key,"uploadId":uid,"partNumbers":[1]})["urls"]
urllib.request.urlopen(urllib.request.Request(urls["1"], data, method="PUT"))
post("/uploads/complete", {"key":key,"uploadId":uid,"blake3Root":"deadbeef",
     "options":{"qc_ai":False,"summarize":False,"compute":compute}})
print(tid)
PYEOF
}
cp "$WORK/clip.mp4" /tmp/compute-clip.mp4

TID_L=$(send local local)
for i in $(seq 1 120); do grep -q pipeline_complete /tmp/sse-local.log 2>/dev/null && break; sleep 0.5; done
grep -q pipeline_complete /tmp/sse-local.log || { echo "FAIL: local run incomplete"; tail -5 /tmp/pipe-local.log; exit 1; }
echo "✓ transfer L (compute=local) complete"
TID_C=$(send cloud cloud)
for i in $(seq 1 180); do grep -q pipeline_complete /tmp/sse-cloud.log 2>/dev/null && break; sleep 0.5; done
grep -q pipeline_complete /tmp/sse-cloud.log || { echo "FAIL: cloud run incomplete"; docker logs --tail 10 ws-cloud-worker; exit 1; }
echo "✓ transfer C (compute=cloud) complete"

echo "=== compute-routing assertions ==="
"$PY" - "$TID_L" "$TID_C" <<'PYEOF'
import boto3, json, sys; from botocore.config import Config
tl, tc = sys.argv[1:3]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def man(tid): return json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/manifest.json")["Body"].read())
ok = True
for tid, tag, expect in ((tl, "local", "local"), (tc, "cloud", "cloud-docker")):
    compute = man(tid)["run"]["metadata"].get("compute")
    sse = open(f"/tmp/sse-{tag}.log").read()
    started = f'"compute":"{expect}"' in sse.replace(" ", "")
    print(f"  {tag}: manifest.run.metadata.compute = {compute!r}, SSE labeled: {started}")
    if compute != expect: print(f"  FAIL: expected {expect}"); ok = False
    if not started: print(f"  FAIL: pipeline_started missing compute label"); ok = False
# the two transfers were genuinely processed by different processes
print("PASS ✓  checkbox routes compute (local vs docker) and provenance records it" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
