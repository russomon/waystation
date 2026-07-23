"""Task 3 — Audio Analysis Engine.
ITU-R BS.1770-4 loudness (integrated LKFS/LUFS, max short-term, LRA, max true
peak via ebur128 peak=true), inter-channel phase correlation, digital clipping,
hum band-energy screening, and channel-mapping verification."""
from __future__ import annotations

import re
import statistics

from .report import check, violation
from .util import run


def measure_loudness(src: str) -> dict:
    """One ebur128 pass -> {i, lra, tp, s_max}."""
    log = run(["ffmpeg", "-hide_banner", "-i", src, "-map", "0:a:0",
               "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr
    def grab(pattern):
        m = re.findall(pattern, log)
        return float(m[-1]) if m else None
    s_vals = [float(x) for x in re.findall(r"S:\s*(-?[\d.]+)", log)]
    return {
        "i": grab(r"I:\s*(-?[\d.]+) LUFS"),
        "lra": grab(r"LRA:\s*(-?[\d.]+) LU"),
        "tp": grab(r"Peak:\s*(-?[\d.]+) dBFS"),
        "s_max": max(s_vals) if s_vals else None,
    }


def loudness_checks(src: str, profile: dict) -> list:
    m = measure_loudness(src)
    checks = []
    lp, tp_p = profile["loudness"], profile["true_peak"]
    if m["i"] is None:
        return [check("loudness", "warn", "could not measure", "audio")]

    if lp["target"] is not None:                    # strict: target ± tolerance
        drift = abs(m["i"] - lp["target"])
        if drift > lp["tolerance"]:
            checks.append(violation("loudness", lp["escalate"],
                                    f"integrated {m['i']} LKFS vs target {lp['target']} ±{lp['tolerance']} "
                                    f"(off by {drift:.1f} LU)", "audio"))
        else:
            checks.append(check("loudness", "pass",
                                f"integrated {m['i']} LKFS (target {lp['target']} ±{lp['tolerance']})", "audio"))
    else:                                           # standard: broad range
        ok = lp["min"] <= m["i"] <= lp["max"]
        checks.append(check("loudness", "pass" if ok else "warn",
                            f"integrated {m['i']} LUFS (broadcast target ~ -23)", "audio"))

    if m["tp"] is not None:
        if tp_p["max"] is not None and m["tp"] > tp_p["max"]:
            checks.append(violation("true_peak", tp_p["escalate"],
                                    f"max true peak {m['tp']} dBTP breaches {tp_p['max']} dBTP", "audio"))
        else:
            limit = f" (limit {tp_p['max']} dBTP)" if tp_p["max"] is not None else ""
            checks.append(check("true_peak", "pass" if tp_p["max"] is not None else "info",
                                f"max true peak {m['tp']} dBTP{limit}", "audio"))
    if m["lra"] is not None:
        checks.append(check("loudness_range", "info", f"LRA {m['lra']} LU", "audio"))
    if m["s_max"] is not None:
        checks.append(check("short_term_loudness", "info", f"max short-term {m['s_max']} LUFS", "audio"))
    return checks


def phase_check(src: str, meta: dict) -> list:
    """Inter-channel phase correlation — components near -1 cancel in a mono
    mixdown. Needs >= 2 channels."""
    a = next((s for s in meta.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not a or int(a.get("channels", 0) or 0) < 2:
        return []
    out = run(["ffprobe", "-v", "error", "-f", "lavfi",
               "-i", f"amovie='{src}',aphasemeter=video=0",
               "-show_entries", "frame_tags=lavfi.aphasemeter.phase", "-of", "csv=p=0",
               "-read_intervals", "%+30"])
    vals = [float(v) for v in out.stdout.split() if v and v != "N/A"][:3000]
    if not vals:
        return []
    mean = statistics.fmean(vals)
    return [check("audio_phase", "pass" if mean > -0.2 else "warn",
                  f"mean inter-channel phase correlation {mean:+.2f}"
                  + ("" if mean > -0.2 else " — mono-mixdown cancellation risk"), "audio")]


def clipping_and_hum(src: str) -> list:
    """astats-based clipping monitor + 50/60 Hz hum band-energy screen."""
    checks = []
    log = run(["ffmpeg", "-hide_banner", "-i", src, "-map", "0:a:0",
               "-af", "astats=metadata=0", "-f", "null", "-"]).stderr
    overall = log[log.rfind("Overall"):] if "Overall" in log else log
    peak = re.search(r"Peak level dB:\s*(-?[\d.]+|inf)", overall)
    flat = re.search(r"Flat factor:\s*([\d.]+)", overall)
    peak_db = float(peak.group(1)) if peak and peak.group(1) != "inf" else 0.0
    flat_f = float(flat.group(1)) if flat else 0.0
    if peak_db > -0.05 and flat_f > 2.0:
        checks.append(check("audio_clipping", "warn",
                            f"digital clipping: peak {peak_db} dBFS with flat factor {flat_f}", "audio"))
    else:
        checks.append(check("audio_clipping", "pass",
                            f"peak {peak_db} dBFS, flat factor {flat_f}", "audio"))

    hum_log = run(["ffmpeg", "-hide_banner", "-t", "60", "-i", src, "-map", "0:a:0",
                   "-af", "highpass=f=40,lowpass=f=70,astats=metadata=0", "-f", "null", "-"]).stderr
    hum_sect = hum_log[hum_log.rfind("Overall"):] if "Overall" in hum_log else hum_log
    band = re.search(r"RMS level dB:\s*(-?[\d.]+)", hum_sect)
    full = re.search(r"RMS level dB:\s*(-?[\d.]+)", overall)
    if band and full:
        b, f = float(band.group(1)), float(full.group(1))
        if b > f - 10:            # mains band carries nearly all the energy
            checks.append(check("audio_hum", "warn",
                                f"50/60 Hz band RMS {b} dB vs programme {f} dB — mains hum suspected", "audio"))
        else:
            checks.append(check("audio_hum", "pass", f"mains band {b - f:+.1f} dB relative to programme", "audio"))
    return checks


_EXPECTED_LAYOUTS = {1: "mono", 2: "stereo (L/R)", 6: "5.1 (L/R/C/LFE/Ls/Rs)", 8: "7.1"}


def channel_map_check(meta: dict) -> list:
    """Channel-mapping verification against the explicit configurations."""
    a = next((s for s in meta.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not a:
        return []
    ch = int(a.get("channels", 0) or 0)
    layout = a.get("channel_layout", "") or "undeclared"
    expected = _EXPECTED_LAYOUTS.get(ch)
    if expected:
        return [check("channel_map", "pass", f"{ch}ch, layout {layout} — matches {expected}", "audio")]
    return [check("channel_map", "warn",
                  f"{ch}ch, layout {layout} — not a standard delivery configuration", "audio")]
