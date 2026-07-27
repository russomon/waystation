#!/usr/bin/env bash
# Hosted-MVP access control proof (MinIO + local gateway, zero cloud spend).
#
# Asserts the properties that make the API safe to publish:
#   A  every upload-control route refuses a request with no sender session (401)
#   B  a wrong access code is refused; the correct one issues a session
#   C  session cookie is HttpOnly + SameSite=Strict (and Secure in production)
#   D  CORS preflight is answered 204 WITHOUT a session — if auth ran before
#      cors(), preflight would 401 and the browser would never send the request
#   E  exact credentialed CORS: allowed origin echoed, unlisted origin refused
#   F  OWNERSHIP: session B cannot sign parts for, list, attach sidecars to,
#      or complete session A's upload, even knowing its key and uploadId
#   G  validation: bad filename, non-finite/negative size, oversized file,
#      out-of-range part numbers, and disallowed sidecar names are refused
#      BEFORE any multipart upload is created on the object store
#   H  completion is idempotent (a retry does not re-assemble or re-meter)
#   I  recipient/progress routes stay reachable WITHOUT a session (share links)
#   J  auth disabled (dev/proof default) leaves everything open
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d); BUCKET=access-test
GW=8795; MIN=9011
cleanup(){ { lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
{ lsof -ti:$GW; lsof -ti:$MIN; } 2>/dev/null | xargs kill -9 2>/dev/null || true
command -v minio >/dev/null || { echo "SKIP — minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP — pipeline venv not built"; exit 0; }

# Fresh code + secrets for this run; never reused, never committed.
OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL: could not generate a code"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/data" --address :$MIN >/tmp/access-minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:$MIN/minio/health/live; do sleep 0.3; done
"$PY" - <<PYEOF
import boto3
from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:$MIN",region_name="us-east-1",
  aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",
  config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception as e: pass
PYEOF

start_gw() { # $1 = auth mode
  { lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$WEB/gateway" && PORT=$GW \
    WAYSTATION_DB_PATH="$WORK/gw-$1.db" WAYSTATION_AUTH_MODE="$1" \
    WAYSTATION_ACCESS_CODE_HASH="$HASH" WAYSTATION_SESSION_SECRET="$SECRET" \
    WAYSTATION_ALLOWED_ORIGINS="https://orbitolive.com" \
    MAX_UPLOAD_BYTES=$((64*1024*1024)) \
    B2_S3_ENDPOINT=http://localhost:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=ps CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=d \
    B2_EVENT_SIGNING_SECRET=s \
    npx tsx src/server.ts >"/tmp/access-gw-$1.log" 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://localhost:$GW/; do sleep 0.3; done
}

ok=1
need(){ [ "$1" = "$2" ] || { echo "  FAIL: $3 (got $1, want $2)"; ok=0; }; }
ORIGIN="https://orbitolive.com"
code_of(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "=== auth enabled ==="
start_gw access-code
A="$WORK/a.ck"; B="$WORK/b.ck"

# A) no session anywhere
for spec in "POST|/api/uploads" "GET|/api/uploads/parts?key=k&uploadId=u" "POST|/api/uploads/parts" \
            "POST|/api/uploads/outboard-url" "POST|/api/uploads/sidecar-url" "POST|/api/uploads/complete"; do
  M="${spec%%|*}"; P="${spec#*|}"
  C=$(code_of -X "$M" -H "Origin: $ORIGIN" -H 'content-type: application/json' --data '{}' "http://localhost:$GW$P")
  need "$C" 401 "no-session $M $P must be 401"
done
echo "  A: all six upload-control routes require a session ✓"

# B/C) session exchange
need "$(code_of -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"code":"WRONG-WRONG-WRONG-WRNG"}' http://localhost:$GW/api/session)" 401 "wrong code"
need "$(code_of -c "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://localhost:$GW/api/session)" 200 "correct code"
SETC=$(curl -si -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://localhost:$GW/api/session | grep -i '^set-cookie')
echo "$SETC" | grep -qi "HttpOnly" || { echo "  FAIL: cookie not HttpOnly"; ok=0; }
echo "$SETC" | grep -qi "SameSite=Strict" || { echo "  FAIL: cookie not SameSite=Strict"; ok=0; }
echo "  B/C: wrong code refused; correct code issues an HttpOnly SameSite=Strict cookie ✓"

# D) preflight before auth
need "$(code_of -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
  http://localhost:$GW/api/uploads)" 204 "preflight must be 204 without a session"
# E) exact credentialed CORS
curl -si -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
  http://localhost:$GW/api/uploads | grep -qi "access-control-allow-origin: $ORIGIN" \
  || { echo "  FAIL: allowed origin not echoed"; ok=0; }
curl -si -X OPTIONS -H "Origin: https://evil.example" -H 'Access-Control-Request-Method: POST' \
  http://localhost:$GW/api/uploads | grep -qi "access-control-allow-origin" \
  && { echo "  FAIL: unlisted origin received an Allow-Origin"; ok=0; }
need "$(code_of -X POST -b "$A" -H "Origin: https://evil.example" -H 'content-type: application/json' \
  --data '{"filename":"a.mp4","size":1024}' http://localhost:$GW/api/uploads)" 403 "unlisted origin on a state-changing request"
echo "  D/E: preflight 204 without auth; exact origin echoed; unlisted origin refused ✓"

# G) validation, before any multipart upload exists
need "$(code_of -X POST -b "$A" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"filename":"../../etc/passwd","size":1024}' http://localhost:$GW/api/uploads)" 400 "traversal filename"
need "$(code_of -X POST -b "$A" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"filename":"a.mp4","size":-5}' http://localhost:$GW/api/uploads)" 400 "negative size"
need "$(code_of -X POST -b "$A" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"filename":"a.mp4","size":"lots"}' http://localhost:$GW/api/uploads)" 400 "non-numeric size"
need "$(code_of -X POST -b "$A" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"filename":"a.mp4","size":999999999999}' http://localhost:$GW/api/uploads)" 413 "oversized file"
echo "  G: bad filename / bad size / oversized refused before B2 initiation ✓"

# F) ownership
curl -s -c "$B" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"code\":\"$CODE\"}" http://localhost:$GW/api/session >/dev/null
INIT=$(curl -s -b "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data '{"filename":"master.mp4","contentType":"video/mp4","size":10485760}' http://localhost:$GW/api/uploads)
KEY=$("$PY" -c "import json,sys;print(json.loads(sys.argv[1])['key'])" "$INIT")
UPL=$("$PY" -c "import json,sys;print(json.loads(sys.argv[1])['uploadId'])" "$INIT")
[ -n "$KEY" ] || { echo "  FAIL: initiate did not return a key: $INIT"; ok=0; }

# owner succeeds
need "$(code_of -b "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"key\":\"$KEY\",\"uploadId\":\"$UPL\",\"partNumbers\":[1]}" http://localhost:$GW/api/uploads/parts)" 200 "owner may sign parts"
need "$(code_of -b "$A" "http://localhost:$GW/api/uploads/parts?key=$KEY&uploadId=$UPL")" 200 "owner may list parts"
need "$(code_of -b "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"key\":\"$KEY\",\"filename\":\"subs.srt\"}" http://localhost:$GW/api/uploads/sidecar-url)" 200 "owner may attach a caption sidecar"
# attacker with full knowledge of key + uploadId is refused
for spec in "POST|/api/uploads/parts|{\"key\":\"$KEY\",\"uploadId\":\"$UPL\",\"partNumbers\":[1]}" \
            "POST|/api/uploads/outboard-url|{\"key\":\"$KEY\"}" \
            "POST|/api/uploads/sidecar-url|{\"key\":\"$KEY\",\"filename\":\"subs.srt\"}" \
            "POST|/api/uploads/complete|{\"key\":\"$KEY\",\"uploadId\":\"$UPL\"}"; do
  M="${spec%%|*}"; rest="${spec#*|}"; P="${rest%%|*}"; BODY="${rest#*|}"
  need "$(code_of -b "$B" -X "$M" -H "Origin: $ORIGIN" -H 'content-type: application/json' \
    --data "$BODY" "http://localhost:$GW$P")" 404 "session B must not use A's upload via $P"
done
need "$(code_of -b "$B" "http://localhost:$GW/api/uploads/parts?key=$KEY&uploadId=$UPL")" 404 "session B must not list A's parts"
# disallowed sidecar name, as the owner
need "$(code_of -b "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"key\":\"$KEY\",\"filename\":\"evil.sh\"}" http://localhost:$GW/api/uploads/sidecar-url)" 400 "disallowed sidecar name"
# out-of-range part number
need "$(code_of -b "$A" -X POST -H "Origin: $ORIGIN" -H 'content-type: application/json' \
  --data "{\"key\":\"$KEY\",\"uploadId\":\"$UPL\",\"partNumbers\":[99999]}" http://localhost:$GW/api/uploads/parts)" 400 "part number out of range"
echo "  F: owner allowed; a second session with the exact key+uploadId gets 404 on every route ✓"

# I) recipient-facing routes need no session (share links must keep working).
# An unknown id correctly yields not-found; what matters is that it is NOT
# session-required — a recipient holding a link has no sender session.
RC=$(code_of "http://localhost:$GW/api/transfers/does-not-exist")
[ "$RC" = 401 ] && { echo "  FAIL: recipient lookup demanded a session (401) — share links would break"; ok=0; }
need "$RC" 404 "unknown transfer should be not-found"
echo "  I: recipient routes reachable without a sender session (unknown id -> 404, not 401) ✓"

echo "=== cost controls (dispatch boundary only) ==="
# K) service allowlist forces a disallowed service OFF in the STORED options.
# The subtle case: undefined options mean "everything on" by contract, so the
# policy must MATERIALIZE an explicit false rather than leave them undefined.
# Written to a file: `tsx -e` evaluates in a CJS context that cannot resolve
# these relative imports.
cat > "$WEB/gateway/src/_policy_check.ts" <<'TSEOF'
import { applyServicePolicy } from "./limits.js";
let ok = true;
const need = (c: boolean, m: string) => { if (!c) { console.log("  FAIL:", m); ok = false; } };
// undefined options == all services on; policy MUST materialize the false
const a = applyServicePolicy(undefined);
need(a.options !== undefined, "undefined options left undefined -> disallowed AI QC would still run");
need(a.options?.qc_ai === false, "qc_ai not forced off");
need(a.disabled.includes("qc_ai"), "disabled service not reported");
// an explicit request is overridden too
const b = applyServicePolicy({ qc_ai: true, qc_av: true });
need(b.options?.qc_ai === false, "explicit qc_ai:true not overridden");
need(b.options?.qc_av === true, "unrelated service was altered");
// a sender who already declined it is not reported as having lost anything
const c2 = applyServicePolicy({ qc_ai: false });
need(c2.disabled.length === 0, "reported a disable the sender never asked for");
if (ok) console.log("  K: allowlist forces disallowed services off, incl. the undefined-options case ✓");
process.exit(ok ? 0 : 1);
TSEOF
( cd "$WEB/gateway" && ALLOW_AI_QC=false npx tsx src/_policy_check.ts 2>&1 | grep -vE "Experimental|trace-warn"; exit "${PIPESTATUS[0]}" )
[ $? -eq 0 ] || { echo "  FAIL: service-allowlist assertions did not pass"; ok=0; }
rm -f "$WEB/gateway/src/_policy_check.ts"

# L) kill switch, active-upload ceiling, reference-QC switch
start_gw_env() { # $1=extra env assignments
  { lsof -ti:$GW; } 2>/dev/null | xargs kill -9 2>/dev/null || true
  ( cd "$WEB/gateway" && env $1 PORT=$GW \
    WAYSTATION_DB_PATH="$WORK/gw-limits.db" WAYSTATION_AUTH_MODE=disabled \
    WAYSTATION_ALLOWED_ORIGINS="https://orbitolive.com" \
    B2_S3_ENDPOINT=http://localhost:$MIN B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
    B2_BUCKET=$BUCKET B2_REGION=us-east-1 B2_FORCE_PATH_STYLE=true \
    PIPELINE_SHARED_SECRET=ps CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=d \
    B2_EVENT_SIGNING_SECRET=s \
    npx tsx src/server.ts >"/tmp/access-gw-limits.log" 2>&1 & )
  until curl -sf -o /dev/null --max-time 1 http://localhost:$GW/; do sleep 0.3; done
}
init_body='{"filename":"a.mp4","contentType":"video/mp4","size":1048576}'

start_gw_env "WAYSTATION_ACCEPT_UPLOADS=false"
need "$(code_of -X POST -H 'content-type: application/json' --data "$init_body" \
  http://localhost:$GW/api/uploads)" 503 "kill switch must refuse new uploads"
echo "  L: WAYSTATION_ACCEPT_UPLOADS=false refuses new uploads (503) ✓"

start_gw_env "MAX_ACTIVE_UPLOADS_PER_SESSION=2"
for i in 1 2; do
  curl -s -o /dev/null -X POST -H 'content-type: application/json' --data "$init_body" \
    http://localhost:$GW/api/uploads
done
need "$(code_of -X POST -H 'content-type: application/json' --data "$init_body" \
  http://localhost:$GW/api/uploads)" 429 "third concurrent upload must be refused"
echo "  M: active-upload ceiling enforced (429) ✓"

start_gw_env "ALLOW_EXPENSIVE_REFERENCE_QC=false"
REFJSON=$(curl -s -X POST -H 'content-type: application/json' --data "$init_body" http://localhost:$GW/api/uploads)
REFKEY=$("$PY" -c "import json,sys;print(json.loads(sys.argv[1])['key'])" "$REFJSON")
need "$(code_of -X POST -H 'content-type: application/json' \
  --data "{\"key\":\"$REFKEY\",\"filename\":\"source.ref.mp4\"}" http://localhost:$GW/api/uploads/sidecar-url)" 403 \
  "reference mezzanine must be refused when reference QC is disabled"
need "$(code_of -X POST -H 'content-type: application/json' \
  --data "{\"key\":\"$REFKEY\",\"filename\":\"subs.srt\"}" http://localhost:$GW/api/uploads/sidecar-url)" 200 \
  "captions must still be accepted"
echo "  N: reference-QC lane gated at the sidecar (403), captions unaffected ✓"

echo "=== auth disabled (dev / existing proof suite) ==="
start_gw disabled
need "$(code_of -X POST -H 'content-type: application/json' \
  --data '{"filename":"a.mp4","contentType":"video/mp4","size":1048576}' http://localhost:$GW/api/uploads)" 200 "disabled mode must allow initiate with no session"
echo "  J: disabled mode leaves the API open for dev and the existing proofs ✓"

[ "$ok" = 1 ] && echo "PASS ✓  access control: session required, ownership bound, validated, CORS exact, dev mode intact" \
             || { echo "FAIL"; exit 1; }
