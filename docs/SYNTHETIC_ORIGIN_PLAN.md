# Synthetic-origin QC — provenance first, perception last, never CLEAR

**Status: DESIGN ONLY. Not implemented.** Deferred past the hackathon
submission by decision on 2026-07-28. This document exists so the design is not
lost; nothing in it is wired into the pipeline.

## Why

Waystation should be able to report whether a delivery is AI-generated. Today it
half-does: `ai_origin_assessment` (`pipeline/worker.py`) asks the VLM "does this
appear AI-generated?" and reports the boolean as an FYI. That is the least
reliable available method — the same holistic-judgment shape this project has
already disproved for lip sync, where the model called a 1.7 s offset "in sync,
high confidence" and only per-frame mouth-openness plus cross-correlation
recovered the true offset.

**Verified gap: neither registry has an origin risk.**

- `GENERATED_RISK_REGISTRY` (`pipeline/qc/generated.py:24`) — **14** dimensions,
  all of which presuppose the asset *is* generated and look for defects within
  it: `prompt_elements`, `subject_identity`, `background_consistency`,
  `object_permanence`, `human_anatomy`, `motion_smoothness`, `temporal_flicker`,
  `physics_contact`, `shadows_reflections`, `camera_continuity`, `rendered_text`,
  `spatial_relationships`, `visual_style`, `imaging_quality`.
- `RISK_REGISTRY` (`pipeline/qc/agentic.py`) — **18** risks, none about
  provenance or origin.

So origin is currently unaccounted for in coverage, which means it can be
silently omitted — exactly what the registries exist to prevent.

Intended outcome: a `synthetic_origin` risk backed by an evidence ladder where
cryptographic provenance decides, deterministic forensics indicate, and the
model contributes only a capped indicator.

## The constraint that shapes everything

**No method establishes camera origin.** Provenance is strippable by
re-encoding; forensic signal is destroyed by compression. Therefore:

> `synthetic_origin` may be CONFIRMED or SUSPECTED, but **never CLEAR**.

Absence of a signed manifest is not evidence of camera capture.

**A second caveat specific to this product:** Waystation inspects *delivery
masters* — re-encoded, often h264, frequently graded and resized. That is the
worst case for signal forensics. PRNU and spectral fingerprints degrade severely
or vanish under delivery compression. Tier 3 must therefore ABSTAIN loudly
rather than guess, and must never be presented as decisive.

## Evidence ladder

### Tier 1 — cryptographic provenance (the only near-definitive tier)

**C2PA / Content Credentials** via `c2patool`, shipped as an OPTIONAL ANALYZER
exactly like Photon, MediaInfo and SyncNet — reuse the `_resolve()` shape at
`pipeline/qc/avsync.py:37` (env var → directory check → executable check →
`None`). Real result when installed, honest FYI when absent, never a silent pass.

| Observation | Verdict |
|---|---|
| valid signature + `c2pa.actions` naming a generative software agent | **CONFIRMED generated** |
| valid signature from a capture device | strong capture evidence — still not CLEAR |
| manifest present, signature **invalid** | a finding in its own right (tampered provenance), independent of origin |
| absent | info: "no provenance manifest; origin undetermined" |

**Genblaze manifest** — the `.genblaze.json` sidecar the worker already ingests
is a first-party generation record.

> **Declared vs verified provenance.** An unsigned `.genblaze.json` is a
> *declaration*, not verified provenance. It is trustworthy only when **signed
> and cryptographically bound to the video digest**; otherwise anyone can assert
> any origin for any file. Report it as `declared_provenance` and say so in the
> output. Waystation is uniquely positioned to trust a *signed* one — but the
> distinction must be visible to the recipient, not collapsed.

### Tier 2 — container / encoder fingerprints (deterministic, ffprobe only, cheap)

Absence of camera-typical metadata (make/model, timecode, capture date),
generator-typical encoder strings, generator-typical resolutions and frame
rates, and a single-generation encode with no edit chain. **INDICATORS ONLY.**

### Tier 3 — signal forensics (deterministic, ffmpeg + numpy)

- **PRNU absence** — real sensors leave photo-response non-uniformity. Extract
  the high-frequency residual, measure cross-frame correlation.
- **Spectral upsampling peaks** — diffusion/GAN decoders leave periodic peaks in
  the 2D FFT magnitude spectrum that a lens never produces.

