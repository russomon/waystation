"""Audio-visual sync via a purpose-built SyncNet model (optional analyzer).

Waystation's charter forbids over-claiming: a general VLM was empirically shown
to confabulate lip-sync verdicts (see DECISIONS.md, 2026-07-23), so true
audio-to-picture sync is measured with a dedicated AV-sync model —
joonson/syncnet_python ("Out of time: automated lip sync in the wild"), which
detects/tracks faces and reports an AV offset (in 25 fps frames) plus a
confidence per face track.

Like Photon (a JVM tool) and MediaInfo, this is an OPTIONAL external analyzer:
it needs torch + pretrained weights, so it lives outside the base worker and is
activated with `scripts/fetch-syncnet.sh`. When it is not installed, Waystation
emits an explicit FYI rather than silently passing — the `lip_sync` risk stays
disclosed, never falsely cleared.

Env:
  SYNCNET_DIR     path to the syncnet_python checkout (with weights + run_*.py)
  SYNCNET_PYTHON  python interpreter that has the SyncNet deps
                  (default: $SYNCNET_DIR/.venv/bin/python)
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile

from .report import check, violation
from .util import run

SYNCNET_FPS = 25          # SyncNet standardizes video to 25 fps → 40 ms per frame
MS_PER_FRAME = 1000.0 / SYNCNET_FPS
FLAG_OFFSET_MS = float(os.environ.get("AVSYNC_FLAG_MS", "60"))     # ~1.5 frames
MIN_CONFIDENCE = float(os.environ.get("AVSYNC_MIN_CONFIDENCE", "3.0"))


def _resolve() -> tuple[str, str] | None:
    d = os.environ.get("SYNCNET_DIR")
    if not d or not os.path.isdir(d):
        return None
    py = os.environ.get("SYNCNET_PYTHON") or os.path.join(d, ".venv", "bin", "python")
    if not os.path.exists(py):
        py = shutil.which("python3") or ""
    if not py or not os.path.exists(os.path.join(d, "run_syncnet.py")):
        return None
    return d, py


def _parse_tracks(stdout: str) -> list[dict]:
    """Parse per-track 'AV offset: N', 'Min dist: X', 'Confidence: Y' triples."""
    offsets = [int(x) for x in re.findall(r"AV offset:\s*(-?\d+)", stdout)]
    dists = [float(x) for x in re.findall(r"Min dist:\s*([\d.]+)", stdout)]
    confs = [float(x) for x in re.findall(r"Confidence:\s*([\d.]+)", stdout)]
    tracks = []
    for i, off in enumerate(offsets):
        tracks.append({"offset_frames": off,
                       "offset_ms": round(off * MS_PER_FRAME, 1),
                       "min_dist": dists[i] if i < len(dists) else None,
                       "confidence": confs[i] if i < len(confs) else 0.0})
    return tracks


def checks(src: str, meta: dict) -> list:
    streams = meta.get("streams", [])
    has_video = any(s.get("codec_type") == "video" for s in streams)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    if not (has_video and has_audio):
        return []

    resolved = _resolve()
    if not resolved:
        return [check("avsync_offset", "info",
                      "AV-sync model unavailable (SyncNet not installed) — measured lip-sync "
                      "skipped; run scripts/fetch-syncnet.sh to enable", "sync")]
    syncnet_dir, py = resolved

    with tempfile.TemporaryDirectory() as work:
        ref = "waystation"
        # 1) face detection + tracking
        p1 = run([py, "run_pipeline.py", "--videofile", os.path.abspath(src),
                  "--reference", ref, "--data_dir", work], timeout=1800)
        # 2) SyncNet on the tracked faces → offset + confidence on stdout
        p2 = run([py, "run_syncnet.py", "--videofile", os.path.abspath(src),
                  "--reference", ref, "--data_dir", work], timeout=1800)
    out = (p1.stdout or "") + (p2.stdout or "") + (p2.stderr or "")

    tracks = _parse_tracks(out)
    if not tracks:
        lowered = out.lower()
        reason = ("no speaking face track detected" if "0 tracks" in lowered or "no face" in lowered
                  else "SyncNet produced no offset (see worker log)")
        return [check("avsync_offset", "info",
                      f"AV-sync model ran but found nothing to measure: {reason}", "sync")]

    # Representative = the highest-confidence face track.
    best = max(tracks, key=lambda t: t["confidence"])
    n = len(tracks)
    where = f" (best of {n} face track(s))" if n > 1 else ""
    if best["confidence"] < MIN_CONFIDENCE:
        return [check("avsync_offset", "info",
                      f"AV-sync measured but low confidence ({best['confidence']:.1f}); offset "
                      f"{best['offset_ms']:+.0f} ms — inconclusive{where}", "sync")]
    if abs(best["offset_ms"]) > FLAG_OFFSET_MS:
        return [check("avsync_offset", "warn",
                      f"measured A/V offset {best['offset_ms']:+.0f} ms "
                      f"({best['offset_frames']:+d} @25fps, confidence {best['confidence']:.1f}) "
                      f"— lip sync out of tolerance{where}", "sync")]
    return [check("avsync_offset", "pass",
                  f"measured A/V offset {best['offset_ms']:+.0f} ms "
                  f"(confidence {best['confidence']:.1f}) — within lip-sync tolerance{where}", "sync")]
