#!/usr/bin/env bash
# Parallel ranged download proof: the range plan and the real multi-connection
# fetch that plan drives.
#
# Two properties, because two different things can go wrong. The arithmetic can
# be off by one — an HTTP Range end is INCLUSIVE, so a mistake there silently
# drops or duplicates a byte per chunk and writes a corrupt file that still
# looks complete. And the transport can be wrong — ranges must survive the
# gateway's redirect and reassemble, out of order, into the original bytes.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8795 MIN=9015 BUCKET=waystation-parallel-proof
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1. the range plan tiles the file exactly ──────────────────────────────────
# Pure arithmetic, no server needed, so this half always runs.
( cd "$WEB/client" && npx tsx - <<'TS'
import { planRanges } from "./src/ranges.js";

const KIB = 1024, MIB = 1024 * 1024, GIB = 1024 * MIB;
const cases = [1, 100, 16 * MIB - 1, 16 * MIB, 16 * MIB + 1, 32 * MIB, 700 * MIB, 26 * GIB];
let failed = false;

for (const total of cases) {
  const r = planRanges(total);
  const problems: string[] = [];
  if (r.length === 0) problems.push("no ranges");
  if (r[0]?.start !== 0) problems.push(`first range starts at ${r[0]?.start}, not 0`);
  // End is INCLUSIVE, so the last one must land on total-1, never total.
  if (r[r.length - 1]?.end !== total - 1)
    problems.push(`last range ends at ${r[r.length - 1]?.end}, expected ${total - 1}`);
  for (let i = 1; i < r.length; i++)
    if (r[i].start !== r[i - 1].end + 1)
      problems.push(`gap or overlap between chunk ${i - 1} and ${i}`);
  const covered = r.reduce((n, c) => n + (c.end - c.start + 1), 0);
  if (covered !== total) problems.push(`covers ${covered} bytes, expected ${total}`);
  if (r.some((c) => c.end < c.start)) problems.push("a range ends before it starts");

  if (problems.length) { failed = true; console.log(`  FAIL ${total}: ${problems.join("; ")}`); }
  else console.log(`  ${String(total).padStart(11)} bytes → ${String(r.length).padStart(3)} ranges, tiled exactly`);
}
if (failed) process.exit(1);
TS
) || { echo "FAIL - range plan"; exit 1; }
echo "  the range plan covers every byte once, with inclusive ends"

# -- 1b. script must never fetch the MEDIATED url for bytes -------------------
# The mediated route answers with a cross-origin redirect, and the Fetch spec
# requires the browser to send `Origin: null` on a redirected CORS request. B2
# answers a null origin with 403 — verified against the live bucket. Both hosts
# have correct CORS and it still fails, so the client must resolve the storage
# url over JSON and fetch the bytes from there. This shipped broken twice; the
# check exists so it cannot ship broken a third time.
BODY=$(awk '/async function saveToDisk/,/^async function sha256Hex/' "$WEB/client/src/delivery.ts")
if printf '%s' "$BODY" | grep 'fetch(' | grep -qv 'fetch(src'; then
  echo "FAIL - saveToDisk fetches something other than the resolved storage url:"
  printf '%s' "$BODY" | grep -n 'fetch(' | grep -v 'fetch(src' | sed 's/^/    /'
  exit 1
fi
grep -q 'format=json' "$WEB/client/src/delivery.ts" \
  || { echo "FAIL - resolver does not request the storage url as JSON"; exit 1; }
grep -q 'if (c.req.query("format") === "json")' "$WEB/gateway/src/routes.ts" \
  || { echo "FAIL - gateway has no JSON mode for the mediated route"; exit 1; }
echo "  every byte fetch targets resolved storage; the redirect is never fetched by script"

# ── 2. the real thing, over the gateway's mediated redirect ───────────────────
command -v minio >/dev/null || { echo "SKIP (transport half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (transport half) - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/parallel-minio.log 2>&1 &
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
  B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
  B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
  PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
  DEV_TRIGGER_ON_COMPLETE=false \
  npx tsx src/server.ts >/tmp/parallel-gateway.log 2>&1 & )
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done

ORIGIN=https://orbitolive.com SENDER="$WORK/sender.cookie"
curl -fsS -c "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
head -c 5242880 /dev/urandom > "$WORK/file.bin"
SIZE=$(wc -c < "$WORK/file.bin" | tr -d ' ')

INIT=$(curl -fsS -b "$SENDER" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"filename\":\"big.bin\",\"contentType\":\"application/octet-stream\",\"size\":$SIZE}" \
  http://127.0.0.1:$GW/api/uploads)
TID=$("$PY" - "$INIT" "$SENDER" "$ORIGIN" "$GW" "$WORK/file.bin" <<'PY'
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
)
URL=$(curl -fsS http://127.0.0.1:$GW/api/transfers/$TID | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["original"]["url"])')

# Fetch every range CONCURRENTLY and reassemble out of order, exactly as the
# browser does with positional writes into one file handle.
"$PY" - "$URL" "$SIZE" "$WORK/out.bin" <<'PY'
import sys, urllib.request, random
from concurrent.futures import ThreadPoolExecutor
url, total, dest = sys.argv[1], int(sys.argv[2]), sys.argv[3]

# Same plan the client uses: 16 MiB floor, inclusive ends. A 5 MiB fixture would
# be one chunk under that floor, so shrink it here to force real concurrency —
# the arithmetic itself is already covered by part 1.
size = 512 * 1024
plan = [(s, min(s + size, total) - 1) for s in range(0, total, size)]
assert len(plan) > 1, "fixture must produce multiple ranges"

probe = urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"}))
assert probe.status == 206, f"expected 206 from the mediated endpoint, got {probe.status}"
resolved = probe.url          # post-redirect storage URL, as res.url gives the client

def grab(r):
    s, e = r
    with urllib.request.urlopen(urllib.request.Request(resolved, headers={"Range": f"bytes={s}-{e}"})) as f:
        assert f.status == 206, f"range {s}-{e} returned {f.status}"
        return s, f.read()

shuffled = plan[:]
random.shuffle(shuffled)       # completion order must not matter
with open(dest, "wb") as out:
    out.truncate(total)
    with ThreadPoolExecutor(max_workers=6) as ex:
        for start, data in ex.map(grab, shuffled):
            out.seek(start)    # positional write, like the FSA writable
            out.write(data)
print(f"  {len(plan)} ranges fetched over 6 connections, written out of order")
PY

cmp -s "$WORK/file.bin" "$WORK/out.bin" || { echo "FAIL - reassembled file differs from the original"; exit 1; }
echo "  reassembled file is byte-identical to the original ($SIZE bytes)"

echo "PASS - parallel ranged download: ranges tile exactly and reassemble byte-identically"
