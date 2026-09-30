#!/usr/bin/env bash
# Storage-URL renewal proof over the real gateway + MinIO path.
#
# The property under test: a browser download that outlives its presigned
# storage URL keeps going. The URL still lives only briefly and still cannot be
# recalled — the download renews it through the mediated route, before expiry
# (proactive) or after a refusal (reactive), with one trip to the gateway no
# matter how many connections were refused. Renewal re-checks revocation, and
# it never meters the same download twice.
#
# The gateway runs with a 2-second storage URL so expiry is observed in seconds;
# production uses an hour. The client logic is exercised directly under Node
# from client/src/storageSource.ts — the same module the delivery page uses.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8799 MIN=9019 BUCKET=waystation-renewal-proof TTL=2
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
  minio server "$WORK/minio" --address :$MIN >/tmp/renewal-minio.log 2>&1 &
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
  WAYSTATION_STORAGE_URL_TTL_SECONDS=$TTL \
  B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
  B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
  PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
  DEV_TRIGGER_ON_COMPLETE=false \
  npx tsx src/server.ts >/tmp/renewal-gateway.log 2>&1 & )
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
egress(){ "$PY" - "$WORK/gateway.db" "$1" <<'PY'
import sqlite3,sys
print(sqlite3.connect(sys.argv[1]).execute(
  "select count(*) from meter_events where transfer_id=? and event='egress'",(sys.argv[2],)).fetchone()[0])
PY
}
# Deleting the egress rows frees the hour-bucket idempotency key — exactly the
# state an hour later, when a download that renews would otherwise re-meter.
new_hour(){ "$PY" - "$WORK/gateway.db" "$1" <<'PY'
import sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.execute("delete from meter_events where transfer_id=? and event='egress'",(sys.argv[2],)); db.commit()
PY
}

