#!/usr/bin/env bash
# Hybrid QC lane proof (perceive-then-compute). Self-contained; only needs
# ffmpeg + the pipeline venv — NO cloud / NO GMI. It feeds the deterministic
# reducers model-SHAPED JSON (what the VLM would return) so the whole
# qc/hybrid.py path is exercised without a model call, and it asserts:
#   - align RECOVERS a known offset from a synthetic openness series,
#   - align ABSTAINS on an aliased (periodic) peak instead of confabulating,
#   - reduce_to_check maps offset/abstain/empty-perception to warn/info honestly,
#   - compare_declared FLAGS dialogue-on-LFE and PASSES a clean layout,
#   - layout_roles maps 5.1 to roles and returns None for stereo (nothing to check),
#   - _audio_envelope honours the new rate= arg (real ffmpeg pass),
#   - coverage treats a hybrid WARN as SUSPECTED but a hybrid PASS never CLEARs
#     lip_sync / channel_assignment (both partial / model_unreliable).
set -u
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
command -v ffmpeg >/dev/null || { echo "SKIP — ffmpeg not installed"; exit 0; }
[ -x "$PY" ] || { echo "SKIP — pipeline venv not built"; exit 0; }

# A 4s amplitude-modulated tone → a real, non-flat audio-energy envelope so the
# rate= arg of _audio_envelope can be exercised through a genuine ffmpeg pass.
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=4" \
  -af "tremolo=f=2:d=0.9" -ar 16000 "$WORK/am.wav" >/dev/null 2>&1

echo "=== assertions ==="
"$PY" -W ignore - "$WORK" "$WEB/pipeline" <<'PYEOF'
import math, sys
sys.path.insert(0, sys.argv[2])
from qc import hybrid, audio as qaudio, agentic
WORK = sys.argv[1]
ok = True
def need(c, m):
    global ok
    if not c: print(f"  FAIL: {m}"); ok = False

RATE = 6

# 1) align recovers a known offset. A single Gaussian bump gives an unambiguous
#    cross-correlation peak; shift it by +3 samples (=500 ms at 6 Hz).
base = [math.exp(-((i - 15) ** 2) / 8.0) for i in range(40)]
shift = 3
openness = [base[i - shift] if 0 <= i - shift < len(base) else 0.0 for i in range(40)]
data = {"frames": [{"t": i / RATE, "openness": v} for i, v in enumerate(openness)]}
series = hybrid.parse_series(data)
res = hybrid.align(series, base, RATE, max_lag_s=1.0)
print(f"  align known offset      -> {res}")
need(res and res["reliable"] and res["offset_ms"] == round(shift * 1000 / RATE, 1),
     "align must recover the +500 ms offset reliably")

# 2) align abstains on an aliased (periodic) signal rather than pick a lag.
per = [math.sin(2 * math.pi * i / 6.0) for i in range(40)]
per_shift = [per[i - 3] if 0 <= i - 3 < len(per) else 0.0 for i in range(40)]
res2 = hybrid.align(per_shift, per, RATE, max_lag_s=1.0)
print(f"  align aliased periodic  -> reliable={res2['reliable'] if res2 else None}")
need(res2 and not res2["reliable"], "align must ABSTAIN on an ambiguous/aliased peak")

# 3) reduce_to_check maps the three cases honestly.
warn = hybrid.reduce_to_check(hybrid.MOUTH_OPENNESS, data, ref_signal=base,
                              rate_hz=RATE, max_lag_s=1.0)
print(f"  lip_sync offset -> {warn['status']}: {warn['detail'][:56]}")
need(warn["status"] == "warn" and warn["source"] == "hybrid",
     "a real perceived offset must WARN and be sourced 'hybrid'")
abstain = hybrid.reduce_to_check(hybrid.MOUTH_OPENNESS,
                                 {"frames": [{"t": i / RATE, "openness": v} for i, v in enumerate(per_shift)]},
                                 ref_signal=per, rate_hz=RATE, max_lag_s=1.0)
