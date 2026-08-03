# Explicit AI Interpretive Analysis

Status: source-ready, production disabled. This mode is separate from
`AI_INTERPRETIVE_SHADOW` and from the older AI QC/Synthetic QC lanes.

## What the run does

The sender explicitly selects **AI Interpretive Analysis**. The gateway must
also allow it and the worker must enable it. The run records these stages:

1. `intake` binds the B2 master key, byte size, and SHA-256.
2. `deterministic_grounding` snapshots only bounded deterministic findings,
   policy identity, and valid review packets. It cannot mutate the QC report.
3. `ai_review_planning` asks a configurable GMI planning model for a bounded,
   risk-targeted review plan. The plan is schema-validated and allowlisted; a
   deterministic fallback plan is recorded if the call is absent or malformed.
4. `evidence_selection` extracts at most four JPEG frames and one six-second
   mono WAV window by default. Finding targets are preferred; timeline anchors
   fill unused capacity. Every object is written beneath the transfer's B2
   derivative prefix with SHA-256 and size.
5. `gmi_visual_analysis` and `gmi_audio_analysis` run concurrently when both
   evidence types exist. Each has an independent timeout and attempt ledger.
6. `synthesis` receives the validated plan, deterministic grounding, and
   sanitized specialist observations,
   never a mutable delivery report.
7. `artifact_storage` records B2 artifact references and hashes.

GMI output is parsed as untrusted data. Waystation creates fresh observations,
clamps confidence, drops unsupported fields, and accepts only evidence IDs
from the run allowlist. Raw model output cannot create a delivery check, status,
tier, score, repair, or pipeline instruction. A separate versioned authority
reducer may issue an AI HOLD or REJECT only for policy-listed risks after
evidence, confidence, and corroboration requirements pass. Missing risk
coverage, malformed output, or provider failure produces HOLD/not_checked,
never READY. AI cannot clear a deterministic rejection.

This first pass analyzes bounded stills and mono audio windows, not the entire
video bitstream in a native video-capable model. Visible image, typography, and
audible-defect categories can be enforceable in `enforce` mode. Temporal
continuity, lip sync, caption semantics, intent, and aesthetics are HOLD-only
until evidence delivery and real-corpus calibration are stronger.

The official `genblaze_gmicloud.chat` SDK boundary performs each configured GMI
call. Official Genblaze Core `RunBuilder` and `StepBuilder` models record stage
timing, provider/model, attempts, fallback, prompt/input hashes, usage, and B2
assets. That dedicated run is embedded in the existing canonical-hashed
delivery manifest; `ai_interpretive.json` and every selected evidence object
are normal hashed derivatives covered by the same manifest.

## Configuration and spend

Both gates default to false:

```text
ALLOW_AI_INTERPRETIVE=false
AI_INTERPRETIVE_RUN_ENABLED=false
AI_INTERPRETIVE_AUTHORITY_MODE=shadow
```

The sender option is a third required condition. Enabling the explicit mode can
make one planning call, two concurrent analysis calls, and one synthesis call.
A media type that
is absent is not called. Every successful provider call emits one separately
metered `run` event. AI QC triage, deeper AI QC, Synthetic QC, AI Summary, and
shadow mode are separate selections and separate spend. For the first bounded
run, turn those services off so the explicit mode's cost and output are isolated.

Models are configuration, not code:

```text
AI_INTERPRETIVE_PROVIDER=gmicloud
AI_INTERPRETIVE_PLANNER_MODEL=openai/gpt-4o-mini
AI_INTERPRETIVE_VISUAL_MODEL=google/gemini-3.5-flash
AI_INTERPRETIVE_AUDIO_MODEL=google/gemini-3.5-flash
AI_INTERPRETIVE_SYNTHESIS_MODEL=openai/gpt-4o-mini
AI_INTERPRETIVE_FALLBACK_PROVIDER=
AI_INTERPRETIVE_FALLBACK_MODEL=
AI_INTERPRETIVE_TIMEOUT_SECONDS=120
AI_INTERPRETIVE_MAX_CONCURRENCY=2
AI_INTERPRETIVE_MAX_FRAMES=4
AI_INTERPRETIVE_MAX_AUDIO_WINDOWS=1
AI_INTERPRETIVE_MAX_OUTPUT_TOKENS=4096
AI_INTERPRETIVE_AUTHORITY_MODE=shadow
```

