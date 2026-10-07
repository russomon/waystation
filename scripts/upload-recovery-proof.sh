#!/usr/bin/env bash
# Owner-based upload recovery over the real gateway + MinIO multipart path.
#
# The property under test: an upload belongs to the OWNER recorded by the server
# (access-code id / admin / per-order), not to the one-hour session that started
# it. A sender whose session lapsed or was replaced by logging in again can
# resume; anyone else gets the same neutral 404 as for an upload that does not
# exist; and logging in again never revives a revoked entitlement.
#
# Local only: MinIO + the gateway on loopback with synthetic secrets. It touches
# no live service. Pure rules are also unit-tested (gateway/test/ownership.test.ts).
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8801 MIN=9021 BUCKET=waystation-recovery-proof
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
OWNED=()
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null || true; }
# Only processes THIS script started are signalled, never "whatever listens on the port".
cleanup(){ for p in ${OWNED[@]+"${OWNED[@]}"}; do killtree "$p"; done; rm -rf "$WORK"; }
trap cleanup EXIT

# ── static guards: run even without minio ────────────────────────────────────
ROUTES="$WEB/gateway/src/routes.ts"
OWN=$(awk '/^function ownUpload/,/^}/' "$ROUTES")
printf '%s' "$OWN" | grep -q 'mayUseUpload' || { echo "FAIL - ownUpload no longer delegates to the owner rule"; exit 1; }
if printf '%s' "$OWN" | grep -v '^\s*//' | grep -q 'row\.sessionId !== sessionIdOf'; then
  echo "FAIL - ownUpload compares session ids again; recovery after a lapsed session would break"; exit 1; fi
if grep -nE 'body\.(owner|ownerId)|query\("owner' "$ROUTES" | grep -q .; then
  echo "FAIL - a route reads an owner id from the request"; exit 1; fi
echo "  guards: ownership is decided by the owner rule, and no route reads an owner from the request"

command -v minio >/dev/null || { echo "SKIP (live half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (live half) - pipeline venv not built"; exit 0; }
for p in $GW $MIN; do
  if lsof -ti:$p >/dev/null 2>&1; then echo "SKIP (live half) - port $p is in use; not touching whatever owns it"; trap - EXIT; rm -rf "$WORK"; exit 0; fi
done

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >"$WORK/minio.log" 2>&1 &
OWNED+=($!)
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

( cd "$WEB/gateway" && PORT=$GW WAYSTATION_DB_PATH="$WORK/gateway.db" \
  WAYSTATION_AUTH_MODE=access-code WAYSTATION_ACCESS_CODE_HASH="$HASH" \
  WAYSTATION_SESSION_SECRET="$SECRET" WAYSTATION_ALLOWED_ORIGINS="https://orbitolive.com" \
  WAYSTATION_PUBLIC_API_ORIGIN="http://127.0.0.1:$GW" \
  B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
  B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
  PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
  DEV_TRIGGER_ON_COMPLETE=false \
  npx tsx src/server.ts >"$WORK/gateway.log" 2>&1 & echo $! >"$WORK/gw.pid" )
OWNED+=($(cat "$WORK/gw.pid"))
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done

ORIGIN=https://orbitolive.com
J='content-type: application/json'
B="http://127.0.0.1:$GW/api"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
jqv(){ "$PY" -c 'import json,sys;d=json.loads(sys.stdin.read())
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }
login(){ # code cookie-jar
  curl -fsS -c "$2" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$1\"}" $B/session >/dev/null; }
sql(){ "$PY" - "$WORK/gateway.db" "$@" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1], timeout=10)
cur=db.execute(sys.argv[2], sys.argv[3:]); db.commit()
row=cur.fetchone()
print("" if row is None else row[0])
PY
}

# Two named codes plus the admin.
ADMIN="$WORK/admin.cookie"; login "$CODE" "$ADMIN"
issue(){ curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"label\":\"$1\"}" $B/admin/codes; }
A=$(issue alpha); B2=$(issue beta)
ALPHA_CODE=$(printf '%s' "$A" | jqv code); ALPHA_ID=$(printf '%s' "$A" | jqv codeId)
BETA_CODE=$(printf '%s' "$B2" | jqv code)

