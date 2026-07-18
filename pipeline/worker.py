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

import base64
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3
import httpx
from botocore.config import Config
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from genblaze_core.models import Asset as GbAsset
from genblaze_core.models import Manifest as GbManifest
from genblaze_core.models import Run as GbRun
from genblaze_core.models import Step as GbStep
from genblaze_core.models.enums import Modality, RunStatus, StepStatus, StepType
from pydantic import BaseModel

from qc import audio as qaudio
from qc import heal as qheal
from qc import imf as qimf
from qc import profiles as qprofiles
from qc import report as qreport
from qc import structural as qstructural
from qc import text as qtext
from qc import video as qvideo
from qc.text import load_caption_cues, load_caption_text, parse_caption_cues

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
# Confirmed served on GMI's Inference Engine (GET /v1/models); cheap + fast.
# Override with GMI_MODEL for anything else in their 75-model catalog.
# (`or` guards an empty GMI_MODEL= line in .env.)
GMI_MODEL = os.environ.get("GMI_MODEL") or "openai/gpt-4o-mini"
# AI-assisted QC needs a natively multimodal model: the gemini family on GMI
# accepts both image_url AND input_audio parts through the OpenAI-compatible
# API (probed live — no whisper/ASR models are served, but gemini transcribes
# audio verbatim). Kept separate from GMI_MODEL so text summaries can use a
# cheaper model.
GMI_MULTIMODAL_MODEL = os.environ.get("GMI_MULTIMODAL_MODEL") or "google/gemini-3.5-flash"
AI_QC_FRAMES = int(os.environ.get("AI_QC_FRAMES", "4"))
AI_QC_ASR_SECONDS = float(os.environ.get("AI_QC_ASR_SECONDS", "45"))


class Job(BaseModel):
    bucket: str
    key: str
    transferId: str
    gatewayUrl: str
    # Sender-selected services. Missing/None = everything on (default).
    # {"thumbnail", "qc_av", "qc_captions", "qc_ai", "summarize"} → bool
    # Sender-selected services; None = everything on. (Optional[...] not `| None`:
    # pydantic evaluates this at runtime, and the py3.9 venv has no PEP 604.)
    options: Optional[dict] = None


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


# Caption parsing/QC now lives in qc/text.py (imported above); the AI lane and
# summarize step keep using parse_caption_cues / load_caption_* from there.


