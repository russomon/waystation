# Explicit AI Interpretive Analysis

Status: source-ready, production disabled. This mode is separate from
`AI_INTERPRETIVE_SHADOW` and from the older AI QC/Synthetic QC lanes.

## What the run does

The sender explicitly selects **AI Interpretive Analysis**. The gateway must
also allow it and the worker must enable it. The run records these stages:

1. `intake` binds the B2 master key, byte size, and SHA-256.
2. `deterministic_grounding` snapshots only bounded deterministic findings,
   policy identity, and valid review packets. It cannot mutate the QC report.
3. `evidence_selection` extracts at most four JPEG frames and one six-second
   mono WAV window by default. Finding targets are preferred; timeline anchors
   fill unused capacity. Every object is written beneath the transfer's B2
   derivative prefix with SHA-256 and size.
4. `gmi_visual_analysis` and `gmi_audio_analysis` run concurrently when both
   evidence types exist. Each has an independent timeout and attempt ledger.
5. `synthesis` receives deterministic grounding plus sanitized observations,
   never a mutable delivery report.
6. `artifact_storage` records B2 artifact references and hashes.

GMI output is parsed as untrusted data. Waystation creates a fresh
`advisory_observations` array, clamps confidence, drops unsupported fields, and
accepts only evidence IDs from the run's allowlist. A model cannot create a
delivery check, status, tier, BLOCKER, score, repair, or pipeline instruction.
Malformed/provider-failed output is `not_checked`, never pass.

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
```

The sender option is a third required condition. Enabling the explicit mode can
make two concurrent analysis calls plus one synthesis call. A media type that
is absent is not called. Every successful provider call emits one separately
metered `run` event. AI QC triage, deeper AI QC, Synthetic QC, AI Summary, and
shadow mode are separate selections and separate spend. For the first bounded
run, turn those services off so the explicit mode's cost and output are isolated.

Models are configuration, not code:

```text
AI_INTERPRETIVE_PROVIDER=gmicloud
AI_INTERPRETIVE_VISUAL_MODEL=google/gemini-3.5-flash
AI_INTERPRETIVE_AUDIO_MODEL=google/gemini-3.5-flash
AI_INTERPRETIVE_SYNTHESIS_MODEL=openai/gpt-4o-mini
AI_INTERPRETIVE_FALLBACK_PROVIDER=
AI_INTERPRETIVE_FALLBACK_MODEL=
AI_INTERPRETIVE_TIMEOUT_SECONDS=120
AI_INTERPRETIVE_MAX_CONCURRENCY=2
AI_INTERPRETIVE_MAX_FRAMES=4
AI_INTERPRETIVE_MAX_AUDIO_WINDOWS=1
```

The installed analysis adapter is GMI Cloud. An alternate provider name is
recorded as `not_configured`; it is never relabeled as GMI or silently invoked.
A fallback occurs only when both fallback provider and model are configured.

## Demo story

1. Upload a short showcase master and select deterministic QC plus **AI
   Interpretive Analysis**. Disable AI QC, Synthetic QC, and AI Summary for the
   first take so each visible GMI event belongs to this run.
2. Show live stages: deterministic grounding, B2 evidence selection, parallel
   GMI visual/audio analysis, synthesis, and artifact storage.
3. Open the recipient link. Keep the deterministic QC badge in view, then open
   the green AI panel: Genblaze run ID, stage timeline, provider/model, advisory
   observations, uncertainty, accepted evidence IDs, and selected B2 frames.
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
through the local gateway, runs three mock-GMI stages, stores and rehashes B2
artifacts in MinIO, exercises the recipient API shape, and SDK-verifies the
canonical manifest. A credentialed GMI run against the release candidate is
still required before the public recording.

On 2026-08-02 one local-only 1x1-image SDK call reached real GMI
`google/gemini-3.5-flash` (1,396 input / 216 output tokens). The intentionally
low 220-token cap ended at `finish_reason=length`, so no structured observation
was accepted. That confirms the live credential/provider boundary and the
fail-closed sanitizer, but it is not an end-to-end explicit-run validation.

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
   interpretation selected. Confirm three or fewer billable model events, GMI
   provider/model metadata, accepted evidence citations, B2 derivative hashes,
   SDK manifest verification, and unchanged deterministic status/tiers.
6. Record only after the credentialed result is visible and truthful. Do not
   replay historical uploads.
7. Roll back on provider loops, missing/mismatched hashes, authority drift,
   unexpected billable events, unhealthy containers, or absent timeline data:
   restore both gates to false and recreate gateway/worker. If code rollback is
   needed, restore the previously recorded images. B2 originals are untouched.
