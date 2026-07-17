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


# SRT/VTT cue: optional hours, comma (SRT) or dot (VTT) millisecond separator.
_CUE_TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})"
_CUE_RE = re.compile(_CUE_TS + r"\s*-->\s*" + _CUE_TS)


def _ts_seconds(h, m, s, ms) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def parse_caption_cues(text: str) -> list:
    """Tolerant SRT/WebVTT parser → [(start_s, end_s, cue_text), …]."""
    cues = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = _CUE_RE.search(lines[i])
        if m:
            start = _ts_seconds(*m.groups()[0:4])
            end = _ts_seconds(*m.groups()[4:8])
            body = []
            i += 1
            while i < len(lines) and lines[i].strip():
                body.append(lines[i].strip())
                i += 1
            cues.append((start, end, "\n".join(body)))
        i += 1
    return cues


def caption_checks(cues: list, duration: float, source: str) -> list:
    """Deterministic caption QC: timing sanity, readability limits, coverage.
    Thresholds follow common broadcast subtitle specs (~20 CPS, 42 chars/line,
    max 2 lines per cue)."""
    checks = []
    n = len(cues)
    if n == 0:
        return [{"name": "captions_valid", "status": "warn",
                 "detail": f"{source}: no cues could be parsed"}]
    checks.append({"name": "captions_valid", "status": "pass", "detail": f"{source}: {n} cue(s) parsed"})

    overlaps = sum(1 for i in range(1, n) if cues[i][0] < cues[i - 1][1])
    out_of_order = sum(1 for i in range(1, n) if cues[i][0] < cues[i - 1][0])
    past_eof = sum(1 for c in cues if duration and c[1] > duration + 1.0)
    timing_issues = overlaps + out_of_order + past_eof
    checks.append({"name": "caption_timing", "status": "pass" if timing_issues == 0 else "warn",
                   "detail": f"{overlaps} overlap(s), {past_eof} past end-of-video, {out_of_order} out-of-order"})

    cps_viol = line_viol = 0
    for (st, en, txt) in cues:
        dur = max(en - st, 0.001)
        if len(txt.replace("\n", "")) / dur > 20.0:
            cps_viol += 1
        cue_lines = txt.split("\n")
        if len(cue_lines) > 2 or any(len(ln) > 42 for ln in cue_lines):
            line_viol += 1
    checks.append({"name": "caption_readability", "status": "pass" if cps_viol + line_viol == 0 else "warn",
                   "detail": f"{cps_viol} cue(s) over 20 CPS, {line_viol} cue(s) over line limits"})

    covered = sum(max(min(en, duration or en) - st, 0) for st, en, _ in cues)
    pct = f", {round(100 * covered / duration, 1)}% of runtime covered" if duration else ""
    checks.append({"name": "caption_coverage", "status": "pass", "detail": f"{n} cue(s){pct}"})
    return checks


