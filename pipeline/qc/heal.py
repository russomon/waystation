"""Task 6 — Automated Correction Engines (Self-Healing).
- Audio: two-pass loudnorm to the profile target (measured first pass →
  linear second pass), video stream copied — no picture re-render.
- Video: luma/chroma limiter clamps out-of-spec values back inside legal
  R103-style bounds (this one necessarily re-encodes the picture).
The healed file is re-measured with the SAME instruments that failed it, so
the fix is proven, not assumed."""
from __future__ import annotations

import json
import os
import re

from .audio import measure_loudness
from .util import run


def _loudnorm_measure(src: str, target_i: float, target_tp: float) -> dict | None:
    log = run(["ffmpeg", "-hide_banner", "-i", src, "-map", "0:a:0",
               "-af", f"loudnorm=I={target_i}:TP={target_tp}:LRA=11:print_format=json",
               "-f", "null", "-"]).stderr
    m = re.search(r"\{[^{}]*\}\s*$", log, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


def heal(src: str, tmp: str, fix_audio: bool, fix_video: bool,
         target_i: float, target_tp: float, bit_depth: int = 8) -> dict | None:
    """Produce a healed copy. Returns {path, applied, detail, after} or None."""
    if not (fix_audio or fix_video):
        return None
    out = os.path.join(tmp, "healed.mp4")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-i", src]
    applied = []

    if fix_video:
        s = 1 << (bit_depth - 8)
        cmd += ["-vf", f"limiter=min={16 * s}:max={235 * s}:planes=1,"
                       f"limiter=min={16 * s}:max={240 * s}:planes=6",
                "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
        applied.append("video legalizer (luma 16-235, chroma 16-240)")
    else:
        cmd += ["-c:v", "copy"]

    if fix_audio:
        measured = _loudnorm_measure(src, target_i, target_tp)
        af = f"loudnorm=I={target_i}:TP={target_tp}:LRA=11"
        if measured:
            af += (f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
                   f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
                   f":linear=true")
        cmd += ["-af", af, "-c:a", "aac", "-b:a", "256k"]
        applied.append(f"loudness normalize → {target_i} LUFS / TP {target_tp} dBTP")
    else:
        cmd += ["-c:a", "copy"]

    r = run(cmd + [out], timeout=1800)
    if r.returncode != 0 or not os.path.exists(out):
        return None

    after = measure_loudness(out) if fix_audio else {}
    return {"path": out, "applied": applied, "after": after,
            "detail": "; ".join(applied)}
