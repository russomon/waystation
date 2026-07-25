#!/usr/bin/env bash
# Blind-jury proof (mock GMI, two model ids, zero spend).
# The reliability passport's reproducibility axis: when the generated-media
# typography reducer produces findings, a BLIND second model re-perceives the
# same evidence, its observations replay through the SAME reducer, and the two
# structured finding sets are matched on match_key. Asserts:
#   A  reproduced + contested verdicts from reducer REPLAY (the mock juror
#      returns raw observations only — it cannot echo findings)
#   B  a contested finding STAYS in the report (risk stays SUSPECTED) with
#      review priority RAISED — disagreement is information, not an eraser
#   C  PROMPT BLINDNESS: no juror request contains the primary's finding text
#   D  jury disabled (GMI_JURY_MODEL empty) → honest single_source verdicts
#   E  same-family juror relation is disclosed; jury frames metered in details
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d)
REQLOG="$WORK/gmi-requests.jsonl"
cleanup(){ lsof -ti:8010 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
lsof -ti:8010 2>/dev/null | xargs kill -9 2>/dev/null || true
command -v ffmpeg >/dev/null || { echo "SKIP — ffmpeg not installed"; exit 0; }

# ── model-aware mock GMI: routes on BOTH prompt keywords AND requested model.
#    Primary sees TWO text mutations (door-sign OPEN→0PEN, poster SALE→SA1E);
#    the juror independently reproduces door-sign but reads poster as stable.
REQLOG="$REQLOG" "$PY" - <<'PYEOF' >/tmp/jurymock.log 2>&1 &
import json, os, re
from http.server import BaseHTTPRequestHandler, HTTPServer

REQLOG = os.environ["REQLOG"]

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = body.get("model", "?")
        content = body["messages"][0]["content"]
        texts = " ".join(p.get("text", "") for p in content if isinstance(p, dict)) \
            if isinstance(content, list) else str(content)
        with open(REQLOG, "a") as f:
            f.write(json.dumps({"model": model, "text": texts}) + "\n")
        evidence_ids = list(dict.fromkeys(re.findall(r'"evidence_id"\s*:\s*"([^"]+)"', texts)))
        pairs = re.findall(r"Text evidence (generated-text-\d+), track ([^,]+),", texts)
        if "COMPILE A READ-ONLY QC BLUEPRINT" in texts:
            text = json.dumps({"summary": "typography-focused plan", "assertions": [
                {"assertion_id": "A1", "risk_id": "rendered_text",
                 "requirement": "signage lettering stays stable",
                 "scope": "shot", "evidence_strategy": "native_text_crops"}]})
        elif "BUILD A SCENE-GRAPH LEDGER" in texts:
            snapshots = []
            for i, evidence_id in enumerate(evidence_ids):
                snapshots.append({
                    "evidence_id": evidence_id, "shot_id": "shot-1",
                    "subjects": [], "objects": [],
                    "background": {"location": "studio"},
                    "text_regions": [
                        {"track_key": "door-sign", "text": "OPEN",
                         "bbox": [0.10, 0.10, 0.30, 0.18], "confidence": "high"},
                        {"track_key": "poster", "text": "SALE",
                         "bbox": [0.55, 0.55, 0.30, 0.18], "confidence": "high"}],
                    "assertions": [], "anomalies": []})
            text = json.dumps({"snapshots": snapshots})
        elif "TRANSCRIBE TRACKED TEXT" in texts:
            juror = model == "mock-juror"
            seen: dict = {}
            observations = []
            for evidence_id, track in pairs:
                nth = seen.get(track, 0); seen[track] = nth + 1
                # mutate ONCE and stay mutated -> exactly one finding per track
                if track == "door-sign":
                    value = "OPEN" if nth == 0 else "0PEN"         # BOTH models see it
                elif juror:
                    value = "SALE"                                  # juror: poster stable
                else:
                    value = "SALE" if nth == 0 else "SA1E"         # primary: poster mutates
                observations.append({"evidence_id": evidence_id, "track_key": track,
                                     "text": value, "confidence": "high"})
            text = json.dumps({"observations": observations})
        elif "AI-GENERATED video" in texts:
            text = json.dumps({"findings": [], "appears_generated": False,
                               "confidence": "low", "summary": "clean"})
        else:
            text = json.dumps({"snapshots": []})
        data = json.dumps({"choices": [{"message": {"content": text}}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 8010), H).serve_forever()
PYEOF
until curl -s -o /dev/null -X POST http://localhost:8010/v1/chat/completions \
  -H 'content-type: application/json' --data '{"messages":[{"content":"ping"}]}'; do sleep 0.3; done

ffmpeg -y -f lavfi -i testsrc2=duration=4:size=640x360:rate=15 \
  -c:v libx264 -pix_fmt yuv420p "$WORK/clip.mp4" >/tmp/juryff.log 2>&1
cat > "$WORK/source.genblaze.json" <<'JSON'
{"schema_version":"1.5","run":{"run_id":"gen-jury","steps":[
  {"step_id":"generate","provider":"gmicloud","model":"video-gen",
   "prompt":"a storefront with an OPEN sign and a SALE poster"}]}}
JSON

echo "=== running case A (jury ON) and case D (jury OFF) ==="
for CASE in on off; do
  JM=$([ "$CASE" = on ] && echo mock-juror || echo "")
  GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8010 \
  GMI_MULTIMODAL_MODEL=mock-primary GMI_JURY_MODEL="$JM" \
  AI_QC_MIN_INTERVAL=0 PIPELINE_SHARED_SECRET=x B2_BUCKET=b \
  B2_S3_ENDPOINT=http://x B2_KEY_ID=x B2_APP_KEY=x B2_REGION=x \
  "$PY" -W ignore - "$WORK" "$WORK/details-$CASE.json" <<PYEOF
import json, subprocess, sys
sys.path.insert(0, "$WEB/pipeline")
import worker
work = sys.argv[1]
src = f"{work}/clip.mp4"
meta = json.loads(subprocess.run(["ffprobe","-v","quiet","-print_format","json",
    "-show_format","-show_streams",src],capture_output=True,text=True).stdout)
checks, frames, details = worker.run_synthetic_qc(src, meta, work, f"{work}/source.genblaze.json")
json.dump({"checks": checks, "frames": frames, "details": details}, open(sys.argv[2], "w"), default=str)
print(f"  case done: {len(checks)} checks")
PYEOF
done

echo "=== assertions ==="
"$PY" - "$WORK" "$REQLOG" <<'PYEOF'
import json, sys
work, reqlog = sys.argv[1], sys.argv[2]
on = json.load(open(f"{work}/details-on.json"))
off = json.load(open(f"{work}/details-off.json"))
ok = True
def need(cond, msg):
    global ok
    if not cond: print(f"  FAIL: {msg}"); ok = False

# A) reproduced + contested via reducer replay
typo = on["details"]["typography"]
findings = typo["findings"]
by_track = {f["track_key"]: f for f in findings}
need(set(by_track) == {"door-sign", "poster"}, f"expected 2 findings, got {list(by_track)}")
door, poster = by_track.get("door-sign", {}), by_track.get("poster", {})
print(f"  door-sign: {door.get('jury', {}).get('verdict')}  poster: {poster.get('jury', {}).get('verdict')}")
need(door.get("jury", {}).get("verdict") == "reproduced", "door-sign mutation should be reproduced")
need(poster.get("jury", {}).get("verdict") == "contested", "poster mutation should be contested")
need(poster["jury"]["review_priority"] == "raised", "contested must RAISE review priority")
need(door["jury"]["juror_relation"] == "same_family_cross_generation" or
     door["jury"]["juror_relation"] == "cross_family",
     f"juror relation missing ({door.get('jury')})")

# B) contested finding STAYS: still among findings + risk still suspected in check
need(any(f["track_key"] == "poster" for f in findings),
     "contested finding was dropped — it must stay SUSPECTED")
check = next(c for c in on["checks"] if c["name"] == "ai_rendered_text_integrity")
print(f"  check: {check['status']} — {check['detail'][:110]}")
need(check["status"] == "warn", "typography check must stay warn with a contested finding")
need("1 reproduced" in check["detail"] and "1 contested" in check["detail"],
     "check detail must summarize jury verdicts")
need("review priority raised" in check["detail"], "check detail must state raised priority")

# C) prompt blindness: juror requests carry no primary finding text
juror_reqs = [json.loads(line) for line in open(reqlog)
              if json.loads(line)["model"] == "mock-juror"]
need(juror_reqs, "no juror requests were made")
for req in juror_reqs:
    for banned in ("Tracked text", "similarity", "changed:", "SA1E", "0PEN"):
        need(banned not in req["text"], f"juror prompt leaked primary finding content: {banned!r}")
    need("TRANSCRIBE TRACKED TEXT" in req["text"], "juror got a non-typography prompt")
print(f"  blindness: {len(juror_reqs)} juror request(s) clean of primary findings")

# D) jury disabled → single_source, disclosed
for f in off["details"]["typography"]["findings"]:
    need(f.get("jury", {}).get("verdict") == "single_source",
         f"disabled jury must yield single_source ({f.get('jury')})")
print(f"  off-case: {len(off['details']['typography']['findings'])} finding(s) single_source")

# E) metering + diagnostics
jinfo = typo["jury"]
need(jinfo.get("frames", 0) > 0, "jury frames not recorded for metering")
diag = jinfo.get("diagnostics") or {}
need(0 < diag.get("raw_agreement", 1.0) < 1.0,
     f"diagnostics should show partial agreement ({diag})")
need(diag.get("gwet_ac1") is not None, "AC1 missing from diagnostics")
print(f"  diagnostics: raw {diag.get('raw_agreement')}, AC1 {diag.get('gwet_ac1')}, jury frames {jinfo['frames']}")

# structured identity survived the pipeline
need(door.get("match_key", {}).get("kind") == "text_mutation", "match_key missing on finding")
need(door.get("finding_id", "").startswith("text_mutation:door-sign:"), "finding_id missing")

print("PASS ✓  blind jury: reducer replay + contested-stays-suspected + prompt blindness + honest single_source"
      if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF