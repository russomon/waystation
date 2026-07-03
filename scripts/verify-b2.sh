#!/usr/bin/env bash
# Verify the transfer spine against your REAL Backblaze B2 bucket, using the
# creds in .env. Runs the gateway pointed at B2 + the full e2e:
#   upload → resume(ListParts) → outboard → complete → delivery → verified range.
# Never prints your secrets. Needs .env filled in (see SETUP.md).
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -f "$WEB/.env" ] || { echo "✗ no .env — copy .env.example and fill in your B2 keys (see SETUP.md)"; exit 1; }
set -a; # shellcheck disable=SC1091
source "$WEB/.env"; set +a

for v in B2_S3_ENDPOINT B2_REGION B2_BUCKET B2_KEY_ID B2_APP_KEY; do
  val="${!v:-}"
  case "$val" in ""|*"<"*">"*) echo "✗ $v is not set in .env"; exit 1;; esac
done
unset B2_FORCE_PATH_STYLE   # B2 = virtual-hosted style
export GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787
export CDN_BASE="${CDN_BASE:-https://cdn.test}" CDN_TOKEN_SECRET="${CDN_TOKEN_SECRET:-dev}"
export B2_EVENT_SIGNING_SECRET="${B2_EVENT_SIGNING_SECRET:-ev}"
export PIPELINE_URL="${PIPELINE_URL:-http://localhost:8000}" PIPELINE_SHARED_SECRET="${PIPELINE_SHARED_SECRET:-ps}"

echo "Bucket: $B2_BUCKET   Region: $B2_REGION   Endpoint: $B2_S3_ENDPOINT"
[ -d "$WEB/crates/blake3-outboard/pkg-node" ] || ( cd "$WEB" && npm run build:wasm:node >/dev/null 2>&1 )

{ lsof -ti:8787; } 2>/dev/null | xargs kill -9 2>/dev/null || true
( cd "$WEB/gateway" && npx tsx src/server.ts >/tmp/gw-b2.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
echo "✓ gateway up (pointed at B2)"

cd "$WEB/gateway"
SIZE_MB="${SIZE_MB:-20}" node scripts/e2e.mjs; RC=$?
{ lsof -ti:8787; } 2>/dev/null | xargs kill -9 2>/dev/null || true
[ $RC -eq 0 ] && echo "✓ B2 transfer verified" || { echo "✗ failed — gateway log:"; tail -15 /tmp/gw-b2.log; }
exit $RC
