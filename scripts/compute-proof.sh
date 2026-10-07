#!/usr/bin/env bash
# Hybrid-compute proof: the sender's "Cloud compute" checkbox routes each
# transfer to a different worker, and the provenance manifest records WHERE
# it was processed.
#   transfer L  compute=local  → host uvicorn worker  → manifest says "local"
#   transfer C  compute=cloud  → DOCKER worker        → manifest says "cloud-docker"
# Requires docker, explicit approval and an image matching this source (scripts/lib/docker-isolation.sh;
# it self-skips otherwise and never builds, pulls or tags on its own). MinIO + gateway run on the host;
# the containerized worker reaches them via host.docker.internal.
set -u
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX"); WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
SECRET=evsecret; SHARED=ps; BUCKET=waystation-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true

grep -Eq 'id="opt_cloud" checked' "$WEB/client/index.html" \
  || { echo "FAIL: Cloud compute is not checked by default"; exit 1; }
! grep -Eq 'id="opt_qc_ai"' "$WEB/client/index.html" \
  || { echo "FAIL: legacy AI QC remains visible"; exit 1; }
grep -Fq 'Creative and delivery context' "$WEB/client/index.html" \
  || { echo "FAIL: interpretive context label is missing"; exit 1; }
echo "✓ sender defaults to Cloud compute and exposes only consolidated interpretive AI"

