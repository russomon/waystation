#!/usr/bin/env bash
# Proficiency Foundry runner — blind planted-defect testing of a QC lane.
#
#   scripts/proficiency.sh --class rendered_text_mutation            # draft
#   scripts/proficiency.sh --class loudness_delta_lu                 # control
#   scripts/proficiency.sh --class rendered_text_mutation --publish  # citable
#
# Draft mode: renders the seeded suite, runs the EXACT production lane subset
# for the class, scores deterministically, writes an UNLOCKED draft manifest to
# the output dir. Drafts are never citable.
# --publish: additionally requires a CLEAN git worktree and B2 credentials with
# MANIFEST_LOCK_DAYS > 0, and writes the manifest to B2 under Object Lock
# (COMPLIANCE) — the immutable proficiency record the report may cite.
#
# The AI class needs GMI env (real for a shipped record; a mock for machinery
# proofs). Control classes run fully offline and prove scoring only.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"

CLASS=""; PUBLISH=0; SEED=20260724; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --class) CLASS=$2; shift 2;;
    --publish) PUBLISH=1; shift;;
    --seed) SEED=$2; shift 2;;
    --out) OUT=$2; shift 2;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done
[ -n "$CLASS" ] || { echo "usage: proficiency.sh --class <id> [--publish] [--seed N] [--out DIR]"; exit 2; }
OUT="${OUT:-$(mktemp -d)/proficiency-$CLASS}"
mkdir -p "$OUT"
command -v ffmpeg >/dev/null || { echo "✗ ffmpeg required"; exit 1; }

# WAYSTATION_REPO_DIR: test seam so the dirty-worktree refusal is provable
# against an ISOLATED scratch repo instead of dirtying the real checkout.
REPO_DIR="${WAYSTATION_REPO_DIR:-$WEB}"
if [ "$PUBLISH" = "1" ]; then
  DIRTY=$(cd "$REPO_DIR" && git status --porcelain)
  [ -z "$DIRTY" ] || { echo "✗ refusing to publish from a dirty worktree:"; echo "$DIRTY" | head -5; exit 1; }
  [ "${MANIFEST_LOCK_DAYS:-0}" -gt 0 ] || { echo "✗ --publish requires MANIFEST_LOCK_DAYS > 0 (WORM)"; exit 1; }
  for v in B2_S3_ENDPOINT B2_KEY_ID B2_APP_KEY B2_BUCKET; do
    [ -n "${!v:-}" ] || { echo "✗ --publish requires $v"; exit 1; }
  done
fi

WEB="$WEB" REPO_DIR="$REPO_DIR" CLASS="$CLASS" SEED="$SEED" OUT="$OUT" PUBLISH="$PUBLISH" \
PIPELINE_SHARED_SECRET="${PIPELINE_SHARED_SECRET:-x}" \
B2_BUCKET="${B2_BUCKET:-b}" B2_S3_ENDPOINT="${B2_S3_ENDPOINT:-http://x}" \
B2_KEY_ID="${B2_KEY_ID:-x}" B2_APP_KEY="${B2_APP_KEY:-x}" B2_REGION="${B2_REGION:-us-east-1}" \
"$PY" -W ignore - <<'PYEOF'
import hashlib, json, os, platform, subprocess, sys
from datetime import datetime, timezone

WEB = os.environ["WEB"]
sys.path.insert(0, f"{WEB}/pipeline")
import worker
import foundry_render
from qc import foundry, generated as qgenerated, jury as qjury
from qc import audio as qaudio, structural as qstructural, profiles as qprofiles

CLASS, SEED, OUT = os.environ["CLASS"], int(os.environ["SEED"]), os.environ["OUT"]
PUBLISH = os.environ["PUBLISH"] == "1"
spec_class = foundry.CLASSES[CLASS]

# ── 1. render the seeded suite (ground truth exact by construction) ──
specs = foundry.plan_suite(CLASS, seed=SEED)
asset_hashes, sidecar_hashes, paths = {}, {}, {}
for spec in specs:
    asset, sidecar = foundry_render.render(spec, OUT)
    paths[spec["asset_id"]] = asset
    asset_hashes[spec["asset_id"]] = foundry_render.sha256_file(asset)
    sidecar_hashes[spec["asset_id"]] = foundry_render.sha256_file(sidecar)
print(f"✓ rendered {len(specs)} assets ({sum(s['planted'] for s in specs)} plants) → {OUT}")

# ── 2. run the EXACT production lane subset per asset (truth stays hidden) ──
def probe(path):
    return json.loads(subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True).stdout)

def text_lane(src, tmp, model=None):
    """Production typography subset: coarse ledger locates text; native crops
    are transcribed; the deterministic reducer derives findings. Identical
    prompts/normalizers/reducers to run_synthetic_qc (fine pass not run —
    recorded in the manifest's sampler descriptor)."""
    meta = probe(src)
    dur = float(meta.get("format", {}).get("duration", 0) or 6.0)
    plan = qgenerated.normalize_plan({}, None)
    parts, evidence, _ = worker._generated_evidence(src, tmp, dur)
    raw, _err = worker._synthetic_json(
        [{"type": "text", "text": qgenerated.scene_ledger_prompt(plan, evidence, "coarse")}] + parts,
        max_tokens=12000, model=model)
    ledger = qgenerated.normalize_ledger(raw, evidence, "coarse")
    tparts, tevidence = worker._typography_evidence(src, tmp, [ledger])
    if not tparts:
        return []
    traw, _terr = worker._synthetic_json(
        [{"type": "text", "text": qgenerated.typography_prompt(tevidence)}] + tparts,
        max_tokens=6000, model=model)
    observations = qgenerated.normalize_text_observations(traw, tevidence)
    return qgenerated.compare_text_observations(observations)

