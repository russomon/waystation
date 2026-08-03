#!/usr/bin/env bash
# Start the local judge-calibration stack with the proven GMI model pair.
# No model call occurs until the sender explicitly submits a transfer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${GMI_API_KEY:-}" ]]; then
  echo "error: GMI_API_KEY is not configured in .env" >&2
  exit 1
fi

export ALLOW_AI_INTERPRETIVE=true
export AI_INTERPRETIVE_RUN_ENABLED=true
export AI_INTERPRETIVE_AUTHORITY_MODE=shadow
export AI_INTERPRETIVE_SHADOW=false
export AI_INTERPRETIVE_PLANNER_MODEL=google/gemini-3.6-flash
export AI_INTERPRETIVE_VISUAL_MODEL=google/gemini-3.5-flash
export AI_INTERPRETIVE_AUDIO_MODEL=google/gemini-3.5-flash
export AI_INTERPRETIVE_JURY_MODEL=google/gemini-3.6-flash
export AI_INTERPRETIVE_SYNTHESIS_MODEL=google/gemini-3.6-flash
export AI_INTERPRETIVE_MAX_CONCURRENCY=3
export AI_INTERPRETIVE_STAGE_MAX_ATTEMPTS=2
export AI_INTERPRETIVE_RETRY_DELAY_SECONDS=5
export AI_INTERPRETIVE_MAX_FRAMES=3
export AI_INTERPRETIVE_MAX_OUTPUT_TOKENS=6144
export WAYSTATION_LOCAL_CLOUD_WORKER=true

printf '%s\n' \
  "Judge calibration: explicit AI on, authority shadow, GMI key set" \
  "  planner/jury/synthesis: google/gemini-3.6-flash" \
  "  visual/audio: google/gemini-3.5-flash" \
  "  evidence: 3 frames max; specialist output: 6144 tokens max" \
  "  compute: Cloud checkbox routes to the shipped Docker worker"

exec bash scripts/dev-up.sh
