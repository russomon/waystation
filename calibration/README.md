# Delivery-quality calibration corpus

This directory defines intake metadata; it does not store customer media.
Place restricted media in an access-controlled corpus outside Git and record
only pseudonymous asset IDs, SHA-256 identities, tool provenance, measured
features, and the source of the accepted/rejected label.

Synthetic fixtures prove extractor and reducer behavior. They are never
network-acceptance evidence. A real record may set
`network_acceptance_evidence: true` only when the label is backed by a retained
delivery decision, rejection report, or equivalent traceable source.

Use `qc.calibration.validate_record()` at intake. The candidate helper requires
at least 20 real, evidenced accepted and 20 rejected examples per metric. Even
then it only emits a review candidate. Changing authority or a threshold
requires documented engineering/editorial review, a versioned policy-pack
change, fixture updates, and regression proof.

Do not commit media, customer names, network credentials, delivery reports, or
other confidential material. Retain those under the archive's normal access,
privacy, and retention controls.