rows, primary_outcomes, juror_outcomes = [], [], []
jury_model = worker.GMI_JURY_MODEL or None
profile = qprofiles.get("netflix")
for spec in specs:
    src = paths[spec["asset_id"]]
    tmp = os.path.join(OUT, f"work-{spec['asset_id']}")
    os.makedirs(tmp, exist_ok=True)
    if CLASS == "rendered_text_mutation":
        primary_findings = text_lane(src, tmp)
        primary_kinds = [f["kind"] for f in primary_findings]
        juror_kinds, jury_verdicts = [], None
        if jury_model:
            juror_findings = text_lane(src, tmp, model=jury_model)   # blind + offline
            juror_kinds = [f["kind"] for f in juror_findings]
            if primary_findings:   # deployed policy: jury only on findings
                verdicts = qjury.replay_verdicts(primary_findings, juror_findings, True)
                jury_verdicts = [v["verdict"] for v in verdicts]
    elif CLASS == "loudness_delta_lu":
        checks = qaudio.loudness_checks(src, profile)
        primary_kinds = [c["name"] for c in checks if c["status"] in {"warn", "fail"}]
        juror_kinds, jury_verdicts = [], None
    elif CLASS == "bad_framerate":
        checks = qstructural.framerate_checks(src, probe(src), profile)
        primary_kinds = [c["name"] for c in checks if c["status"] in {"warn", "fail"}]
        juror_kinds, jury_verdicts = [], None

    outcome = foundry.score_asset(spec, primary_kinds)
    primary_outcomes.append(outcome)
    if jury_model:
        juror_outcomes.append(foundry.score_asset(spec, juror_kinds))
    rows.append({"planted": spec["planted"],
                 "primary_hit": outcome in {"caught", "false_positive_on_twin"},
                 "jury_verdicts": jury_verdicts,
                 "juror_hit": foundry.CLASSES[CLASS]["finding_kind"] in juror_kinds})
    print(f"  {spec['asset_id']} planted={spec['planted']} -> {outcome}"
          + (f" jury={jury_verdicts}" if jury_verdicts else ""))

# ── 3. aggregate the three systems ──
primary = foundry.aggregate(primary_outcomes)
juror = foundry.aggregate(juror_outcomes) if juror_outcomes else None
pair = foundry.pair_policy(rows) if jury_model else None

# ── 4. exact configuration + environment ──
def sha(text): return hashlib.sha256(text.encode()).hexdigest()
repo_dir = os.environ.get("REPO_DIR", WEB)
commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_dir,
                        capture_output=True, text=True).stdout.strip()
dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=repo_dir,
                            capture_output=True, text=True).stdout.strip())
config = {
    "primary_model": worker.GMI_MULTIMODAL_MODEL,
    "juror_model": jury_model,
    "jury_enabled": bool(jury_model),
    "jury_policy_version": qjury.JURY_POLICY_VERSION,
    "typography_prompt_sha256": sha(qgenerated.typography_prompt([])),
    "ledger_prompt_sha256": sha(qgenerated.scene_ledger_prompt({}, [], "coarse")),
    "plan_version": qgenerated.PLAN_VERSION,
    "ledger_version": qgenerated.LEDGER_VERSION,
    "reducer_version": qgenerated.REDUCER_VERSION,
    "suite_version": foundry.SUITE_VERSION,
    "renderer_version": foundry_render.RENDERER_VERSION,
    "sampler": {"targeted_path": "coarse_ledger+typography (production adds a jittered fine pass)",
                **{k: v for k, v in os.environ.items() if k.startswith("AI_QC_SYNTH")}},
    "waystation_commit": commit,
    "worktree_dirty": dirty,
}
ffv = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[:1]
import PIL
environment = {"python": sys.version.split()[0], "pillow": PIL.__version__,
               "ffmpeg": ffv[0] if ffv else "?", "platform": platform.platform()}

manifest = foundry.manifest(
    CLASS, specs, primary, juror, pair, config, environment,
    asset_hashes, sidecar_hashes,
    execution_date=datetime.now(timezone.utc).isoformat(), published=PUBLISH)

draft_path = os.path.join(OUT, f"proficiency-{CLASS}.json")
with open(draft_path, "w") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)

label = "PROVISIONAL" if primary["provisional"] else ""
print(f"\nprimary: {primary['caught']}/{primary['n_plants']} caught "
      f"(Wilson {primary['sensitivity_wilson95']}), "
      f"specificity {primary['true_negatives']}/{primary['n_twins']} {label}")
if juror:
    print(f"juror (offline): {juror['caught']}/{juror['n_plants']} caught")
if pair:
    print(f"pair policy: {pair['plants_reproduced']} reproduced / {pair['plants_contested']} contested "
          f"on plants; offline_juror_only_catch={pair['offline_juror_only_catch']}")

if PUBLISH:
    from datetime import timedelta
    lock_days = int(os.environ.get("MANIFEST_LOCK_DAYS", "0"))
    key = f"proficiency/{CLASS}/{manifest['suite_sha256'][:12]}-{commit[:8]}.json"
    until = datetime.now(timezone.utc) + timedelta(days=lock_days)
    worker.s3.put_object(Bucket=os.environ["B2_BUCKET"], Key=key,
                         Body=json.dumps(manifest, indent=2, sort_keys=True).encode(),
                         ContentType="application/json",
                         ObjectLockMode="COMPLIANCE", ObjectLockRetainUntilDate=until)
    print(f"✓ PUBLISHED (WORM, COMPLIANCE until {until.date()}): s3://{os.environ['B2_BUCKET']}/{key}")
else:
    print(f"draft manifest (NOT citable): {draft_path}")
PYEOF