S1="$WORK/alpha1.cookie" S2="$WORK/alpha2.cookie" SB="$WORK/beta.cookie"
login "$ALPHA_CODE" "$S1"; login "$ALPHA_CODE" "$S2"; login "$BETA_CODE" "$SB"
cookie_val(){ awk -F'\t' 'NF>=7 {print $7}' "$1" | head -1; }
[ -n "$(cookie_val "$S1")" ] && [ "$(cookie_val "$S1")" != "$(cookie_val "$S2")" ] \
  || { echo "FAIL - the two logins did not produce distinct sessions"; exit 1; }

head -c 1048576 /dev/urandom > "$WORK/file.bin"
init(){ curl -fsS -b "$1" -X POST -H "Origin: $ORIGIN" -H "$J" \
  --data '{"filename":"f.bin","contentType":"application/octet-stream","size":1048576}' $B/uploads; }
parts_get(){ code -b "$1" "$B/uploads/parts?key=$(printf '%s' "$2" | "$PY" -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')&uploadId=$3"; }
parts_post(){ code -b "$1" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"key\":\"$2\",\"uploadId\":\"$3\",\"partNumbers\":[1]$4}" $B/uploads/parts; }
finish(){ # cookie init-json -> http code of /complete after PUTting the part
  "$PY" - "$1" "$2" "$ORIGIN" "$GW" "$WORK/file.bin" <<'PY'
import json, sys, urllib.request, urllib.error, http.cookiejar
cookie_path, up, origin, port, source = sys.argv[1], json.loads(sys.argv[2]), *sys.argv[3:]
cj=http.cookiejar.MozillaCookieJar(cookie_path); cj.load(ignore_discard=True, ignore_expires=True)
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
base=f"http://127.0.0.1:{port}/api"
def post(path, body):
  r=urllib.request.Request(base+path,json.dumps(body).encode(),{"content-type":"application/json","origin":origin})
  return json.loads(op.open(r).read())
parts=post("/uploads/parts",{"key":up["key"],"uploadId":up["uploadId"],"partNumbers":[1]})
urllib.request.urlopen(urllib.request.Request(parts["urls"]["1"],open(source,"rb").read(),method="PUT"))
out=post("/uploads/complete",{"key":up["key"],"uploadId":up["uploadId"],"blake3Root":"proof-root","options":{"qc_av":False}})
print("complete-ok" if out.get("ok") else "complete-bad", "already" if out.get("alreadyComplete") else "first")
PY
}

# ── 1. same owner, new session: recovered ───────────────────────────────────
U=$(init "$S1")
KEY=$(printf '%s' "$U" | jqv key); UID_=$(printf '%s' "$U" | jqv uploadId); TID=$(printf '%s' "$U" | jqv transferId)
[ "$(parts_get "$S1" "$KEY" "$UID_")" = 200 ] || { echo "FAIL - the starting session cannot list its own parts"; exit 1; }
[ "$(parts_get "$S2" "$KEY" "$UID_")" = 200 ] || { echo "FAIL - the same owner on a NEW session cannot reattach (ListParts)"; exit 1; }
[ "$(parts_post "$S2" "$KEY" "$UID_" "")" = 200 ] || { echo "FAIL - the same owner on a new session cannot sign parts"; exit 1; }
echo "  same owner, new session: ListParts and part signing succeed — a lapsed session no longer strands an upload"

# ── 2. other owners, strangers and unauthenticated callers are refused ──────
[ "$(parts_get "$SB" "$KEY" "$UID_")" = 404 ] || { echo "FAIL - another owner reached this upload (GET parts)"; exit 1; }
[ "$(parts_post "$SB" "$KEY" "$UID_" "")" = 404 ] || { echo "FAIL - another owner signed parts"; exit 1; }
[ "$(parts_post "$SB" "$KEY" "$UID_" ",\"ownerId\":\"$ALPHA_ID\",\"owner\":\"$ALPHA_ID\"")" = 404 ] \
  || { echo "FAIL - a client-supplied owner id was honoured"; exit 1; }
