#!/usr/bin/env bash
# Gateway-mediated download proof over the real gateway + MinIO multipart path.
#
# The property under test: the recipient is never handed a storage URL for the
# master, so authorization is LIVE rather than frozen at signing time. A
# presigned URL cannot be recalled once minted — revoking a transfer leaves it
# working until it expires. A mediated link is re-checked on every request, and
# it carries no credential of its own: for a password-protected transfer only
# the unlock cookie of the browser that entered the password opens it.
set -euo pipefail
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8794 MIN=9014 BUCKET=waystation-mediated-proof
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
OWNED=()
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null || true; }
# Only processes THIS script started are signalled, never "whatever listens on the port".
cleanup(){ for p in ${OWNED[@]+"${OWNED[@]}"}; do killtree "$p"; done; rm -rf "$WORK"; }
trap cleanup EXIT
command -v minio >/dev/null || { echo "SKIP - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >$TT/mediated-minio.log 2>&1 &
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
  npx tsx src/server.ts >$TT/mediated-gateway.log 2>&1 & echo $! >"$WORK/gw.pid" )
OWNED+=($(cat "$WORK/gw.pid"))
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done

ORIGIN=https://orbitolive.com SENDER="$WORK/sender.cookie" RECIPIENT="$WORK/recipient.cookie"
curl -fsS -c "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
head -c 1048576 /dev/urandom > "$WORK/file.bin"
SIZE=$(wc -c < "$WORK/file.bin" | tr -d ' ')

