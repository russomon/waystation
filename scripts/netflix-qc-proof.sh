#!/usr/bin/env bash
# Netflix-profile + comprehensive QC + self-healing proof. Four assets:
#   A  good24.mp4  — 24p, calibrated to -24 LUFS, + captions + identical .ref
#                    mezzanine → netflix profile: ZERO blockers/issues,
#                    reference SSIM/PSNR/VMAF pass, Photon/DoVi FYI notes
#   B  bad30.mp4   — 30fps (not an allowed rate), superwhite (Y=250), hot
#                    clipped audio → netflix: BLOCKERs (framerate, loudness,
#                    true peak, legal range); self-heal ON → healed derivative
#                    re-measured at -24 LUFS / TP <= -2 / legal luma
#   C  bad30.mp4   — same file, STANDARD profile → zero blockers (review-level
#                    ISSUEs only): the toggle IS the strictness
#   D  strobe.mp4  — alternating black/white frames → netflix PSE scanner
#                    hard-fails (photosensitivity risk)
# Plus: .ref sidecar accepted by /uploads/sidecar-url, .exe rejected, and a
# signed B2 event for the .ref key does NOT trigger a second pipeline run.
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
SECRET=evsecret; SHARED=ps; BUCKET=orbitxfer-test
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
{ lsof -ti:8787; lsof -ti:8000; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" --address :9000 --console-address :9011 >/tmp/minio.log 2>&1 &
until curl -sf -o /dev/null --max-time 1 http://localhost:9000/minio/health/live; do sleep 0.3; done
( cd "$WEB/gateway" && CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev B2_EVENT_SIGNING_SECRET=$SECRET \
   PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 PORT=8787 \
   npx tsx src/server.ts >/tmp/gw.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8787/; do sleep 0.3; done
( cd "$WEB/pipeline" && PIPELINE_SHARED_SECRET=$SHARED ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/pipe.log 2>&1 ) &
until curl -sf -o /dev/null --max-time 1 http://localhost:8000/healthz; do sleep 0.3; done
echo "✓ stack up"

"$PY" - <<PYEOF
import boto3; from botocore.config import Config
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
try: s3.create_bucket(Bucket="$BUCKET")
except Exception: pass
PYEOF

echo "— building test media —"
# A: 24p master calibrated to -24 LUFS (measure, then apply the exact gain)
ffmpeg -y -f lavfi -i testsrc=duration=4:size=640x360:rate=24 -f lavfi -i sine=frequency=440:duration=4 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/probe.mp4" >/dev/null 2>&1
I1=$(ffmpeg -hide_banner -i "$WORK/probe.mp4" -af ebur128 -f null - 2>&1 | grep -Eo 'I:\s+-?[0-9.]+ LUFS' | tail -1 | grep -Eo '\-?[0-9.]+')
GAIN=$(python3 -c "print(round(-24.0 - ($I1), 2))")
ffmpeg -y -f lavfi -i testsrc=duration=4:size=640x360:rate=24 -f lavfi -i sine=frequency=440:duration=4 \
  -af "volume=${GAIN}dB" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/good24.mp4" >/dev/null 2>&1
cp "$WORK/good24.mp4" "$WORK/good24.ref.mp4"
# B: 30fps + superwhite (Y clamped to 250) + hot clipped audio
ffmpeg -y -f lavfi -i testsrc=duration=4:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=4 \
  -vf "lutyuv=y=250" -af "volume=20dB" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$WORK/bad30.mp4" >/dev/null 2>&1
# D: photosensitive strobe — full-frame black/white alternation every frame
ffmpeg -y -f lavfi -i "color=black:duration=3:size=320x240:rate=24" \
  -vf "geq=lum='if(mod(N,2),235,16)':cb=128:cr=128" -c:v libx264 -pix_fmt yuv420p "$WORK/strobe.mp4" >/dev/null 2>&1
cat > "$WORK/good.srt" <<'SRT'
1
00:00:00,200 --> 00:00:01,400
Hello world

2
00:00:01,600 --> 00:00:02,800
A fine master
SRT
echo "  calibrated good24 gain: ${GAIN} dB (from ${I1} LUFS)"

run_job() { # $1=tid $2=file $3=optionsJSON $4=extra-sidecar(or "")
  local tid=$1 file=$2 opts=$3 sidecar=$4
  local key="transfers/$tid/$(basename $file)"
  "$PY" - "$tid" "$file" "$sidecar" <<'PYEOF'
import boto3, os, sys; from botocore.config import Config
tid, file, sidecar = sys.argv[1:4]
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
if sidecar:
    for sc in sidecar.split(","):
        s3.upload_file(sc, "orbitxfer-test", f"transfers/{tid}/{os.path.basename(sc)}")
s3.upload_file(file, "orbitxfer-test", f"transfers/{tid}/{os.path.basename(file)}", ExtraArgs={"ContentType":"video/mp4"})
PYEOF
  curl -N -s "http://localhost:8787/api/progress/$tid" > "/tmp/sse-$tid.log" 2>&1 &
  until grep -q subscribed "/tmp/sse-$tid.log"; do sleep 0.2; done
  curl -sS -o /dev/null -X POST http://localhost:8000/jobs -H "content-type: application/json" -H "authorization: Bearer $SHARED" \
    --data "{\"bucket\":\"$BUCKET\",\"key\":\"$key\",\"transferId\":\"$tid\",\"gatewayUrl\":\"http://localhost:8787\",\"options\":$opts}"
  for i in $(seq 1 240); do grep -q pipeline_complete "/tmp/sse-$tid.log" && return 0; sleep 0.5; done
  echo "TIMEOUT waiting for $tid"; tail -5 /tmp/pipe.log; return 1
}

TID_A=$(uuidgen | tr 'A-Z' 'a-z'); TID_B=$(uuidgen | tr 'A-Z' 'a-z')
TID_C=$(uuidgen | tr 'A-Z' 'a-z'); TID_D=$(uuidgen | tr 'A-Z' 'a-z')

run_job "$TID_A" "$WORK/good24.mp4" '{"profile":"netflix","qc_ai":false}' "$WORK/good.srt,$WORK/good24.ref.mp4" || exit 1
echo "✓ A processed (netflix, compliant + captions + reference)"
run_job "$TID_B" "$WORK/bad30.mp4" '{"profile":"netflix","self_heal":true,"qc_ai":false,"qc_captions":false}' "" || exit 1
echo "✓ B processed (netflix, violating, self-heal on)"
run_job "$TID_C" "$WORK/bad30.mp4" '{"profile":"standard","qc_ai":false,"qc_captions":false}' "" || exit 1
echo "✓ C processed (standard, same violating file)"
run_job "$TID_D" "$WORK/strobe.mp4" '{"profile":"netflix","qc_ai":false,"qc_captions":false}' "" || exit 1
echo "✓ D processed (netflix, strobe)"

echo "— sidecar endpoint validation —"
OK=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8787/api/uploads/sidecar-url \
  -H 'content-type: application/json' --data '{"key":"transfers/x/a.mp4","filename":"master.ref.mp4"}')
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8787/api/uploads/sidecar-url \
  -H 'content-type: application/json' --data '{"key":"transfers/x/a.mp4","filename":"evil.exe"}')
