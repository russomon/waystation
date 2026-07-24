"""Shared subprocess helpers for the QC modules. Every analyzer shells out to
ffmpeg/ffprobe with bounded windows so runtime stays flat on long masters."""
from __future__ import annotations

import json
import re
import subprocess


def run(cmd: list, timeout: int = 600, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)


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


def analysis_windows(duration: float, window: float = 20.0,
                     min_windows: int = 3, max_total: float = 240.0) -> list:
    """Tile short analysis windows across the WHOLE timeline instead of only the
    first N seconds. Short files are covered in one window; long masters get
    windows spread start→end, bounded so total analyzed seconds stays flat
    (~max_total). Returns [(start, length), …]."""
    duration = max(float(duration or 0), 0.0)
    if duration <= window or duration == 0:
        return [(0.0, duration or window)]
    max_windows = max(min_windows, int(max_total // window))
    n = min(max_windows, max(min_windows, int(round(duration / 120.0)) + 1))
    if n == 1:
        return [(max(0.0, duration / 2 - window / 2), window)]
    span = duration - window
    return [(round(span * i / (n - 1), 3), window) for i in range(n)]


def metadata_print_tiled(src: str, vf: str, duration: float, window: float = 20.0,
                         min_windows: int = 3, max_total: float = 240.0) -> tuple:
    """metadata_print run over analysis_windows and concatenated. Returns
    (lines, windows, analyzed_seconds) so callers can compute per-second rates
    over the true analyzed span rather than assuming one contiguous window."""
    windows = analysis_windows(duration, window, min_windows, max_total)
    lines: list = []
    analyzed = 0.0
    for start, length in windows:
        lines.extend(metadata_print(src, vf, length, start))
        analyzed += length
    return lines, windows, analyzed


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
