# Deep package evidence and AI shadow evaluation

## Scope

Waystation policy `us_broadcast_xdcam_hd_422_baseline` v1.4 adds bounded
evidence collection and offline evaluation controls. It does not claim
universal network acceptance, AS-profile conformance, complete IMF application
profile conformance, HDR/Dolby certification, or commercial-QC parity.

## Phase 3 evidence

For MXF inputs, Waystation retains a bounded ffprobe wrapper/package/essence
inventory and notes which independent MediaInfo and MediaConch fact sources
were available. Partition graphs, index tables, random index packs, KLV
alignment, SMPTE 436 ancillary payloads, and AS-profile rule conformance remain
explicitly `not_checked` without a qualified analyzer and validated rule set.

For ZIP-carried IMF packages, the structural inspector reads the central
directory and XML manifests without extracting essence. Entry count, XML size,
and per-asset hash work are capped by policy. It parses AssetMap, PackingList,
and CompositionPlaylist references, reports missing members and unresolved
track-file IDs, and verifies supported PKL SHA-1/SHA-256 hashes only for assets
within the byte bound. Skipped hashes remain `not_checked`. This structural
result is separate from Photon and never implies application-profile
conformance. Photon retains its existing explicit Netflix profile role when
installed and configured.

HDR/color and Dolby-related stream labels are discovered from ffprobe and
MediaInfo. Independently exposed transfer, primaries, matrix, and range labels
are cross-checked. Contradictions are advisory. Observed labels do not establish
bitstream, mastering-display, playback, Dolby Vision, Dolby E, or Atmos
conformance.

`waystation_house_xdcam_hd_422_v1` is a selectable local house template backed
by the same broadcast baseline. Its JSON source hash, template version, scope,
overrides, and effective policy hash are retained. It is intentionally not
named after a broadcaster and contains no invented private network rules.

## Commercial-QC benchmark intake

`calibration/commercial-qc-benchmark.schema.json` records real side-by-side
Waystation and retained human/commercial-QC outcomes with exact policy/tool
provenance and one of these disagreement classes: agreement, Waystation-only,
reference-only, severity difference, category mapping, unsupported capability,
or inconclusive evidence. Synthetic fixtures cannot claim commercial-QC
results. `qc.benchmark.summarize()` reports counts and disagreements, not a
quality, trust, acceptance, or parity score, and cannot change policy.

## Phase 4 shadow workflow

The prompt compiler emits hash-validated packets containing one relevant
deterministic finding, bounded evidence/time ranges, policy/template context,
an explicit review question, and no more than two allowlisted still/audio
requests. A changed field invalidates the packet before media extraction or
model spend. Model citations are restricted to deterministic evidence IDs in
the packet and media evidence generated for that packet; invented IDs are
removed and disclosed.

`AI_INTERPRETIVE_SHADOW=false` remains the default. When explicitly enabled
with AI QC and a GMI key, one shadow run makes one separately metered model
pass. Cost-aware triage, when enabled by the existing AI path, is a separate
model pass and separate spend event. Shadow observations remain detached from
canonical checks and cannot clear, fail, score, or alter the deterministic
delivery outcome.

Human reviewers can record `agree`, `disagree`, `needs_review`, or
`false_positive` dispositions using `calibration/ai-shadow-review.schema.json`.
Records retain model/prompt/packet provenance, reviewer rationale, evidence
references, and a human concern/no-concern/not-determinable label. The offline
evaluator reports a confusion matrix, precision, recall, false-positive rate,
and Wilson 95% intervals. Feedback enters evaluation/calibration only; it never
promotes an AI observation or edits deterministic policy automatically.

## Deferred

- qualified AS-10/AS-11/AS-12 package conformance;
- full MXF partition/index/KLV/ancillary validation;
- complete IMF application-profile and large-essence hash validation;
- qualified HDR/Dolby bitstream and rendering conformance;
- real accepted/rejected customer corpus calibration;
- retained commercial-tool and human-review benchmark records;
- any production activation of source policy v1.4 or AI shadow.

## Proofs

```bash
bash scripts/deep-package-proof.sh
bash scripts/qc-benchmark-proof.sh
bash scripts/interpretive-shadow-proof.sh
bash scripts/shadow-evaluation-proof.sh
```

Synthetic fixtures prove bounds, parsing, reducer behavior, evidence
constraints, and authority isolation. They do not prove broadcaster acceptance,
qualified analyzer equivalence, or live-model quality.
