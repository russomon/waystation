#!/usr/bin/env bash
# Named sender access codes, administered from the portal.
#
# The environment code is the admin. Every other code is a row in access_codes,
# issued by the admin, shown to them exactly once, stored only as an scrypt
# hash, and revocable with effect on the holder's NEXT request — not when their
# cookie happens to expire. Every upload and transfer records which code sent
# it (owner_id), which is the durable identity docs/COMMERCIAL_DELIVERY_PLAN.md
# says must not be deferred.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8797 MIN=9017 BUCKET=waystation-codes-proof
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── static guards: run even without minio ────────────────────────────────────
ROUTES="$WEB/gateway/src/routes.ts" DB="$WEB/gateway/src/db.ts"
CREATE=$(awk '/api.post\("\/admin\/codes",/,/^}\);/' "$ROUTES")
if printf '%s' "$CREATE" | grep -v '^\s*//' | grep -q 'console\.'; then
  echo "FAIL - the create route logs something; the plaintext code must never reach a log"; exit 1; fi
if awk '/const selectCodeList/,/`\);/' "$DB" | grep -v '^\s*//' | grep -q 'code_hash\|SELECT \*'; then
  echo "FAIL - the list query selects code_hash (or *), so a route could leak hashes"; exit 1; fi
grep -q 'accessCodeActive(s.ownerId)' "$WEB/gateway/src/auth.ts" \
  || { echo "FAIL - requireSession no longer re-checks revocation per request"; exit 1; }
echo "  guards: create route never logs; list never selects the hash; revocation is checked per request"

command -v minio >/dev/null || { echo "SKIP (live half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (live half) - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/codes-minio.log 2>&1 &
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
    PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
    DEV_TRIGGER_ON_COMPLETE=false \
    npx tsx src/server.ts >/tmp/codes-gateway.log 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done
}
start_gateway