[ "$(code -b "$SB" -X POST -H "Origin: $ORIGIN" -H "$J" -H "X-Owner-Id: $ALPHA_ID" \
  --data "{\"key\":\"$KEY\",\"uploadId\":\"$UID_\",\"blake3Root\":\"x\"}" $B/uploads/complete)" = 404 ] \
  || { echo "FAIL - another owner completed this upload"; exit 1; }
[ "$(parts_get "$WORK/none.cookie" "$KEY" "$UID_")" = 401 ] || { echo "FAIL - unauthenticated caller was not refused"; exit 1; }
REAL=$(curl -s -b "$SB" "$B/uploads/parts?key=$(printf '%s' "$KEY" | "$PY" -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read(),safe=""))')&uploadId=$UID_")
GONE=$(curl -s -b "$SB" "$B/uploads/parts?key=transfers/00000000-0000-0000-0000-000000000000/x.bin&uploadId=nope")
[ "$REAL" = "$GONE" ] || { echo "FAIL - a foreign upload is distinguishable from a missing one: $REAL vs $GONE"; exit 1; }
echo "  another owner: neutral 404 identical to a missing upload; a forged owner field/header is ignored; no session is 401"

# ── 3. recovery completes the upload, recording the original owner ─────────
[ "$(finish "$S2" "$U")" = "complete-ok first" ] || { echo "FAIL - recovered upload could not complete"; exit 1; }
OWNER=$(sql "select owner_id from transfers where transfer_id=?" "$TID")
[ "$OWNER" = "$ALPHA_ID" ] || { echo "FAIL - the transfer's owner is $OWNER, expected the code id"; exit 1; }
RETRY=$(curl -fsS -b "$S1" -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"key\":\"$KEY\",\"uploadId\":\"$UID_\",\"blake3Root\":\"proof-root\"}" $B/uploads/complete)
printf '%s' "$RETRY" | grep -q '"alreadyComplete":true' || { echo "FAIL - a retried completion is not idempotent: $RETRY"; exit 1; }
echo "  the recovered upload completes under the original owner; a retried completion is idempotent"

# ── 4. legacy rows: session fallback only when the owner is genuinely absent ─
U2=$(init "$S1"); K2=$(printf '%s' "$U2" | jqv key); I2=$(printf '%s' "$U2" | jqv uploadId)
sql "update uploads set owner_id=NULL where upload_id=?" "$I2" >/dev/null
[ "$(parts_get "$S1" "$K2" "$I2")" = 200 ] || { echo "FAIL - a legacy row is not usable by its own session"; exit 1; }
[ "$(parts_get "$S2" "$K2" "$I2")" = 404 ] || { echo "FAIL - a legacy row was opened by a different session"; exit 1; }
[ "$(parts_get "$SB" "$K2" "$I2")" = 404 ] || { echo "FAIL - a legacy row was opened by another owner"; exit 1; }
echo "  pre-identity row (no owner): its own session only; no owner-based access is invented"

# ── 5. bounded recovery: an old upload is not resumed by a different session ─
U3=$(init "$S1"); K3=$(printf '%s' "$U3" | jqv key); I3=$(printf '%s' "$U3" | jqv uploadId)
sql "update uploads set created_at=? where upload_id=?" "$("$PY" -c 'import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')" "$I3" >/dev/null
[ "$(parts_get "$S2" "$K3" "$I3")" = 404 ] || { echo "FAIL - a different session resumed an upload older than the active window"; exit 1; }
[ "$(parts_get "$S1" "$K3" "$I3")" = 200 ] || { echo "FAIL - the starting session lost its pre-existing access"; exit 1; }
echo "  cross-session recovery stops at the active-upload window; the starting session keeps its old behaviour"

# ── 6. revocation wins: logging in again cannot revive a revoked code ───────
U4=$(init "$S1"); K4=$(printf '%s' "$U4" | jqv key); I4=$(printf '%s' "$U4" | jqv uploadId)
[ "$(parts_get "$S2" "$K4" "$I4")" = 200 ]
curl -fsS -b "$ADMIN" -X POST -H "Origin: $ORIGIN" $B/admin/codes/$ALPHA_ID/revoke >/dev/null
[ "$(parts_get "$S2" "$K4" "$I4")" = 401 ] || { echo "FAIL - a revoked code's existing session still reaches its upload"; exit 1; }
[ "$(code -X POST -H "Origin: $ORIGIN" -H "$J" --data "{\"code\":\"$ALPHA_CODE\"}" $B/session)" = 401 ] \
  || { echo "FAIL - a revoked code can log in again"; exit 1; }
echo "  revocation holds: existing sessions get 401 and the revoked code cannot obtain a new one"

echo "PASS - owner-based upload recovery: same-owner resume, neutral 404 for others, legacy fallback, bounded window, revocation"
