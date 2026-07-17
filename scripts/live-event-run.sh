#!/usr/bin/env bash
# REAL reactive architecture, end to end:
#   cloudflared quick tunnel → public webhook URL
#   → B2 Event Notification rule registered on YOUR bucket (native API)
#   → gateway runs with NO dev trigger: uploads complete, then Backblaze B2
#     ITSELF fires b2:ObjectCreated over the tunnel → pipeline runs.
# Also runs the worker with MANIFEST_LOCK_DAYS from .env (WORM manifests).
# Leaves everything up for the browser demo. Ctrl-C tears it all down.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"

[ -f "$WEB/.env" ] || { echo "✗ no .env — see SETUP.md"; exit 1; }
set -a; source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$WEB/.env"); set +a
for v in B2_S3_ENDPOINT B2_REGION B2_BUCKET B2_KEY_ID B2_APP_KEY B2_EVENT_SIGNING_SECRET GMI_API_KEY; do
  [ -n "${!v:-}" ] || { echo "✗ $v not set in .env"; exit 1; }
done
[ "${#B2_EVENT_SIGNING_SECRET}" = "32" ] || { echo "✗ B2_EVENT_SIGNING_SECRET must be exactly 32 chars"; exit 1; }
unset B2_FORCE_PATH_STYLE DEV_TRIGGER_ON_COMPLETE   # real B2 + REAL events only
export GMI_MODEL="${GMI_MODEL:-google/gemini-3.5-flash}"
export GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787
export PIPELINE_URL="${PIPELINE_URL:-http://localhost:8000}"

kill_all(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:5173; } 2>/dev/null | xargs kill -9 2>/dev/null || true; pkill -f "cloudflared tunnel" 2>/dev/null || true; }
trap kill_all INT TERM
kill_all

( cd "$WEB/gateway" && npx tsx src/server.ts >/tmp/we-gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/we-pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
( cd "$WEB/client" && npm run dev >/tmp/we-client.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:5173/; do sleep 0.5; done
echo "✓ gateway + pipeline + client up (dev trigger OFF — B2 events drive the pipeline)"

# ── public webhook URL via cloudflared quick tunnel ──
cloudflared tunnel --url http://localhost:8787 >/tmp/we-tunnel.log 2>&1 &
TUNNEL=""
for i in $(seq 1 60); do
  TUNNEL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/we-tunnel.log | head -1 || true)
  [ -n "$TUNNEL" ] && break; sleep 0.5
done
[ -n "$TUNNEL" ] || { echo "✗ tunnel did not come up"; tail -5 /tmp/we-tunnel.log; exit 1; }
echo "✓ tunnel: $TUNNEL"
# tunnel → local gateway reachability
until curl -sf -o /dev/null --max-time 3 "$TUNNEL/"; do sleep 1; done
echo "✓ tunnel reaches the gateway"

# ── register the Event Notification rule on the bucket (B2 native API) ──
"$PY" - "$TUNNEL" <<'PYEOF'
import base64, json, os, sys, urllib.request

tunnel = sys.argv[1]
kid, key = os.environ["B2_KEY_ID"], os.environ["B2_APP_KEY"]
req = urllib.request.Request("https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    headers={"Authorization": "Basic " + base64.b64encode(f"{kid}:{key}".encode()).decode()})
auth = json.loads(urllib.request.urlopen(req).read())
api = auth.get("apiInfo", {}).get("storageApi", {})
api_url, token = api.get("apiUrl"), auth["authorizationToken"]
bucket_id = api.get("bucketId")
assert api_url and bucket_id, "key must be bucket-scoped with apiUrl"

rules = {"bucketId": bucket_id, "eventNotificationRules": [{
    "name": "waystation-pipeline",
    "eventTypes": ["b2:ObjectCreated:*"],
    "isEnabled": True,
    "objectNamePrefix": "transfers/",
    "targetConfiguration": {
        "targetType": "webhook",
        "url": f"{tunnel}/api/events/b2",
        "hmacSha256SigningSecret": os.environ["B2_EVENT_SIGNING_SECRET"],
    },
}]}
req = urllib.request.Request(f"{api_url}/b2api/v3/b2_set_bucket_notification_rules",
    json.dumps(rules).encode(), {"Authorization": token, "Content-Type": "application/json"})
try:
    resp = json.loads(urllib.request.urlopen(req).read())
    for r in resp.get("eventNotificationRules", []):
        print(f"✓ B2 rule '{r['name']}' → {r['targetConfiguration']['url']}  "
              f"(events {r['eventTypes']}, prefix '{r.get('objectNamePrefix','')}')")
except urllib.error.HTTPError as e:
    msg = e.read().decode()[:300]
    print("⚠ rule registration failed:", e.code, msg)
    if "API not enabled" in msg:
        print("  → Event Notifications not yet enabled on this account (Backblaze support")
        print("    request pending). Stack stays up; fire signed events manually, or re-run")
        print("    scripts/b2-register-events.sh once Backblaze enables the feature.")
PYEOF

# bucket CORS for the browser's direct PUTs / delivery fetches
"$PY" - <<'PYEOF'
import boto3, os
s3 = boto3.client("s3", endpoint_url=os.environ["B2_S3_ENDPOINT"], region_name=os.environ["B2_REGION"],
                  aws_access_key_id=os.environ["B2_KEY_ID"], aws_secret_access_key=os.environ["B2_APP_KEY"])
try:
    s3.put_bucket_cors(Bucket=os.environ["B2_BUCKET"], CORSConfiguration={"CORSRules": [
        {"AllowedOrigins": ["http://localhost:5173"], "AllowedMethods": ["GET", "PUT", "HEAD"],
         "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]})
    print("✓ bucket CORS applied")
except Exception as e:
    print("note: CORS not settable via S3 API:", type(e).__name__)
PYEOF

echo
echo "════════════════════════════════════════════════════"
echo "  REAL reactive stack ready:"
echo "    sender    →  http://localhost:5173"
echo "    webhook   →  $TUNNEL/api/events/b2"
echo "    manifests →  WORM, MANIFEST_LOCK_DAYS=${MANIFEST_LOCK_DAYS:-0}"
echo "  Upload in the browser; B2 itself will fire the event."
echo "════════════════════════════════════════════════════"
while true; do sleep 3600; done
