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

# big masters need real scratch space — mount a volume over /tmp in production
VOLUME /tmp

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=4)"
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "8000"]
