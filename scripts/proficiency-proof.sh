#!/usr/bin/env bash
# Proficiency Foundry proof (deterministic + mock GMI, zero spend). Asserts:
#   1  control class (bad_framerate): blind plants scored 5/5, clean twins 5/5,
#      PROVISIONAL label, Wilson CIs present
#   2  scoring branches through the REAL text lane (mock model): a stable mock
#      scores 0/5 caught (missed) with clean twins; a mutate-everything mock
#      scores 5/5 caught with 5/5 twin FALSE POSITIVES — all four outcomes real
#   3  manifest completeness: every required provenance field present
#   4  citation: draft never citable; config mismatch ⇒ UNCALIBRATED; exact
#      match on a published manifest ⇒ EXACT
#   5  dirty-worktree refusal, proven against an ISOLATED temp git repo
#   6  --publish writes a COMPLIANCE-locked WORM object (MinIO); the locked
#      version cannot be deleted
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d); DATA=$(mktemp -d)
MODEFILE="$WORK/mockmode"; REQLOG="$WORK/req.jsonl"
BUCKET=waystation-prof-test
cleanup(){ { lsof -ti:8010; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK" "$DATA"; }
trap cleanup EXIT
{ lsof -ti:8010; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true
command -v ffmpeg >/dev/null || { echo "SKIP — ffmpeg not installed"; exit 0; }
command -v minio >/dev/null || { echo "SKIP — minio not installed"; exit 0; }

echo "=== 1. control class: bad_framerate (fully offline) ==="
bash "$WEB/scripts/proficiency.sh" --class bad_framerate --out "$WORK/ctl" >/tmp/prof-ctl.log 2>&1 \
  || { echo "FAIL: control run"; tail -5 /tmp/prof-ctl.log; exit 1; }
"$PY" - "$WORK/ctl/proficiency-bad_framerate.json" <<'PYEOF'
import json, sys
doc = json.load(open(sys.argv[1]))
p = doc["primary"]
assert p["caught"] == 5 and p["missed"] == 0, p
assert p["true_negatives"] == 5 and p["false_positives"] == 0, p
assert p["provisional"] is True and p["sensitivity_wilson95"], p
print(f"  control: 5/5 caught, 5/5 twins clean, Wilson {p['sensitivity_wilson95']} PROVISIONAL ✓")
PYEOF

echo "=== 2. text-lane scoring branches (mock model, two modes) ==="
# mode-file-driven mock: 'stable' transcribes identical text everywhere;
# 'mutate' returns a mutated string after the first crop of every track.
MODEFILE="$MODEFILE" REQLOG="$REQLOG" "$PY" - <<'PYEOF' >/tmp/profmock.log 2>&1 &
import json, os, re
from http.server import BaseHTTPRequestHandler, HTTPServer
MODEFILE, REQLOG = os.environ["MODEFILE"], os.environ["REQLOG"]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = body["messages"][0]["content"]
        texts = " ".join(p.get("text", "") for p in content if isinstance(p, dict)) \
            if isinstance(content, list) else str(content)
        with open(REQLOG, "a") as f:
            f.write(json.dumps({"model": body.get("model"), "n": len(texts)}) + "\n")
        try:
            mode = open(MODEFILE).read().strip()
        except OSError:
            mode = "stable"   # readiness ping arrives before the mode file exists
        evidence_ids = list(dict.fromkeys(re.findall(r'"evidence_id"\s*:\s*"([^"]+)"', texts)))
        pairs = re.findall(r"Text evidence (generated-text-\d+), track ([^,]+),", texts)
        if "BUILD A SCENE-GRAPH LEDGER" in texts:
            snapshots = [{"evidence_id": e, "shot_id": "shot-1", "subjects": [], "objects": [],
                          "background": {"location": "card"},
                          "text_regions": [{"track_key": "sign", "text": "SIGN",
                                            "bbox": [0.05, 0.05, 0.9, 0.85], "confidence": "high"}],
                          "assertions": [], "anomalies": []} for e in evidence_ids]
            text = json.dumps({"snapshots": snapshots})
        elif "TRANSCRIBE TRACKED TEXT" in texts:
            seen = {}
            observations = []
            for evidence_id, track in pairs:
                nth = seen.get(track, 0); seen[track] = nth + 1
                value = "SIGN" if (mode == "stable" or nth == 0) else "5IGN"
                observations.append({"evidence_id": evidence_id, "track_key": track,
                                     "text": value, "confidence": "high"})
            text = json.dumps({"observations": observations})
        else:
            text = json.dumps({"snapshots": []})
        data = json.dumps({"choices": [{"message": {"content": text}}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data))); self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 8010), H).serve_forever()
PYEOF
until curl -s -o /dev/null -X POST http://localhost:8010/v1/chat/completions \
  -H 'content-type: application/json' --data '{"messages":[{"content":"ping"}]}'; do sleep 0.3; done

run_text() { # $1=mode $2=outdir
  echo "$1" > "$MODEFILE"
  GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8010 GMI_MULTIMODAL_MODEL=mock-primary \
  AI_QC_MIN_INTERVAL=0 \
  bash "$WEB/scripts/proficiency.sh" --class rendered_text_mutation --out "$2" \
    >/tmp/prof-text-$1.log 2>&1 || { echo "FAIL: text run ($1)"; tail -5 /tmp/prof-text-$1.log; exit 1; }
}
run_text stable "$WORK/stable"
run_text mutate "$WORK/mutate"
"$PY" - "$WORK/stable/proficiency-rendered_text_mutation.json" \
        "$WORK/mutate/proficiency-rendered_text_mutation.json" <<'PYEOF'
import json, sys
stable = json.load(open(sys.argv[1]))["primary"]
mutate = json.load(open(sys.argv[2]))["primary"]
assert stable["caught"] == 0 and stable["missed"] == 5, stable      # missed branch
assert stable["false_positives"] == 0 and stable["true_negatives"] == 5, stable
assert mutate["caught"] == 5 and mutate["missed"] == 0, mutate      # caught branch
assert mutate["false_positives"] == 5 and mutate["true_negatives"] == 0, mutate  # twin-FP branch
print(f"  stable mock: 0/5 caught (missed path), twins clean ✓")
print(f"  mutate mock: 5/5 caught, 5/5 twin FALSE POSITIVES scored ✓")
PYEOF

echo "=== 3+4. manifest completeness + citation states ==="
"$PY" - "$WORK/ctl/proficiency-bad_framerate.json" "$WEB" <<'PYEOF'
import json, sys
sys.path.insert(0, sys.argv[2] + "/pipeline")
from qc import foundry
doc = json.load(open(sys.argv[1]))
required = ["version", "suite_version", "class_id", "class_kind", "lane", "suite_sha256",
            "n_specs", "parameter_ranges", "asset_sha256", "ground_truth_sha256",
            "primary", "config", "environment", "execution_date", "published", "limits"]
missing = [k for k in required if k not in doc]
assert not missing, f"manifest missing {missing}"
cfg = doc["config"]
for key in ["primary_model", "jury_policy_version", "typography_prompt_sha256",
            "ledger_prompt_sha256", "reducer_version", "suite_version",
            "renderer_version", "sampler", "waystation_commit", "worktree_dirty"]:
    assert key in cfg, f"config missing {key}"
assert len(doc["asset_sha256"]) == 10 and len(doc["ground_truth_sha256"]) == 10
print("  manifest completeness ✓ (all provenance fields present)")

# citation: draft never citable
assert foundry.citation_state(doc, cfg)["state"] == "UNCALIBRATED"
# published + exact match -> EXACT; any mismatch -> UNCALIBRATED with keys named
pub = {**doc, "published": True}
assert foundry.citation_state(pub, cfg)["state"] == "EXACT"
drifted = {**cfg, "reducer_version": "changed/2.0"}
state = foundry.citation_state(pub, drifted)
assert state["state"] == "UNCALIBRATED" and "reducer_version" in state["mismatched_keys"]
print("  citation ✓ (draft UNCALIBRATED; exact EXACT; mismatch names keys)")
PYEOF

echo "=== 5. dirty-worktree refusal (isolated temp repo) ==="
SCRATCH_REPO=$(mktemp -d)
( cd "$SCRATCH_REPO" && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  echo dirty > uncommitted.txt )
set +e
OUT=$(WAYSTATION_REPO_DIR="$SCRATCH_REPO" MANIFEST_LOCK_DAYS=1 \
      B2_S3_ENDPOINT=http://x B2_KEY_ID=x B2_APP_KEY=x B2_BUCKET=b \
      bash "$WEB/scripts/proficiency.sh" --class bad_framerate --publish 2>&1)
RC=$?
set -e 2>/dev/null || true
echo "$OUT" | grep -q "refusing to publish from a dirty worktree" && [ "$RC" != "0" ] \
  && echo "  dirty worktree refused (exit $RC) ✓" \
  || { echo "FAIL: dirty worktree was not refused (rc=$RC)"; echo "$OUT" | tail -3; exit 1; }
rm -rf "$SCRATCH_REPO"

echo "=== 6. --publish writes WORM manifest (MinIO object-lock) ==="
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 >/tmp/prof-minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
s3.create_bucket(Bucket="$BUCKET", ObjectLockEnabledForBucket=True)
PYEOF
CLEAN_REPO=$(mktemp -d)
( cd "$CLEAN_REPO" && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init )
WAYSTATION_REPO_DIR="$CLEAN_REPO" MANIFEST_LOCK_DAYS=1 \
B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin \
B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true \
bash "$WEB/scripts/proficiency.sh" --class bad_framerate --publish --out "$WORK/pub" \
  >/tmp/prof-pub.log 2>&1 || { echo "FAIL: publish run"; tail -8 /tmp/prof-pub.log; exit 1; }
rm -rf "$CLEAN_REPO"
"$PY" - <<PYEOF
import boto3, json, sys; from botocore.config import Config
s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                  aws_access_key_id="minioadmin", aws_secret_access_key="minioadmin",
                  config=Config(s3={"addressing_style": "path"}))
keys = [o["Key"] for o in s3.list_objects_v2(Bucket="$BUCKET", Prefix="proficiency/")["Contents"]]
assert len(keys) == 1, keys
head = s3.head_object(Bucket="$BUCKET", Key=keys[0])
assert head.get("ObjectLockMode") == "COMPLIANCE", head.get("ObjectLockMode")
doc = json.loads(s3.get_object(Bucket="$BUCKET", Key=keys[0])["Body"].read())
assert doc["published"] is True and doc["config"]["worktree_dirty"] is False
vid = s3.list_object_versions(Bucket="$BUCKET", Prefix=keys[0])["Versions"][0]["VersionId"]
try:
    s3.delete_object(Bucket="$BUCKET", Key=keys[0], VersionId=vid)
    print("  FAIL: deleted a COMPLIANCE-locked proficiency manifest!"); sys.exit(1)
except Exception as e:
    print(f"  published WORM manifest: COMPLIANCE-locked, delete rejected ({type(e).__name__}) ✓")
print(f"  key: {keys[0]}")
PYEOF

echo "PASS ✓  proficiency foundry: blind scoring + manifest provenance + citation + dirty-refusal + WORM publish"