need(abstain["status"] == "info", "an ambiguous window must degrade to an info, not a pass")
empty = hybrid.reduce_to_check(hybrid.MOUTH_OPENNESS, {"frames": []}, ref_signal=base,
                               rate_hz=RATE, max_lag_s=1.0)
print(f"  lip_sync no-perception -> {empty['status']}")
need(empty["status"] == "info", "absent perception must be an explicit info, never a silent pass")

# 4) compare_declared flags dialogue on the LFE, passes a clean layout.
declared = ["FL", "FR", "FC", "LFE"]
bad = {"channels": [{"index": 0, "content": "music"}, {"index": 1, "content": "music"},
                    {"index": 2, "content": "dialogue"}, {"index": 3, "content": "dialogue"}]}
cwarn = hybrid.reduce_to_check(hybrid.CHANNEL_SEMANTICS, bad, declared=declared)
print(f"  channel dialogue-on-LFE -> {cwarn['status']}: {cwarn['detail'][:56]}")
need(cwarn["status"] == "warn" and "LFE" in cwarn["detail"], "dialogue on LFE must WARN")
clean = {"channels": [{"index": 0, "content": "music"}, {"index": 1, "content": "music"},
                      {"index": 2, "content": "dialogue"}, {"index": 3, "content": "effects"}]}
cpass = hybrid.reduce_to_check(hybrid.CHANNEL_SEMANTICS, clean, declared=declared)
need(cpass["status"] == "pass", "a clean layout must pass")

# 5) layout_roles: known multichannel -> roles; stereo -> None (nothing to check).
need(hybrid.layout_roles("5.1", 6) == ["FL", "FR", "FC", "LFE", "BL", "BR"], "5.1 must map to roles")
need(hybrid.layout_roles("stereo", 2) is None, "stereo must be skipped (no role to violate)")

# 6) _audio_envelope honours rate= (real ffmpeg pass): ~ rate*seconds values.
env = qaudio._audio_envelope(f"{WORK}/am.wav", 0.0, 4.0, rate=RATE)
print(f"  _audio_envelope(rate=6) -> {len(env)} samples over 4 s")
need(15 <= len(env) <= 33 and all(math.isfinite(x) and x >= 0 for x in env),
     "rate= must resample the envelope to ~rate*seconds finite samples")

# 7) coverage: hybrid WARN -> SUSPECTED; hybrid PASS -> REVIEW_REQUIRED (never CLEAR).
meta = {"format": {"duration": 30.0}, "streams": [
    {"codec_type": "video", "width": 1920, "height": 1080},
    {"codec_type": "audio", "channels": 6, "channel_layout": "5.1"}]}
def status_of(rid, checks):
    cov = agentic.build_coverage(meta, "transfers/t/x.mxf", checks, None, "complete")
    return next(r for r in cov["risks"] if r["risk_id"] == rid)["status"]
for rid, name in [("lip_sync", "hybrid_lip_sync"), ("channel_assignment", "hybrid_channel_semantics")]:
    w = status_of(rid, [hybrid._hcheck(name, "warn", "flagged", "sync")])
    p = status_of(rid, [hybrid._hcheck(name, "pass", "clean", "sync")])
    print(f"  {rid:18s} hybrid WARN->{w}  PASS->{p}")
    need(w == "SUSPECTED", f"{rid}: a hybrid WARN must raise SUSPECTED")
    need(p != "CLEAR", f"{rid}: a hybrid PASS must NOT clear (partial/model_unreliable)")
    reg = next(r for r in agentic.RISK_REGISTRY if r["id"] == rid)
    need(name in reg["checks"] and reg.get("model_unreliable") is True,
         f"{rid} must list {name} and be model_unreliable")

print("PASS ✓  hybrid perceive-then-compute reducers + coverage wiring honest"
      if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF