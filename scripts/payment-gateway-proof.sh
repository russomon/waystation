#!/usr/bin/env bash
# Pay-per-gig dual-gateway proof over the real gateway + MinIO multipart path.
#
# Runs the gateway in WAYSTATION_PAYMENTS_MODE=test, which short-circuits the
# Stripe/Coinbase network calls and verifies a webhook with a plain HMAC over the
# raw body — so the whole checkout → webhook → paid → upload → download-credit flow
# is exercised without real provider credentials. Asserts:
#   * pricing: 40 GB is 113c card / 82c crypto at 2 downloads, and the download
#     surcharge moves both prices up per the model;
#   * an UNPAID order cannot mint an upload session;
#   * a webhook (good signature) marks the order paid; a bad signature is refused;
#   * a payment-backed session uploads within its byte budget and is refused past it;
#   * the transfer's downloads_allowed equals what was paid;
#   * the link serves exactly that many downloads, then refuses the next, and a
#     grant token is one download's continuation (does not spend another credit);
#   * a comped/admin transfer is uncapped (regression: the free path still works);
#   * the v4 schema migrates in place to v5 (payment_orders, download_grants).
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8795 MIN=9015 BUCKET=waystation-payment-proof
STRIPE_SECRET=teststripe COINBASE_SECRET=testcoinbase
WORK=$(mktemp -d)
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
command -v minio >/dev/null || { echo "SKIP - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP - pipeline venv not built"; exit 0; }

# ── pure pricing assertions (no gateway needed) ──
cat > "$WORK/price-check.mjs" <<'JS'
const { quote } = await import(process.env.PRICING);
const GB = 1e9;
// [bytes, downloads, weeks, gateway, expectedCents]
const cases = [
  [40 * GB, 2, 1, "stripe", 113], [40 * GB, 2, 1, "coinbase", 82],
  [40 * GB, 3, 1, "stripe", 153],   // +1 download = +40c (1c/GB)
  [40 * GB, 10, 1, "stripe", 433],  // +8 downloads = +320c
  [40 * GB, 2, 2, "stripe", 153],   // +1 week = +40c
  [40 * GB, 2, 5, "stripe", 273],   // +4 weeks = +160c
  [40 * GB, 4, 3, "stripe", 273], [40 * GB, 4, 3, "coinbase", 242], // +2 dl +2 wk = +160c
];
let bad = 0;
for (const c of cases) {
  const got = quote(c[0], c[1], c[2], c[3]).amountCents;
  if (got !== c[4]) { console.error("FAIL price", c.slice(0, 4).join("/"), "got", got, "want", c[4]); bad++; }
}
if (bad) process.exit(1);
console.log("  pricing: 40GB = 113c (2 dl / 1 wk); +40c per extra download and per extra week (1c/GB, flat)");
JS
PRICING="$WEB/gateway/src/pricing.ts" npx tsx "$WORK/price-check.mjs" || { echo "FAIL - pricing assertions"; exit 1; }

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >/tmp/payment-minio.log 2>&1 &
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
    WAYSTATION_PAYMENTS_MODE=test STRIPE_WEBHOOK_SECRET=$STRIPE_SECRET \
    COINBASE_COMMERCE_WEBHOOK_SECRET=$COINBASE_SECRET \
    B2_S3_ENDPOINT=http://127.0.0.1:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=proof-secret CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=cdn-secret \
    B2_EVENT_SIGNING_SECRET=event-secret DEV_TRIGGER_ON_COMPLETE=false \
    npx tsx src/server.ts >/tmp/payment-gateway.log 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done
}

