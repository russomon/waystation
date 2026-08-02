# Delivery-quality calibration

Waystation's no-reference visual/audio measurements are useful evidence, but a
threshold is not delivery-grade merely because it is repeatable on synthetic
media. Blockiness, blur, banding, temporal-outlier, phase, click/pop, dropout,
and channel-consistency findings therefore remain deterministic advisories in
policy `us_broadcast_xdcam_hd_422_baseline` v1.2.0.

## Corpus intake

1. Keep customer media and delivery reports outside Git under appropriate
   access, privacy, and retention controls.
2. Record a pseudonymous asset ID, whole-file SHA-256, selected profile/policy,
   exact tool versions, measured features, and traceable decision provenance
   using `calibration/intake.schema.json`.
3. Label a record `accepted` or `rejected` only from retained real delivery
   evidence. Set `network_acceptance_evidence: true` only when that evidence
   exists.
4. Keep synthetic fixtures in a separate class. They prove extraction and
   reducer behavior, never broadcaster acceptance.
5. Review false positives/negatives by content class, codec generation,
   duration, raster, cadence, and audio layout before proposing a threshold.

`qc.calibration.calibration_candidate()` requires at least 20 real evidenced
accepted and 20 rejected records for one metric. This is a minimum workflow
gate, not a claim of statistical sufficiency. It reports overlapping classes
or a candidate boundary for human review and cannot edit policy.

## Promotion gate

Promoting an advisory to blocking requires a documented policy rationale, a
representative corpus, reviewed error costs, stable results across pinned tool
versions, a new immutable policy-pack version, known-good/known-bad regression
fixtures, and explicit deployment approval. AI cannot promote or override a
deterministic rule. Waystation never combines these metrics into a quality or
trust score.