def run_qc(src: str, meta: dict, captions_path: str | None = None,
           check_av: bool = True, check_captions: bool = True) -> dict:
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

    if check_av:
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

    # 3) captions & subtitles — presence, then text QC on whatever we can read:
    #    a sidecar .srt/.vtt if provided, else the first embedded text track.
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"] if check_captions else []
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    cap_text = cap_source = None
    if captions_path:
        with open(captions_path, encoding="utf-8", errors="replace") as f:
            cap_text = f.read()
        cap_source = "sidecar " + os.path.basename(captions_path)
    elif sub_streams:
        extracted = os.path.join(os.path.dirname(src) or ".", "embedded_captions.srt")
        r = subprocess.run(["ffmpeg", "-y", "-i", src, "-map", "0:s:0", "-c:s", "srt", extracted],
                           capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(extracted):
            with open(extracted, encoding="utf-8", errors="replace") as f:
                cap_text = f.read()
            cap_source = "embedded track"

    if check_captions:
        if captions_path or sub_streams:
            detail = " + ".join(filter(None, [
                "sidecar file" if captions_path else None,
                f"{len(sub_streams)} embedded track(s)" if sub_streams else None]))
            check("captions_present", "pass", detail)
            if cap_text is not None:
                checks.extend(caption_checks(parse_caption_cues(cap_text), duration, cap_source))
            else:
                check("captions_valid", "warn",
                      "subtitle track not text-extractable (bitmap subs?) — text checks skipped")
        else:
            check("captions_present", "warn",
                  "no caption track or sidecar found (mastered deliveries usually require captions)")

    statuses = [c["status"] for c in checks]
    overall = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
    return {"status": overall, "checks": checks}


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


def load_caption_cues(src: str, captions_path: str | None, tmp: str) -> list:
    """Caption cues from the sidecar if present, else the first embedded track."""
    text = None
    if captions_path:
        with open(captions_path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    else:
        extracted = os.path.join(tmp, "ai_embedded.srt")
        r = subprocess.run(["ffmpeg", "-y", "-i", src, "-map", "0:s:0", "-c:s", "srt", extracted],
                           capture_output=True)
        if r.returncode == 0 and os.path.exists(extracted):
            with open(extracted, encoding="utf-8", errors="replace") as f:
                text = f.read()
    return parse_caption_cues(text) if text else []


_VISUAL_PROMPT = (
    "You are a broadcast QC operator. These are frames sampled from a mastered "
    "video delivery. Report ONLY genuine delivery defects you can actually see: "
    "test patterns or color bars, slates or countdown leaders, all-black or blank "
    "frames, severe compression artifacts or corruption, burned-in timecode, "
    "watermarks or channel bugs, accidental letterboxing/pillarboxing. "
    "Normal program content is NOT a defect. Respond with STRICT JSON only:\n"
    '{"findings": [{"issue": "<short description>", "frames": [<1-based frame numbers>]}], '
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
        return {"name": "ai_visual", "status": "warn",
                "detail": f"{used} frame(s) reviewed; model reply unparseable"}, used
    findings = data.get("findings") or []
    if findings:
        detail = "; ".join(str(f.get("issue", "?")) for f in findings[:5])
        return {"name": "ai_visual", "status": "warn",
                "detail": f"{len(findings)} finding(s) in {used} frame(s): {detail}"}, used
    summary = str(data.get("summary", "")).strip()
    return {"name": "ai_visual", "status": "pass",
            "detail": f"{used} frame(s) reviewed, no defects" + (f" — {summary}" if summary else "")}, used


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


def run_ai_qc(src: str, meta: dict, captions_path: str | None, tmp: str) -> tuple:
    """→ (checks, {"frames": n, "asr_seconds": s}) for the qc_ai step."""
    checks: list = []
    frames, asr_seconds = 0, 0.0
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    if any(s.get("codec_type") == "video" for s in meta.get("streams", [])):
        check, frames = ai_visual_check(src, duration, tmp)
        if check:
            checks.append(check)
    cues = load_caption_cues(src, captions_path, tmp)
    if cues:
        check, asr_seconds = ai_caption_accuracy_check(src, meta, cues, tmp)
        if check:
            checks.append(check)
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
    # Sender-selected services (missing = everything on).
    opts = {"thumbnail": True, "qc_av": True, "qc_captions": True, "qc_ai": True, "summarize": True}
    if job.options:
        opts.update({k: bool(v) for k, v in job.options.items()})
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
        captions_path = None
        try:
            listing = s3.list_objects_v2(Bucket=job.bucket, Prefix=f"transfers/{tid}/")
            for obj in listing.get("Contents", []):
                k = obj["Key"]
                if k.lower().endswith((".srt", ".vtt")) and k != job.key:
                    captions_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, captions_path)
                    break
        except Exception as e:
            print("caption sidecar lookup failed:", e)

        qc_report = None
        if opts["qc_av"] or opts["qc_captions"]:
            progress(job, {"type": "step_started", "step": "qc"})
            try:
                qc_report = run_qc(src, meta,
                                   captions_path if opts["qc_captions"] else None,
                                   check_av=opts["qc_av"], check_captions=opts["qc_captions"])
                dur_min = float(meta.get("format", {}).get("duration", 0) or 0) / 60.0
                progress(job, {"type": "step_done", "step": "qc", "status": qc_report["status"],
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
                    ai_checks, ai_units = run_ai_qc(src, meta, captions_path, tmp)
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

        # 3c. one provenance-covered report for both lanes
        if qc_report is not None:
            statuses = [c["status"] for c in qc_report["checks"]]
            qc_report["status"] = "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass")
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
