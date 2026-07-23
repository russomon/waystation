"""Perceive-then-compute hybrid QC framework.

Principle, proven this session: a general multimodal model reliably PERCEIVES
(per-window descriptors — "how open is the mouth", "what is on this channel")
but CONFABULATES when asked to JUDGE timing/alignment/consistency directly (it
called a 1.7s lip-sync offset "in sync / high"). So every hybrid check pairs:

  1. an AI PERCEPTION step (a prompt returning a per-window numeric series or
     per-item labels — run by the worker, which owns the GMI call), and
  2. a DETERMINISTIC REDUCER that owns the decision:
       align            — cross-correlation offset between two signals
       compare_declared — perceived semantics vs declared metadata
       persistence      — consistency of a tag across the timeline

The model never decides; math does. This module is PURE: no GMI import, no
subprocess. The worker calls the model, hands the parsed JSON here, and this
returns a report check dict. qc/ therefore never depends on worker/.

Existing deterministic instances of the same pattern predate this framework:
`qc/audio.py:lip_sync_proxy` (audio-vs-motion align) and `qc/text.py:sync_check`
(caption cues vs speech align). Those use raw signals; hybrid checks swap in
AI-derived perception where raw signals cannot see (mouth openness, channel
semantics).
"""
from __future__ import annotations

import math
import os
import statistics
from dataclasses import dataclass, field

from .report import check


@dataclass
class HybridCheck:
    name: str
    risk_id: str
    category: str
    prompt: str
    output_kind: str          # "series" | "labels"
    reducer: str              # "align" | "compare_declared" | "persistence"
    flag_threshold_ms: float = 100.0
    meta: dict = field(default_factory=dict)


# ── reducers (pure) ──

def _pearson(xs: list, ys: list) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx < 1e-12 or syy < 1e-12:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy)


def align(a: list, b: list, rate_hz: float, max_lag_s: float,
          min_overlap: float = 0.6, peak_margin: float = 0.15) -> dict | None:
    """Cross-correlation offset with the fixes the gross-offset probe demanded:
    per-lag Pearson over ONLY the overlapping region (so short-overlap lags are
    not spuriously favored), skip lags with < min_overlap coverage, and require
    the best peak to beat the runner-up by peak_margin. If the peak is ambiguous
    (aliasing / too-short window) the result is marked unreliable — ABSTAIN
    rather than report a confidently-wrong offset. `offset_ms` positive => a
    leads b."""
    n = min(len(a), len(b))
    if n < 4:
        return None
    a, b = a[:n], b[:n]
    max_lag = max(1, int(max_lag_s * rate_hz))
    scored: list[tuple[int, float]] = []
    for lag in range(-max_lag, max_lag + 1):
        idx = [i for i in range(n) if 0 <= i - lag < n]
        if len(idx) < min_overlap * n:
            continue
        c = _pearson([a[i] for i in idx], [b[i - lag] for i in idx])
        if c is not None:
            scored.append((lag, c))
    if not scored:
        return None
    scored.sort(key=lambda r: r[1], reverse=True)
    best_lag, best_c = scored[0]
    # runner-up must be a genuinely different lag, not an adjacent bin
    runner = next((c for lg, c in scored[1:] if abs(lg - best_lag) > 1), -1.0)
    reliable = best_c > 0.35 and (best_c - runner) >= peak_margin
    return {"offset_ms": round(best_lag * 1000.0 / rate_hz, 1),
            "corr": round(best_c, 3), "margin": round(best_c - runner, 3),
            "reliable": bool(reliable)}


# What each declared channel role is expected to carry, and what must NOT
# appear there. Coarse but catches the classic delivery mistakes.
_CHANNEL_RULES = {
    "FL": {"ok": {"dialogue", "music", "effects"}, "forbid": set()},
    "FR": {"ok": {"dialogue", "music", "effects"}, "forbid": set()},
    "FC": {"expect": "dialogue", "forbid": set()},
    "LFE": {"ok": {"effects", "silence"}, "forbid": {"dialogue", "music"}},
    "BL": {"ok": {"music", "effects", "silence"}, "forbid": set()},
    "BR": {"ok": {"music", "effects", "silence"}, "forbid": set()},
    "SL": {"ok": {"music", "effects", "silence"}, "forbid": set()},
    "SR": {"ok": {"music", "effects", "silence"}, "forbid": set()},
}


