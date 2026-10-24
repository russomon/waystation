#!/usr/bin/env bash
# Folder transfers over the real gateway + MinIO multipart path (ADR-042).
#
# The properties under test:
#   * a folder is declared up front; only its declared paths, at their declared
#     sizes, may be uploaded into it, and only by its owner;
#   * it is not a link until every file is in, and then it is ONE link that
#     lists the whole tree;
#   * the folder's password opens every file in it (and nothing opens without it);
#   * the download allowance applies to each file on its own;
#   * revoking the folder takes every file with it.
#
# Local only: MinIO + the gateway on loopback with synthetic secrets. It touches
# no live service. Pure rules are also unit-tested (gateway/test/folders.test.ts).
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
GW=8803 MIN=9023 BUCKET=waystation-folder-proof
WORK=$(mktemp -d "${TMPDIR:-/tmp}/proof.XXXXXX")
OWNED=()
killtree(){ local c; for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill -9 "$1" 2>/dev/null || true; }
# Only processes THIS script started are signalled, never "whatever listens on the port".
cleanup(){ for p in ${OWNED[@]+"${OWNED[@]}"}; do killtree "$p"; done; rm -rf "$WORK"; }
trap cleanup EXIT

# ── static guards: run even without minio ────────────────────────────────────
ROUTES="$WEB/gateway/src/routes.ts"
GATE=$(awk '/^const recipientGate/,/^};/' "$ROUTES")
printf '%s' "$GATE" | grep -q 'accessTransferId' || { echo "FAIL - the password gate no longer resolves a member to its folder"; exit 1; }
awk '/^api.get\("\/transfers\/:id\/original"/,/^}\);/' "$ROUTES" | grep -q 'accessTransferId(id)' \
  || { echo "FAIL - the download allowance is no longer read from the folder"; exit 1; }
grep -q 'validateRelativePath' "$ROUTES" || { echo "FAIL - folder paths are no longer validated at upload"; exit 1; }
echo "  guards: members are gated and capped by their folder; paths are validated at upload"

command -v minio >/dev/null || { echo "SKIP (live half) - minio not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP (live half) - pipeline venv not built"; exit 0; }
for p in $GW $MIN; do
  if lsof -ti:$p >/dev/null 2>&1; then echo "SKIP (live half) - port $p is in use; not touching whatever owns it"; trap - EXIT; rm -rf "$WORK"; exit 0; fi
done

OUT=$(cd "$WEB" && npx tsx scripts/make-access-code.mjs 2>/dev/null)
CODE=$(printf '%s\n' "$OUT" | sed -n "s/^ *\([A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}-[A-Z2-9]\{5\}\) *$/\1/p")
HASH=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_ACCESS_CODE_HASH='\(.*\)'.*/\1/p")
SECRET=$(printf '%s\n' "$OUT" | sed -n "s/.*WAYSTATION_SESSION_SECRET='\(.*\)'.*/\1/p")
[ -n "$CODE" ] && [ -n "$HASH" ] && [ -n "$SECRET" ] || { echo "FAIL - access credential generation"; exit 1; }

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server "$WORK/minio" --address :$MIN >"$WORK/minio.log" 2>&1 &
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
  npx tsx src/server.ts >"$WORK/gateway.log" 2>&1 & echo $! >"$WORK/gw.pid" )
OWNED+=($(cat "$WORK/gw.pid"))
until curl -sf -o /dev/null --max-time 1 http://127.0.0.1:$GW/; do sleep .2; done

"$PY" - "$CODE" "$GW" "$WORK" <<'PY'
import json, os, sqlite3, sys, urllib.request, urllib.error, http.cookiejar
code, port, work = sys.argv[1], sys.argv[2], sys.argv[3]
base, origin = f"http://127.0.0.1:{port}/api", "https://orbitolive.com"

