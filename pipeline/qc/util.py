"""Shared subprocess helpers for the QC modules. Every analyzer shells out to
ffmpeg/ffprobe with bounded windows so runtime stays flat on long masters."""
from __future__ import annotations

import json
import re
import subprocess


def run(cmd: list, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def ffprobe_json(path: str, *extra: str) -> dict:
    out = run(["ffprobe", "-v", "quiet", "-print_format", "json",
               "-show_format", "-show_streams", *extra, path])
    return json.loads(out.stdout or "{}")


def parse_fraction(s: str) -> tuple:
    """'24000/1001' -> (24000, 1001); tolerant of junk."""
    m = re.match(r"(\d+)\s*/\s*(\d+)", s or "")
    return (int(m.group(1)), int(m.group(2))) if m and int(m.group(2)) else (0, 1)


def fps_value(s: str) -> float:
    n, d = parse_fraction(s)
    return n / d if d else 0.0


# Canonical frame-rate labels used by delivery specs ("23.976p", "29.97p"…).
_RATE_LABELS = {
    (24000, 1001): "23.976", (24, 1): "24", (25, 1): "25",
    (30000, 1001): "29.97", (30, 1): "30", (50, 1): "50",
    (60000, 1001): "59.94", (60, 1): "60", (48, 1): "48",
}


def fps_label(rate: str, interlaced: bool = False) -> str:
    n, d = parse_fraction(rate)
    base = _RATE_LABELS.get((n, d))
    if base is None:
        base = f"{n / d:.3f}".rstrip("0").rstrip(".") if d else "?"
    return base + ("i" if interlaced else "p")


def metadata_print(src: str, vf: str, seconds: float, offset: float = 0.0) -> list:
    """Run `-vf <vf>,metadata=print` over a bounded window; return the per-frame
    tag lines from stdout (`lavfi.<filter>.<KEY>=<value>`)."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats"]
    if offset > 0:
        cmd += ["-ss", f"{offset:.2f}"]
    cmd += ["-t", f"{seconds:.2f}", "-i", src,
            "-vf", vf + ",metadata=mode=print:file=-", "-f", "null", "-"]
    return [ln for ln in run(cmd).stdout.splitlines() if ln.startswith("lavfi.")]


def tag_values(lines: list, key: str) -> list:
    """Extract float values for one lavfi metadata key, in frame order."""
    vals = []
    prefix = key + "="
    for ln in lines:
        if ln.startswith(prefix):
            try:
                vals.append(float(ln[len(prefix):]))
            except ValueError:
                pass
    return vals
