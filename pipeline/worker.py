"""
OrbitXfer Web — Genblaze pipeline worker.

Triggered by the gateway when B2 reports a new original media object. Does
real work on the file (probe + poster frame today; transcribe/summarize via
GMI Cloud as the key lands), writes derivatives + a provenance manifest back
to B2 under a `derivatives/` prefix (so it does NOT re-trigger the event),
and streams progress to the gateway → SSE → browser.

Run:  uvicorn worker:app --port 8000 --reload
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone

import boto3
import httpx
from botocore.config import Config
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
SHARED = os.environ["PIPELINE_SHARED_SECRET"]
BUCKET = os.environ["B2_BUCKET"]

# Tamper-proof provenance: when > 0, the manifest is written under B2 Object
# Lock in COMPLIANCE mode (write-once-read-many) for this many days — nobody,
# not even the account owner, can alter or delete it until then. Requires the
# bucket to have Object Lock enabled. 0 (default) = no lock (dev). Only the
# manifest is locked; originals/derivatives stay expirable via lifecycle.
MANIFEST_LOCK_DAYS = int(os.environ.get("MANIFEST_LOCK_DAYS", "0"))

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["B2_S3_ENDPOINT"],
    region_name=os.environ.get("B2_REGION", "us-east-1"),
    aws_access_key_id=os.environ["B2_KEY_ID"],
    aws_secret_access_key=os.environ["B2_APP_KEY"],
    config=Config(s3={"addressing_style": "path" if os.environ.get("B2_FORCE_PATH_STYLE") == "true" else "auto"}),
)

# GMI Cloud is OpenAI-compatible; the summarize step uses it when a key is set.
GMI_API_KEY = os.environ.get("GMI_API_KEY")
GMI_BASE_URL = os.environ.get("GMI_BASE_URL", "https://api.gmi-serving.com")
GMI_MODEL = os.environ.get("GMI_MODEL", "deepseek-ai/DeepSeek-V3")


class Job(BaseModel):
    bucket: str
    key: str
    transferId: str
    gatewayUrl: str


def progress(job: "Job", event: dict) -> None:
    try:
        httpx.post(
            f"{job.gatewayUrl}/api/internal/progress",
            headers={"authorization": f"Bearer {SHARED}"},
            json={"transferId": job.transferId, **event},
            timeout=10,
        )
    except Exception as e:  # progress is best-effort
        print("progress post failed:", e)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def run_qc(src: str, meta: dict) -> dict:
    """Deterministic media QC (the checks broadcast QC tools sell):
    stream conformance, full-decode corruption pass, black/freeze/silence
    detection, and EBU R128 loudness. Pure ffmpeg/ffprobe — no AI keys.
    The AI-assisted QC lane (GMI vision models on sampled frames) plugs in
    alongside this once a GMI key is present."""
    checks: list[dict] = []

    def check(name: str, status: str, detail: str = "") -> None:
        checks.append({"name": name, "status": status, "detail": detail})

    streams = meta.get("streams", [])
    kinds = [s.get("codec_type") for s in streams]
    has_video = "video" in kinds
    has_audio = "audio" in kinds
    codecs = ", ".join(f"{s.get('codec_type')}/{s.get('codec_name')}" for s in streams)
    check("has_video", "pass" if has_video else "fail", codecs)
    check("has_audio", "pass" if has_audio else "warn", "")

    # 1) full-decode pass — corruption / bitstream errors
    dec = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-f", "null", "-"],
                         capture_output=True, text=True)
    errs = [ln for ln in dec.stderr.splitlines() if ln.strip()]
    check("decode", "pass" if not errs else "fail",
          f"{len(errs)} error line(s)" + (f"; first: {errs[0][:120]}" if errs else ""))

    # 2) detections + loudness in one analysis pass (filters gated on streams)
    cmd = ["ffmpeg", "-hide_banner", "-i", src]
    if has_video:
        cmd += ["-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2"]
    if has_audio:
        cmd += ["-af", "silencedetect=noise=-50dB:d=2,ebur128"]
    cmd += ["-f", "null", "-"]
    log = subprocess.run(cmd, capture_output=True, text=True).stderr

    if has_video:
        blacks = log.count("black_start")
        freezes = log.count("freeze_start")
        check("black_frames", "pass" if blacks == 0 else "warn", f"{blacks} black segment(s)")
        check("freeze_frames", "pass" if freezes == 0 else "warn", f"{freezes} frozen segment(s)")
    if has_audio:
        silences = log.count("silence_start")
        check("audio_silence", "pass" if silences == 0 else "warn", f"{silences} silent segment(s)")
        lufs_matches = re.findall(r"I:\s*(-?[\d.]+)\s*LUFS", log)
        if lufs_matches:
            lufs = float(lufs_matches[-1])  # last = the summary block
            check("loudness", "pass" if -30.0 <= lufs <= -10.0 else "warn",
                  f"integrated {lufs} LUFS (broadcast target ~ -23)")
        else:
            check("loudness", "warn", "could not measure")

    statuses = [c["status"] for c in checks]
    overall = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"status": overall, "checks": checks}


def summarize_via_gmi(meta: dict) -> str | None:
    if not GMI_API_KEY:
        return None
    fmt = meta.get("format", {})
    prompt = (
        "In one sentence, describe this media file for a recipient. "
        f"Duration {fmt.get('duration')}s, streams: "
        + ", ".join(s.get("codec_type", "?") + "/" + s.get("codec_name", "?") for s in meta.get("streams", []))
    )
    r = httpx.post(
        f"{GMI_BASE_URL}/v1/chat/completions",
        headers={"authorization": f"Bearer {GMI_API_KEY}"},
        json={"model": GMI_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def run_pipeline(job: Job) -> None:
    progress(job, {"type": "pipeline_started", "key": job.key})
    tid = job.transferId
    derivatives: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src")

        # 0. fetch the original from B2/MinIO
        progress(job, {"type": "step_started", "step": "fetch"})
        s3.download_file(job.bucket, job.key, src)
        src_sha = sha256_file(src)
        progress(job, {"type": "step_done", "step": "fetch", "sha256": src_sha})

        # 1. probe — real metadata
        progress(job, {"type": "step_started", "step": "probe"})
        try:
            meta = ffprobe(src)
            dur = meta.get("format", {}).get("duration")
            progress(job, {"type": "step_done", "step": "probe", "duration": dur,
                           "streams": [s.get("codec_type") for s in meta.get("streams", [])]})
        except Exception as e:
            meta = {}
            progress(job, {"type": "step_error", "step": "probe", "error": str(e)})

        # 2. thumbnail — real ffmpeg poster frame → derivative in B2
        progress(job, {"type": "step_started", "step": "thumbnail"})
        try:
            thumb = os.path.join(tmp, "thumb.jpg")
            subprocess.run(["ffmpeg", "-y", "-ss", "1", "-i", src, "-frames:v", "1",
                            "-vf", "scale=640:-1", thumb], capture_output=True, check=True)
            key = f"derivatives/{tid}/thumb.jpg"
            s3.upload_file(thumb, BUCKET, key, ExtraArgs={"ContentType": "image/jpeg"})
            derivatives.append({"step": "thumbnail", "key": key, "sha256": sha256_file(thumb), "mime": "image/jpeg"})
            progress(job, {"type": "step_done", "step": "thumbnail", "key": key,
                           "billable": {"unit": "run", "units": 1}})
        except Exception as e:
            progress(job, {"type": "step_error", "step": "thumbnail", "error": str(e)})

        # 3. QC — deterministic media checks (billable per media-minute)
        progress(job, {"type": "step_started", "step": "qc"})
        try:
            qc = run_qc(src, meta)
            qc_key = f"derivatives/{tid}/qc_report.json"
            qc_body = json.dumps(qc, indent=2).encode()
            s3.put_object(Bucket=BUCKET, Key=qc_key, Body=qc_body, ContentType="application/json")
            derivatives.append({"step": "qc", "key": qc_key,
                                "sha256": hashlib.sha256(qc_body).hexdigest(),
                                "mime": "application/json"})
            dur_min = float(meta.get("format", {}).get("duration", 0) or 0) / 60.0
            progress(job, {"type": "step_done", "step": "qc", "key": qc_key, "status": qc["status"],
                           "billable": {"unit": "minutes", "units": round(max(dur_min, 0.01), 3)}})
        except Exception as e:
            progress(job, {"type": "step_error", "step": "qc", "error": str(e)})

        # 4. summarize — GMI Cloud seam (skipped cleanly until a key is set)
        progress(job, {"type": "step_started", "step": "summarize"})
        summary = None
        try:
            summary = summarize_via_gmi(meta)
            progress(job, {"type": "step_done" if summary else "step_skipped",
                           "step": "summarize", "summary": summary, "reason": None if summary else "no GMI_API_KEY",
                           **({"billable": {"unit": "run", "units": 1}} if summary else {})})
        except Exception as e:
            progress(job, {"type": "step_error", "step": "summarize", "error": str(e)})

        # 4. provenance manifest (the Object Lock target). Interim shape;
        #    swap for the real Genblaze manifest when wiring genblaze-core.
        manifest = {
            "run_id": tid,
            "input": {"key": job.key, "sha256": src_sha},
            "steps": derivatives + ([{"step": "summarize", "provider": "gmicloud",
                                      "model": GMI_MODEL, "text": summary}] if summary else []),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mkey = f"derivatives/{tid}/manifest.json"
        put_args = dict(Bucket=BUCKET, Key=mkey,
                        Body=json.dumps(manifest, indent=2).encode(),
                        ContentType="application/json")
        locked_until = None
        if MANIFEST_LOCK_DAYS > 0:
            locked_until = datetime.now(timezone.utc) + timedelta(days=MANIFEST_LOCK_DAYS)
            put_args["ObjectLockMode"] = "COMPLIANCE"
            put_args["ObjectLockRetainUntilDate"] = locked_until
        s3.put_object(**put_args)
        progress(job, {"type": "manifest_written", "key": mkey,
                       "locked_until": locked_until.isoformat() if locked_until else None})

    progress(job, {"type": "pipeline_complete", "derivatives": [d["key"] for d in derivatives], "manifest": mkey})


@app.post("/jobs")
async def jobs(job: Job, bg: BackgroundTasks, authorization: str = Header(default="")):
    if authorization != f"Bearer {SHARED}":
        raise HTTPException(status_code=401, detail="forbidden")
    bg.add_task(run_pipeline, job)  # return fast; work happens in the background
    return {"accepted": True}


@app.get("/healthz")
async def healthz():
    return {"ok": True}