class Browser:
  """One cookie jar = one browser."""
  def __init__(self):
    self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  def call(self, method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(base + path, data, {"content-type": "application/json", "origin": origin}, method=method)
    try:
      res = self.op.open(r); return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
      raw = e.read(); return e.code, (json.loads(raw) if raw else None)
  post = lambda self, p, b=None: self.call("POST", p, b if b is not None else {})
  get = lambda self, p: self.call("GET", p)

def fail(msg): print("FAIL - " + msg); sys.exit(1)
def expect(got, want, what):
  if got != want: fail(f"{what}: expected {want}, got {got}")
def sql(q, *a):
  db = sqlite3.connect(os.path.join(work, "gateway.db"), timeout=10)
  db.execute(q, a); db.commit(); db.close()

admin = Browser(); expect(admin.post("/session", {"code": code})[0], 200, "admin login")
def named(label):
  s, c = admin.post("/admin/codes", {"label": label}); expect(s, 200, "issue code")
  b = Browser(); expect(b.post("/session", {"code": c["code"]})[0], 200, "code login"); return b
alpha, beta = named("alpha"), named("beta")

files = {"Reel 1/picture.mov": os.urandom(300_000), "Reel 1/audio/mix.wav": os.urandom(70_000),
         "notes.txt": b"folder transfer proof\n"}
manifest = [{"path": p, "size": len(b)} for p, b in files.items()]

# ── 1. the manifest is validated before anything exists ─────────────────────
for bad in ([{"path": "../escape.txt", "size": 1}], [{"path": "/abs", "size": 1}],
            [{"path": "a/b", "size": 1}, {"path": "A/B", "size": 1}], [{"path": "x", "size": 0}], []):
  s, _ = alpha.post("/folders", {"name": "Bad", "files": bad})
  expect(s, 400, f"bad manifest {bad}")
expect(alpha.post("/folders", {"name": "../up", "files": manifest})[0], 400, "a folder name with traversal")
s, f = alpha.post("/folders", {"name": "Delivery", "files": manifest}); expect(s, 200, "create folder")
fid = f["folderId"]
print("  manifest: traversal, absolute, duplicate (any case) and empty files refused; a good tree accepted")

# ── 2. only the owner, only declared paths and sizes ────────────────────────
def init(b, path, size, folder=fid):
  return b.post("/uploads", {"filename": "ignored", "size": size, "folderId": folder, "relativePath": path})
expect(init(beta, "notes.txt", len(files["notes.txt"]))[0], 404, "another owner uploading into the folder")
expect(init(alpha, "extra.txt", 5)[0], 400, "an undeclared path")
expect(init(alpha, "notes.txt", 999)[0], 400, "a declared path at the wrong size")
expect(init(alpha, "notes.txt", len(files["notes.txt"]), folder="00000000-0000-0000-0000-000000000000")[0], 404, "an unknown folder")
expect(alpha.get(f"/transfers/{fid}")[0], 404, "the folder link before it is complete")
expect(alpha.post(f"/folders/{fid}/complete")[0], 409, "completing with files missing")
expect(beta.post(f"/folders/{fid}/complete")[0], 404, "another owner completing the folder")
print("  only the owner may add files, only at declared paths and sizes; an unfinished folder is not a link")

# ── 3. upload every file through the ordinary multipart routes ─────────────
members = {}
for path, data in files.items():
  s, u = init(alpha, path, len(data)); expect(s, 200, f"initiate {path}")
  if not u["key"].endswith("/" + path.split("/")[-1]): fail(f"object key {u['key']} does not end with the file name")
  s, p = alpha.post("/uploads/parts", {"key": u["key"], "uploadId": u["uploadId"], "partNumbers": [1]})
  urllib.request.urlopen(urllib.request.Request(p["urls"]["1"], data, method="PUT"))
  # A password or QC option sent with a member is ignored: the folder decides.
  s, _ = alpha.post("/uploads/complete", {"key": u["key"], "uploadId": u["uploadId"], "blake3Root": "proof",
                                          "recipientPassword": "member-pw", "options": {"qc_av": True}})
  expect(s, 200, f"complete {path}")
  members[path] = u["transferId"]
expect(init(alpha, "notes.txt", len(files["notes.txt"]))[0], 409, "re-uploading a finished file")
expect(alpha.post(f"/folders/{fid}/complete", {"recipientPassword": "abc"})[0], 400, "a too-short folder password")
expect(alpha.post(f"/folders/{fid}/complete", {"recipientPassword": "folder-pw"})[0], 200, "complete folder")
expect(alpha.post(f"/folders/{fid}/complete", {"recipientPassword": "other"})[1].get("alreadyComplete"), True, "idempotent completion")
expect(init(alpha, "notes.txt", len(files["notes.txt"]))[0], 409, "adding to a sent folder")
print("  every file went up through /uploads; the folder sealed once, idempotently, and takes no more files")

# ── 4. one password opens the whole folder, and nothing opens without it ────
r1 = Browser()
expect(r1.get(f"/transfers/{fid}")[0], 401, "the folder without its password")
for path, tid in members.items():
  expect(r1.get(f"/transfers/{tid}/original?format=json")[0], 401, f"{path} without the folder password")
  expect(r1.post(f"/transfers/{tid}/unlock", {"password": "member-pw"})[0], 401, "a member-level password")
expect(r1.post(f"/transfers/{fid}/unlock", {"password": "folder-pw"})[0], 200, "unlock the folder")
s, listing = r1.get(f"/transfers/{fid}"); expect(s, 200, "folder listing")
expect(listing["kind"], "folder", "listing kind")
expect(sorted(x["path"] for x in listing["files"]), sorted(files), "the listed tree")
expect(listing["totalBytes"], sum(len(b) for b in files.values()), "listed total")
for path, tid in members.items():
  s, t = r1.get(f"/transfers/{tid}"); expect(s, 200, f"{path} detail after the folder unlock")
  expect(t["parentId"], fid, "member names its folder")
  s, j = r1.get(f"/transfers/{tid}/original?format=json"); expect(s, 200, f"{path} download after unlock")
  if urllib.request.urlopen(j["url"]).read() != files[path]: fail(f"{path}: downloaded bytes differ")
print("  the folder password opens every file and the tree; without it nothing opens; a member password was never set")

# ── 5. the allowance is per file ────────────────────────────────────────────
sql("update transfers set downloads_allowed = 1 where transfer_id = ?", fid)
grab = lambda b, tid: b.get(f"/transfers/{tid}/original?format=json")[0]
r2, r3 = Browser(), Browser()
for b in (r2, r3): expect(b.post(f"/transfers/{fid}/unlock", {"password": "folder-pw"})[0], 200, "unlock")
expect(grab(r2, members["notes.txt"]), 200, "first download of notes.txt")
expect(grab(r2, members["notes.txt"]), 200, "the same download continuing (grant cookie)")
expect(grab(r3, members["notes.txt"]), 403, "a second download of notes.txt past its allowance of 1")
expect(grab(r3, members["Reel 1/picture.mov"]), 200, "another file still has its own allowance")
left = {x["path"]: x["downloadsLeft"] for x in r3.get(f"/transfers/{fid}")[1]["files"]}
expect(left["notes.txt"], 0, "downloads left for notes.txt")
expect(left["Reel 1/audio/mix.wav"], 1, "downloads left for an untouched file")
print("  each file has its own allowance: one file used up leaves the others downloadable")

# ── 6. revoking the folder takes every file with it ─────────────────────────
sql("update transfers set revoked = 1, revoked_at = '2026-01-01T00:00:00.000Z' where transfer_id = ?", fid)
expect(r2.get(f"/transfers/{fid}")[0], 404, "the revoked folder")
for path, tid in members.items():
  expect(r2.get(f"/transfers/{tid}/original?format=json")[0], 404, f"{path} after its folder was revoked")
print("  revoking the folder closes every file in it")
PY

echo "PASS - folder transfers: declared manifest, owner-only member uploads, one link, folder password, per-file allowance, revocation"