# shellcheck source=lib/docker-isolation.sh
. "$WEB/scripts/lib/docker-isolation.sh"
OWNED=()
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null || true; }
# Only processes THIS script started are signalled, never "whatever listens on the port";
# containers are removed only by their run label (ws_dk_cleanup).
cleanup(){ for p in ${OWNED[@]+"${OWNED[@]}"}; do killtree "$p"; done; ws_dk_cleanup; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
ws_dk_begin compute
if [ "${WS_DOCKER_PLAN:-0}" != 1 ]; then
  for p in 8787 8000 9000; do
    if lsof -ti:$p >/dev/null 2>&1; then echo "SKIP - port $p is in use; not touching whatever owns it"; exit 0; fi
  done
fi

# The cloud worker must be the CURRENT source: an existing image whose application files
# match this tree, or an authorized build. Never a shared tag, never silently an old image.
ws_dk_obtain_image worker; CLOUD_IMAGE="$WS_DK_IMAGE_ID"
if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then CP=18001; else CP=$(ws_dk_free_port); fi

if [ "${WS_DOCKER_PLAN:-0}" != 1 ]; then
  MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >$TT/minio.log 2>&1 &
  OWNED+=($!)
  until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done

  # local worker (host python) on :8000
  ( cd "$WEB/pipeline" && exec env PIPELINE_SHARED_SECRET=$SHARED WORKER_LABEL=local \
     ./.venv/bin/uvicorn worker:app --port 8000 ) >$TT/pipe-local.log 2>&1 &
  OWNED+=($!)
  until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
fi

# cloud worker (the SHIPPED docker image) on a free loopback port. It reaches the host MinIO and
# gateway through host.docker.internal, so those two (and only those) are reachable from it.
ws_dk run -d --name "${WS_DK_RUN_ID}-cloud" --label "$WS_DK_LABEL" "${WS_DK_LIMITS[@]}" --memory 2g --memory-swap 2g \
  --tmpfs /tmp:rw,size=2g -p "127.0.0.1:${CP}:8000" \
  -e PIPELINE_SHARED_SECRET=$SHARED -e WORKER_LABEL=cloud-docker -e PYTHONDONTWRITEBYTECODE=1 \
  -e B2_S3_ENDPOINT=http://host.docker.internal:9000 -e B2_REGION=us-east-1 \
  -e B2_KEY_ID=minioadmin -e B2_APP_KEY=minioadmin -e B2_BUCKET=$BUCKET \
  -e B2_FORCE_PATH_STYLE=true -e GATEWAY_URL=http://host.docker.internal:8787 \
  --add-host=host.docker.internal:host-gateway "$CLOUD_IMAGE" >/dev/null || { echo "FAIL: cloud worker did not start"; exit 1; }
if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then echo "PLAN-ONLY: nothing executed"; exit 0; fi
until curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:$CP/healthz"; do sleep 0.5; done

# gateway with BOTH workers registered
( cd "$WEB/gateway" && exec env CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   DEV_TRIGGER_ON_COMPLETE=true \
   PIPELINE_URL=http://localhost:8000 PIPELINE_URL_CLOUD=http://127.0.0.1:$CP \
   PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts ) >$TT/gw.log 2>&1 &
OWNED+=($!)
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
echo "✓ minio + local worker + DOCKER cloud worker + gateway up"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -f lavfi -i sine=frequency=440:duration=3 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/clip.mp4" >$TT/ff.log 2>&1

send() { # $1=tag $2=compute — real gateway flow: initiate → PUT → complete
  "$PY" - "$1" "$2" <<'PYEOF'
TT = __import__("os").environ["TT"]
import json, subprocess, sys, time, urllib.request
tag, compute = sys.argv[1], sys.argv[2]
GW = "http://localhost:8787/api"
def post(p, body):
    r = urllib.request.urlopen(urllib.request.Request(GW+p, json.dumps(body).encode(), {"content-type":"application/json"}))
    return json.loads(r.read())
data = open(TT + "/compute-clip.mp4","rb").read()
up = post("/uploads", {"filename":"clip.mp4","contentType":"video/mp4","size":len(data)})
key, uid = up["key"], up["uploadId"]
tid = key.split("/")[1]
subprocess.Popen(["curl","-N","-s",f"{GW}/progress/{tid}"], stdout=open(f"{TT}/sse-{tag}.log","w"))
for _ in range(50):
    if "subscribed" in open(f"{TT}/sse-{tag}.log").read(): break
    time.sleep(0.2)
urls = post("/uploads/parts", {"key":key,"uploadId":uid,"partNumbers":[1]})["urls"]
urllib.request.urlopen(urllib.request.Request(urls["1"], data, method="PUT"))
post("/uploads/complete", {"key":key,"uploadId":uid,"blake3Root":"deadbeef",
     "options":{"qc_ai":False,"summarize":False,"compute":compute}})
print(tid)
PYEOF
}
cp "$WORK/clip.mp4" $TT/compute-clip.mp4

TID_L=$(send local local)
for i in $(seq 1 120); do grep -q pipeline_complete $TT/sse-local.log 2>/dev/null && break; sleep 0.5; done
grep -q pipeline_complete $TT/sse-local.log || { echo "FAIL: local run incomplete"; tail -5 $TT/pipe-local.log; exit 1; }
echo "✓ transfer L (compute=local) complete"
TID_C=$(send cloud cloud)
for i in $(seq 1 180); do grep -q pipeline_complete $TT/sse-cloud.log 2>/dev/null && break; sleep 0.5; done
grep -q pipeline_complete $TT/sse-cloud.log || { echo "FAIL: cloud run incomplete"; ws_dk logs --tail 10 "${WS_DK_RUN_ID}-cloud"; exit 1; }
echo "✓ transfer C (compute=cloud) complete"

echo "=== compute-routing assertions ==="
"$PY" - "$TID_L" "$TID_C" <<'PYEOF'
TT = __import__("os").environ["TT"]
import boto3, json, sys; from botocore.config import Config
tl, tc = sys.argv[1:3]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def man(tid): return json.loads(s3.get_object(Bucket="waystation-test", Key=f"derivatives/{tid}/manifest.json")["Body"].read())
ok = True
for tid, tag, expect in ((tl, "local", "local"), (tc, "cloud", "cloud-docker")):
    compute = man(tid)["run"]["metadata"].get("compute")
    sse = open(f"{TT}/sse-{tag}.log").read()
    started = f'"compute":"{expect}"' in sse.replace(" ", "")
    print(f"  {tag}: manifest.run.metadata.compute = {compute!r}, SSE labeled: {started}")
    if compute != expect: print(f"  FAIL: expected {expect}"); ok = False
    if not started: print(f"  FAIL: pipeline_started missing compute label"); ok = False
# the two transfers were genuinely processed by different processes
print("PASS ✓  checkbox routes compute (local vs docker) and provenance records it" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