Both must return an explicit `inconclusive` when the compression level makes the
measurement meaningless. Reuse the abstain discipline already proven in
`pipeline/qc/hybrid.py` (`align`'s peak-margin gate → `reliable: False`).

### Tier 4 — model perception (capped at ISSUE by the existing rule)

Replace the holistic yes/no with **perceive-then-compute**: the model emits
per-window descriptors (texture regularity, anatomical anomaly count, physics
implausibility) and a deterministic reducer aggregates them into an indicator.
**The model never answers "is this AI."**

This cap is not new work — `checks_from_findings` (`pipeline/qc/agentic.py:410`)
already caps *every* agentic finding at ISSUE, never BLOCKER, under any
`risk_id`. That cap was learned across two live runs in which the model laundered
restatements of measured instrument failures through ill-fitting registered ids.

## Files this would touch

- **New** `pipeline/qc/origin.py` — pure reducers plus the `c2patool` wrapper.
  Mirrors `qc/avsync.py` (optional analyzer) and `qc/hybrid.py` (perceive-then-
  compute reducers). Env `C2PATOOL`, following the `SYNCNET_DIR` convention.
- **Edit** `pipeline/qc/agentic.py` — add the registry entry:

  ```python
  {"id": "synthetic_origin",
   "label": "Synthetic (AI-generated) origin and provenance",
   "category": "provenance", "applies": "video",
   "checks": ["c2pa_manifest", "genblaze_provenance",
              "container_origin_fingerprint", "spectral_synthesis_indicator"],
   "support_checks": ["ai_origin_assessment"],
   "scope": "partial", "model_unreliable": True,
   "limit": "Provenance is strippable by re-encoding, so an absent manifest is "
            "not evidence of camera origin. Forensic indicators degrade under "
            "delivery compression and are generator-dependent; none of them "
            "establish origin."}
  ```

  **No new coverage logic is needed** — both properties are already implemented
  and proven. `scope: "partial"` means a passing instrument cannot CLEAR, because
  the CLEAR branch at `agentic.py:516` requires `scope == "full"`; and
  `model_unreliable` excludes the risk from AI-based clearing at `agentic.py:528`.

- **Edit** `pipeline/worker.py` — call the origin lane, relabel
  `ai_origin_assessment` as an indicator, meter as `qc_origin`.
- **Edit** `pipeline/qc/foundry.py` — add the proficiency class below.
- **New** `scripts/origin-proof.sh` — the capability proof.

## Measuring it — the differentiator

Add a Foundry class so the claim is measured rather than asserted:

```python
"synthetic_origin": {"label": "Synthetic-origin detection (AI proficiency)",
                     "kind": "ai", "finding_kind": "synthetic_origin",
                     "lane": "origin"}
```

**Honest difference from `rendered_text_mutation`:** that class is *renderable* —
ffmpeg and Pillow manufacture ground truth. This one is **not**. It needs a
curated corpus: real camera clips (known provenance, ideally C2PA-signed) and
generated clips from named generators. **That is a data-collection task, not a
code task, and it is the real cost of this feature.**

With a corpus, the published record reads:

> On these generators, at this date, this configuration caught 8/10 with
> clean-twin specificity 10/10 — WORM-sealed, Wilson intervals, generator list
> named.

That is a claim nobody else in the category supports, and it is only possible
because the Proficiency Foundry already exists.

## Verification (when built)

1. **Unit** — spectral and PRNU reducers on constructed stimuli: a synthetic
   gradient with injected periodic peaks must score high, camera-like noise must
   not, and the abstain path must fire on a heavily compressed input.
2. **`scripts/origin-proof.sh`** — asserts that an absent `c2patool` yields an
   explicit FYI and never a silent pass; a *signed* Genblaze manifest CONFIRMS
   generated origin while an unsigned one reports only `declared_provenance`; a
   clean camera-style clip is **never CLEARED** (the central rule); an invalid
   C2PA signature is reported as tampered provenance distinctly from origin; and
   the model's indicator cannot exceed ISSUE.
3. **Mutation test** — force the never-CLEAR rule off and confirm the proof
   fails, as was done for the undefined-options bug in `access-proof.sh`.
4. **Regression** — every `scripts/*-proof.sh`, discovered from the filesystem,
   stays green.
5. **Live** — one C2PA-signed asset and one Genblaze-manifested generated clip
   through real GMI; then a proficiency session once the corpus exists.

## Sequencing

Deferred until after the hackathon submission. It is a multi-day feature
(c2patool integration, forensic reducers, corpus collection) and mixing a new QC
lane into the production rehearsal would put the submission at risk.

Cheap and honest to do instead, when there is time — one line, no new lane:

- relabel `ai_origin_assessment` from what reads as a determination to
  *"synthetic-origin indicator — perceptual only, not a provenance
  determination."*
- On camera, state the true and already-implemented claim: Waystation treats a
  recorded generation provenance record as evidence and refuses to guess when it
  is absent.
