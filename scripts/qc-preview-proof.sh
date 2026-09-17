#!/usr/bin/env bash
# QC preview mode: the Transfer + QC tab stays visible to every sender, but
# with WAYSTATION_QC_MODE=preview only the admin session may START a QC
# upload. A client is refused at initiate — 403 qc_preview, before any
# multipart exists on B2 — and GET /session tells each viewer which they get,
# so the page can grey the panel out rather than let someone discover the
# rule by trying. Default is live, so nothing else in the suite changes.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8798 MIN=9018 BUCKET=waystation-qcpreview-proof
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── static guard: the client tells the gateway which tab it is on ────────────
INIT=$(awk '/const r = await post\("\/uploads", \{/,/\}\);/' "$WEB/client/src/uploader.ts")
printf '%s' "$INIT" | grep -q 'mode:' || { echo "FAIL - the client's initiate body no longer carries mode; the gateway cannot tell QC from Transfer"; exit 1; }
grep -q 'code: "qc_preview"' "$WEB/gateway/src/routes.ts" || { echo "FAIL - gateway has no qc_preview refusal"; exit 1; }
echo "  guards: initiate carries mode; the gateway has the refusal"

command -v minio >/dev/null || { echo "SKIP (live half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (live half) - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/qcpreview-minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$MIN/minio/health/live; do sleep .2; done
"$PY" - <<PY
import boto3
from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://127.0.0.1:$MIN",region_name="us-east-1",
  aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",
  config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PY

start_gateway(){ # [WAYSTATION_QC_MODE value]
  { lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$WEB/gateway" && PORT=$GW WAYSTATION_DB_PATH="$WORK/gateway.db" \
    WAYSTATION_AUTH_MODE=access-code WAYSTATION_ACCESS_CODE_HASH="$HASH" \
    WAYSTATION_SESSION_SECRET="$SECRET" WAYSTATION_ALLOWED_ORIGINS="https://orbitolive.com" \
    B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
    DEV_TRIGGER_ON_COMPLETE=false \
    env ${1:+WAYSTATION_QC_MODE="$1"} npx tsx src/server.ts >/tmp/qcpreview-gateway.log 2>&1 & )
}
wait_gateway(){ until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done; }

# 1. an unknown mode refuses to boot; preview shows in the banner
start_gateway bogus; sleep 3
grep -q 'WAYSTATION_QC_MODE must be "live" or "preview"' /tmp/qcpreview-gateway.log \
  || { echo "FAIL - an invalid WAYSTATION_QC_MODE did not refuse to start"; exit 1; }
start_gateway preview; wait_gateway
grep -q "qc=preview" /tmp/qcpreview-gateway.log || { echo "FAIL - banner does not show qc=preview"; exit 1; }
echo "  invalid mode refuses to boot; preview is announced in the banner"

ORIGIN=https://orbitolive.com ADMIN="$WORK/admin.cookie" CLIENT="$WORK/client.cookie"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
J='content-type: application/json'
initiate(){ # cookie extra-json-fields
  curl -s -b "$1" -X POST -H "Origin: $ORIGIN" -H "$J" -w '\n%{http_code}' \
    --data "{\"filename\":\"m.mov\",\"contentType\":\"video/quicktime\",\"size\":1048576$2}" http://127.0.0.1:$GW/api/uploads
}
rows(){ "$PY" -c 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("select count(*) from uploads").fetchone()[0])' "$WORK/gateway.db"; }

# 2. the admin is live even in preview
curl -fsS -c "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
curl -fsS -b "$ADMIN" http://127.0.0.1:$GW/api/session | grep -q '"qc":"live"' || { echo "FAIL - admin does not see QC live"; exit 1; }
R=$(initiate "$ADMIN" ',"mode":"qc"'); [ "$(printf '%s' "$R" | tail -1)" = 200 ] || { echo "FAIL - admin QC initiate refused: $R"; exit 1; }
[ "$(rows)" = 1 ]
echo "  the admin session sees qc:live and can start a QC upload"

# 3. a client is in preview: QC refused before anything is created, Transfer unaffected
ISSUED=$(curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data '{"label":"Client"}' http://127.0.0.1:$GW/api/admin/codes)
CLIENT_CODE=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["code"])' "$ISSUED")
curl -fsS -c "$CLIENT" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$CLIENT_CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
curl -fsS -b "$CLIENT" http://127.0.0.1:$GW/api/session | grep -q '"qc":"preview"' || { echo "FAIL - client does not see QC preview"; exit 1; }
R=$(initiate "$CLIENT" ',"mode":"qc"')
[ "$(printf '%s' "$R" | tail -1)" = 403 ] && printf '%s' "$R" | grep -q qc_preview || { echo "FAIL - client QC initiate not refused with qc_preview: $R"; exit 1; }
[ "$(rows)" = 1 ] || { echo "FAIL - a refused QC initiate still created an upload row"; exit 1; }
R=$(initiate "$CLIENT" ',"mode":"transfer"'); [ "$(printf '%s' "$R" | tail -1)" = 200 ] || { echo "FAIL - client Transfer initiate refused: $R"; exit 1; }
R=$(initiate "$CLIENT" ''); [ "$(printf '%s' "$R" | tail -1)" = 200 ] || { echo "FAIL - client initiate without mode refused: $R"; exit 1; }
R=$(initiate "$CLIENT" ',"mode":"bogus"'); [ "$(printf '%s' "$R" | tail -1)" = 400 ] || { echo "FAIL - bogus mode accepted: $R"; exit 1; }
[ "$(rows)" = 3 ]
echo "  a client sees qc:preview; QC initiate is 403 qc_preview with no row; Transfer and no-mode succeed; a bogus mode is 400"

# 4. default is live: the same client may start QC when the flag is unset
start_gateway; wait_gateway
grep -q "qc=live" /tmp/qcpreview-gateway.log || { echo "FAIL - default banner is not qc=live"; exit 1; }
curl -fsS -b "$CLIENT" http://127.0.0.1:$GW/api/session | grep -q '"qc":"live"' || { echo "FAIL - client does not see QC live by default"; exit 1; }
R=$(initiate "$CLIENT" ',"mode":"qc"'); [ "$(printf '%s' "$R" | tail -1)" = 200 ] || { echo "FAIL - client QC initiate refused in live mode: $R"; exit 1; }
echo "  without the flag the deployment is live and the client may start QC"

echo "PASS - QC preview: visible to all, startable only by the admin, refused before spend, live by default"
