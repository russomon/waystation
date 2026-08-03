"""Versioned, bounded poster-frame planning and GMI output validation."""
from __future__ import annotations

import hashlib
import json


SCHEMA_VERSION = "waystation-ai-poster-selection/1.0"
PROMPT_VERSION = "waystation-ai-poster-prompt/1.0"


def candidate_times(duration: float, scene_cuts: list[float] | None = None,
                    maximum: int = 6) -> list[float]:
    """Return bounded timeline anchors enriched by post-cut representatives."""
    if duration <= 0 or maximum <= 0:
        return []
    edge = min(0.25, duration / 10)
    anchors = [edge + max(duration - 2 * edge, 0) * fraction
               for fraction in (0.08, 0.25, 0.45, 0.65, 0.82)]
    cut_frames = [min(max(float(value) + 0.2, edge), max(duration - edge, edge))
                  for value in (scene_cuts or [])]
    values = sorted(max(0.0, min(value, max(duration - 0.05, 0.0)))
                    for value in anchors + cut_frames)
    deduped: list[float] = []
    for value in values:
        if not deduped or value - deduped[-1] >= 0.4:
            deduped.append(value)
    if len(deduped) > maximum:
        indexes = [round(i * (len(deduped) - 1) / max(maximum - 1, 1))
                   for i in range(maximum)]
        deduped = [deduped[index] for index in indexes]
    return [round(value, 3) for value in deduped]


def build_prompt(candidates: list[dict]) -> tuple[str, str]:
    catalog = [{key: item.get(key) for key in
                ("candidate_id", "time_seconds", "sha256", "width")}
               for item in candidates]
    prompt = (
        f"Waystation poster selector {PROMPT_VERSION}. Select exactly one supplied frame as the "
        "recipient preview. Choose a representative, sharp, well-exposed frame with a clear subject "
        "and strong composition. Avoid black, bars, slates, credits, transition frames, motion blur, "
        "awkward expressions, and frames dominated by captions or titles. Never invent an ID, edit "
        "an image, or request another frame. Return strict JSON only, without Markdown or prose, as "
        "{\"selected_candidate_id\":\"poster-candidate-01\",\"reason\":\"...\","
        "\"confidence\":0.0}. Keep reason under 180 characters.\n"
        f"ALLOWLISTED CANDIDATES: {json.dumps(catalog, sort_keys=True)}"
    )
    return prompt, hashlib.sha256(prompt.encode()).hexdigest()


def sanitize_selection(payload: dict | None, candidates: list[dict]) -> dict | None:
    if not isinstance(payload, dict):
        return None
    allowed = {item["candidate_id"] for item in candidates}
    selected = str(payload.get("selected_candidate_id") or "")
    if selected not in allowed:
        return None
    try:
        confidence = min(1.0, max(0.0, float(payload.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "selected_candidate_id": selected,
        "reason": str(payload.get("reason") or "AI selected this representative frame.")[:180],
        "confidence": confidence,
    }


def deterministic_fallback(candidates: list[dict]) -> dict:
    """Prefer a detailed central frame when AI is unavailable or malformed."""
    if not candidates:
        raise ValueError("poster selection has no candidates")
    central = candidates[1:-1] or candidates
    selected = max(central, key=lambda item: (int(item.get("size_bytes") or 0),
                                              -float(item.get("time_seconds") or 0)))
    return {
        "selected_candidate_id": selected["candidate_id"],
        "reason": "AI unavailable or invalid; selected the most detailed central candidate.",
        "confidence": 0.0,
    }