[ "$OK" = "200" ] && [ "$BAD" = "400" ] && echo "✓ .ref.mp4 accepted (200), .exe rejected (400)" \
  || { echo "FAIL: sidecar validation ($OK/$BAD)"; exit 1; }

# signed event for the .ref key must NOT start a second pipeline
REFKEY="transfers/$TID_A/good24.ref.mp4"
BODY="{\"events\":[{\"eventType\":\"b2:ObjectCreated:Upload\",\"objectName\":\"$REFKEY\",\"bucketName\":\"$BUCKET\"}]}"
SIG="v1=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -sS -o /dev/null -X POST http://localhost:8787/api/events/b2 -H "content-type: application/json" -H "X-Bz-Event-Notification-Signature: $SIG" --data-raw "$BODY"
sleep 2
RUNS=$(grep -c pipeline_started "/tmp/sse-$TID_A.log")
[ "$RUNS" = "1" ] && echo "✓ .ref event ignored (still exactly 1 pipeline run)" \
  || { echo "FAIL: ref event triggered a run ($RUNS)"; exit 1; }

echo "=== tiered QC + self-heal assertions ==="
"$PY" - "$TID_A" "$TID_B" "$TID_C" "$TID_D" "$WEB" <<'PYEOF'
import boto3, json, subprocess, sys, urllib.request; from botocore.config import Config
ta, tb, tc, td, web = sys.argv[1:6]
sys.path.insert(0, f"{web}/pipeline")
from qc.audio import measure_loudness
from qc.util import metadata_print, tag_values
s3=boto3.client("s3",endpoint_url="http://localhost:9000",region_name="us-east-1",aws_access_key_id="minioadmin",aws_secret_access_key="minioadmin",config=Config(s3={"addressing_style":"path"}))
def qc(tid): return json.loads(s3.get_object(Bucket="orbitxfer-test", Key=f"derivatives/{tid}/qc_report.json")["Body"].read())
def usage(tid): return json.load(urllib.request.urlopen(f"http://localhost:8787/api/transfers/{tid}/usage"))
def ck(r, n):
    h = [c for c in r["checks"] if c["name"] == n]
    return h[0] if h else None