upload(){ # filename password-json -> transferId
  local init
  init=$(curl -fsS -b "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
    --data "{\"filename\":\"$1\",\"contentType\":\"application/octet-stream\",\"size\":$SIZE}" \
    http://127.0.0.1:$GW/api/uploads)
  "$PY" - "$init" "$2" "$SENDER" "$ORIGIN" "$GW" "$WORK/file.bin" <<'PY'
import json, sys, urllib.request, http.cookiejar
up, password, cookie_path, origin, port, source = json.loads(sys.argv[1]), json.loads(sys.argv[2]), *sys.argv[3:]
cookies=http.cookiejar.MozillaCookieJar(cookie_path); cookies.load(ignore_discard=True, ignore_expires=True)
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
base=f"http://127.0.0.1:{port}/api"
def post(path, body):
  req=urllib.request.Request(base+path,json.dumps(body).encode(),{"content-type":"application/json","origin":origin})
  return json.loads(opener.open(req).read())
parts=post("/uploads/parts",{"key":up["key"],"uploadId":up["uploadId"],"partNumbers":[1]})
urllib.request.urlopen(urllib.request.Request(parts["urls"]["1"],open(source,"rb").read(),method="PUT"))
body={"key":up["key"],"uploadId":up["uploadId"],"blake3Root":"proof-root","options":{"qc_av":False}}
if password is not None: body["recipientPassword"]=password
post("/uploads/complete",body)
print(up["key"].split("/")[1])
PY
}
jqv(){ "$PY" -c 'import json,sys;d=json.loads(sys.stdin.read())
for k in sys.argv[1].split("."): d=d[k]
print(d)' "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

TID=$(upload open.bin 'null')
META=$(curl -fsS http://127.0.0.1:$GW/api/transfers/$TID)
URL=$(printf '%s' "$META" | jqv original.url)

# 1 ── the recipient is handed a gateway URL, never a storage URL.
[ "$URL" = "http://127.0.0.1:$GW/api/transfers/$TID/original" ] \
  || { echo "FAIL - original.url is not the bare mediated link: $URL"; exit 1; }
if printf '%s' "$META" | grep -q "X-Amz-Signature"; then
  echo "FAIL - metadata still leaks a presigned URL"; exit 1
fi
echo "  the master is delivered as a bare mediated gateway link — no presigned URL, no credential in it"

# 1b -- the link origin is CONFIGURED (WAYSTATION_PUBLIC_API_ORIGIN), never taken
#       from the request. Host and X-Forwarded-* are client-controlled: honouring
#       them would let a forged header put an attacker's origin in a link the page
#       then follows. Scheme and host must therefore be identical whatever the
#       request claims, and the /api path prefix must be preserved.
for H in "X-Forwarded-Host: evil.example.test" "X-Forwarded-Proto: https" "Host: evil.example.test:9999" \
         "X-Forwarded-Host: evil.example.test:8443"; do
  GOT=$(curl -fsS -H "$H" "http://127.0.0.1:$GW/api/transfers/$TID" | jqv original.url)
  [ "$GOT" = "$URL" ] || { echo "FAIL - a forged header changed the link ($H): $GOT"; exit 1; }
done
GOT=$(curl -fsS -H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: evil.example.test" -H "Host: evil.example.test" \
  "http://127.0.0.1:$GW/api/transfers/$TID" | jqv original.url)
[ "$GOT" = "$URL" ] || { echo "FAIL - combined forged headers changed the link: $GOT"; exit 1; }
case "$URL" in "http://127.0.0.1:$GW/api/transfers/"*) ;; *) echo "FAIL - API path prefix lost: $URL"; exit 1;; esac
echo "  forged Host / X-Forwarded-Host / X-Forwarded-Proto never change the link; the /api prefix is preserved"

# 1c -- invalid configuration refuses to start (no silent fallback to headers).
for BAD in "http://evil.example.test" "https://api.example.test/api" "not-a-url" "https://user:pw@api.example.test"; do
  ( cd "$WEB/gateway" && PORT=$((GW+50)) WAYSTATION_DB_PATH=":memory:" WAYSTATION_AUTH_MODE=access-code \
    WAYSTATION_ACCESS_CODE_HASH="$HASH" WAYSTATION_SESSION_SECRET="$SECRET" \
    WAYSTATION_PUBLIC_API_ORIGIN="$BAD" B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=x B2_APP_KEY=x \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 PIPELINE_SHARED_SECRET=x B2_EVENT_SIGNING_SECRET=x \
    npx tsx src/server.ts >"$WORK/badorigin.log" 2>&1 & echo $! >"$WORK/badorigin.pid" )
  BP=$(cat "$WORK/badorigin.pid"); n=0
  while kill -0 "$BP" 2>/dev/null && [ $n -lt 150 ]; do sleep .1; n=$((n+1)); done
  if kill -0 "$BP" 2>/dev/null; then kill -9 "$BP" 2>/dev/null || true; echo "FAIL - gateway started with invalid WAYSTATION_PUBLIC_API_ORIGIN=$BAD"; exit 1; fi
  grep -q "WAYSTATION_PUBLIC_API_ORIGIN" "$WORK/badorigin.log" \
    || { echo "FAIL - refusal for $BAD did not name the setting"; cat "$WORK/badorigin.log"; exit 1; }
done
echo "  an invalid or unsafe WAYSTATION_PUBLIC_API_ORIGIN refuses to start and names the setting"

# 2 ── it redirects to storage, and the bytes that arrive are the bytes sent.
[ "$(code "$URL")" = 302 ] || { echo "FAIL - expected a 302"; exit 1; }
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$URL")
case "$LOC" in *"127.0.0.1:$MIN"*) ;; *) echo "FAIL - redirect does not point at storage: $LOC"; exit 1;; esac
curl -fsSL "$URL" -o "$WORK/got.bin"
cmp -s "$WORK/file.bin" "$WORK/got.bin" || { echo "FAIL - downloaded bytes differ"; exit 1; }
echo "  it redirects to storage and delivers byte-identical content ($SIZE bytes)"

# 2b -- JSON mode: the same gate, a shape a browser can actually use.
#       A browser cannot fetch() the redirect: a cross-origin redirected CORS
#       request carries Origin: null, which B2 refuses. So script asks for JSON
#       and goes to storage itself.
JSON=$(curl -fsS "$URL?format=json")
JURL=$(printf '%s' "$JSON" | jqv url)
case "$JURL" in
  *"127.0.0.1:$MIN"*) ;;
  *) echo "FAIL - format=json did not return a storage url: $JURL"; exit 1;;
esac
curl -fsS "$JURL" -o "$WORK/viajson.bin"
cmp -s "$WORK/file.bin" "$WORK/viajson.bin" || { echo "FAIL - json-resolved url served different bytes"; exit 1; }
echo "  format=json returns a storage url that serves identical bytes"


# 3 ── ranged requests survive the redirect: this is what parallel and resumed
#      downloads depend on, and what makes the CORS allowHeaders change matter.
curl -fsSL -H 'Range: bytes=0-1023' "$URL" -o "$WORK/part.bin"
[ "$(wc -c < "$WORK/part.bin" | tr -d ' ')" = 1024 ] || { echo "FAIL - range request did not return 1024 bytes"; exit 1; }
cmp -s <(head -c 1024 "$WORK/file.bin") "$WORK/part.bin" \
  || { echo "FAIL - ranged bytes differ"; exit 1; }
