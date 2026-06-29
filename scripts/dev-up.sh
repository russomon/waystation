#!/usr/bin/env bash
# One command to run the whole stack locally: MinIO (B2 stand-in) + gateway
# + pipeline worker + Vite client, all wired together. Open localhost:5173,
# drag in a small video, watch the pipeline run, then open the share link.
# Ctrl-C tears everything down. Data persists in .devdata/ across runs.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA="$WEB/.devdata"; mkdir -p "$DATA"
SECRET=devevent; SHARED=devshared; BUCKET=orbitxfer-dev
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 \
       B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true

kill_ports(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; lsof -ti:5173; } 2>/dev/null | xargs kill -9 2>/dev/null || true; }
trap 'echo; echo "shutting down…"; kill_ports' EXIT INT TERM
kill_ports

# preflight
command -v minio >/dev/null || { echo "✗ minio not found — brew install minio"; exit 1; }
[ -x "$PY" ] || { echo "✗ pipeline venv missing — cd pipeline && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"; exit 1; }
[ -d "$WEB/crates/blake3-outboard/pkg" ] || { echo "✗ wasm not built — npm run build:wasm"; exit 1; }
[ -d "$WEB/node_modules" ] || { echo "✗ deps not installed — npm install"; exit 1; }

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

echo "▶ gateway…"
( cd "$WEB/gateway" && CDN_BASE=http://localhost:9000 CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 \
   DEV_TRIGGER_ON_COMPLETE=true PORT=8787 npx tsx src/server.ts >/tmp/ox-gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done

echo "▶ pipeline…"
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED GMI_API_KEY="${GMI_API_KEY:-}" \
   ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/ox-pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done

echo "▶ client (vite)…"
( cd "$WEB/client" && npm run dev >/tmp/ox-client.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:5173/; do sleep 0.5; done

cat <<MSG

  ✅ OrbitXfer Web is up.
       open  →  http://localhost:5173
       logs  →  /tmp/ox-{minio,gw,pipe,client}.log
       data  →  $DATA  (persists across runs)
       GMI   →  ${GMI_API_KEY:+set (real summarize)}${GMI_API_KEY:-unset (summarize step skips)}

  Drag in a small video → watch the pipeline → open the share link → Verify.
  Ctrl-C to stop everything.

MSG
while true; do sleep 3600; done