def run_qc(src: str, meta: dict, captions_path: str | None = None,
           check_av: bool = True, check_captions: bool = True,
           profile: dict | None = None, key: str = "", tmp: str = ".",
           ref_path: str | None = None) -> dict:
    """Deterministic QC orchestrator — profile-driven, tiered, resilient.
    Execution order per the delivery architecture: structural parsing first,
    then signal-level video/audio metrics, then text. Each analyzer group is
    isolated so one crashed probe degrades to a finding instead of killing
    the report. The semantic AI layer (run_ai_qc) appends afterwards."""
    profile = profile or qprofiles.get("standard")
    checks: list[dict] = []

    def guarded(fn, *args, group=""):
        try:
            checks.extend(fn(*args) or [])
        except Exception as e:  # analyzer resilience: degrade, don't die
            checks.append(qreport.check(f"{group or fn.__name__}", "warn",
                                        f"analyzer error: {str(e)[:140]}", "engine"))

    streams = meta.get("streams", [])
    kinds = [s.get("codec_type") for s in streams]
    has_video, has_audio = "video" in kinds, "audio" in kinds
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    bit_depth = 10 if "10le" in str(v.get("pix_fmt", "")) else 8

    if check_av:
        codecs = ", ".join(f"{s.get('codec_type')}/{s.get('codec_name')}" for s in streams)
        checks.append(qreport.check("has_video", "pass" if has_video else "fail", codecs))
        checks.append(qreport.check("has_audio", "pass" if has_audio else "warn", "", "audio"))

        # ── Task 1: structural parsing first ──
        guarded(qstructural.timecode_checks, src, group="timecode_continuity")
        guarded(qstructural.container_checks, meta, key, profile, group="container_metadata")
        if key.lower().endswith((".m3u8", ".mpd")):
            guarded(qstructural.abr_lint, src, group="abr_manifest")
        guarded(qimf.photon_checks, src, tmp, profile, group="imf_photon")

        # ── Task 2: signal video quality ──
        blacks: list = []
        if True:
            try:
                det, blacks = qvideo.decode_and_detections(src, has_video, has_audio)
                checks.extend(det)
            except Exception as e:
                checks.append(qreport.check("decode", "warn", f"analyzer error: {str(e)[:140]}", "engine"))
        if has_video:
            guarded(qstructural.framerate_checks, src, meta, profile, group="framerate")
            guarded(qvideo.boundary_check, blacks, duration, group="picture_boundaries")
            guarded(qvideo.range_and_pse, src, duration, profile, bit_depth, group="video_legal_range")
            guarded(qvideo.matte_and_aspect, src, meta, duration, group="letterbox_matte")
            guarded(qvideo.upconversion_check, src, meta, duration, group="upconversion")
            guarded(qvideo.operational_metadata, src, meta, profile, group="cc_metadata")
            if ref_path:
                guarded(qvideo.reference_checks, src, ref_path, tmp, group="reference_ssim")

        # ── Task 3: audio analysis ──
        if has_audio:
            guarded(qaudio.loudness_checks, src, profile, group="loudness")
            guarded(qaudio.phase_check, src, meta, group="audio_phase")
            guarded(qaudio.clipping_and_hum, src, group="audio_clipping")
            guarded(qaudio.channel_map_check, meta, group="channel_map")

    # ── Task 4: captions, subtitles & text ──
    if check_captions:
        sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]
        cap_text = None
        try:
            cap_text = load_caption_text(src, captions_path, tmp)
        except Exception:
            pass
        if captions_path or sub_streams:
            detail = " + ".join(filter(None, [
                "sidecar file" if captions_path else None,
                f"{len(sub_streams)} embedded track(s)" if sub_streams else None]))
            checks.append(qreport.check("captions_present", "pass", detail, "text"))
            if cap_text is not None:
                source = ("sidecar " + os.path.basename(captions_path)) if captions_path else "embedded track"
                cues = parse_caption_cues(cap_text)
                guarded(lambda: qtext.caption_checks(cues, duration, source), group="caption_timing")
                guarded(lambda: qtext.text_integrity_checks(cap_text), group="caption_encoding")
                if has_audio:
                    guarded(lambda: qtext.sync_check(src, cues, duration), group="caption_sync")
            else:
                checks.append(qreport.check("captions_valid", "warn",
                                            "subtitle track not text-extractable (bitmap subs?) — "
                                            "text checks skipped", "text"))
        else:
            checks.append(qreport.check("captions_present", "warn",
                                        "no caption track or sidecar found (mastered deliveries "
                                        "usually require captions)", "text"))

    return qreport.finalize({"checks": checks}, profile)


# ───────────────────────── AI-assisted QC lane ─────────────────────────
# Runs beside the deterministic lane, gated by the sender's `qc_ai` toggle:
#   ai_visual           — GMI vision reviews sampled frames for delivery
#                         defects a filter can't name (test patterns, slates,
#                         watermarks, burned-in timecode, letterboxing).
#   ai_caption_accuracy — GMI transcribes a sampled audio window and the
#                         transcript is diffed (word error rate) against the
#                         caption text for that window. This is the QC
#                         instrument for "are these captions actually right?"
# All verdicts land in the same qc_report.json, provenance-covered.

