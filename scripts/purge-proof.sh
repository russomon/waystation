#!/usr/bin/env bash
# Storage purge proof over the real gateway + a VERSIONED MinIO bucket.
#
# The property under test: once a transfer's link is dead — expired or revoked —
# and the grace period has passed, every byte of it leaves storage: every
# version and every delete marker under transfers/<id>/ and derivatives/<id>/.
# Nothing else is touched: not a live transfer, not one still inside its grace
# period, not an object whose row has a malformed id, and nothing at all in
# dry-run mode, which is the default.
set -euo pipefail
TT="${TMPDIR:-/tmp}"; TT="${TT%/}"; export TT   # this run's own temp area: the proof runner points TMPDIR at a private directory
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8800 MIN=9020 BUCKET=waystation-purge-proof
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
LOG=$TT/purge-gateway.log
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
command -v minio >/dev/null || { echo "SKIP - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP - pipeline venv not built"; exit 0; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >$TT/purge-minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$MIN/minio/health/live; do sleep .2; done

s3py(){ "$PY" - "$@" <<PY
import sys, boto3
from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://127.0.0.1:$MIN",region_name="us-east-1",
  aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",
  config=Config(s3={"addressing_style":"path"}))
B="$BUCKET"
$(cat)
PY
}
echo 'try: s3.create_bucket(Bucket=B)
except Exception: pass
s3.put_bucket_versioning(Bucket=B, VersioningConfiguration={"Status":"Enabled"})' | s3py

# Four transfers, each with an original, a sidecar, a derivative, an OLD version
# of the original and a DELETE MARKER — so a purge that removed only current
# objects, or only one prefix, would visibly leave bytes behind.
ids=()
for name in expired revoked fresh live; do
  id=$("$PY" -c 'import uuid;print(uuid.uuid4())')
  ids+=("$id")
  echo "
import sys
id='$id'
for k in (f'transfers/{id}/master.mov', f'transfers/{id}/master.mov.obao', f'derivatives/{id}/qc_report.json'):
    s3.put_object(Bucket=B, Key=k, Body=b'v1-' + k.encode())
s3.put_object(Bucket=B, Key=f'transfers/{id}/master.mov', Body=b'v2')       # older version stays behind
s3.put_object(Bucket=B, Key=f'transfers/{id}/gone.srt', Body=b'x')
s3.delete_object(Bucket=B, Key=f'transfers/{id}/gone.srt')                  # delete marker + hidden version
" | s3py
done
EXPIRED=${ids[0]} REVOKED=${ids[1]} FRESH=${ids[2]} LIVE=${ids[3]}
echo "s3.put_object(Bucket=B, Key='transfers/legacy/master.mov', Body=b'legacy')" | s3py

versions(){ # prefix -> count of versions + delete markers
  echo "
r=s3.list_object_versions(Bucket=B, Prefix='$1')
print(len(r.get('Versions',[])) + len(r.get('DeleteMarkers',[])))" | s3py
}
[ "$(versions "transfers/$EXPIRED/")" = 5 ] && [ "$(versions "derivatives/$EXPIRED/")" = 1 ] \
  || { echo "FAIL - fixture: expected 5 versions+markers under transfers/ and 1 derivative"; exit 1; }

start_gateway(){ # mode
  { lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$WEB/gateway" && PORT=$GW WAYSTATION_DB_PATH="$WORK/gateway.db" \
    WAYSTATION_AUTH_MODE=disabled \
    B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=proof-secret B2_EVENT_SIGNING_SECRET=event-secret \
    DEV_TRIGGER_ON_COMPLETE=false \
    WAYSTATION_PURGE_MODE="$1" WAYSTATION_PURGE_GRACE_DAYS=7 WAYSTATION_PURGE_INTERVAL_SECONDS=1 \
    npx tsx src/server.ts >"$LOG" 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done
}

# Rows, written straight into the control database (created by a first boot):
#   expired — link expired 8 days ago     → past the 7-day grace: PURGE
#   revoked — revoked 8 days ago          → past the grace:       PURGE
#   fresh   — expired 2 days ago          → inside the grace:     keep
#   live    — expires in 10 days          → live:                 keep
#   legacy  — expired 30 days ago, non-UUID id → never a delete prefix: keep
start_gateway off
"$PY" - "$WORK/gateway.db" "$EXPIRED" "$REVOKED" "$FRESH" "$LIVE" <<'PY'
import sqlite3, sys, datetime as dt
db=sqlite3.connect(sys.argv[1]); e, r, f, l = sys.argv[2:6]
iso=lambda days: (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=days)).isoformat().replace("+00:00","Z")
rows=[(e, iso(-8), 0, None), (r, iso(20), 1, iso(-8)), (f, iso(-2), 0, None), (l, iso(10), 0, None),
      ("legacy", iso(-30), 0, None)]
