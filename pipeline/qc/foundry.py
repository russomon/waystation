"""Proficiency Foundry — blind planted-defect testing for the AI QC lanes.

Not "calibration": a small synthetic challenge suite cannot establish
statistical representativeness. It is a PROFICIENCY TEST — the same idea as a
lab's blind proficiency samples: manufacture media with ONE precisely measured
defect (plus an untouched clean twin), hide the ground truth from the models,
run the EXACT production configuration, and score detection deterministically.
Results ship in an immutable proficiency manifest (WORM in B2) that binds the
numbers to the exact configuration that earned them; any config change makes a
lane UNCALIBRATED until rerun. At the starting n the numbers are labeled
PROVISIONAL and always rendered with Wilson intervals, never as a mature rate.

Three systems are measured separately (an honest split — under finding-only
jurying the juror cannot rescue a primary miss in production):
  primary  — standalone sensitivity/specificity
  juror    — standalone sensitivity/specificity, offline over every asset
             (a juror-only catch is `offline_juror_only_catch`, context only)
  pair     — the DEPLOYED policy, conditional on a primary finding:
             reproduced/contested on plants, reproduced/contested on twin
             false positives, jury-unavailable rate

This module is PURE: specs, randomization plans, scoring, aggregation, and
manifest assembly. Rendering (ffmpeg/Pillow) lives in foundry_render.py; model
calls live in the worker/runner.
"""
from __future__ import annotations

import hashlib
import json
import random
from typing import Any

from .jury import wilson_interval

SUITE_VERSION = "waystation-proficiency-suite/1.0"
MANIFEST_VERSION = "waystation-proficiency-manifest/1.0"

# Real words for plants (twins keep them intact). Mutations must remain
# visually plausible: glyph confusions, a dropped letter, adjacent swap.
_WORDS = ["OPEN", "SALE", "EXIT", "GATE 7", "FRESH COFFEE", "STATION",
          "WELCOME", "DANGER", "TICKETS", "ARRIVALS"]
_GLYPH_SWAPS = [("O", "0"), ("I", "1"), ("E", "3"), ("S", "5"), ("A", "4")]

CLASSES = {
    "rendered_text_mutation": {
        "label": "Rendered-text mutation (AI proficiency)",
        "kind": "ai",
        "finding_kind": "text_mutation",
        "lane": "generated_typography",
    },
    # Control classes prove the SCORING MACHINERY only — they are measured by
    # deterministic instruments and say nothing about AI reliability.
    "loudness_delta_lu": {
        "label": "Integrated-loudness delta (control: scoring machinery)",
        "kind": "control",
        "finding_kind": "loudness",
        "lane": "deterministic_audio",
    },
    "bad_framerate": {
        "label": "Non-allowed frame rate (control: scoring machinery)",
        "kind": "control",
        "finding_kind": "framerate",
        "lane": "deterministic_structural",
    },
}


def _mutate(word: str, rng: random.Random) -> tuple[str, str]:
    """One visually plausible mutation; returns (mutated, style)."""
    styles = []
    for src, dst in _GLYPH_SWAPS:
        if src in word:
            styles.append(("glyph_swap", src, dst))
    letters = [i for i, c in enumerate(word) if c.isalpha()]
    if len(letters) >= 3:
        styles.append(("letter_drop", None, None))
    if len(letters) >= 4:
        styles.append(("adjacent_swap", None, None))
    style = styles[rng.randrange(len(styles))]
    if style[0] == "glyph_swap":
        _, src, dst = style
        index = word.index(src)
        return word[:index] + dst + word[index + 1:], f"glyph_swap:{src}->{dst}"
    if style[0] == "letter_drop":
        index = letters[rng.randrange(1, len(letters))]
        return word[:index] + word[index + 1:], f"letter_drop:{word[index]}@{index}"
    index = letters[rng.randrange(len(letters) - 1)]
    swapped = list(word)
    swapped[index], swapped[index + 1] = swapped[index + 1], swapped[index]
    return "".join(swapped), f"adjacent_swap@{index}"


