# Delivery-quality calibration

Waystation's no-reference visual/audio measurements are useful evidence, but a
threshold is not delivery-grade merely because it is repeatable on synthetic
media. Blockiness, blur, banding, temporal-outlier, phase, click/pop, dropout,
and channel-consistency findings therefore remain deterministic advisories in
policy `us_broadcast_xdcam_hd_422_baseline` v1.4.0.

## Corpus intake

1. Keep customer media and delivery reports outside Git under appropriate
   access, privacy, and retention controls.
2. Record a pseudonymous asset ID, whole-file SHA-256, independent-source
   group, preassigned `training` or `holdout` split, selected profile/policy,
   exact tool versions, measured features, and traceable decision provenance
   using `calibration/intake.schema.json`.
3. Label a record `accepted` or `rejected` only from retained real delivery
   evidence. Set `network_acceptance_evidence: true` only when that evidence
   exists.
4. Keep synthetic fixtures in a separate class. They prove extraction and
   reducer behavior, never broadcaster acceptance.
5. Record the required strata: content class, codec generation, cadence/frame
   rate, and audio layout. Add further dimensions such as duration and raster
   when they can affect the measurement.
6. Derivatives from one source master share one `independence_group`; they may
   not be counted as independent examples. Duplicate hashes or groups fail the
   intake gate.

`qc.calibration.calibration_candidate()` derives a candidate boundary from the
training split only. It then evaluates the untouched, stratified holdout split,
reports a confusion matrix, and computes Wilson 95% confidence intervals for
false positives and false negatives. The default asymmetric limits require
the false-positive upper bound to be no greater than 5% and the false-negative
upper bound no greater than 10%. At least 20 real evidenced accepted and 20
rejected records are required in each split, but confidence bounds normally
demand substantially more data. Every training stratum must be represented in
holdout, and each holdout stratum must include both decisions.

The result states `candidate_ready_for_policy_review` only when separation,
independence, strata, sample floors, and both confidence-bound limits pass. It
still cannot edit policy or grant blocking authority.

## Promotion gate

Promoting an advisory to blocking requires a documented policy rationale, an
independent representative corpus, a passing untouched holdout, reviewed error
costs and strata, stable results across pinned tool versions, a new immutable
policy-pack version, known-good/known-bad regression fixtures, and explicit
deployment approval. Passing the statistical gate is necessary, not automatic
promotion. AI cannot promote or override a deterministic rule. Waystation
never combines these metrics into a quality or trust score.

## Benchmark and AI-review datasets

Use `calibration/commercial-qc-benchmark.schema.json` for retained
side-by-side Waystation versus human/commercial-QC records. It preserves the
reference evidence location, tool/policy versions, per-category outcomes, and
disagreement taxonomy. It does not compute or authorize a parity claim.

Use `calibration/ai-shadow-review.schema.json` for human dispositions on AI
shadow observations. The offline evaluator reports confusion, precision,
recall, false-positive rate, and Wilson 95% intervals. These records can expose
model failure modes and guide later packet/prompt work, but they never grant AI
delivery authority or update policy automatically.
