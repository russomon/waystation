"""Blind cross-family Jury — reproducibility measurement for AI findings.

A disagreement detector, never a truth oracle. The worker sends the SAME
evidence and the SAME perception prompt to a second model family, blind to the
primary's findings. The juror's raw observations are then run through the SAME
deterministic normalizer + reducer (reducer REPLAY), and the two structured
finding sets are matched on `match_key`. The verdict is therefore a statement
about the whole perceive-then-compute pipeline, not about prose similarity.

Verdicts (per primary finding):
  reproduced     — the blind juror's independent replay produced a finding with
                   the same match_key.
  contested      — it did not. The finding STAYS SUSPECTED; contested raises
                   review priority. Disagreement is information, not an eraser.
  single_source  — no juror ran (disabled/unavailable). Disclosed, never silent.

Agreement statistics (raw agreement, confusion matrix, Gwet's AC1) are
DIAGNOSTICS attached to the passport, not the verdict mechanism. AC1 is
preferred over Cohen's kappa because kappa is unstable when label prevalence
is imbalanced (common here: most tracked text does not mutate).

This module is PURE: no GMI import, no subprocess, no I/O.
"""
from __future__ import annotations

import math
import statistics

JURY_POLICY_VERSION = "waystation-jury-policy/1.0"


# ── verdicts via reducer replay ──

def _canon_key(match_key: dict) -> tuple:
    """Canonical, hashable form of a structured match_key."""
    return (
        str(match_key.get("kind", "")),
        str(match_key.get("risk_id", "")),
        str(match_key.get("track_key", "")),
        str(match_key.get("field", "")),
        str(match_key.get("shot_id", "")),
        tuple(str(e) for e in match_key.get("evidence_ids") or []),
    )


def replay_verdicts(primary_findings: list[dict], juror_findings: list[dict] | None,
                    juror_available: bool) -> list[dict]:
    """Match the juror's independently reduced findings against the primary's.

    juror_findings=None with juror_available=False → single_source for all.
    Juror-only findings (juror saw a concern the primary did not) are reported
    for the record — in production the jury runs only when a primary finding
    exists, so these are context, never new report findings."""
    if not juror_available:
        return [{"finding_id": f.get("finding_id"), "verdict": "single_source",
                 "review_priority": "normal"} for f in primary_findings]
    juror_keys = {_canon_key(f.get("match_key") or {}) for f in (juror_findings or [])}
    out = []
    for finding in primary_findings:
        key = _canon_key(finding.get("match_key") or {})
        reproduced = key in juror_keys
        out.append({
            "finding_id": finding.get("finding_id"),
            "verdict": "reproduced" if reproduced else "contested",
            # contested = the finding STAYS SUSPECTED and review priority RISES.
            "review_priority": "normal" if reproduced else "raised",
        })
    return out


def juror_only_keys(primary_findings: list[dict], juror_findings: list[dict]) -> list[dict]:
    """Concerns the juror's replay produced that the primary did not (context /
    offline-foundry measurement; labeled offline_juror_only_catch there)."""
    primary_keys = {_canon_key(f.get("match_key") or {}) for f in primary_findings}
    extras = []
    for finding in juror_findings:
        if _canon_key(finding.get("match_key") or {}) not in primary_keys:
            extras.append({"finding_id": finding.get("finding_id"),
                           "match_key": finding.get("match_key")})
    return extras


def juror_relation(primary_model: str, juror_model: str) -> str:
    """cross_family when the model families differ (e.g. google vs openai);
    same_family_cross_generation otherwise. Both ride the same GMI control
    plane, so this is reproducibility, never claimed as vendor independence."""
    fam = lambda m: (m or "").split("/", 1)[0].lower()
    if not primary_model or not juror_model:
        return "single_source"
    return ("cross_family" if fam(primary_model) != fam(juror_model)
            else "same_family_cross_generation")


# ── diagnostics: categorical agreement ──

