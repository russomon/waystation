#!/usr/bin/env bash
# Register (or re-register) the B2 Event Notification rule pointing at the
# currently running cloudflared tunnel. Run this:
#   - once Backblaze enables Event Notifications on the account, and
#   - again any time the quick tunnel restarts (its URL changes).
# Requires: live-event-run.sh stack running (reads the tunnel URL from its log),
# and an app key with writeBucketNotifications (yours has it).
set -u
export PATH="/opt/homebrew/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
set -a; source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$WEB/.env"); set +a
[ "${#B2_EVENT_SIGNING_SECRET}" = "32" ] || { echo "✗ B2_EVENT_SIGNING_SECRET must be exactly 32 chars"; exit 1; }

TUNNEL="${1:-$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/we-tunnel.log 2>/dev/null | head -1)}"
[ -n "$TUNNEL" ] || { echo "✗ no tunnel URL (start scripts/live-event-run.sh first, or pass the URL as \$1)"; exit 1; }
curl -sf -o /dev/null --max-time 5 "$TUNNEL/" || { echo "✗ tunnel $TUNNEL not reachable"; exit 1; }
echo "registering webhook: $TUNNEL/api/events/b2"

"$PY" - "$TUNNEL" <<'PYEOF'
import base64, json, os, sys, urllib.request, urllib.error

tunnel = sys.argv[1]
kid, key = os.environ["B2_KEY_ID"], os.environ["B2_APP_KEY"]
req = urllib.request.Request("https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    headers={"Authorization": "Basic " + base64.b64encode(f"{kid}:{key}".encode()).decode()})
auth = json.loads(urllib.request.urlopen(req).read())
api = auth["apiInfo"]["storageApi"]
api_url, token, bucket_id = api["apiUrl"], auth["authorizationToken"], api["bucketId"]

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
        print(f"✓ B2 rule '{r['name']}' live → {r['targetConfiguration']['url']}")
        print(f"  events {r['eventTypes']}, prefix '{r.get('objectNamePrefix', '')}'")
    print("Backblaze B2 now drives the pipeline — upload something and watch.")
except urllib.error.HTTPError as e:
    print("✗ registration failed:", e.code, e.read().decode()[:300])
    sys.exit(1)
PYEOF
