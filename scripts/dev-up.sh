#!/usr/bin/env bash
# One command to run the whole stack locally: MinIO (B2 stand-in) + gateway
# + pipeline worker + Vite client, all wired together. Open localhost:5173,
# drag in a small video, watch the pipeline run, then open the share link.
# Ctrl-C tears everything down. Data persists in .devdata/ across runs.
# The shipped Docker worker runs on :8001 by default so the checked Cloud
# compute option always routes to a distinct, tool-complete process. Set
# WAYSTATION_LOCAL_CLOUD_WORKER=false only when deliberately running host-only.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA="$WEB/.devdata"; mkdir -p "$DATA"
SECRET=devevent; SHARED=devshared; BUCKET=waystation-dev
LOCAL_CLOUD_WORKER="${WAYSTATION_LOCAL_CLOUD_WORKER:-true}"
CLOUD_CONTAINER="waystation-local-cloud-worker"
CLOUD_PIPELINE_URL=""
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 \
       B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true

kill_ports(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:8001; lsof -ti:9000; lsof -ti:5173; } 2>/dev/null | xargs kill -9 2>/dev/null || true; }
cleanup(){
  trap - EXIT INT TERM
  echo
  echo "shutting down…"
  if [ "$LOCAL_CLOUD_WORKER" = "true" ]; then
    docker rm -f "$CLOUD_CONTAINER" >/dev/null 2>&1 || true
  fi
  kill_ports
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
kill_ports

# preflight
command -v minio >/dev/null || { echo "✗ minio not found — brew install minio"; exit 1; }
[ -x "$PY" ] || { echo "✗ pipeline venv missing — cd pipeline && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt"; exit 1; }
[ -d "$WEB/crates/blake3-outboard/pkg" ] || { echo "✗ wasm not built — npm run build:wasm"; exit 1; }
[ -d "$WEB/node_modules" ] || { echo "✗ deps not installed — npm install"; exit 1; }
if [ "$LOCAL_CLOUD_WORKER" = "true" ]; then
  command -v docker >/dev/null || { echo "✗ Docker is required for local Cloud compute"; exit 1; }
  docker info >/dev/null 2>&1 || { echo "✗ Docker is not running — start Docker Desktop"; exit 1; }
fi

echo "▶ MinIO…"
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin MINIO_API_CORS_ALLOW_ORIGIN="http://localhost:5173" \
  minio server "$DATA" --address :9000 --console-address :9011 >/tmp/ox-minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done

# bucket (CORS is handled by MINIO_API_CORS_ALLOW_ORIGIN above — verified to
# allow the cross-origin PUT preflight; the gateway assembles from ListParts
# so no ETag exposure is needed)
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
print("  bucket ready")
PYEOF

if [ "$LOCAL_CLOUD_WORKER" = "true" ]; then
  echo "▶ cloud worker image…"
  PIPELINE_FINGERPRINT=$(
    cd "$WEB"
    git ls-files -z pipeline \
      | xargs -0 shasum -a 256 \
      | shasum -a 256 \
      | cut -c1-12
  )
  CLOUD_IMAGE="waystation-worker:local-$PIPELINE_FINGERPRINT"
  if ! docker image inspect "$CLOUD_IMAGE" >/dev/null 2>&1; then
    docker build -t "$CLOUD_IMAGE" "$WEB/pipeline" \
      >/tmp/ox-cloud-build.log 2>&1 \
      || { echo "✗ cloud worker build failed — see /tmp/ox-cloud-build.log"; tail -30 /tmp/ox-cloud-build.log; exit 1; }
  fi
  docker rm -f "$CLOUD_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CLOUD_CONTAINER" -p 8001:8000 \
    --add-host=host.docker.internal:host-gateway \
    -v waystation-local-cloud-scratch:/tmp \
    -e PIPELINE_SHARED_SECRET="$SHARED" \
    -e WORKER_LABEL=cloud-docker-local \
    -e GATEWAY_URL=http://host.docker.internal:8787 \
    -e B2_S3_ENDPOINT=http://host.docker.internal:9000 \
    -e B2_REGION=us-east-1 -e B2_KEY_ID=minioadmin -e B2_APP_KEY=minioadmin \
    -e B2_BUCKET="$BUCKET" -e B2_FORCE_PATH_STYLE=true -e MANIFEST_LOCK_DAYS=0 \
    -e GMI_API_KEY -e GMI_BASE_URL -e GMI_MODEL -e GMI_MULTIMODAL_MODEL \
    -e AI_INTERPRETIVE_RUN_ENABLED -e AI_INTERPRETIVE_AUTHORITY_MODE \
    -e AI_INTERPRETIVE_SHADOW -e AI_INTERPRETIVE_PROVIDER \
    -e AI_INTERPRETIVE_PLANNER_MODEL -e AI_INTERPRETIVE_VISUAL_MODEL \
    -e AI_INTERPRETIVE_AUDIO_MODEL -e AI_INTERPRETIVE_JURY_MODEL \
    -e AI_INTERPRETIVE_SYNTHESIS_MODEL -e AI_INTERPRETIVE_FALLBACK_PROVIDER \
    -e AI_INTERPRETIVE_FALLBACK_MODEL -e AI_INTERPRETIVE_MAX_CONCURRENCY \
    -e AI_INTERPRETIVE_STAGE_MAX_ATTEMPTS -e AI_INTERPRETIVE_RETRY_DELAY_SECONDS \
    -e AI_INTERPRETIVE_MAX_FRAMES -e AI_INTERPRETIVE_MAX_AUDIO_WINDOWS \
    -e AI_INTERPRETIVE_MAX_OUTPUT_TOKENS -e AI_INTERPRETIVE_PLANNER_MAX_OUTPUT_TOKENS \
    -e AI_INTERPRETIVE_SYNTHESIS_MAX_OUTPUT_TOKENS \
    "$CLOUD_IMAGE" >/dev/null
  until curl -sf -o /dev/null --max-time 1 http://localhost:8001/healthz; do sleep 0.5; done
  CLOUD_PIPELINE_URL=http://localhost:8001
  echo "  cloud route ready @ cloud-docker-local"
fi

echo "▶ gateway…"
( cd "$WEB/gateway" && CDN_BASE=http://localhost:9000 CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_URL_CLOUD="$CLOUD_PIPELINE_URL" \
   PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 \
   DEV_TRIGGER_ON_COMPLETE=true PORT=8787 npx tsx src/server.ts >/tmp/ox-gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done

echo "▶ pipeline…"
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED GMI_API_KEY="${GMI_API_KEY:-}" \
   MANIFEST_LOCK_DAYS=0 \
   ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/ox-pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done

echo "▶ client (vite)…"
( cd "$WEB/client" && npm run dev >/tmp/ox-client.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:5173/; do sleep 0.5; done

if [ -n "${GMI_API_KEY:-}" ]; then
  GMI_STATUS="set (real GMI enabled)"
else
  GMI_STATUS="unset (GMI steps skip)"
fi
if [ "$LOCAL_CLOUD_WORKER" = "true" ]; then
  CLOUD_STATUS="ready @ cloud-docker-local (:8001)"
else
  CLOUD_STATUS="not registered (cloud requests fall back to local)"
fi

cat <<MSG

  ✅ Waystation is up.
       open  →  http://localhost:5173
       logs  →  /tmp/ox-{minio,gw,pipe,client}.log
       data  →  $DATA  (persists across runs)
       GMI   →  $GMI_STATUS
       cloud →  $CLOUD_STATUS
       lock  →  off (local MinIO)

  Drag in a small video → watch the pipeline → open the share link → Verify.
  Ctrl-C to stop everything.

MSG
while true; do sleep 3600; done
