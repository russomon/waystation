"""Task 3 — Audio Analysis Engine.
ITU-R BS.1770-4 loudness (integrated LKFS/LUFS, max short-term, LRA, max true
peak via ebur128 peak=true), inter-channel phase correlation, digital clipping,
hum band-energy screening, and channel-mapping verification."""
from __future__ import annotations

import math
import re
import statistics

from .report import check, violation
from .util import run, tag_values


# Lip-sync PROXY (registry risk `lip_sync`). Two coarse, deterministic signals:
#   1. container A/V start-time offset (catches gross mux misalignment)
#   2. cross-correlation of the audio-energy envelope against the visual-motion
#      envelope, both resampled to a common rate, to estimate global A/V drift.
# This is NOT true lip sync — it compares whole-frame motion to whole-mix
# energy, not mouth shapes to phonemes — so a pass never CLEARs the risk; it
# only flags when a confident, sizeable offset is measured. Bounded to a window.
LIPSYNC_RATE_HZ = 25
LIPSYNC_MAX_LAG_S = 0.6
LIPSYNC_MIN_CORR = 0.35
LIPSYNC_FLAG_MS = 120.0


def _audio_envelope(src: str, offset: float, window: float, rate: int = LIPSYNC_RATE_HZ) -> list:
    """Audio-energy envelope (linear RMS) resampled to `rate` Hz over a window.
    The default 25 Hz feeds the deterministic proxy; the hybrid lip-sync lane
    passes a lower `rate` so the envelope aligns 1:1 with per-frame perception."""
    log = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{offset:.2f}", "-t", f"{window:.2f}",
               "-i", src, "-map", "0:a:0",
               "-af", f"aresample=8000,asetnsamples={max(1, 8000 // rate)}:p=0,"
                      "astats=metadata=1:reset=1,ametadata=mode=print:file=-",
               "-f", "null", "-"]).stdout
    out = []
    for v in tag_values(log.splitlines(), "lavfi.astats.Overall.RMS_level"):
        out.append(0.0 if math.isinf(v) or math.isnan(v) else 10 ** (v / 20.0))  # dB → linear
    return out


def _motion_envelope(src: str, offset: float, window: float) -> list:
    log = run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{offset:.2f}", "-t", f"{window:.2f}",
               "-i", src, "-map", "0:v:0",
               "-vf", f"fps={LIPSYNC_RATE_HZ},signalstats,metadata=mode=print:file=-",
               "-an", "-f", "null", "-"]).stdout
    return [v for v in tag_values(log.splitlines(), "lavfi.signalstats.YDIF")]


def _normalize(series: list) -> list:
    if len(series) < 4:
        return []
    mean = statistics.fmean(series)
    centered = [x - mean for x in series]
    norm = math.sqrt(sum(x * x for x in centered))
    return [x / norm for x in centered] if norm > 1e-9 else []


def _best_lag(a: list, b: list, max_lag: int) -> tuple:
    """Return (lag_samples, correlation) maximizing correlation of a vs b, where
    a positive lag means series a is delayed relative to b."""
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    best_lag, best_corr = 0, -2.0
    for lag in range(-max_lag, max_lag + 1):
        s = 0.0
        for i in range(n):
            j = i - lag
            if 0 <= j < n:
                s += a[i] * b[j]
        if s > best_corr:
            best_corr, best_lag = s, lag
    return best_lag, best_corr


def lip_sync_proxy(src: str, meta: dict, duration: float) -> list:
    streams = meta.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v or not a:
        return []
    checks = []

    # 1) container A/V start-time offset
    def start_of(s):
        try:
            return float(s.get("start_time"))
        except (TypeError, ValueError):
            return None
    vs, as_ = start_of(v), start_of(a)
    if vs is not None and as_ is not None:
        off_ms = round((as_ - vs) * 1000.0, 1)
        if abs(off_ms) > 100:
            checks.append(check("lip_sync_container_offset", "warn",
                                f"audio stream starts {off_ms:+.0f} ms vs video in the container — "
                                f"A/V misalignment likely", "audio"))
        else:
            checks.append(check("lip_sync_container_offset", "pass",
                                f"container A/V start offset {off_ms:+.0f} ms", "audio"))

    # 2) envelope cross-correlation drift estimate over a bounded window
    off = min(duration * 0.25, 10.0)
    window = min(30.0, max(duration - off, 2.0))
    audio_env = _normalize(_audio_envelope(src, off, window))
    motion_env = _normalize(_motion_envelope(src, off, window))
    if len(audio_env) >= LIPSYNC_RATE_HZ and len(motion_env) >= LIPSYNC_RATE_HZ:
        max_lag = int(LIPSYNC_MAX_LAG_S * LIPSYNC_RATE_HZ)
        lag, corr = _best_lag(audio_env, motion_env, max_lag)
        drift_ms = round(lag * 1000.0 / LIPSYNC_RATE_HZ, 1)
        if corr >= LIPSYNC_MIN_CORR and abs(drift_ms) >= LIPSYNC_FLAG_MS:
            checks.append(check("lip_sync_drift_proxy", "warn",
                                f"estimated A/V drift ~{drift_ms:+.0f} ms (audio vs motion envelope, "
                                f"corr {corr:.2f}) — proxy, confirm with speech-bearing review", "audio"))
        else:
            basis = (f"drift ~{drift_ms:+.0f} ms, corr {corr:.2f}"
                     if corr >= LIPSYNC_MIN_CORR else f"no reliable A/V correlation (corr {corr:.2f})")
            checks.append(check("lip_sync_drift_proxy", "info",
                                f"A/V envelope proxy: {basis} over a {window:.0f}s window "
                                f"(coarse; not certified lip sync)", "audio"))
    return checks


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