ok = True
def need(cond, msg):
    global ok
    if not cond: print(f"  FAIL: {msg}"); ok = False

a, b, c, d = qc(ta), qc(tb), qc(tc), qc(td)

print(f"  A (netflix, compliant): status={a['status']} tiers={a['tiers']}")
need(a["profile"] == "netflix" and a["profile_label"] == "Netflix_Delivery_Specification_Strict", "A profile label")
need(a["tiers"]["BLOCKER"] == 0 and a["tiers"]["ISSUE"] == 0, "A must have zero blockers/issues")
for name, frag in [("framerate", "24p"), ("loudness", "-24"), ("true_peak", ""),
                   ("timecode_continuity", "monotonic"), ("multipart_delivery", "single"),
                   ("pse_flash_risk", ""), ("video_legal_range", ""), ("reference_ssim", "SSIM"),
                   ("caption_sync", ""), ("caption_encoding", "")]:
    chk = ck(a, name)
    need(chk and chk["status"] == "pass", f"A {name} should pass ({chk})")
    if chk and frag: need(frag in chk["detail"], f"A {name} detail missing '{frag}': {chk['detail']}")
vmaf = ck(a, "reference_vmaf")
if vmaf: print(f"    reference_vmaf: {vmaf['detail']}")
need(vmaf and vmaf["status"] == "pass" and "MOS" in vmaf["detail"], "A VMAF/MOS vs identical mezzanine")
need(ck(a, "imf_photon") and ck(a, "imf_photon")["status"] == "info", "A Photon FYI note (Rule 4)")
need(ck(a, "hdr_dolby_vision") and ck(a, "hdr_dolby_vision")["tier"] == "FYI", "A DoVi FYI note (Rule 5)")

print(f"  B (netflix, violating): status={b['status']} tiers={b['tiers']}")
for name in ("framerate", "loudness", "true_peak", "video_legal_range"):
    chk = ck(b, name)
    print(f"    {name}: {chk['status']} [{chk.get('tier')}] — {chk['detail'][:90]}")
    need(chk and chk["status"] == "fail" and chk.get("tier") == "BLOCKER", f"B {name} must be a BLOCKER")
need(b["tiers"]["BLOCKER"] >= 4, f"B expected >=4 blockers, got {b['tiers']}")
heal = ck(b, "self_heal")
need(heal and heal["status"] == "pass", f"B self_heal check ({heal})")
if heal: print(f"    self_heal: {heal['detail'][:110]}")
# healed derivative: download and re-measure with the same instruments
healed = [o["Key"] for o in s3.list_objects_v2(Bucket="orbitxfer-test", Prefix=f"derivatives/{tb}/").get("Contents", [])
          if "/healed_" in o["Key"]]
need(healed, "B healed derivative missing")
if healed:
    s3.download_file("orbitxfer-test", healed[0], "/tmp/healed-proof.mp4")
    m = measure_loudness("/tmp/healed-proof.mp4")
    lines = metadata_print("/tmp/healed-proof.mp4", "signalstats", 4.0)
    ymax = max(tag_values(lines, "lavfi.signalstats.YMAX") or [999])
    print(f"    healed re-measured: I={m['i']} LUFS, TP={m['tp']} dBTP, YMAX={ymax:.0f}")
    need(m["i"] is not None and abs(m["i"] + 24.0) <= 1.5, f"healed loudness {m['i']} not within -24±1.5")
    need(m["tp"] is not None and m["tp"] <= -1.7, f"healed true peak {m['tp']} above -2 (tol -1.7)")
    need(ymax <= 237, f"healed luma still illegal (YMAX {ymax})")
need("heal" in usage(tb)["totals"], "B heal run not metered")

print(f"  C (standard, same file): status={c['status']} tiers={c['tiers']}")
need(c["tiers"]["BLOCKER"] == 0, "C standard profile must not block")
need(c["tiers"]["ISSUE"] >= 1, "C should surface review-level issues")
need(ck(c, "framerate")["status"] == "pass", "C framerate unrestricted under standard")

print(f"  D (netflix, strobe): status={d['status']} tiers={d['tiers']}")
pse = ck(d, "pse_flash_risk")
print(f"    pse_flash_risk: {pse['status']} [{pse.get('tier')}] — {pse['detail']}")
need(pse and pse["status"] == "fail" and pse.get("tier") == "BLOCKER", "D PSE scanner must hard-fail (Rule 7)")

print("PASS ✓  Netflix profile + tiers + self-heal + reference lane + PSE" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
