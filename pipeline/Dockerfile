# Waystation pipeline worker — the waystation's compute, in one image:
#   python 3.13 + ffmpeg/ffprobe + MediaInfo + MediaConch + QCTools qcli
#   (headless deterministic QC reporting and analytics plumbing)
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

# ── stage 2: build only QCTools' headless qcli target ──
# Debian does not package qcli. Build an exact upstream revision against the
# same Debian/FFmpeg generation as the worker, then copy only the CLI binary.
FROM python:3.13-slim AS qcli-build
ARG QCTOOLS_VERSION=1.4+29bc627
ARG QCTOOLS_COMMIT=29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2
ENV SOURCE_DATE_EPOCH=1783329476
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential qt5-qmake qtbase5-dev \
      qtmultimedia5-dev pkg-config libavcodec-dev libavdevice-dev \
      libavfilter-dev libavformat-dev libavutil-dev libpostproc-dev \
      libswresample-dev libswscale-dev zlib1g-dev libbz2-dev \
 && git init /src/qctools \
 && git -C /src/qctools remote add origin https://github.com/bavc/qctools.git \
 && git -C /src/qctools fetch --depth 1 origin "$QCTOOLS_COMMIT" \
 && git -C /src/qctools checkout --detach FETCH_HEAD \
 && test "$(git -C /src/qctools rev-parse HEAD)" = "$QCTOOLS_COMMIT" \
 && git -C /src/qctools submodule update --init --depth 1 \
 && printf '%s\n' \
      '#ifndef VERSION_H' \
      '#define VERSION_H' \
      "const char* VERSION = \"$QCTOOLS_VERSION ($QCTOOLS_COMMIT)\";" \
      '#endif // VERSION_H' \
      > /src/qctools/Source/Cli/version.h \
 && mkdir /src/qctools/Project/QtCreator/build \
 && cd /src/qctools/Project/QtCreator/build \
 && USE_BREW=true qmake .. DEFINES+=QT_AVPLAYER_MULTIMEDIA \
 && make -j2 sub-qctools-cli \
 && install -Dm755 qctools-cli/qcli /out/qcli

# ── stage 3: the worker ──
FROM python:3.13-slim
ARG QCTOOLS_VERSION=1.4+29bc627
ARG QCTOOLS_COMMIT=29bc627d7a3b4048d3e2ac250ca20adb1ba39cd2
ARG MEDIACONCH_PACKAGE_VERSION=25.04-2
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg mediainfo mediaconch="$MEDIACONCH_PACKAGE_VERSION" \
      libqt5multimedia5 default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
COPY --from=qcli-build /out/qcli /usr/local/bin/qcli
RUN qcli -v >/dev/null \
 && mediaconch --Version >/dev/null
LABEL org.opencontainers.image.waystation.qctools.version="$QCTOOLS_VERSION" \
      org.opencontainers.image.waystation.qctools.revision="$QCTOOLS_COMMIT" \
      org.opencontainers.image.waystation.mediaconch.package-version="$MEDIACONCH_PACKAGE_VERSION"
ENV QCTOOLS_VERSION="$QCTOOLS_VERSION" \
    QCTOOLS_COMMIT="$QCTOOLS_COMMIT" \
    MEDIACONCH_PACKAGE_VERSION="$MEDIACONCH_PACKAGE_VERSION"

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