The installed analysis adapter is GMI Cloud. An alternate provider name is
recorded as `not_configured`; it is never relabeled as GMI or silently invoked.
A fallback occurs only when both fallback provider and model are configured.

Authority modes are staged and reversible:

- `shadow`: record the AI gate's proposed disposition; deterministic policy
  alone determines the displayed disposition.
- `hold`: AI may stop release for review but cannot reject on its own.
- `enforce`: corroborated, evidence-backed findings in enforceable policy
  categories may reject. Deterministic rejection always wins.

## Demo story

1. Upload a short showcase master and select deterministic QC plus **AI
   Interpretive Analysis**. Disable AI QC, Synthetic QC, and AI Summary for the
   first take so each visible GMI event belongs to this run.
2. Show live stages: deterministic grounding, B2 evidence selection, parallel
   GMI visual/audio analysis, synthesis, and artifact storage.
3. Open the recipient link. Keep the deterministic QC badge in view, then open
   the AI panel: dual-key READY/HOLD/REJECT, both gate dispositions, Genblaze
   run ID, stage timeline, provider/model, observations, uncertainty, accepted
   evidence IDs, and selected B2 frames.
4. Open Provenance and verify it. The canonical Genblaze manifest covers the
   master, QC report, AI result JSON, and selected evidence hashes.

Do not call the network-free proof a live GMI run:

```bash
bash scripts/ai-interpretive-run-proof.sh
bash scripts/ai-interpretive-loop-proof.sh
```

It validates orchestration, overlap, fallback records, sanitizer behavior,
artifact hashing, SDK run shape, metering events, and authority isolation with
an SDK-shaped mock. The second proof sends a browser-style multipart upload
through the local gateway, runs four mock-GMI stages, stores and rehashes B2
artifacts in MinIO, exercises the recipient API shape, and SDK-verifies the
canonical manifest. A credentialed GMI run against the release candidate is
still required before the public recording.

On 2026-08-02 one local-only 1x1-image SDK call reached real GMI
`google/gemini-3.5-flash` (1,396 input / 216 output tokens). The intentionally
low 220-token cap ended at `finish_reason=length`, so no structured observation
was accepted. That confirms the live credential/provider boundary and the
fail-closed sanitizer, but it is not an end-to-end explicit-run validation.

A later credentialed local upload reached the full explicit pipeline and stored
three JPEG frames plus one WAV evidence object. The configured planner returned
429, while the two Gemini specialist calls each stopped at 2,396 output tokens
against the former 2,400-token ceiling; neither yielded valid structured JSON,
so synthesis did not run. The final manifest also failed because a production
`MANIFEST_LOCK_DAYS=1` value had leaked into local MinIO, whose existing bucket
was not Object-Lock-enabled. This was not a successful QC run. The follow-up
source revision lane-scopes specialist plans, requires compact JSON, uses a
bounded 4,096-token default, records provider `finish_reason`, and forces Object
Lock off only in `scripts/dev-up.sh`. A clean credentialed rerun remains pending.

## Reversible production release checklist

1. Review and push a release commit. Build the gateway, client, and worker
   locally; run the explicit proof, existing regressions, Docker tool proof, and
   full gateway-worker-MinIO loop.
2. Verify the actual VPS checkout/ref, compose file, image IDs, free scratch
   space, and `scripts/preflight-scratch.sh` before mutation. Keep both new
   gates false for the initial image rollout.
3. Rebuild/recreate only the services whose source changed. Publish the client
   export through the existing OrbitWebsite release flow. Confirm health and
   confirm the sender control is rejected by gateway policy while gated off.
4. Set `ALLOW_AI_INTERPRETIVE=true` and `AI_INTERPRETIVE_RUN_ENABLED=true`,
   recreate only gateway and worker, then recheck health and effective env.
5. Run one short, bounded asset with only deterministic QC and explicit
   interpretation selected. Confirm four or fewer billable model events, GMI
   provider/model metadata, accepted evidence citations, B2 derivative hashes,
   SDK manifest verification, unchanged deterministic status/tiers, and a
   shadow-mode dual-key decision. Promote to `hold` first; use `enforce` only
   after retained accepted/rejected corpus review for each enforceable risk.
6. Record only after the credentialed result is visible and truthful. Do not
   replay historical uploads.
7. Roll back on provider loops, missing/mismatched hashes, authority drift,
   unexpected billable events, unhealthy containers, or absent timeline data:
   restore both gates to false and recreate gateway/worker. If code rollback is
   needed, restore the previously recorded images. B2 originals are untouched.