# Boot once so the migrations build the full current schema on a real database.
start_gateway
# Now simulate the persistent production database one schema BEFORE this feature:
# drop the v5 additions and stamp it v4, so the NEXT start must migrate in place
# rather than requiring a fresh control volume.
{ lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("ALTER TABLE transfers DROP COLUMN downloads_allowed")
db.execute("DROP TABLE IF EXISTS payment_orders")
db.execute("DROP TABLE IF EXISTS download_grants")
db.execute("PRAGMA user_version = 4")
db.commit()
PY
start_gateway
"$PY" - "$WORK/gateway.db" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
version = db.execute("PRAGMA user_version").fetchone()[0]
tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
tcols = {r[1] for r in db.execute("PRAGMA table_info(transfers)")}
ocols = {r[1] for r in db.execute("PRAGMA table_info(payment_orders)")}
assert version >= 6, version
assert "payment_orders" in tables and "download_grants" in tables, tables
assert "downloads_allowed" in tcols, tcols
assert "weeks" in ocols, ocols
print("  schema v4 migrates in place to v6 (payment_orders+weeks, download_grants, downloads_allowed)")
PY

ORIGIN=https://orbitolive.com
J(){ "$PY" -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }
api(){ curl -s "$@"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ── quote route matches the model ──
Q=$(api -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
      --data '{"bytes":40000000000,"downloads":2,"weeks":1}' http://127.0.0.1:$GW/api/payments/quote)
[ "$(printf '%s' "$Q" | "$PY" -c 'import json,sys;d=json.load(sys.stdin);print(d["stripe"]["amountCents"],d["coinbase"]["amountCents"],d["maxDownloads"],d["maxWeeks"])')" = "113 82 10 5" ]
echo "  /payments/quote returns 113c / 82c, a 10-download and a 5-week ceiling"

# ── checkout (3 downloads, 2-week link) → pending order; no session before payment ──
CO=$(api -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
      --data '{"bytes":6291456,"gateway":"stripe","downloads":3,"weeks":2}' http://127.0.0.1:$GW/api/payments/checkout)
ORDER=$(printf '%s' "$CO" | J orderId)
AMOUNT=$(printf '%s' "$CO" | J amountCents)
[ -n "$ORDER" ] && [ -n "$AMOUNT" ]
[ "$(code -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/payments/$ORDER/session)" = 402 ]
echo "  checkout creates a pending order; its session is refused before payment"

# ── a webhook with a BAD signature is refused, a good one confirms ──
[ "$(code -X POST -H 'content-type: application/json' -H 'stripe-signature: deadbeef' \
      --data '{}' http://127.0.0.1:$GW/api/payments/stripe/webhook)" = 400 ]
send_webhook(){ # orderId amountCents
  "$PY" - "$1" "$2" "$GW" "$STRIPE_SECRET" <<'PY'
import sys, json, hmac, hashlib, urllib.request
order, amount, port, secret = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
raw = json.dumps({"type": "checkout.session.completed", "data": {"object": {
  "metadata": {"order_id": order}, "amount_total": amount, "currency": "usd",
  "payment_status": "paid", "customer_details": {"email": "proof@example.com"}}}})
sig = hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(f"http://127.0.0.1:{port}/api/payments/stripe/webhook",
  raw.encode(), {"content-type": "application/json", "stripe-signature": sig})
urllib.request.urlopen(req).read()
PY
}
send_webhook "$ORDER" "$AMOUNT"
[ "$(api http://127.0.0.1:$GW/api/payments/$ORDER | J status)" = paid ]
echo "  a bad-signature webhook is refused; a signed one marks the order paid"

# ── claim the paid order → payment-backed upload session ──
PAYJAR="$WORK/pay.cookie"
api -c "$PAYJAR" -X POST -H "Origin: $ORIGIN" http://127.0.0.1:$GW/api/payments/$ORDER/session >/dev/null
grep -q ws_session "$PAYJAR"
echo "  a paid order mints a payment-backed upload session"

# ── the paid budget bounds the upload (6,291,456 bytes paid for) ──
dd if=/dev/zero of="$WORK/six.bin" bs=1m count=6 status=none      # 6 MiB == the whole budget
full_upload(){ # cookiejar filename source
  "$PY" - "$1" "$ORIGIN" "$GW" "$2" "$3" <<'PY'
import json, sys, os, urllib.request, http.cookiejar
cookie_path, origin, port, filename, source = sys.argv[1:6]
cj = http.cookiejar.MozillaCookieJar(cookie_path); cj.load(ignore_discard=True, ignore_expires=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
base = f"http://127.0.0.1:{port}/api"
def post(path, body):
  req = urllib.request.Request(base + path, json.dumps(body).encode(),
    {"content-type": "application/json", "origin": origin})
  return json.loads(op.open(req).read())
size = os.path.getsize(source)
up = post("/uploads", {"filename": filename, "contentType": "application/octet-stream", "size": size})
parts = post("/uploads/parts", {"key": up["key"], "uploadId": up["uploadId"], "partNumbers": [1]})
urllib.request.urlopen(urllib.request.Request(parts["urls"]["1"], open(source, "rb").read(), method="PUT"))
post("/uploads/complete", {"key": up["key"], "uploadId": up["uploadId"], "blake3Root": "proof-root", "options": {"qc_av": False}})
print(up["key"].split("/")[1])
PY
}
PAID_TID=$(full_upload "$PAYJAR" paid.bin "$WORK/six.bin")   # consumes the whole 6 MiB budget
[ -n "$PAID_TID" ]
# A further initiate has no budget left → 402 insufficient_paid_budget.
OVER=$(code -b "$PAYJAR" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
        --data '{"filename":"more.bin","size":1048576}' http://127.0.0.1:$GW/api/uploads)
[ "$OVER" = 402 ]
echo "  the paid byte budget admits the upload it covers and refuses the byte over it"

# ── downloads_allowed = chosen 3 + hidden bonus 1 = 4; expiry = weeks(2)*7 + 1 = 15 days ──
"$PY" - "$WORK/gateway.db" "$PAID_TID" <<'PY'
import sqlite3, sys, datetime
row = sqlite3.connect(sys.argv[1]).execute(
  "select downloads_allowed, created_at, expires_at from transfers where transfer_id=?", (sys.argv[2],)).fetchone()
assert row, "no transfer row"
allowed, created, expires = row
assert allowed == 4, ("downloads_allowed", allowed)          # 3 paid + 1 hidden bonus
parse = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
days = (parse(expires) - parse(created)).total_seconds() / 86400
assert abs(days - 15) < 0.05, ("expiry days", days)          # weeks(2)*7 + 1
print(f"  transfer: downloads_allowed = 4 (3 paid + 1 hidden bonus) and expires in {days:.0f} days (2-week link + 1)")
PY

# ── the link serves 4 downloads (3 paid + 1 hidden bonus), then refuses; a grant never re-spends ──
orig_json(){ api "http://127.0.0.1:$GW/api/transfers/$PAID_TID/original?format=json"; }
R1=$(orig_json); G1=$(printf '%s' "$R1" | J grant); [ -n "$G1" ]        # download 1 of 4
for _ in 1 2 3; do
  [ "$(code "http://127.0.0.1:$GW/api/transfers/$PAID_TID/original?format=json&grant=$G1")" = 200 ]
done
echo "  a grant token is one download's continuation — repeated use spends no extra credit"
orig_json >/dev/null                                                    # download 2 (fresh, no grant)
orig_json >/dev/null                                                    # download 3
orig_json >/dev/null                                                    # download 4 (the hidden bonus)
[ "$(code "http://127.0.0.1:$GW/api/transfers/$PAID_TID/original?format=json")" = 403 ]   # 5th refused
[ "$(code "http://127.0.0.1:$GW/api/transfers/$PAID_TID/original?format=json&grant=$G1")" = 200 ]  # grant still valid
echo "  the link serves 4 downloads (3 paid + 1 hidden bonus) then returns downloads_exhausted; earlier grants still resume"

# ── regression: a comped (admin) transfer is uncapped and needs no payment ──
ADMIN="$WORK/admin.cookie"
api -c "$ADMIN" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://127.0.0.1:$GW/api/session >/dev/null
FREE_TID=$(full_upload "$ADMIN" free.bin "$WORK/six.bin")               # no payment, admin session
"$PY" - "$WORK/gateway.db" "$FREE_TID" <<'PY'
import sqlite3, sys
row = sqlite3.connect(sys.argv[1]).execute(
  "select downloads_allowed from transfers where transfer_id=?", (sys.argv[2],)).fetchone()
assert row and row[0] is None, row      # NULL = unlimited
print("  a comped/admin transfer has downloads_allowed = NULL (unlimited)")
PY
for _ in 1 2 3 4 5; do
  [ "$(code "http://127.0.0.1:$GW/api/transfers/$FREE_TID/original?format=json")" = 200 ]
done
echo "  the comped transfer serves unlimited downloads and never charged payment"

echo "PASS payment-gateway-proof"
