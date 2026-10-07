#!/usr/bin/env bash
# Optional recipient-password proof over the real gateway + MinIO multipart path.
set -euo pipefail
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8793 MIN=9013 BUCKET=waystation-password-proof
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
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
  minio server "$WORK/minio" --address :$MIN >$TT/password-minio.log 2>&1 &
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
    MAX_ACTIVE_UPLOADS_PER_SESSION=50 MAX_JOBS_PER_SESSION=50 \
    npx tsx src/server.ts >$TT/password-gateway.log 2>&1 & )
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
assert version >= 3 and "password_hash" in cols  # >= : later migrations (v4 access codes) may run in the same start
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
TID=$(complete_upload "$PROTECTED" '"open-sesame"')
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code http://127.0.0.1:$GW/api/transfers/$TID)" = 401 ]
[ "$(code http://127.0.0.1:$GW/api/progress/$TID)" = 401 ]
[ "$(code --get --data-urlencode "key=transfers/$TID/protected.bin" http://127.0.0.1:$GW/api/transfers/$TID/download)" = 401 ]
[ "$(code -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' --data '{"password":"wrong"}' http://127.0.0.1:$GW/api/transfers/$TID/unlock)" = 401 ]
echo "  protected metadata, progress, and download signing refuse unauthenticated recipients"

# The sender's own session is not a key to the delivery page. A sender tests
# the link before forwarding it; being waved past the password they just set
# looks like the feature is broken and hides what the recipient will see.
[ "$(code -b "$SENDER" http://127.0.0.1:$GW/api/transfers/$TID)" = 401 ]
[ "$(code -b "$SENDER" --get --data-urlencode "key=transfers/$TID/protected.bin" http://127.0.0.1:$GW/api/transfers/$TID/download)" = 401 ]
[ "$(code -b "$SENDER" http://127.0.0.1:$GW/api/transfers/$TID/original)" = 401 ]
echo "  the sender's own session is asked for the password like any recipient"
# ...but the progress stream is the send page's QC view, opened under the
# sender session with no unlock step, so it must still admit the sender.
{ curl -sN --max-time 1 -b "$SENDER" http://127.0.0.1:$GW/api/progress/$TID 2>/dev/null || true; } | grep -q subscribed
echo "  the progress stream still admits the originating sender session"

curl -fsS -c "$RECIPIENT" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"password":"open-sesame"}' http://127.0.0.1:$GW/api/transfers/$TID/unlock >/dev/null
[ "$(code -b "$RECIPIENT" http://127.0.0.1:$GW/api/transfers/$TID)" = 200 ]
[ "$(code -b "$RECIPIENT" --get --data-urlencode "key=transfers/$TID/protected.bin" http://127.0.0.1:$GW/api/transfers/$TID/download)" = 200 ]
{ curl -sN --max-time 1 -b "$RECIPIENT" http://127.0.0.1:$GW/api/progress/$TID 2>/dev/null || true; } | grep -q subscribed
echo "  the password unlocks all recipient routes"

"$PY" - "$WORK/gateway.db" "$TID" <<'PY'
import sqlite3,sys
value=sqlite3.connect(sys.argv[1]).execute("select password_hash from transfers where transfer_id=?",(sys.argv[2],)).fetchone()[0]
parts=value.split("$")
assert value != "open-sesame" and len(parts) == 6 and parts[0] == "scrypt" and len(parts[4]) >= 16 and len(parts[5]) >= 32
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

# ── a NEW transfer's password is at least 4 characters ──
complete_raw(){ # init-json password -> http status of /uploads/complete
  local key upl
  key=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["key"])' "$1")
  upl=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["uploadId"])' "$1")
  code -b "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
    --data "{\"key\":\"$key\",\"uploadId\":\"$upl\",\"recipientPassword\":\"$2\"}" \
    http://127.0.0.1:$GW/api/uploads/complete
}
for short in a ab abc; do
  [ "$(complete_raw "$(init_upload "short-$short.bin")" "$short")" = 400 ] \
    || { echo "FAIL - a $((${#short}))-character password was accepted for a new transfer"; exit 1; }
done
FOUR_TID=$(complete_upload "$(init_upload four.bin)" '"abcd"') \
  || { echo "FAIL - a 4-character password was refused"; exit 1; }
echo "  new transfers refuse 1-3 character passwords and accept 4"

# ── ...but a link created before the minimum still opens with its old password ──
LEGACY_HASH=$(cd "$WEB/gateway" && npx tsx -e 'import { hashAccessCode } from "./src/auth.ts"; console.log(hashAccessCode("x"))' 2>/dev/null | tail -1)
"$PY" - "$WORK/gateway.db" "$FOUR_TID" "$LEGACY_HASH" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("update transfers set password_hash=? where transfer_id=?",(sys.argv[3],sys.argv[2])); db.commit()
PY
[ "$(code -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' --data '{"password":"x"}' \
  http://127.0.0.1:$GW/api/transfers/$FOUR_TID/unlock)" = 200 ] \
  || { echo "FAIL - an existing 1-character password no longer unlocks its link"; exit 1; }
echo "  an existing link with a 1-character password still unlocks (the minimum applies to new transfers only)"

# ── guessing one link is capped, from however many addresses ──
LOCKED_TID=$(complete_upload "$(init_upload locked.bin)" '"right-pass"')
unlock_as(){ # tid password ip -> status
  code -X POST -H "Origin: $ORIGIN" -H "CF-Connecting-IP: $3" -H 'content-type: application/json' \
    --data "{\"password\":\"$2\"}" http://127.0.0.1:$GW/api/transfers/$1/unlock
}
for i in $(seq 1 20); do
  [ "$(unlock_as "$LOCKED_TID" wrong "10.1.0.$i")" = 401 ] || { echo "FAIL - wrong guess $i was not a plain 401"; exit 1; }
done
BODY=$(curl -s -X POST -H "Origin: $ORIGIN" -H "CF-Connecting-IP: 10.1.1.1" -H 'content-type: application/json' \
  --data '{"password":"right-pass"}' http://127.0.0.1:$GW/api/transfers/$LOCKED_TID/unlock)
printf '%s' "$BODY" | grep -q '"unlock_locked"' \
  || { echo "FAIL - after 20 wrong guesses from 20 addresses the link was not locked: $BODY"; exit 1; }
[ "$(unlock_as "$TID" open-sesame 10.1.2.1)" = 200 ] || { echo "FAIL - locking one link locked another"; exit 1; }
echo "  20 wrong guesses from 20 different addresses lock that link (even the right password waits); other links are unaffected"

# ── and the whole deployment's guess rate is capped (60/min), last because it
#    leaves the unlock route saturated for the rest of the minute ──
hit=""
for i in $(seq 1 70); do
  BODY=$(curl -s -X POST -H "Origin: $ORIGIN" -H "CF-Connecting-IP: 10.2.$i.1" -H 'content-type: application/json' \
    --data '{"password":"wrong"}' http://127.0.0.1:$GW/api/transfers/$TID/unlock)
  if printf '%s' "$BODY" | grep -q '"rate_limited"'; then hit=$i; break; fi
done
[ -n "$hit" ] && [ "$hit" -le 61 ] || { echo "FAIL - no deployment-wide cap on unlock attempts (hit=${hit:-never})"; exit 1; }
echo "  a distributed guesser (one attempt per address) hits the deployment-wide cap (request $hit this minute)"

echo "PASS - optional recipient passwords are hashed, persistent, scoped, and enforced"