def agree_labels(a: dict, b: dict) -> dict | None:
    """Agreement between two raters' labels over the same keyed items.
    a, b: {item_key -> label}. Only keys present in BOTH are compared.
    Returns raw agreement, confusion matrix, and Gwet's AC1."""
    keys = sorted(set(a) & set(b))
    if not keys:
        return None
    pairs = [(str(a[k]).casefold(), str(b[k]).casefold()) for k in keys]
    n = len(pairs)
    agree = sum(1 for x, y in pairs if x == y)
    labels = sorted({x for p in pairs for x in p})
    confusion = {la: {lb: 0 for lb in labels} for la in labels}
    for x, y in pairs:
        confusion[x][y] += 1
    # Gwet's AC1: pe = 1/(K-1) * Σ_k π_k(1-π_k), π_k = mean prevalence of k.
    po = agree / n
    if len(labels) < 2:
        ac1 = 1.0 if po == 1.0 else 0.0
    else:
        pe = sum((lambda pi: pi * (1 - pi))(
            (sum(1 for x, _ in pairs if x == lab) + sum(1 for _, y in pairs if y == lab)) / (2 * n))
            for lab in labels) / (len(labels) - 1)
        ac1 = (po - pe) / (1 - pe) if pe < 1.0 else 0.0
    return {"n": n, "raw_agreement": round(po, 3), "gwet_ac1": round(ac1, 3),
            "confusion": confusion}


# ── diagnostics: numeric-series agreement (unit-tested now; wired for the
#    later hybrid jury) ──

def agree_series(a: list, b: list, reduced_a: float | None = None,
                 reduced_b: float | None = None,
                 reliable_a: bool | None = None,
                 reliable_b: bool | None = None) -> dict | None:
    """Two jurors' per-window numeric perceptions of the same evidence.
    a, b: aligned lists, None where a juror could not observe. Correlation is
    computed z-normalized over the overlap; each juror's INDEPENDENTLY reduced
    value (e.g. offset_ms from its own align()) is compared by divergence."""
    n = max(len(a), len(b))
    if n == 0:
        return None
    a = list(a) + [None] * (n - len(a))
    b = list(b) + [None] * (n - len(b))
    missing_a = sum(1 for x in a if x is None) / n
    missing_b = sum(1 for x in b if x is None) / n
    overlap = [(float(x), float(y)) for x, y in zip(a, b) if x is not None and y is not None]
    z_corr = None
    if len(overlap) >= 4:
        xs, ys = [p[0] for p in overlap], [p[1] for p in overlap]
        sx, sy = statistics.pstdev(xs), statistics.pstdev(ys)
        if sx > 1e-12 and sy > 1e-12:
            mx, my = statistics.fmean(xs), statistics.fmean(ys)
            z_corr = round(sum((x - mx) / sx * (y - my) / sy for x, y in overlap) / len(overlap), 3)
    divergence = (round(abs(reduced_a - reduced_b), 3)
                  if reduced_a is not None and reduced_b is not None else None)
    return {"n": n, "overlap": len(overlap),
            "missing_rate_a": round(missing_a, 3), "missing_rate_b": round(missing_b, 3),
            "z_corr": z_corr, "reduced_a": reduced_a, "reduced_b": reduced_b,
            "reduced_divergence": divergence,
            "both_reliable": bool(reliable_a) and bool(reliable_b)
            if reliable_a is not None or reliable_b is not None else None}


# ── proficiency statistics ──

def wilson_interval(successes: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson score 95% CI for a proportion. Honest at the tiny n the Foundry
    starts with — always rendered next to the raw count, never instead of it."""
    if n <= 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round(max(0.0, center - half), 3), round(min(1.0, center + half), 3))


# ── passport assembly (pure) ──

def reproducibility_block(verdict: dict, primary_model: str, juror_model: str | None,
                          diagnostics: dict | None = None) -> dict:
    """The reproducibility section of one finding's reliability passport."""
    relation = juror_relation(primary_model, juror_model or "")
    return {
        "policy_version": JURY_POLICY_VERSION,
        "verdict": verdict["verdict"],
        "review_priority": verdict["review_priority"],
        "primary_model": primary_model,
        "juror_model": juror_model or None,
        # Honest relation: cross_family is the strong form; a same-family jury
        # (e.g. gemini-3.5 vs 3.6 when no other family has capacity) is
        # disclosed as such and never presented as vendor independence.
        "juror_relation": relation,
        **({"diagnostics": diagnostics} if diagnostics else {}),
    }