echo "  Range survives the redirect and returns the correct slice"

# 4 ── authority for a protected transfer is the unlock cookie, and only that.
#      An UNPROTECTED transfer needs nothing: its id is the capability. A
#      protected one must refuse the download link on its own — otherwise copying
#      it out of the page (Firefox/Safari render it as a plain link) would bypass
#      the password for the rest of the transfer's life.
PROT=$(upload protected.bin '"open-sesame"')
PROT2=$(upload protected2.bin '"other-pass"')
[ "$(code "http://127.0.0.1:$GW/api/transfers/$PROT/original")" = 401 ] \
  || { echo "FAIL - protected transfer served without authorization"; exit 1; }
[ "$(code "http://127.0.0.1:$GW/api/transfers/$PROT/original?format=json")" = 401 ] \
  || { echo "FAIL - format=json bypassed the password gate"; exit 1; }
echo "  a protected transfer refuses an unauthenticated request, in either shape"

curl -fsS -c "$RECIPIENT" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"password":"open-sesame"}' http://127.0.0.1:$GW/api/transfers/$PROT/unlock >/dev/null
PURL=$(curl -fsS -b "$RECIPIENT" http://127.0.0.1:$GW/api/transfers/$PROT | jqv original.url)
[ "$(code -b "$RECIPIENT" "$PURL")" = 302 ] || { echo "FAIL - the unlocked browser cannot download"; exit 1; }
[ "$(code "$PURL")" = 401 ] || { echo "FAIL - the link copied out of an unlocked page opens WITHOUT the password"; exit 1; }
[ "$(code "$PURL?format=json")" = 401 ] || { echo "FAIL - the copied link opens in JSON mode without the password"; exit 1; }
[ "$(code -b "$RECIPIENT" "http://127.0.0.1:$GW/api/transfers/$PROT2/original")" = 401 ] \
  || { echo "FAIL - one transfer's unlock opened a different protected transfer"; exit 1; }
echo "  the unlocked browser downloads; the same link copied elsewhere is refused (401); an unlock is per-transfer"

# The unlock SLIDES: each authorized request re-issues the cookie, so a browser
# that keeps renewing its storage URL through a long download stays unlocked.
curl -s -o /dev/null -D "$WORK/hdr" -b "$RECIPIENT" "$PURL?format=json"
grep -qi "^set-cookie: ws_r_" "$WORK/hdr" || { echo "FAIL - an authorized download did not extend the unlock"; exit 1; }
echo "  every authorized request extends the unlock, so a long download never loses it"

# 5 ── THE POINT OF THE FEATURE: revocation takes effect on the next request.
#      A presigned URL handed out earlier would keep serving until it expired.
"$PY" - "$WORK/gateway.db" "$TID" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("update transfers set revoked=1 where transfer_id=?",(sys.argv[2],)); db.commit()
PY
[ "$(code "$URL")" = 404 ] || { echo "FAIL - a revoked transfer still redirected"; exit 1; }
[ "$(code "$URL?format=json")" = 404 ] || { echo "FAIL - format=json still served a revoked transfer"; exit 1; }
echo "  revocation is immediate — the same link 404s on the very next request"

# 6 ── egress is metered, and the many requests of ONE download collapse into a
#      single line item rather than billing once per range.
for _ in 1 2 3 4 5; do curl -s -o /dev/null -b "$RECIPIENT" "$PURL"; done
"$PY" - "$WORK/gateway.db" "$PROT" "$SIZE" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
rows=db.execute("select units,unit from meter_events where transfer_id=? and event='egress'",(sys.argv[2],)).fetchall()
assert len(rows) == 1, f"expected 1 collapsed egress event, got {len(rows)}"
# meter() stores Number(gb.toFixed(6)), so compare at that precision, not tighter.
assert rows[0][1] == "gb" and abs(rows[0][0] - round(int(sys.argv[3])/1e9, 6)) < 1e-9, rows
print(f"  egress metered once for six requests ({rows[0][0]} gb) — ranges do not bill separately")
PY

echo "PASS - mediated downloads: no storage URL disclosed, password-bound links, live revocation, metered egress"
