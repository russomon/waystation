#!/usr/bin/env bash
# Optional recipient-password proof over the real gateway + MinIO multipart path.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8793 MIN=9013 BUCKET=waystation-password-proof
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
command -v minio >/dev/null || { echo "SKIP - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/password-minio.log 2>&1 &
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

start_gateway(){
  { lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$WEB/gateway" && PORT=$GW WAYSTATION_DB_PATH="$WORK/gateway.db" \
    WAYSTATION_AUTH_MODE=access-code WAYSTATION_ACCESS_CODE_HASH="$HASH" \
    WAYSTATION_SESSION_SECRET="$SECRET" WAYSTATION_ALLOWED_ORIGINS="https://orbitolive.com" \
    B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=proof-secret CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=cdn-secret \
    B2_EVENT_SIGNING_SECRET=event-secret DEV_TRIGGER_ON_COMPLETE=false \
    npx tsx src/server.ts >/tmp/password-gateway.log 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done
}
start_gateway

# Simulate the persistent production database immediately before this feature:
# schema v2 has no password_hash column. The next gateway start must migrate it
# in place rather than requiring a fresh control volume.
{ lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute("ALTER TABLE transfers DROP COLUMN password_hash")
db.execute("PRAGMA user_version = 2")
db.commit()
PY
start_gateway
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
cols={row[1] for row in db.execute("PRAGMA table_info(transfers)")}
version=db.execute("PRAGMA user_version").fetchone()[0]
assert version == 3 and "password_hash" in cols
print("  schema v2 migrates in place to the password-capable schema")
PY
ORIGIN=https://orbitolive.com SENDER="$WORK/sender.cookie" RECIPIENT="$WORK/recipient.cookie"
curl -fsS -c "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
dd if=/dev/zero of="$WORK/file.bin" bs=1m count=6 status=none

init_upload(){
  curl -fsS -b "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
    --data "{\"filename\":\"$1\",\"contentType\":\"application/octet-stream\",\"size\":6291456}" \
    http://127.0.0.1:$GW/api/uploads
}
complete_upload(){ # init-json password-json-value
  "$PY" - "$1" "$2" "$SENDER" "$ORIGIN" "$GW" "$WORK/file.bin" <<'PY'
import json, sys, urllib.request, http.cookiejar
up, password, cookie_path, origin, port, source = json.loads(sys.argv[1]), json.loads(sys.argv[2]), *sys.argv[3:]
cookies=http.cookiejar.MozillaCookieJar(cookie_path); cookies.load(ignore_discard=True, ignore_expires=True)
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
base=f"http://127.0.0.1:{port}/api"
def post(path, body):
  req=urllib.request.Request(base+path,json.dumps(body).encode(),{"content-type":"application/json","origin":origin})
  return json.loads(opener.open(req).read())
parts=post("/uploads/parts",{"key":up["key"],"uploadId":up["uploadId"],"partNumbers":[1]})
data=open(source,"rb").read()
urllib.request.urlopen(urllib.request.Request(parts["urls"]["1"],data,method="PUT"))
body={"key":up["key"],"uploadId":up["uploadId"],"blake3Root":"proof-root","options":{"qc_av":False}}
if password is not None: body["recipientPassword"]=password
post("/uploads/complete",body)
print(up["key"].split("/")[1])
PY
}

PROTECTED=$(init_upload protected.bin)
TID=$(complete_upload "$PROTECTED" '"x"')
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code http://127.0.0.1:$GW/api/transfers/$TID)" = 401 ]
[ "$(code http://127.0.0.1:$GW/api/progress/$TID)" = 401 ]
[ "$(code --get --data-urlencode "key=transfers/$TID/protected.bin" http://127.0.0.1:$GW/api/transfers/$TID/download)" = 401 ]
[ "$(code -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' --data '{"password":"wrong"}' http://127.0.0.1:$GW/api/transfers/$TID/unlock)" = 401 ]
echo "  protected metadata, progress, and download signing refuse unauthenticated recipients"

curl -fsS -c "$RECIPIENT" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"password":"x"}' http://127.0.0.1:$GW/api/transfers/$TID/unlock >/dev/null
[ "$(code -b "$RECIPIENT" http://127.0.0.1:$GW/api/transfers/$TID)" = 200 ]
[ "$(code -b "$RECIPIENT" --get --data-urlencode "key=transfers/$TID/protected.bin" http://127.0.0.1:$GW/api/transfers/$TID/download)" = 200 ]
{ curl -sN --max-time 1 -b "$RECIPIENT" http://127.0.0.1:$GW/api/progress/$TID 2>/dev/null || true; } | grep -q subscribed
echo "  one-character password unlocks all recipient routes"

"$PY" - "$WORK/gateway.db" "$TID" <<'PY'
import sqlite3,sys
value=sqlite3.connect(sys.argv[1]).execute("select password_hash from transfers where transfer_id=?",(sys.argv[2],)).fetchone()[0]
parts=value.split("$")
assert value != "x" and len(parts) == 6 and parts[0] == "scrypt" and len(parts[4]) >= 16 and len(parts[5]) >= 32
print("  persistent database contains a salted scrypt record, not plaintext")
PY

start_gateway
[ "$(code -b "$RECIPIENT" http://127.0.0.1:$GW/api/transfers/$TID)" = 200 ]
echo "  recipient unlock survives a gateway restart"

OPEN=$(init_upload open.bin)
OPEN_TID=$(complete_upload "$OPEN" 'null')
[ "$(code http://127.0.0.1:$GW/api/transfers/$OPEN_TID)" = 200 ]
echo "  unprotected transfers remain recipient-accessible"

TOO_LONG=$(init_upload too-long.bin)
LONG=$(printf 'x%.0s' $(seq 1 129))
KEY=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["key"])' "$TOO_LONG")
UPL=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["uploadId"])' "$TOO_LONG")
[ "$(code -b "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"key\":\"$KEY\",\"uploadId\":\"$UPL\",\"recipientPassword\":\"$LONG\"}" \
  http://127.0.0.1:$GW/api/uploads/complete)" = 400 ]
echo "  129-character passwords are rejected before multipart completion"

echo "PASS - optional recipient passwords are hashed, persistent, scoped, and enforced"
