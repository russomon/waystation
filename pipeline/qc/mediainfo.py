"""MediaInfo-based wrapper and broadcast metadata checks.

MediaInfo sees some MXF/profile metadata more clearly than ffprobe. Treat it
as an optional structural analyzer: unavailable tooling is an explicit FYI,
while real wrapper mismatches become profile-aware findings.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil

from .report import check, violation
from .util import run


def _tracks(payload: dict) -> list:
    media = payload.get("media") or {}
    tracks = media.get("track") or []
    return tracks if isinstance(tracks, list) else []


def _track(tracks: list, kind: str) -> dict:
    return next((t for t in tracks if t.get("@type") == kind), {})


def _has_any(track: dict, needles: tuple[str, ...]) -> bool:
    text = " ".join(f"{k} {v}" for k, v in track.items()).lower()
    return any(n.lower() in text for n in needles)


def _facts(general: dict, video: dict, audio_tracks: list[dict]) -> dict:
    """Normalized fact inventory for independent metadata cross-validation."""
    audio = audio_tracks[0] if audio_tracks else {}
    rate_num = video.get("FrameRate_Num")
    rate_den = video.get("FrameRate_Den")
    rate = f"{rate_num}/{rate_den}" if rate_num and rate_den else video.get("FrameRate")
    scan = video.get("ScanOrder") or video.get("ScanType")
    chroma = video.get("ChromaSubsampling") or video.get("ColorSpace")
    return {
        "format": general.get("Format"),
        "width": video.get("Width"), "height": video.get("Height"),
        "frame_rate": rate, "scan": scan, "chroma": chroma,
        "video_bit_depth": video.get("BitDepth"),
        "audio_sample_rate": audio.get("SamplingRate"),
        "audio_channels": audio.get("Channels"),
        "color_transfer": video.get("transfer_characteristics") or video.get("TransferCharacteristics"),
        "color_primaries": video.get("colour_primaries") or video.get("ColorPrimaries"),
        "color_space": video.get("matrix_coefficients") or video.get("MatrixCoefficients"),
        "color_range": video.get("colour_range") or video.get("ColorRange"),
        "hdr_format": video.get("HDR_Format"),
        "hdr_format_profile": video.get("HDR_Format_Profile"),
        "hdr_compatibility": video.get("HDR_Format_Compatibility"),
    }


def checks(src: str, profile: dict) -> list:
    """Run `mediainfo --Output=JSON` and emit structural delivery findings.

    Current scope: container/profile reporting, MXF OP1a enforcement for strict
    profiles, AS-11/UK DPP metadata visibility, HDR format FYIs, and Dolby
    E/Atmos transparency caveats.
    """
    if not shutil.which("mediainfo"):
        return [check("mediainfo_wrapper", "info",
                      "MediaInfo unavailable (not found) — MXF OP1a / AS-11 / Dolby metadata "
                      "cross-check skipped", "structural")]

    r = run(["mediainfo", "--Output=JSON", src])
    if r.returncode != 0:
        missing = "not found" if not r.stderr.strip() else r.stderr.strip().splitlines()[-1][:120]
        return [check("mediainfo_wrapper", "info",
                      f"MediaInfo unavailable ({missing}) — MXF OP1a / AS-11 / Dolby metadata "
                      "cross-check skipped", "structural")]
    try:
        data = json.loads(r.stdout or "{}")
    except json.JSONDecodeError as e:
        return [check("mediainfo_wrapper", "warn",
                      f"MediaInfo JSON parse failed: {e}", "structural")]

    tracks = _tracks(data)
    general = _track(tracks, "General")
    video = _track(tracks, "Video")
    audio_tracks = [t for t in tracks if t.get("@type") == "Audio"]
    fmt = str(general.get("Format") or os.path.splitext(src)[1].lstrip(".") or "Unknown")
    profile_name = str(general.get("Format_Profile") or general.get("Format profile") or "")
    wrapper = check("mediainfo_wrapper", "pass",
                    f"{fmt}" + (f", profile {profile_name}" if profile_name else ""), "structural")
    wrapper.update({
        "facts": _facts(general, video, audio_tracks),
        "report_sha256": hashlib.sha256((r.stdout or "").encode()).hexdigest(),
        "provenance": {"tool": "mediainfo", "method": "--Output=JSON fact inventory"},
    })
    checks_out = [wrapper]

    strict = profile.get("name") in ("netflix", "us_broadcast_xdcam_hd_422_v1") \
        or bool(profile.get("photon_required"))
    if fmt.upper() == "MXF":
        op = f"{profile_name} {general.get('Format_Commercial_IfAny', '')}".lower()
        op_norm = "".join(ch for ch in op if ch.isalnum())
        is_op1a = "op1a" in op_norm or "operationalpattern1a" in op_norm
        if is_op1a:
            checks_out.append(check("mxf_op1a", "pass", "MXF wrapper is OP1a", "structural"))
        else:
            checks_out.append(violation("mxf_op1a", strict,
                                        "MXF wrapper is not visibly OP1a in MediaInfo metadata",
                                        "structural"))
        if _has_any(general, ("as-11", "as11", "ukdpp", "uk dpp", "dpp")):
            checks_out.append(check("as11_dpp_metadata", "pass",
                                    "AS-11 / UK DPP metadata visible", "structural"))
        else:
            checks_out.append(check("as11_dpp_metadata", "info",
                                    "AS-11 / UK DPP metadata not visible in MediaInfo output",
                                    "structural"))
    else:
        checks_out.append(check("mxf_op1a", "info",
                                f"{fmt} input — MXF OP1a rule not applicable", "structural"))

    hdr_bits = []
    for key in ("HDR_Format", "HDR_Format_Profile", "HDR_Format_Compatibility"):
        val = video.get(key)
        if val:
            hdr_bits.append(str(val))
    if hdr_bits:
        checks_out.append(check("mediainfo_hdr", "info",
                                " / ".join(hdr_bits[:4]), "structural"))

    for idx, audio in enumerate(audio_tracks, start=1):
        afmt = str(audio.get("Format") or "")
        if "Dolby E" in afmt or "E-AC-3 JOC" in afmt or "Atmos" in str(audio):
            checks_out.append(check("dolby_audio_metadata", "info",
                                    f"audio track {idx}: {afmt} detected — stream-level metadata visible, "
                                    "Dolby E/Atmos sub-frame validation needs specialized tooling",
                                    "audio"))
    return checks_out