# ffmpeg's canonical channel order for each `channel_layout` string that ffprobe
# reports. Used to turn a multichannel master into an ordered role list so
# per-channel perception can be checked against the declared layout. Only layouts
# with a role a mistake can land on (a center, an LFE) are worth checking.
CHANNEL_LAYOUTS = {
    "mono": ["FC"],
    "stereo": ["FL", "FR"],
    "3.0": ["FL", "FR", "FC"],
    "3.0(back)": ["FL", "FR", "BC"],
    "4.0": ["FL", "FR", "FC", "BC"],
    "quad": ["FL", "FR", "BL", "BR"],
    "5.0": ["FL", "FR", "FC", "BL", "BR"],
    "5.0(side)": ["FL", "FR", "FC", "SL", "SR"],
    "5.1": ["FL", "FR", "FC", "LFE", "BL", "BR"],
    "5.1(side)": ["FL", "FR", "FC", "LFE", "SL", "SR"],
    "6.1": ["FL", "FR", "FC", "LFE", "BC", "SL", "SR"],
    "7.1": ["FL", "FR", "FC", "LFE", "BL", "BR", "SL", "SR"],
    "7.1(wide-side)": ["FL", "FR", "FC", "LFE", "FLC", "FRC", "SL", "SR"],
}


def layout_roles(layout: str, n_channels: int) -> list | None:
    """Map an ffprobe `channel_layout` (e.g. '5.1(side)') to an ordered role
    list. Falls back to the count when the string is unknown but the channel
    count matches a canonical layout. Returns None when the layout has no
    role a delivery mistake can violate (mono/stereo → nothing to check)."""
    roles = CHANNEL_LAYOUTS.get((layout or "").strip().lower())
    if roles is None:
        roles = next((r for r in CHANNEL_LAYOUTS.values()
                      if len(r) == n_channels and ("FC" in r or "LFE" in r)), None)
    if not roles or len(roles) != n_channels or len(roles) < 3:
        return None
    return roles


def compare_declared(perceived: dict, declared: list) -> list:
    """perceived: {channel_index -> content_label}; declared: ordered channel
    role labels (e.g. ['FL','FR','FC','LFE','BL','BR']). Returns human-readable
    mismatch strings for clear violations (dialogue on LFE, no dialogue in the
    center of a multichannel mix, etc.)."""
    mism = []
    roles = {i: r for i, r in enumerate(declared)}
    for idx, label in perceived.items():
        role = roles.get(idx)
        if not role:
            continue
        rule = _CHANNEL_RULES.get(role.upper())
        if not rule:
            continue
        if label in rule.get("forbid", set()):
            mism.append(f"{role} channel carries {label} (should not)")
        expect = rule.get("expect")
        if expect and label not in {expect, "silence"}:
            mism.append(f"{role} channel carries {label}, expected {expect}")
    # center exists in a multichannel layout but no channel carries dialogue
    if len(declared) >= 5 and "dialogue" not in perceived.values():
        mism.append("no channel carries dialogue in a multichannel layout")
    return mism


def persistence(per_window: list, present_key: str = "present") -> dict:
    """per_window: list of {present: bool, ...}. A genuine channel bug/logo is
    consistent; an accidental leftover is intermittent. Returns fraction present
    and an 'intermittent' flag."""
    flags = [bool(w.get(present_key)) for w in per_window]
    if not flags:
        return {"fraction": 0.0, "intermittent": False, "n": 0}
    frac = sum(flags) / len(flags)
    return {"fraction": round(frac, 3), "n": len(flags),
            "intermittent": 0.15 < frac < 0.85}


# ── parsing (tolerant) ──

def parse_series(data: dict, value_key: str = "openness", t_key: str = "t") -> list:
    frames = (data or {}).get("frames") or []
    out = []
    for f in frames:
        if not isinstance(f, dict):
            continue
        try:
            out.append((float(f.get(t_key, len(out))), float(f.get(value_key))))
        except (TypeError, ValueError):
            continue
    out.sort(key=lambda p: p[0])
    return [v for _, v in out]


def parse_labels(data: dict, items_key: str = "channels") -> dict:
    items = (data or {}).get(items_key) or []
    labels = {}
    for it in items:
        if isinstance(it, dict) and "index" in it:
            try:
                labels[int(it["index"])] = str(it.get("content", "")).lower().strip()
            except (TypeError, ValueError):
                continue
    return labels