def plan_suite(class_id: str, n_plants: int = 5, n_twins: int = 5,
               seed: int = 20260724) -> list[dict]:
    """Deterministic (seeded) randomized challenge plan. Every spec fully
    describes one asset; the renderer must not add unrecorded randomness."""
    if class_id not in CLASSES:
        raise ValueError(f"unknown proficiency class: {class_id}")
    rng = random.Random(f"{SUITE_VERSION}:{class_id}:{seed}")
    specs = []
    positions = [(0.12, 0.12), (0.55, 0.15), (0.15, 0.70), (0.50, 0.68), (0.32, 0.42)]
    for index in range(n_plants + n_twins):
        planted = index < n_plants
        name = f"challenge-{rng.getrandbits(32):08x}"
        base = {"class_id": class_id, "asset_id": name, "planted": planted,
                "seed": seed, "duration_s": 6.0}
        if class_id == "rendered_text_mutation":
            word = _WORDS[rng.randrange(len(_WORDS))]
            mutated, style = _mutate(word, rng)
            x, y = positions[rng.randrange(len(positions))]
            spec = {**base, "word": word,
                    "position": [round(x, 3), round(y, 3)],
                    "font_px": rng.choice([40, 48, 56]),
                    "fps": 5,
                    "mutation_time_s": round(rng.uniform(2.0, 4.0), 2) if planted else None,
                    "mutated_word": mutated if planted else None,
                    "mutation_style": style if planted else None}
        elif class_id == "loudness_delta_lu":
            spec = {**base, "delta_lu": round(rng.uniform(8.0, 14.0), 1) if planted else 0.0}
        elif class_id == "bad_framerate":
            spec = {**base, "fps": 30 if planted else 24}
        specs.append(spec)
    rng.shuffle(specs)   # randomize run order so plants/twins are not grouped
    return specs


def suite_fingerprint(specs: list[dict]) -> str:
    return hashlib.sha256(json.dumps(specs, sort_keys=True).encode()).hexdigest()


# ── scoring ──

def score_asset(spec: dict, finding_kinds: list[str]) -> str:
    """caught | missed | false_positive_on_twin | true_negative, from the
    finding KINDS the target lane produced for this asset."""
    hit = CLASSES[spec["class_id"]]["finding_kind"] in finding_kinds
    if spec["planted"]:
        return "caught" if hit else "missed"
    return "false_positive_on_twin" if hit else "true_negative"


def aggregate(outcomes: list[str]) -> dict:
    """Sensitivity/specificity with Wilson 95% CIs. Raw counts always kept —
    the CI is rendered NEXT TO the count, never instead of it."""
    caught = outcomes.count("caught")
    missed = outcomes.count("missed")
    fp = outcomes.count("false_positive_on_twin")
    tn = outcomes.count("true_negative")
    n_plants, n_twins = caught + missed, fp + tn
    return {
        "n_plants": n_plants, "caught": caught, "missed": missed,
        "n_twins": n_twins, "false_positives": fp, "true_negatives": tn,
        "sensitivity": round(caught / n_plants, 3) if n_plants else None,
        "sensitivity_wilson95": wilson_interval(caught, n_plants),
        "specificity": round(tn / n_twins, 3) if n_twins else None,
        "specificity_wilson95": wilson_interval(tn, n_twins),
        "provisional": True if 0 < n_plants < 30 else False,
    }