# 1. the production database immediately before this feature is schema v3 with
#    no access_codes table and no owner_id columns; it must migrate in place.
{ lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute("DROP TABLE access_codes")
db.execute("ALTER TABLE uploads DROP COLUMN owner_id")
db.execute("ALTER TABLE transfers DROP COLUMN owner_id")
db.execute("INSERT INTO transfers (transfer_id, object_key, created_at) VALUES ('legacy', 'transfers/legacy/x.bin', '2026-01-01T00:00:00Z')")
db.execute("PRAGMA user_version = 3")
db.commit()
PY
start_gateway
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
assert db.execute("PRAGMA user_version").fetchone()[0] == 4
tables={r[0] for r in db.execute("select name from sqlite_master where type='table'")}
assert "access_codes" in tables
assert db.execute("select owner_id from transfers where transfer_id='legacy'").fetchone()[0] is None
print("  schema v3 migrates in place to v4; pre-identity rows keep a NULL owner")
PY
grep -q "senderCodes=0" /tmp/codes-gateway.log || { echo "FAIL - boot banner does not report the code count"; exit 1; }

ORIGIN=https://orbitolive.com ADMIN="$WORK/admin.cookie" CLIENT="$WORK/client.cookie"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
J='content-type: application/json'

# 2. the environment code is the admin
curl -fsS -c "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
curl -fsS -b "$ADMIN" http://127.0.0.1:$GW/api/session | grep -q '"admin":true' || { echo "FAIL - env code is not admin"; exit 1; }
[ "$(code -X POST -H "Origin: $ORIGIN" -H "$J" --data '{"label":"nobody"}' http://127.0.0.1:$GW/api/admin/codes)" = 401 ]
echo "  the environment code opens the admin session; no session gets 401 on /admin"

# 3. issue a code: shaped like the operator script's, returned once, stored as a hash only
[ "$(code -b "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data '{"label":""}' http://127.0.0.1:$GW/api/admin/codes)" = 400 ]
ISSUED=$(curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data '{"label":"  Acme Post  "}' http://127.0.0.1:$GW/api/admin/codes)
CLIENT_CODE=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["code"])' "$ISSUED")
CODE_ID=$("$PY" -c 'import json,sys;print(json.loads(sys.argv[1])["codeId"])' "$ISSUED")
printf '%s' "$CLIENT_CODE" | grep -Eq '^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$' || { echo "FAIL - issued code has the wrong shape"; exit 1; }
"$PY" - "$WORK/gateway.db" "$CODE_ID" "$CLIENT_CODE" <<'PY'
import sqlite3,sys
db,cid,plain=sqlite3.connect(sys.argv[1]),sys.argv[2],sys.argv[3]
label,h=db.execute("select label, code_hash from access_codes where code_id=?",(cid,)).fetchone()
assert label == "Acme Post", label            # trimmed
assert h != plain and h.startswith("scrypt$") and len(h.split("$")) == 6
assert plain not in open(sys.argv[1],"rb").read().decode("latin1")
print("  the code is returned once and the database holds only its scrypt hash")
PY
LIST=$(curl -fsS -b "$ADMIN" http://127.0.0.1:$GW/api/admin/codes)
printf '%s' "$LIST" | grep -q "$CLIENT_CODE" && { echo "FAIL - list discloses the code"; exit 1; }
printf '%s' "$LIST" | grep -q 'scrypt\$\|code_hash\|codeHash' && { echo "FAIL - list discloses the hash"; exit 1; }
printf '%s' "$LIST" | grep -q '"label":"Acme Post"' || { echo "FAIL - list is missing the new code"; exit 1; }
grep -q "$CLIENT_CODE" /tmp/codes-gateway.log && { echo "FAIL - the code reached the gateway log"; exit 1; }
echo "  the list shows the label and never the code or hash; the log never saw the code"

# 4. the client logs in with it, is not admin, cannot reach /admin, and their upload records who they are
curl -fsS -c "$CLIENT" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$CLIENT_CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
curl -fsS -b "$CLIENT" http://127.0.0.1:$GW/api/session | grep -q '"admin":false' || { echo "FAIL - client session is admin"; exit 1; }
[ "$(code -b "$CLIENT" http://127.0.0.1:$GW/api/admin/codes)" = 404 ]
[ "$(code -b "$CLIENT" -X POST -H "Origin: $ORIGIN" -H "$J" --data '{"label":"x"}' http://127.0.0.1:$GW/api/admin/codes)" = 404 ]
[ "$(code -b "$CLIENT" -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/admin/codes/$CODE_ID/revoke)" = 404 ]
echo "  a client session is not admin and gets a neutral 404 on every /admin route"

head -c 1048576 /dev/urandom > "$WORK/file.bin"
init_upload(){ # cookie
  curl -fsS -b "$1" -X POST -H "Origin: $ORIGIN" -H "$J" \
    --data '{"filename":"f.bin","contentType":"application/octet-stream","size":1048576}' http://127.0.0.1:$GW/api/uploads
}
complete_upload(){ # init-json cookie
  "$PY" - "$1" "$2" "$ORIGIN" "$GW" "$WORK/file.bin" <<'PY'
import json, sys, urllib.request, http.cookiejar
up, cookie_path, origin, port, source = json.loads(sys.argv[1]), *sys.argv[2:]
cookies=http.cookiejar.MozillaCookieJar(cookie_path); cookies.load(ignore_discard=True, ignore_expires=True)
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
base=f"http://127.0.0.1:{port}/api"
def post(path, body):
  req=urllib.request.Request(base+path,json.dumps(body).encode(),{"content-type":"application/json","origin":origin})
  return json.loads(opener.open(req).read())
parts=post("/uploads/parts",{"key":up["key"],"uploadId":up["uploadId"],"partNumbers":[1]})
urllib.request.urlopen(urllib.request.Request(parts["urls"]["1"],open(source,"rb").read(),method="PUT"))
post("/uploads/complete",{"key":up["key"],"uploadId":up["uploadId"],"blake3Root":"proof-root","options":{"qc_av":False}})
print(up["key"].split("/")[1])
PY
}
CLIENT_TID=$(complete_upload "$(init_upload "$CLIENT")" "$CLIENT")
ADMIN_TID=$(complete_upload "$(init_upload "$ADMIN")" "$ADMIN")
"$PY" - "$WORK/gateway.db" "$CODE_ID" "$CLIENT_TID" "$ADMIN_TID" <<'PY'
import sqlite3,sys
db,cid,ctid,atid=sqlite3.connect(sys.argv[1]),*sys.argv[2:]
assert db.execute("select owner_id from uploads where transfer_id=?",(ctid,)).fetchone()[0] == cid
assert db.execute("select owner_id from transfers where transfer_id=?",(ctid,)).fetchone()[0] == cid
assert db.execute("select owner_id from transfers where transfer_id=?",(atid,)).fetchone()[0] == "admin"
assert db.execute("select last_used_at from access_codes where code_id=?",(cid,)).fetchone()[0] is not None
print("  uploads and transfers record their owner: the code id, or 'admin'")
PY
curl -fsS -b "$ADMIN" http://127.0.0.1:$GW/api/admin/codes | grep -q '"transfers":1' || { echo "FAIL - list does not count the client's transfer"; exit 1; }

# 5. revoke: the EXISTING client session dies on its next request, the code no longer logs in, and revoke is idempotent
REV=$(curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/admin/codes/$CODE_ID/revoke)
printf '%s' "$REV" | grep -q '"revokedAt"' || { echo "FAIL - revoke did not return a timestamp"; exit 1; }
R=$(curl -s -b "$CLIENT" -X POST -H "Origin: $ORIGIN" -H "$J" \
  --data '{"filename":"g.bin","contentType":"application/octet-stream","size":1048576}' -w '\n%{http_code}' http://127.0.0.1:$GW/api/uploads)
[ "$(printf '%s' "$R" | tail -1)" = 401 ] && printf '%s' "$R" | grep -q session_revoked \
  || { echo "FAIL - revoked code's live session still accepted: $R"; exit 1; }
[ "$(code -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$CLIENT_CODE\"}" http://127.0.0.1:$GW/api/session)" = 401 ]
REV2=$(curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/admin/codes/$CODE_ID/revoke)
[ "$REV" = "$REV2" ] || { echo "FAIL - a second revoke changed the timestamp"; exit 1; }
[ "$(code -b "$ADMIN" -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/admin/codes/no-such-id/revoke)" = 404 ]
[ "$(code -b "$ADMIN" http://127.0.0.1:$GW/api/session)" = 200 ]
echo "  revoke cuts off the live session at its next request, blocks login, is idempotent; the admin is unaffected"

# 6. a cookie from before sessions carried an owner is rejected, not treated as anybody
OLD=$(cd "$WEB/gateway" && WAYSTATION_AUTH_MODE=access-code WAYSTATION_ACCESS_CODE_HASH="$HASH" WAYSTATION_SESSION_SECRET="$SECRET" \
  npx tsx -e '
    import { createHmac } from "node:crypto";
    const payload = Buffer.from(JSON.stringify({ sid: "legacy-sid", exp: Date.now() + 3600000 })).toString("base64url");
    const mac = createHmac("sha256", process.env.WAYSTATION_SESSION_SECRET).update(payload).digest("base64url");
    console.log(`${payload}.${mac}`);' 2>/dev/null | tail -1)
curl -fsS -H "Cookie: ws_session=$OLD" http://127.0.0.1:$GW/api/session | grep -q '"hasSession":false' \
  || { echo "FAIL - an ownerless pre-change cookie was accepted"; exit 1; }
echo "  a correctly signed cookie without an owner is rejected (one re-login after deploy)"

echo "PASS - access codes: admin-issued, shown once, hashed, owner-recorded, live-revocable"