for tid, exp, revoked, revoked_at in rows:
    db.execute("insert into transfers (transfer_id, object_key, created_at, expires_at, revoked, revoked_at) values (?,?,?,?,?,?)",
               (tid, f"transfers/{tid}/master.mov", iso(-40), exp, revoked, revoked_at))
db.commit()
assert db.execute("pragma user_version").fetchone()[0] >= 7
PY
grep -q "purge: off" "$LOG" || { echo "FAIL - boot banner does not report purge mode"; exit 1; }
echo "  schema v7: revoked_at + purged_at present; banner reports the purge mode"

# 1 ── dry-run (the default mode) deletes NOTHING and says what it would do.
start_gateway dry-run
for _ in $(seq 1 50); do grep -q "DRY RUN" "$LOG" && break; sleep .2; done
sleep 1.5  # a second pass, to be sure repetition changes nothing either
grep -q "purge: DRY RUN — would delete 6 object version(s) for ${EXPIRED:0:8}…" "$LOG" \
  || { echo "FAIL - dry-run did not report the expired transfer"; cat "$LOG"; exit 1; }
for id in "$EXPIRED" "$REVOKED"; do
  [ "$(versions "transfers/$id/")" = 5 ] || { echo "FAIL - dry-run deleted something"; exit 1; }
done
if grep -q "$EXPIRED" "$LOG"; then echo "FAIL - a full transfer id (a bearer capability) reached the log"; exit 1; fi
echo "  dry-run lists what it would delete, deletes nothing, and logs only 8-character id prefixes"

# 2 ── on: the dead-and-past-grace transfers lose every version, in both prefixes.
start_gateway on
for _ in $(seq 1 50); do [ "$(grep -c "deleted .* object version(s)" "$LOG")" -ge 2 ] && break; sleep .2; done
for id in "$EXPIRED" "$REVOKED"; do
  [ "$(versions "transfers/$id/")" = 0 ] && [ "$(versions "derivatives/$id/")" = 0 ] \
    || { echo "FAIL - ${id:0:8}… still has versions or delete markers"; exit 1; }
done
echo "  expired-8-days and revoked-8-days transfers: every version and delete marker gone from both prefixes"

# 3 ── everything else is untouched.
[ "$(versions "transfers/$FRESH/")" = 5 ] || { echo "FAIL - a transfer inside its grace period was purged"; exit 1; }
[ "$(versions "transfers/$LIVE/")" = 5 ] || { echo "FAIL - a live transfer was purged"; exit 1; }
[ "$(versions "transfers/legacy/")" = 1 ] || { echo "FAIL - a non-UUID row was turned into a delete prefix"; exit 1; }
grep -q "id is not a UUID" "$LOG" || { echo "FAIL - the non-UUID row was not reported"; exit 1; }
echo "  inside-grace, live, and non-UUID-id transfers are untouched (the last is reported, never deleted)"

# 4 ── the row is kept, marked purged, and not processed again.
"$PY" - "$WORK/gateway.db" "$EXPIRED" "$REVOKED" "$FRESH" <<'PY'
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
get=lambda t: db.execute("select purged_at from transfers where transfer_id=?", (t,)).fetchone()
assert get(sys.argv[2])[0] and get(sys.argv[3])[0], "purged rows not marked"
assert get(sys.argv[4])[0] is None, "an unpurged row was marked"
PY
sleep 1.5
[ "$(grep -c "${EXPIRED:0:8}… — deleted" "$LOG")" = 1 ] || { echo "FAIL - a purged transfer was processed again"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$GW/api/transfers/$EXPIRED)" = 404 ] \
  || { echo "FAIL - a purged transfer's link does not 404"; exit 1; }
echo "  purged rows are kept with purged_at set, never reprocessed, and their links 404"

echo "PASS - storage purge: dry-run by default, every version removed past the grace, nothing else touched"
