#!/usr/bin/env bash
# Fetch and set up the SyncNet AV-sync model (joonson/syncnet_python) so
# Waystation can MEASURE lip sync instead of guessing. Heavy (torch + weights),
# so — like Photon and MediaInfo — it lives outside the base worker and is
# activated on machines that need measured lip-sync.
#
# After it completes, add to .env:
#   SYNCNET_DIR=<repo>/vendor/syncnet
#   SYNCNET_PYTHON=<repo>/vendor/syncnet/.venv/bin/python
#
# Requires: git, python3 (3.10-3.12 recommended for torch/opencv wheels), ffmpeg.
set -euo pipefail
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$WEB/vendor/syncnet"
PYBIN="${SYNCNET_BUILD_PYTHON:-python3}"

command -v git >/dev/null || { echo "✗ git required"; exit 1; }
"$PYBIN" --version >/dev/null 2>&1 || { echo "✗ python3 required"; exit 1; }

if [ ! -d "$DEST/.git" ]; then
  echo "▶ cloning syncnet_python…"
  git clone --depth 1 https://github.com/joonson/syncnet_python.git "$DEST"
fi
cd "$DEST"

echo "▶ downloading pretrained weights…"
[ -f download_model.sh ] && bash download_model.sh || echo "  (no download_model.sh — check the repo)"

echo "▶ creating an isolated venv with the SyncNet deps…"
"$PYBIN" -m venv .venv
./.venv/bin/pip install -q --upgrade pip
# The upstream repo pins old versions; these are the runtime deps it imports.
./.venv/bin/pip install -q \
  torch torchvision numpy scipy opencv-python scenedetect python_speech_features || {
    echo "⚠ dependency install hit a version conflict — the upstream repo is old."
    echo "  See vendor/syncnet/requirements.txt / environment.yml and pin as needed."
    echo "  The Waystation wrapper (qc/avsync.py) will keep reporting an honest FYI"
    echo "  until 'SYNCNET_PYTHON run_syncnet.py' runs, so nothing silently passes."
    exit 1
  }

echo "✓ SyncNet set up in $DEST"
echo "  add to .env:"
echo "    SYNCNET_DIR=$DEST"
echo "    SYNCNET_PYTHON=$DEST/.venv/bin/python"