# ── orchestration: parsed model JSON + context -> report check ──

def _hcheck(name: str, status: str, detail: str, category: str) -> dict:
    """report.check() hardcodes source='deterministic'; stamp these as hybrid so
    coverage/UI attribute them to AI perception (worker overrides source the same
    way for ai_support/synthetic_ai checks)."""
    c = check(name, status, detail, category)
    c["source"] = "hybrid"
    return c


def reduce_to_check(spec: HybridCheck, data: dict, *, ref_signal: list | None = None,
                    rate_hz: float | None = None, max_lag_s: float | None = None,
                    declared: list | None = None) -> dict | None:
    if spec.output_kind == "series" and spec.reducer == "align":
        series = parse_series(data)
        if not series or not ref_signal:
            return _hcheck(spec.name, "info", "perception unavailable — hybrid alignment skipped",
                           spec.category)
        res = align(series, ref_signal, rate_hz or 25.0, max_lag_s or 1.0)
        if not res or not res["reliable"]:
            detail = ("no reliable A/V offset (ambiguous/low-correlation window; "
                      f"corr {res['corr'] if res else 'n/a'})")
            return _hcheck(spec.name, "info", detail, spec.category)
        off = res["offset_ms"]
        if abs(off) > spec.flag_threshold_ms:
            return _hcheck(spec.name, "warn",
                           f"measured ~{off:+.0f} ms A/V drift (perceptual: mouth-openness vs "
                           f"audio, corr {res['corr']}) — coarse proxy, confirm", spec.category)
        return _hcheck(spec.name, "pass",
                       f"~{off:+.0f} ms A/V offset (perceptual proxy, corr {res['corr']}) — in tolerance",
                       spec.category)

    if spec.output_kind == "labels" and spec.reducer == "compare_declared":
        labels = parse_labels(data)
        if not labels or not declared:
            return _hcheck(spec.name, "info", "channel content not perceivable — skipped",
                           spec.category)
        mism = compare_declared(labels, declared)
        summary = ", ".join(f"{declared[i] if i < len(declared) else i}={l}" for i, l in sorted(labels.items()))
        if mism:
            return _hcheck(spec.name, "warn", "channel-assignment concern: " + "; ".join(mism[:4])
                           + f" (perceived {summary})", spec.category)
        return _hcheck(spec.name, "pass", f"channel content consistent with declared layout ({summary})",
                       spec.category)
    return None


HYBRID_SOURCES = {"hybrid"}


# Concrete check specs (prompts live with the framework; the worker supplies
# evidence + context and calls the model).
LIPSYNC_RATE_HZ = int(os.environ.get("HYBRID_LIPSYNC_RATE", "6"))
LIPSYNC_MAX_LAG_S = float(os.environ.get("HYBRID_LIPSYNC_MAX_LAG", "1.0"))

MOUTH_OPENNESS = HybridCheck(
    name="hybrid_lip_sync", risk_id="lip_sync", category="sync",
    output_kind="series", reducer="align", flag_threshold_ms=120.0,
    prompt=(
        "You are a viseme analyzer. You are given {n} consecutive video frames of a "
        "face, in order, at {rate} frames per second (timecodes listed). Do NOT judge "
        "synchronization, timing, or quality — only describe what each frame shows. For "
        "EVERY frame report mouth openness: 0.00 = fully closed / lips a thin line, "
        "1.00 = maximally open. If no face or the mouth is not visible, use null. Return "
        'STRICT JSON only: {{"frames":[{{"t":<seconds>,"openness":<0..1 or null>}}]}} — '
        "exactly {n} entries, in order. No other text."),
)

CHANNEL_SEMANTICS = HybridCheck(
    name="hybrid_channel_semantics", risk_id="channel_assignment", category="audio",
    output_kind="labels", reducer="compare_declared",
    prompt=(
        "You are an audio QC operator. You are given {n} short audio clips, each the "
        "content of ONE numbered channel of a multichannel master. For EACH channel, "
        "classify the DOMINANT content as exactly one of: dialogue, music, effects, "
        "silence. Judge only what you hear; do not guess the layout. Return STRICT JSON "
        'only: {{"channels":[{{"index":<0-based>,"content":"<dialogue|music|effects|silence>"}}]}} '
        "— one entry per supplied channel. No other text."),
)