TID=$(upload open.bin 'null')
URL=$(curl -fsS http://127.0.0.1:$GW/api/transfers/$TID | jqv original.url)

# 1 ── the JSON answer says how long its URL lives, and carries a continuation.
J1=$(curl -fsS "$URL&format=json")
[ "$(printf '%s' "$J1" | jqv expiresIn)" = "$TTL" ] || { echo "FAIL - expiresIn missing or wrong: $J1"; exit 1; }
CONT=$(printf '%s' "$J1" | jqv continuation)
[ -n "$CONT" ] || { echo "FAIL - no continuation token for an unlimited transfer"; exit 1; }
echo "  format=json reports expiresIn=${TTL}s and hands an unlimited transfer a continuation token"

# 2 ── the storage URL really does expire: this is the failure being fixed.
SURL=$(printf '%s' "$J1" | jqv url)
[ "$(code -H 'Range: bytes=0-0' "$SURL")" = 206 ] || { echo "FAIL - fresh storage url refused"; exit 1; }
sleep $((TTL + 1))
[ "$(code -H 'Range: bytes=0-0' "$SURL")" = 403 ] || { echo "FAIL - storage url did not expire"; exit 1; }
echo "  a range started after expiry is refused by storage (403)"

# 3 ── billing: a renewal carrying the continuation is never metered again.
[ "$(egress "$TID")" = 1 ] || { echo "FAIL - first resolution not metered once"; exit 1; }
new_hour "$TID"
curl -fsS "$URL&format=json&cont=$CONT" >/dev/null
[ "$(egress "$TID")" = 0 ] || { echo "FAIL - a renewal in a later hour re-metered the download"; exit 1; }
curl -fsS "$URL&format=json" >/dev/null
[ "$(egress "$TID")" = 1 ] || { echo "FAIL - a genuinely new download was not metered"; exit 1; }
new_hour "$TID"; curl -fsS "$URL&format=json&cont=${CONT}x" >/dev/null
[ "$(egress "$TID")" = 1 ] || { echo "FAIL - a tampered continuation suppressed metering"; exit 1; }
echo "  a renewal an hour later records no egress; a new download and a tampered token still do"

# 4 ── domain separation: a continuation is never an authorization, and a
#      ticket is never a continuation.
PROT=$(upload protected.bin '"x"')
curl -fsS -c "$RECIPIENT" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"password":"x"}' http://127.0.0.1:$GW/api/transfers/$PROT/unlock >/dev/null
PURL=$(curl -fsS -b "$RECIPIENT" http://127.0.0.1:$GW/api/transfers/$PROT | jqv original.url)
PCONT=$(curl -fsS "$PURL&format=json" | jqv continuation)
[ "$(code "http://127.0.0.1:$GW/api/transfers/$PROT/original?ticket=$PCONT")" = 401 ] \
  || { echo "FAIL - a continuation token opened a password-protected transfer"; exit 1; }
PTICKET="${PURL#*ticket=}"
new_hour "$PROT"; curl -fsS "$PURL&format=json&cont=$PTICKET" >/dev/null
[ "$(egress "$PROT")" = 1 ] || { echo "FAIL - a ticket passed as a continuation and suppressed metering"; exit 1; }
echo "  a continuation cannot open a protected transfer, and a ticket cannot pose as a continuation"

# 5 ── the client: proactive and reactive renewal, single-flight, revocation.
( cd "$WEB/client" && URL="$URL" SIZE="$SIZE" TTL="$TTL" FILE="$WORK/file.bin" \
    DB="$WORK/gateway.db" TID="$TID" PY="$PY" npx tsx - <<'TS'
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fetchFromStorage, openStorageSource, resolveStorageUrl } from "./src/storageSource.js";

const { URL: mediated, TTL, FILE, DB, TID, PY } = process.env as Record<string, string>;
const want = readFileSync(FILE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => { console.error(`FAIL - ${m}`); process.exit(1); };
let resolves = 0;
const counting: typeof resolveStorageUrl = (u, c) => { resolves++; return resolveStorageUrl(u, c); };
const range = async (src: Parameters<typeof fetchFromStorage>[0], start: number, end: number) => {
  const res = await fetchFromStorage(src, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) fail(`range ${start}-${end}: HTTP ${res.status}`);
  const got = Buffer.from(await res.arrayBuffer());
  if (!got.equals(want.subarray(start, end + 1))) fail(`range ${start}-${end}: wrong bytes`);
};
// Count storage refusals, to tell a proactive renewal (none) from a reactive one.
let refused = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
  const r = await realFetch(...a);
  if (r.status === 403 && !String(a[0]).includes("/api/")) refused++;
  return r;
}) as typeof fetch;

// PROACTIVE: with a margin, the URL is replaced before storage ever refuses it.
{
  resolves = 0; refused = 0;
  const src = await openStorageSource(mediated, { marginMs: 500, resolve: counting });
  await range(src, 0, 1023);
  await sleep(Number(TTL) * 1000 + 500);
  await range(src, 1024, 2047);
  if (resolves !== 2) fail(`proactive: expected 2 resolutions, got ${resolves}`);
  if (refused !== 0) fail(`proactive: storage refused ${refused} request(s) — renewal came too late`);
  console.log("  proactive: the URL was renewed before expiry — storage refused nothing");
}

// REACTIVE + SINGLE-FLIGHT: proactive renewal disabled, so a slept-through
// expiry is met by twelve refused ranges at once. They share ONE renewal.
{
  resolves = 0; refused = 0;
  const src = await openStorageSource(mediated, { marginMs: -1e12, resolve: counting });
  await range(src, 0, 1023);
  await sleep(Number(TTL) * 1000 + 1000);
  await Promise.all(Array.from({ length: 12 }, (_, i) => range(src, i * 4096, i * 4096 + 4095)));
  if (refused !== 12) fail(`reactive: expected 12 refusals, got ${refused}`);
  if (resolves !== 2) fail(`reactive: 12 refused ranges should share one renewal; resolutions=${resolves}`);
  console.log("  reactive: 12 ranges refused after expiry shared ONE renewal and all completed byte-identically");
}

// REVOCATION: renewal goes back through the gate, so a revoked transfer stops.
{
  const src = await openStorageSource(mediated, { marginMs: 0 });
  await range(src, 0, 1023);
  execFileSync(PY, ["-c", `import sqlite3;db=sqlite3.connect(${JSON.stringify(DB)});db.execute("update transfers set revoked=1 where transfer_id=?",(${JSON.stringify(TID)},));db.commit()`]);
  await sleep(Number(TTL) * 1000 + 500);
  const err = await fetchFromStorage(src, { headers: { Range: "bytes=0-1023" } }).then(() => null, (e) => e as Error);
  if (!err || !/no longer available/.test(err.message)) fail(`revoked transfer kept downloading (${err?.message ?? "no error"})`);
  console.log("  revocation: the next renewal is refused, so a revoked transfer stops mid-download");
}
TS
)

echo "PASS - storage renewal: proactive + single-flight reactive renewal, revocation honoured, no double metering"
