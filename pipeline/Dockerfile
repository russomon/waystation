# Waystation pipeline worker — the waystation's compute, in one image:
#   python 3.13 + ffmpeg/ffprobe + MediaInfo (deterministic QC reporting)
#   + a JRE + Netflix Photon 5.0.1 with its full dependency tree (Rule 4)
#   + the Genblaze SDK (provenance manifests)
# Stateless by design: everything durable lands back in B2. Deploy anywhere.
#
#   docker build -t waystation-worker pipeline/
#   docker run -e ... -p 8000:8000 waystation-worker

# ── stage 1: resolve Photon + transitive deps from Maven Central ──
FROM maven:3.9-eclipse-temurin-21 AS photon
WORKDIR /build
COPY photon-pom.xml pom.xml
RUN mvn -q dependency:copy-dependencies -DoutputDirectory=/opt/photon -DincludeScope=runtime

# ── stage 2: the worker ──
FROM python:3.13-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg mediainfo default-jre-headless \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py .
COPY qc ./qc
COPY --from=photon /opt/photon /opt/photon
ENV PHOTON_JAR=/opt/photon

# ── optional: SyncNet AV-sync (measured lip-sync), CPU ──
# Heavy (torch + weights), so it's opt-in: `--build-arg INSTALL_SYNCNET=1`.
# micromamba supplies ONLY a self-contained Python 3.10 (SyncNet's version),
# independent of this image's 3.13 — no cross-interpreter venv juggling — and
# pip supplies CPU torch, whose wheels exist for x86_64 AND aarch64 (the pytorch
# CONDA channel is x86_64-only, which is why the env is not built from upstream's
# environment-cpu.yml). Deps are the ones SyncNet actually imports: torch, cv2,
# numpy, scipy, python_speech_features, scenedetect, tqdm — it never imports
# torchaudio or torchvision, so both are omitted. opencv is the -headless build
# so no libGL is needed in a slim image.
# The base build (arg unset) is byte-for-byte unchanged. qc/avsync.py finds this
# via SYNCNET_DIR/SYNCNET_PYTHON and, when absent, emits an honest FYI instead
# of a silent pass.
ARG INSTALL_SYNCNET=0
RUN if [ "$INSTALL_SYNCNET" = "1" ]; then set -eux; \
      apt-get update && apt-get install -y --no-install-recommends git wget bzip2 ca-certificates; \
      arch="$(uname -m)"; case "$arch" in x86_64) mm=linux-64;; aarch64) mm=linux-aarch64;; *) mm=linux-64;; esac; \
      wget -qO /tmp/mm.tar.bz2 "https://micro.mamba.pm/api/micromamba/${mm}/latest"; \
      tar -xj -C /usr/local/bin --strip-components=1 -f /tmp/mm.tar.bz2 bin/micromamba; \
      export MAMBA_ROOT_PREFIX=/opt/syncnet/mamba; \
      micromamba create -y -p /opt/syncnet/env -c conda-forge python=3.10 pip; \
      git clone --depth 1 https://github.com/joonson/syncnet_python.git /opt/syncnet/repo; \
      (cd /opt/syncnet/repo && bash download_model.sh); \
      PY=/opt/syncnet/env/bin/python; \
      if [ "$arch" = "x86_64" ]; then \
        "$PY" -m pip install --no-cache-dir torch==2.5.1+cpu \
          --index-url https://download.pytorch.org/whl/cpu; \
      else \
        "$PY" -m pip install --no-cache-dir torch==2.5.1; \
      fi; \
      "$PY" -m pip install --no-cache-dir \
        numpy scipy opencv-contrib-python-headless \
        python_speech_features==0.6 scenedetect==0.6.7.1 tqdm; \
      micromamba clean -y --all; \
      apt-get purge -y git wget bzip2 && apt-get autoremove -y; \
      rm -rf /var/lib/apt/lists/* /tmp/mm.tar.bz2 /opt/syncnet/mamba/pkgs; \
    fi
# Harmless when SyncNet is not installed: avsync._resolve() checks the dir exists.
ENV SYNCNET_DIR=/opt/syncnet/repo \
    SYNCNET_PYTHON=/opt/syncnet/env/bin/python

# big masters need real scratch space — mount a volume over /tmp in production
VOLUME /tmp

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=4)"
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "8000"]