def _gmi_chat(content: list, max_tokens: int = 600) -> str:
    r = httpx.post(
        f"{GMI_BASE_URL}/v1/chat/completions",
        headers={"authorization": f"Bearer {GMI_API_KEY}"},
        json={"model": GMI_MULTIMODAL_MODEL, "max_tokens": max_tokens, "temperature": 0,
              "messages": [{"role": "user", "content": content}]},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _json_from(text: str) -> dict | None:
    """Extract the first JSON object from a model reply (tolerates fences/prose)."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _norm_words(text: str) -> list:
    return re.findall(r"[a-z0-9']+", text.lower())


def word_error_rate(ref: list, hyp: list) -> float:
    """Standard word-level Levenshtein WER (substitutions+insertions+deletions / len(ref))."""
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, rw in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, hw in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / len(ref)


_VISUAL_PROMPT = (
    "You are a broadcast QC operator. These are frames sampled from a mastered "
    "video delivery. Report ONLY genuine delivery defects you can actually see: "
    "test patterns or color bars, slates or countdown leaders, all-black or blank "
    "frames, macroblocking / heavy pixelation / compression breakdown, tape-hit "
    "lines or digital dropouts, burned-in timecode, watermarks or channel bugs, "
    "burned-in text or logos, accidental letterboxing/pillarboxing, censorship "
    "artifacts (blur patches, mosaic/pixelation blocks over faces or objects), "
    "graphic violence, or nudity. Normal program content is NOT a defect. "
    "Respond with STRICT JSON only:\n"
    '{"findings": [{"issue": "<short description>", '
    '"category": "<test_pattern|slate|black|compression|dropout|timecode|watermark|'
    'burned_text|matte|censorship|violence|nudity|other>", '
    '"frames": [<1-based frame numbers>]}], '
    '"summary": "<one short sentence about what the frames show>"}\n'
    "Use an empty findings array if the frames look clean."
)


def ai_visual_check(src: str, duration: float, tmp: str) -> tuple:
    """(check-dict | None, frames-analyzed). One vision call over all samples."""
    n = max(AI_QC_FRAMES, 1)
    dur = max(duration, 0.5)
    parts: list = [{"type": "text", "text": _VISUAL_PROMPT}]
    used = 0
    for i in range(n):
        t = dur * (i + 1) / (n + 1)  # evenly spaced, skips first/last stretch
        fp = os.path.join(tmp, f"ai_frame_{i}.jpg")
        subprocess.run(["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1",
                        "-vf", "scale=512:-2", fp], capture_output=True)
        if os.path.exists(fp) and os.path.getsize(fp) > 0:
            b64 = base64.b64encode(open(fp, "rb").read()).decode()
            parts.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
            used += 1
    if used == 0:
        return None, 0
    data = _json_from(_gmi_chat(parts))
    if data is None:
        return [{"name": "ai_visual", "status": "warn", "tier": "ISSUE",
                 "detail": f"{used} frame(s) reviewed; model reply unparseable"}], used
    findings = data.get("findings") or []
    checks = []
    if findings:
        detail = "; ".join(str(f.get("issue", "?")) for f in findings[:5])
        checks.append({"name": "ai_visual", "status": "warn", "tier": "ISSUE",
                       "detail": f"{len(findings)} finding(s) in {used} frame(s): {detail}"})
    else:
        summary = str(data.get("summary", "")).strip()
        checks.append({"name": "ai_visual", "status": "pass",
                       "detail": f"{used} frame(s) reviewed, no defects" + (f" — {summary}" if summary else "")})
    # Rule 3 (censorship): blur/mosaic/bleep artifacts get their own check so
    # the strict profile can hard-fail them.
    cens = [f for f in findings
            if f.get("category") == "censorship"
            or re.search(r"blur|mosaic|pixelat.*censor|bleep", str(f.get("issue", "")), re.I)]
    if cens:
        checks.append({"name": "ai_censorship", "status": "fail", "tier": "BLOCKER",
                       "detail": f"censorship element(s) detected: "
                                 f"{'; '.join(str(f.get('issue')) for f in cens[:3])}"})
    return checks, used


def ai_caption_accuracy_check(src: str, meta: dict, cues: list, tmp: str) -> tuple:
    """(check-dict | None, asr-seconds). Transcribe a sampled window, WER it
    against the caption text covering that window."""
    if not any(s.get("codec_type") == "audio" for s in meta.get("streams", [])):
        return None, 0.0  # nothing to transcribe; has_audio already warns in the AV lane
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    window = min(AI_QC_ASR_SECONDS, duration) if duration else AI_QC_ASR_SECONDS
    t0 = max(0.0, min(duration * 0.1, max(duration - window, 0.0)))
    wav = os.path.join(tmp, "ai_asr.wav")
    subprocess.run(["ffmpeg", "-y", "-ss", f"{t0:.2f}", "-t", f"{window:.2f}", "-i", src,
                    "-vn", "-ac", "1", "-ar", "16000", wav], capture_output=True)
    if not os.path.exists(wav) or os.path.getsize(wav) < 1000:
        return None, 0.0
    b64 = base64.b64encode(open(wav, "rb").read()).decode()
    reply = _gmi_chat([
        {"type": "text", "text": "Transcribe this audio verbatim. Output ONLY the spoken words. "
                                 "If there is no speech, output exactly: [no speech]"},
        {"type": "input_audio", "input_audio": {"data": b64, "format": "wav"}}])
    hyp = [] if "[no speech]" in reply.lower() else _norm_words(reply)
    ref = _norm_words(" ".join(txt for (st, en, txt) in cues if en > t0 and st < t0 + window))
    span = f"{t0:.0f}s–{t0 + window:.0f}s window"
    if not ref:
        return {"name": "ai_caption_accuracy", "status": "warn",
                "detail": f"no caption text within the sampled {span}"}, window
    if not hyp:
        return {"name": "ai_caption_accuracy", "status": "warn",
                "detail": f"captions present but no speech recognized in the {span}"}, window
    acc = max(0.0, 1.0 - word_error_rate(ref, hyp))
    return {"name": "ai_caption_accuracy", "status": "pass" if acc >= 0.80 else "warn",
            "detail": f"{round(acc * 100, 1)}% word match between captions and speech "
                      f"({len(ref)} caption vs {len(hyp)} spoken words, {span})"}, window


def ai_language_check(src: str, meta: dict, tmp: str) -> dict | None:
    """Verify the spoken language matches the declared metadata tag (only runs
    when the container actually declares one)."""
    a = next((s for s in meta.get("streams", []) if s.get("codec_type") == "audio"), None)
    declared = ((a or {}).get("tags", {}) or {}).get("language", "").lower()
    if not a or declared in ("", "und"):
        return None
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    window = min(20.0, duration) if duration else 20.0
    wav = os.path.join(tmp, "ai_lang.wav")
    subprocess.run(["ffmpeg", "-y", "-t", f"{window:.2f}", "-i", src,
                    "-vn", "-ac", "1", "-ar", "16000", wav], capture_output=True)
    if not os.path.exists(wav) or os.path.getsize(wav) < 1000:
        return None
    b64 = base64.b64encode(open(wav, "rb").read()).decode()
    reply = _gmi_chat([
        {"type": "text", "text": "Identify the language spoken in this audio. "
                                 "Reply with ONLY the ISO 639-2 three-letter code (e.g. eng, spa, fra). "
                                 "If there is no speech, reply exactly: none"},
        {"type": "input_audio", "input_audio": {"data": b64, "format": "wav"}}], max_tokens=10)
    heard = reply.strip().lower()[:3]
    if heard in ("non", ""):
        return {"name": "ai_language", "status": "info", "tier": "FYI",
                "detail": f"declared '{declared}' but no speech recognized in the sample"}
    if heard == declared[:3]:
        return {"name": "ai_language", "status": "pass",
                "detail": f"spoken language matches declared tag '{declared}'"}
    return {"name": "ai_language", "status": "warn", "tier": "ISSUE",
            "detail": f"declared '{declared}' but heard '{heard}' in the sample"}


def ai_text_compliance_check(cap_text: str) -> dict | None:
    """NLP pass over the timed text: profanity + regional-compliance screen."""
    reply = _gmi_chat([{
        "type": "text",
        "text": "You are a content-compliance reviewer. Analyze this subtitle text for "
                "profanity and regional compliance concerns (slurs, hate speech, adult content). "
                "Respond with STRICT JSON only: "
                '{"profanity_count": <int>, "flags": ["<short description>", ...]}\n\n'
                + cap_text[:3000]}], max_tokens=200)
    data = _json_from(reply)
    if data is None:
        return {"name": "ai_text_compliance", "status": "info", "tier": "FYI",
                "detail": "compliance reply unparseable"}
    n = int(data.get("profanity_count") or 0)
    flags = data.get("flags") or []
    if n or flags:
        return {"name": "ai_text_compliance", "status": "warn", "tier": "ISSUE",
                "detail": f"{n} profanity hit(s); {'; '.join(map(str, flags[:3])) or 'no other flags'}"}
    return {"name": "ai_text_compliance", "status": "pass", "detail": "no profanity or compliance flags"}


def run_ai_qc(src: str, meta: dict, captions_path: str | None, tmp: str,
              profile: dict | None = None) -> tuple:
    """Semantic AI layer → (checks, {"frames": n, "asr_seconds": s}).
    Vision review, censorship screen (Rule 3), caption accuracy vs ASR,
    spoken-language verification, and timed-text compliance."""
    profile = profile or qprofiles.get("standard")
    checks: list = []
    frames, asr_seconds = 0, 0.0
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    if any(s.get("codec_type") == "video" for s in meta.get("streams", [])):
        vis_checks, frames = ai_visual_check(src, duration, tmp)
        for c in vis_checks or []:
            if c["name"] == "ai_censorship" and not profile["censorship"]["escalate"]:
                c["status"], c["tier"] = "warn", "ISSUE"   # standard: review, don't block
            checks.append(c)
    cues = load_caption_cues(src, captions_path, tmp)
    if cues:
        check, asr_seconds = ai_caption_accuracy_check(src, meta, cues, tmp)
        if check:
            checks.append(check)
        try:
            cap_text = load_caption_text(src, captions_path, tmp)
            if cap_text:
                c = ai_text_compliance_check(cap_text)
                if c:
                    checks.append(c)
        except Exception as e:
            print("text compliance failed:", e)
    try:
        c = ai_language_check(src, meta, tmp)
        if c:
            checks.append(c)
    except Exception as e:
        print("language check failed:", e)
    return checks, {"frames": frames, "asr_seconds": round(asr_seconds, 1)}


def summarize_via_gmi(meta: dict, captions_text: str | None = None) -> str | None:
    if not GMI_API_KEY:
        return None
    fmt = meta.get("format", {})
    parts = []
    for s in meta.get("streams", []):
        if s.get("codec_type") == "video":
            parts.append(f"video {s.get('codec_name')} {s.get('width')}x{s.get('height')}")
        elif s.get("codec_type") == "audio":
            parts.append(f"audio {s.get('codec_name')}")
    prompt = (
        "Write ONE concise sentence describing this media delivery for its recipient. "
        "Use only the information given. Never mention missing information, metadata, "
        "or that you cannot see the file.\n"
        f"Technical: duration {fmt.get('duration')}s; {', '.join(parts)}.\n"
    )
    if captions_text:
        prompt += f"Captions/dialogue from the file:\n{captions_text[:2000]}\n"
    prompt += "One sentence:"
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
    # Sender-selected services (missing = everything on). Non-boolean keys in
    # options carry the QC profile and self-heal switch — don't coerce those.
    SERVICE_FLAGS = ("thumbnail", "qc_av", "qc_captions", "qc_ai", "summarize")
    opts = {k: True for k in SERVICE_FLAGS}
    if job.options:
        for k in SERVICE_FLAGS:
            if k in job.options:
                opts[k] = bool(job.options[k])
    profile = qprofiles.get((job.options or {}).get("profile", "standard"))
    self_heal = bool((job.options or {}).get("self_heal"))
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
        if opts["thumbnail"]:
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
        else:
            progress(job, {"type": "step_skipped", "step": "thumbnail", "reason": "disabled by sender"})

        # 3. QC — deterministic media checks (billable per media-minute).
        #    A caption sidecar (.srt/.vtt) uploaded alongside the master rides
        #    into the caption QC; it never triggers its own pipeline run (the
        #    gateway's event filter excludes those extensions).
        captions_path = ref_path = None
        try:
            listing = s3.list_objects_v2(Bucket=job.bucket, Prefix=f"transfers/{tid}/")
            for obj in listing.get("Contents", []):
                k = obj["Key"]
                if k == job.key:
                    continue
                if k.lower().endswith((".srt", ".vtt")) and not captions_path:
                    captions_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, captions_path)
                elif ".ref." in k.lower() and not ref_path:
                    # source-master mezzanine → reference SSIM/PSNR/VMAF lane
                    ref_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, ref_path)
        except Exception as e:
            print("sidecar lookup failed:", e)

        qc_report = None
        if opts["qc_av"] or opts["qc_captions"]:
            progress(job, {"type": "step_started", "step": "qc", "profile": profile["name"]})
            try:
                qc_report = run_qc(src, meta,
                                   captions_path if opts["qc_captions"] else None,
                                   check_av=opts["qc_av"], check_captions=opts["qc_captions"],
                                   profile=profile, key=job.key, tmp=tmp, ref_path=ref_path)
                dur_min = float(meta.get("format", {}).get("duration", 0) or 0) / 60.0
                progress(job, {"type": "step_done", "step": "qc", "status": qc_report["status"],
                               "tiers": qc_report["tiers"],
                               "billable": {"unit": "minutes", "units": round(max(dur_min, 0.01), 3)}})
            except Exception as e:
                progress(job, {"type": "step_error", "step": "qc", "error": str(e)})
        else:
            progress(job, {"type": "step_skipped", "step": "qc", "reason": "disabled by sender"})

        # 3b. AI-assisted QC — GMI multimodal beside the deterministic lane.
        #     Vision review of sampled frames + ASR caption-accuracy diff.
        #     Uses the sidecar regardless of the qc_captions toggle: this is
        #     its own service. Verdicts merge into the same qc_report.json.
        if opts["qc_ai"]:
            if not GMI_API_KEY:
                progress(job, {"type": "step_skipped", "step": "qc_ai", "reason": "no GMI_API_KEY"})
            else:
                progress(job, {"type": "step_started", "step": "qc_ai"})
                try:
                    ai_checks, ai_units = run_ai_qc(src, meta, captions_path, tmp, profile)
                    if qc_report is None:
                        qc_report = {"status": "pass", "checks": []}
                    qc_report["checks"].extend(ai_checks)
                    qc_report["ai"] = {"model": GMI_MULTIMODAL_MODEL, **ai_units}
                    progress(job, {"type": "step_done", "step": "qc_ai",
                                   "checks": [c["name"] for c in ai_checks],
                                   "billable": {"unit": "frames", "units": ai_units["frames"]}})
                    if ai_units["asr_seconds"]:
                        # second billable line: ASR is metered in seconds
                        progress(job, {"type": "step_metered", "step": "qc_ai_asr",
                                       "billable": {"unit": "seconds", "units": ai_units["asr_seconds"]}})
                except Exception as e:
                    progress(job, {"type": "step_error", "step": "qc_ai", "error": str(e)})
        else:
            progress(job, {"type": "step_skipped", "step": "qc_ai", "reason": "disabled by sender"})

        # 3c. self-healing (Task 6) — when enabled and the report shows healable
        #     defects, produce a corrected copy, re-measure it with the same
        #     instruments, and record the fix as its own provenance-covered step.
        if qc_report is not None:
            qc_report = qreport.finalize(qc_report, profile)
            if self_heal:
                bad = {c["name"] for c in qc_report["checks"] if c["status"] in ("warn", "fail")}
                fix_audio = bool(bad & {"loudness", "true_peak", "audio_clipping"})
                fix_video = "video_legal_range" in bad
                if fix_audio or fix_video:
                    progress(job, {"type": "step_started", "step": "heal"})
                    try:
                        t = profile["heal"]
                        healed = qheal.heal(src, tmp, fix_audio, fix_video,
                                            t["target_i"], t["target_tp"])
                        if healed:
                            hname = "healed_" + os.path.basename(job.key)
                            hkey = f"derivatives/{tid}/{hname}"
                            s3.upload_file(healed["path"], BUCKET, hkey,
                                           ExtraArgs={"ContentType": "video/mp4"})
                            derivatives.append({"step": "heal", "key": hkey,
                                                "sha256": sha256_file(healed["path"]),
                                                "mime": "video/mp4"})
                            after = healed.get("after") or {}
                            verified = (after.get("i") is not None
                                        and abs(after["i"] - t["target_i"]) <= 1.2
                                        and (after.get("tp") is None or after["tp"] <= t["target_tp"] + 0.3))
                            detail = healed["detail"]
                            if after.get("i") is not None:
                                detail += (f" — re-measured: {after['i']} LUFS, "
                                           f"TP {after.get('tp')} dBTP")
                            qc_report["checks"].append(
                                {"name": "self_heal", "status": "pass" if verified or not fix_audio else "warn",
                                 "detail": detail, "category": "heal"})
                            qc_report = qreport.finalize(qc_report, profile)
                            progress(job, {"type": "step_done", "step": "heal", "key": hkey,
                                           "billable": {"unit": "run", "units": 1}})
                        else:
                            progress(job, {"type": "step_error", "step": "heal",
                                           "error": "healer produced no output"})
                    except Exception as e:
                        progress(job, {"type": "step_error", "step": "heal", "error": str(e)})
                else:
                    progress(job, {"type": "step_skipped", "step": "heal",
                                   "reason": "nothing healable in the report"})

        # 3d. one provenance-covered report for all lanes (deterministic + AI + heal)
        if qc_report is not None:
            qc_key = f"derivatives/{tid}/qc_report.json"
            qc_body = json.dumps(qc_report, indent=2).encode()
            s3.put_object(Bucket=BUCKET, Key=qc_key, Body=qc_body, ContentType="application/json")
            derivatives.append({"step": "qc", "key": qc_key,
                                "sha256": hashlib.sha256(qc_body).hexdigest(),
                                "mime": "application/json"})

        # 4. summarize — GMI Cloud seam (skipped cleanly until a key is set)
        summary = None
        if opts["summarize"]:
            progress(job, {"type": "step_started", "step": "summarize"})
            cap_text_for_summary = None
            if captions_path:
                try:
                    with open(captions_path, encoding="utf-8", errors="replace") as f:
                        cap_text_for_summary = f.read()
                except Exception:
                    pass
            try:
                summary = summarize_via_gmi(meta, cap_text_for_summary)
                progress(job, {"type": "step_done" if summary else "step_skipped",
                               "step": "summarize", "summary": summary, "reason": None if summary else "no GMI_API_KEY",
                               **({"billable": {"unit": "run", "units": 1}} if summary else {})})
            except Exception as e:
                progress(job, {"type": "step_error", "step": "summarize", "error": str(e)})
        else:
            progress(job, {"type": "step_skipped", "step": "summarize", "reason": "disabled by sender"})

        # 4. provenance manifest — a REAL Genblaze manifest (genblaze-core),
        #    canonical-hashed by the SDK and verified with the SDK's own
        #    verifier before upload. B2 Object Lock stays the trust anchor
        #    (the manifest itself is tamper-evident, not tamper-proof).
        src_asset = GbAsset(
            asset_id="master", url=f"s3://{BUCKET}/{job.key}",
            media_type="video/mp4", sha256=src_sha, size_bytes=os.path.getsize(src),
            duration=float(meta.get("format", {}).get("duration", 0) or 0) or None)
        STEP_INFO = {   # provider/model/type/modality per pipeline step
            "thumbnail": ("ffmpeg", "ffmpeg/poster-frame", StepType.TRANSCODE, Modality.IMAGE),
            "qc": ("waystation", "qc-engine/deterministic+ai", StepType.CUSTOM, Modality.TEXT),
            "heal": ("ffmpeg", "loudnorm+limiter", StepType.TRANSCODE, Modality.VIDEO),
        }
        gb_steps = []
        for i, d in enumerate(derivatives):
            prov, model, stype, mod = STEP_INFO.get(d["step"], ("waystation", d["step"], StepType.CUSTOM, Modality.TEXT))
            gb_steps.append(GbStep(
                step_id=d["step"], run_id=tid, provider=prov, model=model,
                step_type=stype, modality=mod, status=StepStatus.SUCCEEDED,
                step_index=i, inputs=[src_asset],
                assets=[GbAsset(asset_id=d["step"] + "-out", url=f"s3://{BUCKET}/{d['key']}",
                                media_type=d["mime"], sha256=d["sha256"])]))
        if summary:
            gb_steps.append(GbStep(
                step_id="summarize", run_id=tid, provider="gmicloud", model=GMI_MODEL,
                step_type=StepType.GENERATE, modality=Modality.TEXT,
                status=StepStatus.SUCCEEDED, step_index=len(gb_steps),
                inputs=[src_asset], metadata={"summary": summary}))
        manifest = GbManifest(run=GbRun(
            run_id=tid, name="waystation-delivery", status=RunStatus.COMPLETED,
            steps=gb_steps, completed_at=datetime.now(timezone.utc),
            metadata={"transferId": tid, "profile": profile["name"], "services": opts,
                      **({"qc_status": qc_report["status"], "qc_tiers": qc_report["tiers"]}
                         if qc_report else {})}))
        mkey = f"derivatives/{tid}/manifest.json"
        manifest.manifest_uri = f"s3://{BUCKET}/{mkey}"
        manifest.canonical_hash = manifest.compute_hash()
        assert manifest.verify_hash(), "genblaze manifest failed self-verification"
        put_args = dict(Bucket=BUCKET, Key=mkey,
                        Body=manifest.model_dump_json(indent=2).encode(),
                        ContentType="application/json")
        locked_until = None
        if MANIFEST_LOCK_DAYS > 0:
            locked_until = datetime.now(timezone.utc) + timedelta(days=MANIFEST_LOCK_DAYS)
            put_args["ObjectLockMode"] = "COMPLIANCE"
            put_args["ObjectLockRetainUntilDate"] = locked_until
        s3.put_object(**put_args)
        progress(job, {"type": "manifest_written", "key": mkey,
                       "schema": f"genblaze/{manifest.schema_version}",
                       "canonical_hash": manifest.canonical_hash,
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