def pair_policy(rows: list[dict]) -> dict:
    """Deployed-policy metrics, CONDITIONAL on a primary finding (the only
    time the jury runs in production). rows: per-asset
    {planted, primary_hit, jury_verdicts: [verdict per primary finding] or
    None when jury unavailable, juror_hit (offline)}."""
    plants_reproduced = plants_contested = 0
    twin_fp_reproduced = twin_fp_contested = 0
    jury_unavailable = 0
    offline_juror_only = 0
    triggering = 0
    for row in rows:
        if row.get("primary_hit"):
            triggering += 1
            verdicts = row.get("jury_verdicts")
            if verdicts is None:
                jury_unavailable += 1
            else:
                reproduced = any(v == "reproduced" for v in verdicts)
                if row["planted"]:
                    plants_reproduced += 1 if reproduced else 0
                    plants_contested += 0 if reproduced else 1
                else:
                    twin_fp_reproduced += 1 if reproduced else 0
                    twin_fp_contested += 0 if reproduced else 1
        elif row.get("juror_hit") and row.get("planted"):
            # only observable OFFLINE — production never juries a clean pass
            offline_juror_only += 1
    return {
        "conditional_on_primary_finding": True,
        "primary_findings_total": triggering,
        "plants_reproduced": plants_reproduced,
        "plants_contested": plants_contested,
        "twin_false_positives_reproduced": twin_fp_reproduced,
        "twin_false_positives_contested": twin_fp_contested,
        "jury_unavailable": jury_unavailable,
        "offline_juror_only_catch": offline_juror_only,
        "note": "jury characterizes reliability of findings; it cannot add recall "
                "under the deployed finding-only policy",
    }


# ── manifest ──

def manifest(class_id: str, specs: list[dict], primary: dict, juror: dict | None,
             pair: dict | None, config: dict, environment: dict,
             asset_hashes: dict, sidecar_hashes: dict,
             execution_date: str, published: bool) -> dict:
    """The proficiency record. Citable only when `published` (clean worktree,
    WORM-locked); drafts are for local iteration and never citable."""
    return {
        "version": MANIFEST_VERSION,
        "suite_version": SUITE_VERSION,
        "class_id": class_id,
        "class_label": CLASSES[class_id]["label"],
        "class_kind": CLASSES[class_id]["kind"],
        "lane": CLASSES[class_id]["lane"],
        "suite_sha256": suite_fingerprint(specs),
        "n_specs": len(specs),
        "parameter_ranges": _parameter_ranges(class_id, specs),
        "asset_sha256": asset_hashes,
        "ground_truth_sha256": sidecar_hashes,
        "primary": primary,
        **({"juror_offline": juror} if juror else {}),
        **({"deployed_pair_policy": pair} if pair else {}),
        "config": config,
        "environment": environment,
        "execution_date": execution_date,
        "published": published,
        "limits": [
            "PROVISIONAL at small n — Wilson 95% intervals are wide and are "
            "rendered next to raw counts, never instead of them",
            "a remote model id does not pin model weights; the serving side may "
            "change behind a stable id, so proficiency is dated, not eternal",
            "synthetic challenges measure detection of THESE defect classes at "
            "THESE parameters; they are not general accuracy claims",
        ],
    }


def _parameter_ranges(class_id: str, specs: list[dict]) -> dict:
    plants = [s for s in specs if s["planted"]]
    if class_id == "rendered_text_mutation":
        return {"mutation_time_s": [min(s["mutation_time_s"] for s in plants),
                                    max(s["mutation_time_s"] for s in plants)],
                "styles": sorted({s["mutation_style"].split(":")[0] for s in plants}),
                "font_px": sorted({s["font_px"] for s in specs})}
    if class_id == "loudness_delta_lu":
        return {"delta_lu": [min(s["delta_lu"] for s in plants),
                             max(s["delta_lu"] for s in plants)]}
    if class_id == "bad_framerate":
        return {"planted_fps": sorted({s["fps"] for s in plants})}
    return {}


def citation_state(manifest_doc: dict, current_config: dict) -> dict:
    """EXACT when every config hash matches the current runtime, else
    UNCALIBRATED with the mismatched keys named. Never cite 'latest'."""
    recorded = manifest_doc.get("config", {})
    mismatched = sorted(k for k in set(recorded) | set(current_config)
                        if recorded.get(k) != current_config.get(k))
    if not manifest_doc.get("published"):
        return {"state": "UNCALIBRATED", "reason": "draft manifest is never citable",
                "mismatched_keys": mismatched}
    if mismatched:
        return {"state": "UNCALIBRATED", "mismatched_keys": mismatched}
    return {"state": "EXACT", "mismatched_keys": []}
