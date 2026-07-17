"""Task 4 — Captions, Subtitles & Text Engine.
Canonical SRT/VTT parsing (moved here from worker.py), timing/collision
matrix, CPS + WPM density, encoding and markup validation, and a
speech-alignment analyzer that estimates sync drift by sliding the cue
timeline against detected speech activity."""
from __future__ import annotations

import os
import re
import subprocess

from .report import check
from .util import run

# SRT/VTT cue: optional hours, comma (SRT) or dot (VTT) millisecond separator.
_CUE_TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})"
_CUE_RE = re.compile(_CUE_TS + r"\s*-->\s*" + _CUE_TS)
_MARKUP_RE = re.compile(r"<font\b|{\\an?\d|&#\d+;|<\s*/?\s*(?:b|i|u|ruby|c\.[\w.]+)\s*>", re.I)


def _ts_seconds(h, m, s, ms) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_caption_cues(text: str) -> list:
    """Tolerant SRT/WebVTT parser → [(start_s, end_s, cue_text), …]."""
    cues = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = _CUE_RE.search(lines[i])
        if m:
            start = _ts_seconds(*m.groups()[0:4])
            end = _ts_seconds(*m.groups()[4:8])
            body = []
            i += 1
            while i < len(lines) and lines[i].strip():
                body.append(lines[i].strip())
                i += 1
            cues.append((start, end, "\n".join(body)))
        i += 1
    return cues


def load_caption_cues(src: str, captions_path: str | None, tmp: str) -> list:
    """Cues from the sidecar if present, else the first embedded text track."""
    text = load_caption_text(src, captions_path, tmp)
    return parse_caption_cues(text) if text else []


def load_caption_text(src: str, captions_path: str | None, tmp: str) -> str | None:
    if captions_path:
        with open(captions_path, encoding="utf-8", errors="replace") as f:
            return f.read()
    extracted = os.path.join(tmp, "embedded_captions.srt")
    r = subprocess.run(["ffmpeg", "-y", "-i", src, "-map", "0:s:0", "-c:s", "srt", extracted],
                       capture_output=True)
    if r.returncode == 0 and os.path.exists(extracted):
        with open(extracted, encoding="utf-8", errors="replace") as f:
            return f.read()
    return None


def caption_checks(cues: list, duration: float, source: str) -> list:
    """Deterministic caption QC: timing/collision matrix, readability limits,
    coverage. Thresholds follow common broadcast subtitle specs (~20 CPS,
    42 chars/line, max 2 lines per cue)."""
    checks = []
    n = len(cues)
    if n == 0:
        return [check("captions_valid", "warn", f"{source}: no cues could be parsed", "text")]
    checks.append(check("captions_valid", "pass", f"{source}: {n} cue(s) parsed", "text"))

    overlaps = sum(1 for i in range(1, n) if cues[i][0] < cues[i - 1][1])
    out_of_order = sum(1 for i in range(1, n) if cues[i][0] < cues[i - 1][0])
    past_eof = sum(1 for c in cues if duration and c[1] > duration + 1.0)
    rapid = sum(1 for i in range(1, n) if 0 <= cues[i][0] - cues[i - 1][1] < 0.083)
    timing_issues = overlaps + out_of_order + past_eof
    checks.append(check("caption_timing", "pass" if timing_issues == 0 else "warn",
                        f"{overlaps} overlap(s), {past_eof} past end-of-video, "
                        f"{out_of_order} out-of-order, {rapid} rapid transition(s) <2 frames", "text"))

    cps_viol = line_viol = 0
    for (st, en, txt) in cues:
        dur = max(en - st, 0.001)
        if len(txt.replace("\n", "")) / dur > 20.0:
            cps_viol += 1
        cue_lines = txt.split("\n")
        if len(cue_lines) > 2 or any(len(ln) > 42 for ln in cue_lines):
            line_viol += 1
    checks.append(check("caption_readability", "pass" if cps_viol + line_viol == 0 else "warn",
                        f"{cps_viol} cue(s) over 20 CPS, {line_viol} cue(s) over line limits", "text"))

    words = sum(len(txt.split()) for _, _, txt in cues)
    cue_minutes = sum(en - st for st, en, _ in cues) / 60.0
    wpm = round(words / cue_minutes) if cue_minutes > 0 else 0
    checks.append(check("caption_density", "info", f"{words} words, ~{wpm} WPM over cue time", "text"))

    covered = sum(max(min(en, duration or en) - st, 0) for st, en, _ in cues)
    pct = f", {round(100 * covered / duration, 1)}% of runtime covered" if duration else ""
    checks.append(check("caption_coverage", "pass", f"{n} cue(s){pct}", "text"))
    return checks


def text_integrity_checks(raw_text: str) -> list:
    """Encoding (mojibake / replacement chars) + illegal markup tags."""
    checks = []
    bad_chars = raw_text.count("�")
    checks.append(check("caption_encoding", "pass" if bad_chars == 0 else "warn",
                        "clean UTF-8" if bad_chars == 0
                        else f"{bad_chars} broken character(s) (encoding damage)", "text"))
    tags = _MARKUP_RE.findall(raw_text)
    checks.append(check("caption_markup", "pass" if not tags else "warn",
                        "no illegal markup" if not tags
                        else f"{len(tags)} styling/font tag(s) found (first: {tags[0]!r})", "text"))
    return checks


def sync_check(src: str, cues: list, duration: float) -> list:
    """Alignment analyzer: build speech-activity intervals from silencedetect,
    then slide the cue timeline ±2 s to find the offset that best overlaps
    speech. Reports estimated drift; poor best-case overlap flags misalignment."""
    if len(cues) < 2 or not duration:
        return []
    log = run(["ffmpeg", "-hide_banner", "-i", src, "-map", "0:a:0",
               "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"]).stderr
    starts = [float(x) for x in re.findall(r"silence_start:\s*([\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([\d.]+)", log)]
    # invert silences → speech intervals
    speech, cursor = [], 0.0
    for s, e in zip(starts, ends):
        if s > cursor:
            speech.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < duration:
        speech.append((cursor, duration))
    if not speech:
        return [check("caption_sync", "warn", "no speech activity detected but captions present", "text")]

    def overlap(shift: float) -> float:
        total = got = 0.0
        for st, en, _ in cues:
            total += en - st
            for a, b in speech:
                got += max(0.0, min(en + shift, b) - max(st + shift, a))
        return got / total if total else 0.0

    best_shift, best = 0.0, overlap(0.0)
    for ms in range(-2000, 2001, 100):
        o = overlap(ms / 1000.0)
        if o > best + 1e-9:
            best, best_shift = o, ms / 1000.0
    drift_ms = int(best_shift * 1000)
    if best < 0.5:
        return [check("caption_sync", "warn",
                      f"cues overlap speech only {best:.0%} even at best alignment", "text")]
    if abs(drift_ms) > 500 and best > overlap(0.0) + 0.10:
        return [check("caption_sync", "warn",
                      f"estimated sync drift ~{drift_ms:+d} ms (overlap {overlap(0.0):.0%} → {best:.0%} when shifted)",
                      "text")]
    return [check("caption_sync", "pass",
                  f"{overlap(0.0):.0%} of cue time overlaps speech activity (drift < 500 ms)", "text")]
