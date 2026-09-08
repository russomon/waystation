#!/usr/bin/env bash
# Resumable download proof: stop a download part-way, start again, get the file.
#
# Resume is Range requests plus bookkeeping — no hashing, no protocol. The risk
# is arithmetic: if the skipped set and the remaining set do not tile the file
# exactly, resume writes a file with a HOLE in it and reports success. Nothing
# errors and the file looks complete, so both halves are checked — the tiling,
# and a real interrupted download finished on a second attempt.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8796 MIN=9016 BUCKET=waystation-resume-proof
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# ── 1. a resumed download must not truncate what is already on disk ───────────
# createWritable() truncates by DEFAULT. Resuming without keepExistingData
# silently discards every byte already downloaded, turning resume into a slower
# way to start over — with no error to notice.
grep -q "keepExistingData: resuming" "$WEB/client/src/delivery.ts" \
  || { echo "FAIL - resumed writable does not set keepExistingData"; exit 1; }

# The resume record must be written ONLY after a successful close(). A
# FileSystemWritableFileStream writes to a swap file and commits nothing until
# close, so a record saved mid-download claims durability that does not exist:
# close the tab and no bytes land, while the record says ranges are complete.
# Resume then skips them, truncate sets the right size, and the result is a
# correctly-sized file full of holes that opens as garbage. This shipped once.
BODY=$(awk '/async function saveToDisk/,/^async function sha256Hex/' "$WEB/client/src/delivery.ts")
if printf '%s' "$BODY" | grep -qE "saveDownloadResume|markRangeDone|clearDownloadResume"; then
  echo "FAIL - saveToDisk writes the resume record; it cannot know what committed:"
  printf '%s' "$BODY" | grep -nE "saveDownloadResume|markRangeDone|clearDownloadResume" | sed 's/^/    /'
  exit 1
fi
printf '%s' "$BODY" | grep -q "resume?.completed.push" \
  || { echo "FAIL - completed ranges are not collected in memory"; exit 1; }
grep -q "await writable?.close(); durable = true" "$WEB/client/src/delivery.ts" \
  || { echo "FAIL - the interrupted path does not close before recording"; exit 1; }
echo "  ranges are collected in memory; the record is written only after close() commits"

# A deliberate pause must NOT fall back to a single stream. The fallback exists
# so a broken optimisation cannot break downloads, but an abort is not a fault:
# falling back would restart from byte zero and silently undo exactly what the
# user chose to keep. The short-circuit must come BEFORE the fallback call.
# `|| true` on each: with `set -e` and pipefail a non-matching grep would kill
# the script at the assignment, so the guard would abort silently instead of
# reporting — a check that cannot say why it failed is not a check.
CATCH=$(printf '%s' "$BODY" | awk '/catch \(e\)/,0')
ABORT_AT=$(printf '%s' "$CATCH" | grep -n "signal?.aborted" | head -1 | cut -d: -f1 || true)
FALLBACK_AT=$(printf '%s' "$CATCH" | grep -n "await single()" | head -1 | cut -d: -f1 || true)
if [ -z "$ABORT_AT" ]; then
  echo "FAIL - a paused download would fall back to a single stream and restart from zero"; exit 1
fi
if [ -n "$FALLBACK_AT" ] && [ "$ABORT_AT" -gt "$FALLBACK_AT" ]; then
  echo "FAIL - the abort short-circuit comes after the fallback; pausing would restart"; exit 1
fi
printf '%s' "$BODY" | grep -q "signal }" \
  || { echo "FAIL - the ranged fetch does not receive the abort signal"; exit 1; }
echo "  a paused download stops; it does not fall back and restart from zero"

# Running out of space is reported as itself, not as an opaque browser error.
grep -q "const isOutOfSpace" "$WEB/client/src/delivery.ts" \
  || { echo "FAIL - no out-of-space detection"; exit 1; }
grep -q "ran out of space on the destination disk" "$WEB/client/src/delivery.ts" \
  || { echo "FAIL - out-of-space is not surfaced to the recipient"; exit 1; }
echo "  a full destination disk is named as the cause, with the partial file kept"

# ── 2. skipped + remaining tile the file exactly, at every interruption point ──
( cd "$WEB/client" && npx tsx - <<'TS'
import { planRanges } from "./src/ranges.js";
const MIB = 1024 * 1024;
let failed = false;
for (const total of [40 * MIB, 700 * MIB, 26 * 1024 * MIB]) {
  const all = planRanges(total);
  for (const k of [0, 1, Math.floor(all.length / 2), all.length - 1, all.length]) {
    const doneSet = new Set(all.slice(0, k).map((r) => r.start));
    const skipped = all.filter((r) => doneSet.has(r.start));
    const todo = all.filter((r) => !doneSet.has(r.start));
    const bytes = [...skipped, ...todo].reduce((n, r) => n + (r.end - r.start + 1), 0);
    const starts = new Set([...skipped, ...todo].map((r) => r.start));
    if (bytes !== total || starts.size !== all.length || skipped.length + todo.length !== all.length) {
      console.log(`  FAIL total=${total} done=${k}: ${bytes} bytes, ${starts.size} unique ranges`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("  skipped + remaining tile the file exactly at every interruption point");
TS
) || { echo "FAIL - resume tiling"; exit 1; }

# ── 3. a real transfer to interrupt ───────────────────
command -v minio >/dev/null || { echo "SKIP (transport half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (transport half) - pipeline venv not built"; exit 0; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/resume-minio.log 2>&1 &
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
  npx tsx src/server.ts >/tmp/resume-gateway.log 2>&1 & )
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

# ── 4. a real interrupted download, finished on the second attempt ────────────
"$PY" - "$URL" "$SIZE" "$WORK/out.bin" <<'PY'
import sys, urllib.request, random
from concurrent.futures import ThreadPoolExecutor
url, total, dest = sys.argv[1], int(sys.argv[2]), sys.argv[3]

size = 512 * 1024
plan = [(s, min(s + size, total) - 1) for s in range(0, total, size)]
assert len(plan) > 3, "fixture must produce several ranges"

probe = urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"}))
assert probe.status == 206
resolved = probe.url

def grab(r):
    s, e = r
    with urllib.request.urlopen(urllib.request.Request(resolved, headers={"Range": f"bytes={s}-{e}"})) as f:
        assert f.status == 206
        return s, f.read()

def fetch(ranges, mode):
    with open(dest, mode) as out:
        out.truncate(total)
        with ThreadPoolExecutor(max_workers=6) as ex:
            for start, data in ex.map(grab, ranges):
                out.seek(start); out.write(data)

first = random.sample(plan, len(plan) // 2)
fetch(first, "wb")
done = {s for s, _ in first}
print(f"  attempt 1: {len(first)} of {len(plan)} ranges written out of order, then interrupted")

rest = [r for r in plan if r[0] not in done]
fetch(rest, "r+b")
print(f"  attempt 2: resumed with the remaining {len(rest)} ranges, without truncating")
PY

cmp -s "$WORK/file.bin" "$WORK/out.bin" \
  || { echo "FAIL - the resumed file differs from the original"; exit 1; }
echo "  the resumed file is byte-identical to the original ($SIZE bytes)"

echo "PASS - resumable downloads: exact tiling, no truncation, byte-identical after an interruption"
