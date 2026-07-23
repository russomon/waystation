"""
Waystation — Genblaze pipeline worker.

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
import time
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
from genblaze_core.exceptions import ProviderError
from genblaze_core.models.enums import RETRYABLE_ERROR_CODES
from genblaze_gmicloud import chat as gb_gmi_chat
from pydantic import BaseModel

from qc import agentic as qagentic
from qc import audio as qaudio
from qc import avsync as qavsync
from qc import imf as qimf
from qc import mediainfo as qmediainfo
from qc import profiles as qprofiles
from qc import report as qreport
from qc import structural as qstructural
from qc import text as qtext
from qc import video as qvideo
from qc.text import load_caption_cues, load_caption_text, parse_caption_cues

app = FastAPI()
SHARED = os.environ["PIPELINE_SHARED_SECRET"]
BUCKET = os.environ["B2_BUCKET"]

# Compute identity: which waystation worker is this? Rides in progress events
# and the provenance manifest so the delivery records WHERE it was processed.
WORKER_LABEL = os.environ.get("WORKER_LABEL", "local")
# A deployed worker may reach the gateway at a different address than the one
# the dispatch payload carries (containers, NAT) — its own env wins.
GATEWAY_URL_OVERRIDE = os.environ.get("GATEWAY_URL")

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
AI_QC_FRAMES = int(os.environ.get("AI_QC_FRAMES", "8"))              # floor on initial frames
AI_QC_FRAMES_MAX = int(os.environ.get("AI_QC_FRAMES_MAX", "40"))     # ceiling on initial frames
AI_QC_SECONDS_PER_FRAME = float(os.environ.get("AI_QC_SECONDS_PER_FRAME", "45"))  # duration scaling
AI_QC_FRAME_SCALE = int(os.environ.get("AI_QC_FRAME_SCALE", "1024"))  # evidence width px (was 640)
AI_QC_AUDIO_WINDOWS = int(os.environ.get("AI_QC_AUDIO_WINDOWS", "3"))  # blind-pass audio samples
AI_QC_AUDIO_WINDOW_S = float(os.environ.get("AI_QC_AUDIO_WINDOW_S", "6"))
AI_QC_SCENE_THRESHOLD = float(os.environ.get("AI_QC_SCENE_THRESHOLD", "0.4"))
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
            f"{GATEWAY_URL_OVERRIDE or job.gatewayUrl}/api/internal/progress",
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
        guarded(qmediainfo.checks, src, profile, group="mediainfo_wrapper")
        if key.lower().endswith((".m3u8", ".mpd")):
            guarded(qstructural.abr_lint, src, group="abr_manifest")
        guarded(qimf.photon_checks, src, tmp, profile, group="imf_photon")

        # ── Task 2: signal video quality ──
        segments: dict = {"black": [], "freeze": []}
        try:
            det, segments = qvideo.decode_and_detections(src, has_video, has_audio, duration)
            checks.extend(det)
        except Exception as e:
            checks.append(qreport.check("decode", "warn", f"analyzer error: {str(e)[:140]}", "engine"))
        if has_video:
            guarded(qstructural.framerate_checks, src, meta, profile, group="framerate")
            guarded(qvideo.boundary_check, segments["black"], duration, group="picture_boundaries")
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
            if has_video:  # lip-sync proxy needs both streams
                guarded(qaudio.lip_sync_proxy, src, meta, duration, group="lip_sync_drift_proxy")
                # measured lip-sync via SyncNet when installed; honest FYI when not
                guarded(qavsync.checks, src, meta, group="avsync_offset")

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

    report = qreport.finalize({"checks": checks}, profile)
    # Flagged segment timecodes ride in the report: consumers see WHERE the
    # detections fired, and the AI escalation adjudicates those exact moments.
    if check_av and (segments["black"] or segments["freeze"]):
        report["detections"] = {k: [[round(s, 2), round(e, 2)] for s, e in v]
                                for k, v in segments.items() if v}
    return report


# ───────────────────────── AI-assisted QC lane ─────────────────────────
# Runs beside the deterministic lane, gated by the sender's `qc_ai` toggle:
#   agentic reporter    — GMI performs a blind sweep, an instrument-informed
#                         sweep with adaptive evidence, and a critic pass.
#   ai_caption_accuracy — GMI transcribes a sampled audio window and the
#                         transcript is diffed (word error rate) against the
#                         caption text for that window. This is the QC
#                         instrument for "are these captions actually right?"
# All verdicts land in the same qc_report.json, provenance-covered.

# GMI paces multi-image calls per-minute; the AI lanes fire several in a row.
# Enforce a minimum inter-call gap and back off hard on 429s — a background
# pipeline can afford to wait, but must not lose a whole QC step to a limit.
AI_QC_MIN_INTERVAL = float(os.environ.get("AI_QC_MIN_INTERVAL", "4"))
_gmi_last_call = 0.0


def _gmi_chat(content: list, max_tokens: int = 2000) -> str:
    global _gmi_last_call
    for attempt in range(4):
        wait = AI_QC_MIN_INTERVAL - (time.monotonic() - _gmi_last_call)
        if wait > 0:
            time.sleep(wait)
        _gmi_last_call = time.monotonic()
        try:
            response = gb_gmi_chat(
                GMI_MULTIMODAL_MODEL,
                messages=[{"role": "user", "content": content}],
                temperature=0, max_tokens=max_tokens,
                api_key=GMI_API_KEY,
                base_url=f"{GMI_BASE_URL.rstrip('/')}/v1",
                timeout=120,
            )
            return response.text
        except ProviderError as e:
            if e.error_code not in RETRYABLE_ERROR_CODES or attempt == 3:
                raise
            time.sleep(float(e.retry_after or 15 * (attempt + 1)))
    raise RuntimeError("unreachable GMI retry state")


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


def _frame_evidence(src: str, tmp: str, evidence_id: str, at: float,
                    scale: int = 640, crop: tuple | None = None) -> tuple[dict, dict] | None:
    """Extract one frame from sanitized numeric inputs and return model/public forms."""
    fp = os.path.join(tmp, f"{evidence_id}.jpg")
    vf = f"scale={scale}:-2"
    if crop:
        x, y, width, height = crop
        vf = (f"crop=iw*{width:.4f}:ih*{height:.4f}:iw*{x:.4f}:ih*{y:.4f},"
              f"scale={scale}:-2")
    subprocess.run(["ffmpeg", "-y", "-ss", f"{at:.3f}", "-i", src,
                    "-frames:v", "1", "-vf", vf, fp], capture_output=True)
    if not os.path.exists(fp) or os.path.getsize(fp) == 0:
        return None
    with open(fp, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    model = {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
    public = {"evidence_id": evidence_id, "type": "frame", "time_seconds": round(at, 3)}
    if crop:
        public["crop"] = {"x": crop[0], "y": crop[1], "width": crop[2], "height": crop[3]}
    return model, public


def _scene_cuts(src: str, duration: float, threshold: float = AI_QC_SCENE_THRESHOLD,
                cap: int = 60) -> list[float]:
    """Shot-boundary timecodes via ffmpeg scene score, spatially downscaled so the
    detection pass stays cheap. Best-effort: returns [] on any failure so the
    caller falls back to even spacing."""
    if duration < 2:
        return []
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", src, "-map", "0:v:0",
             "-vf", f"scale=160:-2,select='gt(scene,{threshold})',metadata=mode=print:file=-",
             "-an", "-f", "null", "-"],
            capture_output=True, text=True, timeout=600).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    cuts = []
    for m in re.finditer(r"pts_time:([\d.]+)", out):
        try:
            t = float(m.group(1))
            if 0.0 <= t <= duration:
                cuts.append(round(t, 3))
        except ValueError:
            pass
    return sorted(set(cuts))[:cap]


def _scaled_frame_count(duration: float) -> int:
    """Initial frame budget scales with runtime: ~1 per AI_QC_SECONDS_PER_FRAME,
    floored at AI_QC_FRAMES and capped at AI_QC_FRAMES_MAX."""
    target = int(round(duration / max(AI_QC_SECONDS_PER_FRAME, 1))) + 1
    return max(1, min(max(AI_QC_FRAMES, target), AI_QC_FRAMES_MAX))


def _dedupe_times(times: list[float], duration: float, min_gap: float = 0.4) -> list[float]:
    out: list[float] = []
    for t in sorted(max(0.0, min(float(t), max(duration - 0.05, 0.0))) for t in times):
        if not out or t - out[-1] >= min_gap:
            out.append(round(t, 3))
    return out


def _initial_agentic_evidence(src: str, meta: dict, tmp: str,
                              detections: dict | None = None) -> tuple[list, list, dict]:
    """Blind-pass evidence, selected for COVERAGE rather than even spacing:
    scene-change frames (one representative per shot) + deterministic anomaly
    timecodes (black/freeze/silence) + evenly-spaced anchors, scaled with
    duration; PLUS audio windows so the independent pass can inspect sound, not
    only picture. Returns (parts, records, meta_out) where meta_out carries the
    shot list and selection provenance."""
    duration = max(float(meta.get("format", {}).get("duration", 0) or 0), 0.5)
    has_video = any(s.get("codec_type") == "video" for s in meta.get("streams", []))
    has_audio = any(s.get("codec_type") == "audio" for s in meta.get("streams", []))
    detections = detections or {}
    parts: list = []
    records: list = []
    shot_boundaries: list[float] = []

    frame_times: list[float] = []
    if has_video:
        budget = _scaled_frame_count(duration)
        # 1) evenly-spaced anchors so no long stretch is unsampled
        anchors = max(2, budget // 3)
        edge = min(0.25, duration / 4)
        frame_times += [edge + (duration - 2 * edge) * i / (anchors - 1) for i in range(anchors)] \
            if anchors > 1 else [duration / 2]
        # 2) one representative frame just after each shot change
        shot_boundaries = _scene_cuts(src, duration)
        frame_times += [min(t + 0.15, duration - 0.05) for t in shot_boundaries]
        # 3) deterministic anomaly midpoints — look where the instruments smelled smoke
        for kind in ("black", "freeze", "silence"):
            for seg in detections.get(kind, []):
                try:
                    s, e = float(seg[0]), float(seg[1])
                    frame_times.append((s + e) / 2)
                except (TypeError, ValueError, IndexError):
                    pass
        frame_times = _dedupe_times(frame_times, duration)
        # keep the budget: always retain anchors + anomalies, sample shots to fit
        if len(frame_times) > budget:
            keep = set(_dedupe_times(
                [edge + (duration - 2 * edge) * i / (anchors - 1) for i in range(anchors)]
                + [(float(s) + float(e)) / 2 for k in ("black", "freeze", "silence")
                   for s, e in detections.get(k, [])], duration))
            extras = [t for t in frame_times if t not in keep]
            step = max(1, len(extras) // max(budget - len(keep), 1))
            frame_times = _dedupe_times(list(keep) + extras[::step], duration)[:budget]

    for i, at in enumerate(frame_times, 1):
        evidence_id = f"timeline-frame-{i}"
        item = _frame_evidence(src, tmp, evidence_id, at, scale=AI_QC_FRAME_SCALE)
        if not item:
            continue
        model, public = item
        if any(abs(at - b) < 0.5 for b in shot_boundaries):
            public["at_shot_boundary"] = True
        parts.extend([{"type": "text", "text": f"Evidence {evidence_id} at {at:.3f}s:"}, model])
        records.append(public)

    # 4) audio windows for the blind pass — start/mid/end plus silence-flagged points
    if has_audio:
        audio_starts = []
        n_aud = max(1, AI_QC_AUDIO_WINDOWS)
        win = min(AI_QC_AUDIO_WINDOW_S, duration)
        if duration <= win:
            audio_starts = [0.0]
        else:
            audio_starts = [round((duration - win) * i / max(n_aud - 1, 1), 3) for i in range(n_aud)]
        for seg in detections.get("silence", [])[:2]:
            try:
                audio_starts.append(max(0.0, float(seg[0]) - 0.5))
            except (TypeError, ValueError, IndexError):
                pass
        for j, start in enumerate(_dedupe_times(audio_starts, duration, min_gap=win / 2), 1):
            evidence_id = f"timeline-audio-{j}"
            item = _audio_evidence(src, tmp, evidence_id, start, min(win, max(duration - start, 0.5)))
            if not item:
                continue
            model, public, _ = item
            parts.extend([{"type": "text", "text": f"Evidence {evidence_id} (audio {start:.2f}s):"}, model])
            records.append(public)

    meta_out = {
        "shot_boundaries": shot_boundaries,
        "frame_samples": len([r for r in records if r["type"] == "frame"]),
        "audio_samples": len([r for r in records if r["type"] == "audio_window"]),
        "selection": "scene+anomaly+anchor" if shot_boundaries or detections else "anchor",
    }
    return parts, records, meta_out


def _audio_evidence(src: str, tmp: str, evidence_id: str, start: float,
                    duration: float) -> tuple[dict, dict, str] | None:
    wav = os.path.join(tmp, f"{evidence_id}.wav")
    subprocess.run(["ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
                    "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav], capture_output=True)
    if not os.path.exists(wav) or os.path.getsize(wav) < 1000:
        return None
    with open(wav, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    model = {"type": "input_audio", "input_audio": {"data": b64, "format": "wav"}}
    public = {"evidence_id": evidence_id, "type": "audio_window",
              "start_seconds": round(start, 3), "duration_seconds": round(duration, 3)}
    return model, public, wav


def _execute_evidence_requests(src: str, meta: dict, tmp: str,
                               requests: list[dict]) -> tuple[list, list, list, int, float]:
    """Execute one bounded round of allowlisted, read-only evidence requests."""
    parts, records, executions = [], [], []
    frames, audio_seconds = 0, 0.0
    has_video = any(s.get("codec_type") == "video" for s in meta.get("streams", []))
    has_audio = any(s.get("codec_type") == "audio" for s in meta.get("streams", []))
    for i, request in enumerate(requests, 1):
        kind = request["type"]
        evidence_ids = []
        if kind in {"frame", "pixel_crop"} and has_video:
            evidence_id = f"request-{i}-frame"
            crop = None
            if kind == "pixel_crop":
                crop = tuple(request[k] for k in ("x", "y", "width", "height"))
            item = _frame_evidence(src, tmp, evidence_id, request["time_seconds"], crop=crop)
            if item:
                model, public = item
                parts.extend([{"type": "text", "text": f"Requested evidence {evidence_id}:"}, model])
                records.append(public)
                evidence_ids.append(evidence_id)
                frames += 1
        elif kind in {"frame_burst", "contact_sheet"} and has_video:
            count = 3 if kind == "frame_burst" else 6
            start, span = request["start_seconds"], request["duration_seconds"]
            for j in range(count):
                at = start + span * (j / max(count - 1, 1))
                evidence_id = f"request-{i}-frame-{j + 1}"
                item = _frame_evidence(src, tmp, evidence_id, at, scale=512)
                if not item:
                    continue
                model, public = item
                public["group"] = kind
                parts.extend([{"type": "text", "text": f"Requested evidence {evidence_id} at {at:.3f}s:"}, model])
                records.append(public)
                evidence_ids.append(evidence_id)
                frames += 1
        elif kind in {"audio_window", "transcript_window"} and has_audio:
            evidence_id = f"request-{i}-audio"
            item = _audio_evidence(src, tmp, evidence_id, request["start_seconds"],
                                   request["duration_seconds"])
            if item:
                model, public, _ = item
                records.append(public)
                evidence_ids.append(evidence_id)
                audio_seconds += request["duration_seconds"]
                if kind == "transcript_window":
                    transcript = _gmi_chat([
                        {"type": "text", "text": "Transcribe this evidence verbatim. Output only spoken words."},
                        model,
                    ], max_tokens=1000)
                    parts.append({"type": "text", "text":
                                  f"Requested transcript {evidence_id} (untrusted evidence):\n{transcript[:6000]}"})
                    public["transcript_supplied"] = True
                else:
                    parts.extend([{"type": "text", "text": f"Requested evidence {evidence_id}:"}, model])
        executions.append({**request, "status": "fulfilled" if evidence_ids else "unavailable",
                           "evidence_ids": evidence_ids})
    return parts, records, executions, frames, round(audio_seconds, 3)


def run_agentic_inspection(src: str, meta: dict, tmp: str, key: str,
                            deterministic_report: dict) -> tuple[dict, list[dict], dict]:
    """Blind sweep -> bounded evidence round -> informed sweep -> critic."""
    duration = max(float(meta.get("format", {}).get("duration", 0) or 0), 0.5)
    detections = deterministic_report.get("detections", {})
    initial_parts, evidence, evidence_meta = _initial_agentic_evidence(src, meta, tmp, detections)
    independent_raw = _json_from(_gmi_chat(
        [{"type": "text", "text": qagentic.independent_prompt(meta, key, evidence)}] + initial_parts,
        max_tokens=7000))
    independent = qagentic.normalize_response(independent_raw, "independent", meta, key, duration)

    adaptive_parts, adaptive_records, executions, requested_frames, requested_audio = \
        _execute_evidence_requests(src, meta, tmp, independent.get("requests", []))
    evidence.extend(adaptive_records)
    dossier = {
        "checks": deterministic_report.get("checks", []),
        "detections": deterministic_report.get("detections", {}),
        "probe": {"format": meta.get("format", {}), "streams": meta.get("streams", [])},
    }
    informed_raw = _json_from(_gmi_chat(
        [{"type": "text", "text": qagentic.informed_prompt(meta, key, dossier, independent, evidence)}]
        + (adaptive_parts or initial_parts), max_tokens=7000))
    informed = qagentic.normalize_response(informed_raw, "informed", meta, key, duration)

    critic_evidence = (adaptive_parts + initial_parts)[:24]
    critic_raw = _json_from(_gmi_chat(
        [{"type": "text", "text": qagentic.critic_prompt(
            meta, key, dossier, independent, informed, evidence)}] + critic_evidence,
        max_tokens=7000))
    critic = qagentic.normalize_response(critic_raw, "critic", meta, key, duration)
    agentic = {
        "model": GMI_MULTIMODAL_MODEL,
        "prompt": qagentic.prompt_identity(),
        "mode": "read_only_no_repair",
        "passes": {"independent": independent, "informed": informed, "critic": critic},
        "evidence": evidence,
        "requests": executions,
        "shot_boundaries": evidence_meta.get("shot_boundaries", []),
        "limits": {"initial_frame_samples": evidence_meta.get("frame_samples", 0),
                   "initial_audio_samples": evidence_meta.get("audio_samples", 0),
                   "frame_selection": evidence_meta.get("selection", "anchor"),
                   "adaptive_rounds": 1, "sampled_evidence_is_not_full_timeline_clearance": True},
    }
    units = {"frames": len([e for e in evidence if e["type"] == "frame"]),
             "audio_windows": len([e for e in evidence if e["type"] == "audio_window"]),
             "requested_frames": requested_frames, "requested_audio_seconds": requested_audio,
             "model_passes": 3}
    return agentic, qagentic.checks_from_findings(agentic), units


AI_QC_ESCALATION_MAX = int(os.environ.get("AI_QC_ESCALATION_MAX", "4"))

_ESCALATION_PROMPT = (
    "You are the supervising broadcast QC operator. The deterministic scanner "
    "flagged suspect segments in a mastered delivery. For each segment you see "
    "three frames: BEFORE the segment, INSIDE it, and AFTER it (times labeled). "
    "Adjudicate each segment: an INTENTIONAL editorial event (fade to black, "
    "chapter break, title card, scene transition, deliberate hold) or a "
    "delivery DEFECT (dropout, accidental black insert, encoder failure, "
    "stuck/frozen frame interrupting action). Key heuristic: if the BEFORE and "
    "AFTER frames belong to the same continuing shot, an interruption between "
    "them is a DEFECT; if they are different scenes, black between them is "
    "likely an intentional transition. Respond with STRICT JSON only:\n"
    '{"verdicts": [{"segment": <n>, "verdict": "intentional|defect|uncertain", '
    '"reason": "<short>"}]}'
)


def ai_escalation_check(src: str, detections: dict, duration: float, tmp: str) -> tuple:
    """AI-targeted escalation: the deterministic lane found black/frozen
    segments at exact timecodes — sample frames AROUND those moments and have
    Gemini adjudicate intent. Returns (check-dict | None, frames_used)."""
    suspects = ([("black", s, e) for s, e in detections.get("black", [])] +
                [("freeze", s, e) for s, e in detections.get("freeze", [])])[:AI_QC_ESCALATION_MAX]
    if not suspects:
        return None, 0
    parts: list = [{"type": "text", "text": _ESCALATION_PROMPT}]
    frames = 0
    end_cap = max((duration or 0) - 0.05, 0.1)
    for n, (kind, s, e) in enumerate(suspects, 1):
        parts.append({"type": "text",
                      "text": f"Segment {n}: {kind.upper()} {s:.1f}s–{e:.1f}s. "
                              f"Frames: before / inside / after:"})
        for t in (max(s - 0.5, 0.0), (s + e) / 2, min(e + 0.5, end_cap)):
            fp = os.path.join(tmp, f"esc_{n}_{t:.2f}.jpg")
            subprocess.run(["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1",
                            "-vf", "scale=448:-2", fp], capture_output=True)
            if os.path.exists(fp) and os.path.getsize(fp) > 0:
                b64 = base64.b64encode(open(fp, "rb").read()).decode()
                parts.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
                frames += 1
    if frames == 0:
        return None, 0
    data = _json_from(_gmi_chat(parts))
    if data is None:
        return {"name": "ai_escalation", "status": "info", "tier": "FYI",
                "detail": f"{len(suspects)} flagged segment(s) sent for adjudication; reply unparseable"}, frames
    verdicts = data.get("verdicts") or []
    by = {"intentional": [], "defect": [], "uncertain": []}
    for v in verdicts:
        by.setdefault(str(v.get("verdict", "uncertain")).lower(), by["uncertain"]).append(v)
    if by["defect"]:
        detail = "; ".join(f"segment {v.get('segment', '?')}: {v.get('reason', '')}" for v in by["defect"][:3])
        return {"name": "ai_escalation", "status": "warn", "tier": "ISSUE",
                "detail": f"{len(by['defect'])} of {len(suspects)} flagged segment(s) adjudicated as "
                          f"DEFECTS — {detail}"}, frames
    if by["uncertain"]:
        return {"name": "ai_escalation", "status": "warn", "tier": "ISSUE",
                "detail": f"{len(by['uncertain'])} flagged segment(s) could not be adjudicated — "
                          f"human review advised"}, frames
    reasons = "; ".join(str(v.get("reason", "")) for v in by["intentional"][:2])
    return {"name": "ai_escalation", "status": "pass",
            "detail": f"all {len(suspects)} flagged segment(s) adjudicated as intentional editorial "
                      f"events ({reasons}) — deterministic black/freeze warnings are editorial, "
                      f"not defects"}, frames


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


def ai_text_compliance_check(cap_text: str) -> list:
    """NLP pass over the timed text: profanity/regional compliance PLUS the
    prompt-native upgrade — spelling and grammar proofread (BATON sells
    subtitle spell-check as a feature; an LLM does it natively)."""
    reply = _gmi_chat([{
        "type": "text",
        "text": "You are a content-compliance reviewer and proofreader. Analyze this "
                "subtitle text for (a) profanity and regional compliance concerns "
                "(slurs, hate speech, adult content) and (b) spelling and grammar "
                "errors. Respond with STRICT JSON only: "
                '{"profanity_count": <int>, "flags": ["<short>", ...], '
                '"spelling_errors": <int>, "grammar_issues": <int>, '
                '"examples": ["<up to 3 misspelled/incorrect fragments>", ...]}\n\n'
                + cap_text[:3000]}], max_tokens=300)
    data = _json_from(reply)
    if data is None:
        return [{"name": "ai_text_compliance", "status": "info", "tier": "FYI",
                 "detail": "compliance reply unparseable"}]
    checks = []
    n = int(data.get("profanity_count") or 0)
    flags = data.get("flags") or []
    if n or flags:
        checks.append({"name": "ai_text_compliance", "status": "warn", "tier": "ISSUE",
                       "detail": f"{n} profanity hit(s); {'; '.join(map(str, flags[:3])) or 'no other flags'}"})
    else:
        checks.append({"name": "ai_text_compliance", "status": "pass",
                       "detail": "no profanity or compliance flags"})
    if "spelling_errors" in data or "grammar_issues" in data:
        sp, gr = int(data.get("spelling_errors") or 0), int(data.get("grammar_issues") or 0)
        ex = [str(x) for x in (data.get("examples") or [])][:3]
        if sp + gr:
            checks.append({"name": "ai_caption_proofread", "status": "warn", "tier": "ISSUE",
                           "detail": f"{sp} spelling / {gr} grammar issue(s)"
                                     + (f" — e.g. {'; '.join(ex)}" if ex else "")})
        else:
            checks.append({"name": "ai_caption_proofread", "status": "pass",
                           "detail": "spelling and grammar clean"})
    return checks


def run_ai_qc(src: str, meta: dict, captions_path: str | None, tmp: str,
              profile: dict | None = None, detections: dict | None = None,
              declared: str = "", deterministic_report: dict | None = None) -> tuple:
    """Read-only agentic reporter plus focused AI support instruments."""
    profile = profile or qprofiles.get("standard")
    checks: list = []
    frames, asr_seconds, esc_frames = 0, 0.0, 0
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    agentic, agentic_checks, agentic_units = run_agentic_inspection(
        src, meta, tmp, declared, deterministic_report or {"checks": []})
    for check in agentic_checks:
        if re.search(r"censor|mosaic|blur patch|bleep", str(check.get("detail", "")), re.I):
            check["name"] = "ai_censorship"
            check["status"] = "fail" if profile["censorship"]["escalate"] else "warn"
    checks.extend(agentic_checks)
    frames = int(agentic_units["frames"])
    if any(s.get("codec_type") == "video" for s in meta.get("streams", [])):
        if detections:
            try:
                c, esc_frames = ai_escalation_check(src, detections, duration, tmp)
                if c:
                    checks.append(c)
            except Exception as e:
                print("escalation failed:", e)
    cues = load_caption_cues(src, captions_path, tmp)
    if cues:
        check, asr_seconds = ai_caption_accuracy_check(src, meta, cues, tmp)
        if check:
            checks.append(check)
        try:
            cap_text = load_caption_text(src, captions_path, tmp)
            if cap_text:
                checks.extend(ai_text_compliance_check(cap_text) or [])
        except Exception as e:
            print("text compliance failed:", e)
    try:
        c = ai_language_check(src, meta, tmp)
        if c:
            checks.append(c)
    except Exception as e:
        print("language check failed:", e)
    for check in checks:
        check.setdefault("source", "ai_support")
    return checks, {"frames": frames, "asr_seconds": round(asr_seconds, 1),
                    "escalation_frames": esc_frames,
                    "requested_frames": agentic_units["requested_frames"],
                    "requested_audio_seconds": agentic_units["requested_audio_seconds"],
                    "model_passes": agentic_units["model_passes"]}, agentic


# ─────────────────────── Synthetic QC lane (generative media) ───────────────────────
# QC for media that was never shot. AI-generated video fails in ways no
# signal filter has a name for — anatomy, physics, identity drift, garbled
# glyphs — and, uniquely, it ARRIVES with its generation intent recorded in a
# Genblaze manifest, so the prompt itself becomes the QC reference.

AI_QC_SYNTH_FRAMES = int(os.environ.get("AI_QC_SYNTH_FRAMES", "6"))

_SYNTH_PROMPT = (
    "You are a QC operator specializing in AI-GENERATED video. These frames are "
    "sampled from a delivery that may be partly or wholly generated. Report "
    "generation defects: anatomical errors (hands, fingers, teeth, limbs, "
    "faces), garbled or nonsensical rendered text/signage, physics violations "
    "(impossible shadows, reflections, liquids), melted/merged objects, "
    "generation seams or tiling, over-smoothed 'AI sheen'. Also give your "
    "assessment of whether the content appears AI-generated at all. "
    "Respond with STRICT JSON only:\n"
    '{"findings": [{"issue": "<short>", "category": "<anatomy|text|physics|'
    'merge|seam|sheen|other>", "frames": [<1-based>]}], '
    '"appears_generated": <bool>, "confidence": "<low|medium|high>", '
    '"summary": "<one short sentence>"}\n'
    "Empty findings array if the frames are clean."
)

_TEMPORAL_PROMPT = (
    "You are a QC operator checking TEMPORAL COHERENCE in possibly AI-generated "
    "video. You see bursts of frames sampled close together in time (labeled). "
    "Within and across bursts, check: do characters keep the same identity "
    "(face, clothing, build)? Do objects persist (nothing appears/vanishes "
    "impossibly)? Is the background stable (no melting/morphing)? Is motion "
    "natural? Respond with STRICT JSON only:\n"
    '{"issues": [{"issue": "<short>", "kind": "<identity|permanence|background|'
    'motion>"}], "verdict": "<coherent|incoherent>", "summary": "<one sentence>"}'
)

_ADHERENCE_PROMPT = (
    "You are QC-ing an AI-generated video against its RECORDED GENERATION "
    "PROMPT (from the delivery's Genblaze provenance manifest). The prompt "
    "was:\n---\n{prompt}\n---\n"
    "Looking at these sampled frames, score how faithfully the video realizes "
    "that prompt. Respond with STRICT JSON only:\n"
    '{"adherence_score": <0-100>, "matches": ["<prompt elements clearly '
    'present>", ...], "mismatches": ["<prompt elements missing or wrong>", ...],'
    ' "summary": "<one sentence>"}'
)


def _sample_frames(src: str, times: list, tmp: str, tag: str, scale: int = 448) -> list:
    """Extract frames at the given times → list of image_url content parts."""
    parts = []
    for i, t in enumerate(times):
        fp = os.path.join(tmp, f"{tag}_{i}_{t:.2f}.jpg")
        subprocess.run(["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1",
                        "-vf", f"scale={scale}:-2", fp], capture_output=True)
        if os.path.exists(fp) and os.path.getsize(fp) > 0:
            b64 = base64.b64encode(open(fp, "rb").read()).decode()
            parts.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    return parts


def extract_gen_prompt(path: str) -> str | None:
    """Pull the generation prompt out of a Genblaze manifest sidecar (or a
    plain {"prompt": ...} JSON). Prompts may be redacted (prompt_visibility)
    — absence is a fact to report, not an error."""
    try:
        data = json.loads(open(path, encoding="utf-8", errors="replace").read())
    except (OSError, ValueError):
        return None
    steps = (data.get("run") or {}).get("steps") or []
    prompts = [s.get("prompt") for s in steps if s.get("prompt")]
    if prompts:
        return str(prompts[-1])
    return str(data["prompt"]) if data.get("prompt") else None


def run_synthetic_qc(src: str, meta: dict, tmp: str, gen_manifest_path: str | None) -> tuple:
    """→ (checks, frames_used). Three prompt engines: generation artifacts,
    temporal coherence (frame bursts), and prompt adherence vs the Genblaze
    manifest's recorded prompt."""
    checks: list = []
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    dur = max(duration, 0.5)
    if not any(s.get("codec_type") == "video" for s in meta.get("streams", [])):
        return checks, 0

    # 1. generation artifacts — evenly sampled stills
    n = max(AI_QC_SYNTH_FRAMES, 2)
    still_times = [dur * (i + 1) / (n + 1) for i in range(n)]
    stills = _sample_frames(src, still_times, tmp, "synth")
    frames = len(stills)
    if stills:
        data = _json_from(_gmi_chat([{"type": "text", "text": _SYNTH_PROMPT}] + stills, max_tokens=4000))
        if data is None:
            checks.append({"name": "ai_synthetic_artifacts", "status": "info", "tier": "FYI",
                           "detail": f"{frames} frame(s) reviewed; reply unparseable"})
        else:
            findings = data.get("findings") or []
            if findings:
                detail = "; ".join(f"{f.get('category', '?')}: {f.get('issue', '?')}" for f in findings[:4])
                checks.append({"name": "ai_synthetic_artifacts", "status": "warn", "tier": "ISSUE",
                               "detail": f"{len(findings)} generation defect(s): {detail}"})
            else:
                checks.append({"name": "ai_synthetic_artifacts", "status": "pass",
                               "detail": f"{frames} frame(s): no generation defects"})
            if "appears_generated" in data:
                checks.append({"name": "ai_origin_assessment", "status": "info", "tier": "FYI",
                               "detail": f"appears AI-generated: {bool(data['appears_generated'])} "
                                         f"(confidence {data.get('confidence', '?')})"})

    # 2. temporal coherence — bursts of close-together frames
    burst_starts = [dur * f for f in (0.2, 0.5, 0.8)]
    parts: list = [{"type": "text", "text": _TEMPORAL_PROMPT}]
    for bn, t0 in enumerate(burst_starts, 1):
        burst_times = [t0, min(t0 + 0.4, dur - 0.05), min(t0 + 0.8, dur - 0.02)]
        burst = _sample_frames(src, burst_times, tmp, f"burst{bn}")
        if burst:
            parts.append({"type": "text", "text": f"Burst {bn} (t≈{t0:.1f}s, 3 frames ~0.4s apart):"})
            parts.extend(burst)
            frames += len(burst)
    if len(parts) > 1:
        data = _json_from(_gmi_chat(parts, max_tokens=4000))
        if data is None:
            checks.append({"name": "ai_temporal_coherence", "status": "info", "tier": "FYI",
                           "detail": "coherence reply unparseable"})
        else:
            issues = data.get("issues") or []
            if issues or data.get("verdict") == "incoherent":
                detail = "; ".join(f"{i.get('kind', '?')}: {i.get('issue', '?')}" for i in issues[:4]) \
                         or "model judged the sequence incoherent"
                checks.append({"name": "ai_temporal_coherence", "status": "warn", "tier": "ISSUE",
                               "detail": detail})
            else:
                checks.append({"name": "ai_temporal_coherence", "status": "pass",
                               "detail": f"identity/permanence/background stable across "
                                         f"{len(burst_starts)} sampled bursts"})

    # 3. prompt adherence — the provenance record IS the QC reference
    if gen_manifest_path:
        gen_prompt = extract_gen_prompt(gen_manifest_path)
        if not gen_prompt:
            checks.append({"name": "ai_prompt_adherence", "status": "info", "tier": "FYI",
                           "detail": "generation manifest supplied but carries no visible prompt "
                                     "(redacted prompt_visibility?) — adherence not scorable"})
        elif stills:
            data = _json_from(_gmi_chat(
                [{"type": "text", "text": _ADHERENCE_PROMPT.replace("{prompt}", gen_prompt[:1500])}] + stills,
                max_tokens=4000))
            if data is None or not isinstance(data.get("adherence_score"), (int, float)):
                checks.append({"name": "ai_prompt_adherence", "status": "info", "tier": "FYI",
                               "detail": "adherence reply unparseable"})
            elif True:
                score = float(data["adherence_score"])
                mism = [str(m) for m in (data.get("mismatches") or [])][:3]
                if score >= 70:
                    checks.append({"name": "ai_prompt_adherence", "status": "pass",
                                   "detail": f"{score:.0f}/100 — output matches its recorded "
                                             f"generation prompt" + (f" (minor: {'; '.join(mism)})" if mism else "")})
                else:
                    checks.append({"name": "ai_prompt_adherence", "status": "warn", "tier": "ISSUE",
                                   "detail": f"{score:.0f}/100 vs recorded prompt — mismatches: "
                                             f"{'; '.join(mism) or 'unspecified'}"})
    return checks, frames


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
    progress(job, {"type": "pipeline_started", "key": job.key, "compute": WORKER_LABEL})
    tid = job.transferId
    # Sender-selected services (missing = everything on). Non-boolean keys in
    # options carry the QC profile and compute target; do not coerce those.
    SERVICE_FLAGS = ("thumbnail", "qc_av", "qc_captions", "qc_ai", "qc_synthetic", "summarize")
    opts = {k: True for k in SERVICE_FLAGS}
    opts["qc_synthetic"] = False   # specialized for generative media — opt-in
    if job.options:
        for k in SERVICE_FLAGS:
            if k in job.options:
                opts[k] = bool(job.options[k])
    profile = qprofiles.get((job.options or {}).get("profile", "standard"))
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
        captions_path = ref_path = gen_manifest_path = None
        try:
            listing = s3.list_objects_v2(Bucket=job.bucket, Prefix=f"transfers/{tid}/")
            for obj in listing.get("Contents", []):
                k = obj["Key"]
                if k == job.key:
                    continue
                if k.lower().endswith((".srt", ".vtt")) and not captions_path:
                    captions_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, captions_path)
                elif k.lower().endswith(".genblaze.json") and not gen_manifest_path:
                    # source Genblaze manifest → prompt-adherence QC reference
                    gen_manifest_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, gen_manifest_path)
                elif ".ref." in k.lower() and not ref_path:
                    # source-master mezzanine → reference SSIM/PSNR/VMAF lane
                    ref_path = os.path.join(tmp, os.path.basename(k))
                    s3.download_file(job.bucket, k, ref_path)
        except Exception as e:
            print("sidecar lookup failed:", e)

        qc_report = None
        agentic_report = None
        ai_state = "disabled"
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
                ai_state = "unavailable"
                if qc_report is None:
                    qc_report = {"status": "warn", "checks": [{
                        "name": "agentic_qc", "status": "warn",
                        "detail": "agentic inspection unavailable: no GMI_API_KEY",
                        "category": "engine", "source": "ai_support"}]}
                progress(job, {"type": "step_skipped", "step": "qc_ai", "reason": "no GMI_API_KEY"})
            else:
                progress(job, {"type": "step_started", "step": "qc_ai"})
                try:
                    ai_checks, ai_units, agentic_report = run_ai_qc(
                        src, meta, captions_path, tmp, profile,
                        detections=(qc_report or {}).get("detections"),
                        declared=job.key, deterministic_report=qc_report)
                    if qc_report is None:
                        qc_report = {"status": "pass", "checks": []}
                    qc_report["checks"].extend(ai_checks)
                    qc_report["ai"] = {"model": GMI_MULTIMODAL_MODEL, **ai_units}
                    ai_state = "complete"
                    progress(job, {"type": "step_done", "step": "qc_ai",
                                   "checks": [c["name"] for c in ai_checks],
                                   "billable": {"unit": "frames", "units": ai_units["frames"]}})
                    if ai_units["asr_seconds"]:
                        # second billable line: ASR is metered in seconds
                        progress(job, {"type": "step_metered", "step": "qc_ai_asr",
                                       "billable": {"unit": "seconds", "units": ai_units["asr_seconds"]}})
                    if ai_units.get("escalation_frames"):
                        # third billable line: targeted escalation, in frames
                        progress(job, {"type": "step_metered", "step": "qc_ai_escalation",
                                       "billable": {"unit": "frames", "units": ai_units["escalation_frames"]}})
                    if ai_units.get("requested_audio_seconds"):
                        progress(job, {"type": "step_metered", "step": "qc_ai_evidence_audio",
                                       "billable": {"unit": "seconds",
                                                    "units": ai_units["requested_audio_seconds"]}})
                except Exception as e:
                    ai_state = "error"
                    if qc_report is None:
                        qc_report = {"status": "warn", "checks": [{
                            "name": "agentic_qc", "status": "warn",
                            "detail": f"agentic inspection failed: {str(e)[:180]}",
                            "category": "engine", "source": "ai_support"}]}
                    progress(job, {"type": "step_error", "step": "qc_ai", "error": str(e)})
        else:
            progress(job, {"type": "step_skipped", "step": "qc_ai", "reason": "disabled by sender"})

        # 3b-2. Synthetic QC — the generative-media lane: generation-artifact
        #       review, temporal coherence, and prompt adherence against the
        #       Genblaze manifest's recorded prompt (the provenance record as
        #       the QC reference). Opt-in via the sender's Synthetic QC toggle.
        if opts["qc_synthetic"]:
            if not GMI_API_KEY:
                progress(job, {"type": "step_skipped", "step": "qc_synthetic", "reason": "no GMI_API_KEY"})
            else:
                progress(job, {"type": "step_started", "step": "qc_synthetic"})
                try:
                    syn_checks, syn_frames = run_synthetic_qc(src, meta, tmp, gen_manifest_path)
                    if qc_report is None:
                        qc_report = {"status": "pass", "checks": []}
                    for check in syn_checks:
                        check.setdefault("source", "synthetic_ai")
                    qc_report["checks"].extend(syn_checks)
                    qc_report["synthetic"] = {"model": GMI_MULTIMODAL_MODEL, "frames": syn_frames,
                                              "prompt_reference": bool(gen_manifest_path)}
                    progress(job, {"type": "step_done", "step": "qc_synthetic",
                                   "checks": [c["name"] for c in syn_checks],
                                   "billable": {"unit": "frames", "units": syn_frames}})
                except Exception as e:
                    progress(job, {"type": "step_error", "step": "qc_synthetic", "error": str(e)})
        else:
            progress(job, {"type": "step_skipped", "step": "qc_synthetic", "reason": "disabled by sender"})

        # 3c. Finalize a read-only report. Legacy self_heal options are ignored:
        #     Waystation observes and reports; it never changes the master.
        if qc_report is not None:
            qc_report = qreport.finalize(qc_report, profile)
            qc_report = qagentic.finalize_report(
                qc_report, meta, job.key, agentic_report, ai_state)

        # 3d. one provenance-covered report for deterministic and AI lanes.
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
            "qc": ("waystation", "qc-reporter/deterministic+agentic", StepType.CUSTOM, Modality.TEXT),
        }
        gb_steps = []
        for i, d in enumerate(derivatives):
            prov, model, stype, mod = STEP_INFO.get(d["step"], ("waystation", d["step"], StepType.CUSTOM, Modality.TEXT))
            step_metadata = None
            if d["step"] == "qc" and qc_report:
                step_metadata = {
                    "report_schema": qc_report.get("schema_version"),
                    "reporter_mode": qc_report.get("reporter_mode"),
                    "coverage_registry": qc_report.get("coverage", {}).get("registry_version"),
                    "coverage_accounting_complete": qc_report.get("coverage", {}).get("accounting_complete"),
                }
            gb_steps.append(GbStep(
                step_id=d["step"], run_id=tid, provider=prov, model=model,
                step_type=stype, modality=mod, status=StepStatus.SUCCEEDED,
                step_index=i, inputs=[src_asset],
                assets=[GbAsset(asset_id=d["step"] + "-out", url=f"s3://{BUCKET}/{d['key']}",
                                media_type=d["mime"], sha256=d["sha256"])],
                metadata=step_metadata or {}))
        if agentic_report:
            prompt_meta = agentic_report["prompt"]
            for pass_name in ("independent", "informed", "critic"):
                gb_steps.append(GbStep(
                    step_id=f"qc-agent-{pass_name}", run_id=tid,
                    provider="gmicloud", model=GMI_MULTIMODAL_MODEL,
                    step_type=StepType.GENERATE, modality=Modality.TEXT,
                    status=StepStatus.SUCCEEDED, step_index=len(gb_steps),
                    inputs=[src_asset], metadata={
                        "purpose": "read-only media QC reporting",
                        "pass": pass_name,
                        "prompt_version": prompt_meta["version"],
                        "prompt_sha256": prompt_meta["sha256"],
                        "risk_registry_version": prompt_meta["risk_registry_version"],
                        "repairs_allowed": False,
                    }))
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
                      "compute": WORKER_LABEL,
                      "reporter_mode": "read_only_no_repair",
                      **({"qc_prompt_version": agentic_report["prompt"]["version"],
                          "qc_prompt_sha256": agentic_report["prompt"]["sha256"],
                          "qc_risk_registry": agentic_report["prompt"]["risk_registry_version"]}
                         if agentic_report else {}),
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
