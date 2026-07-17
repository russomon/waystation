"""Task 2 — Signal Video Quality.
Decode integrity, black/freeze detection, picture boundaries, EBU-R103-style
legal range (signalstats), letterbox/pillarbox mattes (cropdetect), aspect
ratio sanity, PSE flash-risk (BT.1702-informed heuristic on the YDIF series),
upconversion screening, reference SSIM/PSNR/VMAF (MOS), and operational
metadata detection (CEA-608/A53, AFD, Dolby Vision RPU presence)."""
from __future__ import annotations

import json
import os
import re

from .report import check, violation
from .util import metadata_print, run, tag_values

ANALYSIS_WINDOW_S = 60.0   # bounded window keeps runtime flat on long masters


def decode_and_detections(src: str, has_video: bool, has_audio: bool) -> tuple:
    """Full-decode corruption pass + black/freeze/silence detections.
    Returns (checks, black_segments) — segments feed the boundary check."""
    checks = []
    dec = run(["ffmpeg", "-v", "error", "-i", src, "-f", "null", "-"])
    errs = [ln for ln in dec.stderr.splitlines() if ln.strip()]
    checks.append(check("decode", "pass" if not errs else "fail",
                        f"{len(errs)} error line(s)" + (f"; first: {errs[0][:120]}" if errs else "")))

    cmd = ["ffmpeg", "-hide_banner", "-i", src]
    if has_video:
        cmd += ["-vf", "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2"]
    if has_audio:
        cmd += ["-af", "silencedetect=noise=-50dB:d=2"]
    cmd += ["-f", "null", "-"]
    log = run(cmd).stderr

    blacks = []
    if has_video:
        blacks = [(float(a), float(b)) for a, b in
                  re.findall(r"black_start:([\d.]+).*?black_end:([\d.]+)", log)]
        freezes = log.count("freeze_start")
        checks.append(check("black_frames", "pass" if not blacks else "warn",
                            f"{len(blacks)} black segment(s)"))
        checks.append(check("freeze_frames", "pass" if freezes == 0 else "warn",
                            f"{freezes} frozen segment(s)"))
    if has_audio:
        silences = log.count("silence_start")
        checks.append(check("audio_silence", "pass" if silences == 0 else "warn",
                            f"{silences} silent segment(s)", "audio"))
    return checks, blacks


def boundary_check(blacks: list, duration: float) -> list:
    """Picture boundaries: lead-in/lead-out black and active picture duration."""
    if not duration:
        return []
    lead = next((b for a, b in blacks if a < 0.25), 0.0)
    tail = next((duration - a for a, b in blacks if b > duration - 0.25), 0.0)
    active = duration - lead - tail
    detail = f"active picture {active:.2f}s of {duration:.2f}s"
    if lead or tail:
        detail += f" (lead-in black {lead:.2f}s, lead-out black {tail:.2f}s)"
    return [check("picture_boundaries", "info", detail)]


def range_and_pse(src: str, duration: float, profile: dict, bit_depth: int = 8) -> list:
    """One signalstats pass powers two checks:
    - video_legal_range: Y outside 16–235 / chroma outside 16–240 (R103-style
      overshoot policing at the YUV level, ±2 code-value tolerance)
    - pse_flash_risk: BT.1702-informed heuristic — count of alternating
      high-luma-delta transitions per second window (>=5/s flags)."""
    checks = []
    scale = 1 << (bit_depth - 8)
    off = min(duration * 0.1, 5.0) if duration else 0.0
    lines = metadata_print(src, "signalstats", min(ANALYSIS_WINDOW_S, duration or ANALYSIS_WINDOW_S), off)
    if not lines:
        return [check("video_legal_range", "info", "signalstats produced no frames", )]

    ymin = min(tag_values(lines, "lavfi.signalstats.YMIN") or [16 * scale])
    ymax = max(tag_values(lines, "lavfi.signalstats.YMAX") or [235 * scale])
    cmin = min((tag_values(lines, "lavfi.signalstats.UMIN") or [16 * scale]) +
               (tag_values(lines, "lavfi.signalstats.VMIN") or [16 * scale]))
    cmax = max((tag_values(lines, "lavfi.signalstats.UMAX") or [240 * scale]) +
               (tag_values(lines, "lavfi.signalstats.VMAX") or [240 * scale]))

    # R103-style amplitude + area policy: codec ringing legitimately produces
    # isolated out-of-range samples, so we flag only when pixels beyond the
    # R103 transient tolerance (Y outside -5%..+105% ≈ 5..246, chroma 5..251
    # in 8-bit) cover more than 0.1% of the picture. A lut violation-mask pass
    # turns signalstats plane averages into exact out-of-range fractions.
    ylo, yhi = 5 * scale, 246 * scale
    clo, chi = 5 * scale, 251 * scale
    # Explicit 0/full mask values: lutyuv's minval/maxval are COLOR-RANGE
    # dependent (16/235 on limited-range input), which would bias the average.
    outv = 255 * scale
    mask = (f"lutyuv=y='if(between(val,{ylo},{yhi}),0,{outv})'"
            f":u='if(between(val,{clo},{chi}),0,{outv})'"
            f":v='if(between(val,{clo},{chi}),0,{outv})',signalstats")
    mlines = metadata_print(src, mask, min(ANALYSIS_WINDOW_S, duration or ANALYSIS_WINDOW_S), off)
    full = 255.0 * scale
    def frac(key):
        vals = tag_values(mlines, key)
        return (sum(vals) / len(vals) / full) if vals else 0.0
    fy, fu, fv = frac("lavfi.signalstats.YAVG"), frac("lavfi.signalstats.UAVG"), frac("lavfi.signalstats.VAVG")
    worst_frac = max(fy, fu, fv)
    detail = (f"Y [{ymin:.0f}..{ymax:.0f}] chroma [{cmin:.0f}..{cmax:.0f}]; "
              f"out-of-tolerance pixels Y {fy:.3%} / U {fu:.3%} / V {fv:.3%} "
              f"(area threshold 0.1%)")
    if worst_frac > 0.001:
        checks.append(violation("video_legal_range", profile["video_range"]["escalate"],
                                "level overshoot: " + detail))
    else:
        checks.append(check("video_legal_range", "pass", detail))

    if profile["pse"]["enabled"]:
        ydif = tag_values(lines, "lavfi.signalstats.YDIF")
        fps = max(round(len(ydif) / max(min(ANALYSIS_WINDOW_S, duration or 1), 0.1)), 1)
        worst = 0
        for i in range(0, max(len(ydif) - fps, 1), max(fps // 2, 1)):
            window = ydif[i:i + fps]
            worst = max(worst, sum(1 for d in window if d > 40 * scale))
        if worst >= 5:
            checks.append(violation("pse_flash_risk", profile["pse"]["escalate"],
                                    f"up to {worst} high-luma flashes/second — photosensitivity risk "
                                    f"(BT.1702-informed screen)", ))
        else:
            checks.append(check("pse_flash_risk", "pass",
                                f"max {worst} luma flash(es)/second in the analysis window"))
    return checks


def matte_and_aspect(src: str, meta: dict, duration: float) -> list:
    """cropdetect-based matte detection + SAR/DAR sanity."""
    checks = []
    v = next((s for s in meta.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        return checks
    w, h = int(v.get("width", 0) or 0), int(v.get("height", 0) or 0)
    off = min(duration * 0.2, 10.0) if duration else 0.0
    log = run(["ffmpeg", "-hide_banner", "-ss", f"{off:.2f}", "-t", "10", "-i", src,
               "-vf", "cropdetect=limit=24:round=2", "-f", "null", "-"]).stderr
    crops = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", log)
    if crops and w and h:
        cw, ch, _, _ = map(int, crops[-1])
        if ch < h * 0.97 and cw >= w * 0.97:
            checks.append(check("letterbox_matte", "warn",
                                f"letterboxing detected: active {cw}x{ch} inside {w}x{h}"))
        elif cw < w * 0.97 and ch >= h * 0.97:
            checks.append(check("letterbox_matte", "warn",
                                f"pillarboxing detected: active {cw}x{ch} inside {w}x{h}"))
        elif cw < w * 0.97 and ch < h * 0.97:
            checks.append(check("letterbox_matte", "warn",
                                f"windowboxing/matte error: active {cw}x{ch} inside {w}x{h}"))
        else:
            checks.append(check("letterbox_matte", "pass", "full active picture, no unexpected mattes"))

    sar = v.get("sample_aspect_ratio", "1:1")
    if sar not in ("1:1", "0:1", "", None):
        checks.append(check("aspect_ratio", "warn",
                            f"non-square pixels (SAR {sar}) — anamorphic stretch on square-pixel displays"))
    else:
        checks.append(check("aspect_ratio", "pass",
                            f"{w}x{h}, square pixels, DAR {v.get('display_aspect_ratio', '?')}"))
    return checks


def upconversion_check(src: str, meta: dict, duration: float) -> list:
    """Spatial-frequency screen: if a frame survives a down/up round-trip nearly
    unchanged (SSIM > 0.985) it carries no genuine HD detail — likely an
    SD/soft upconversion. Screening signal only, never escalated."""
    v = next((s for s in meta.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v or int(v.get("height", 0) or 0) < 480 or not duration:
        return []
    w, h = int(v["width"]), int(v["height"])
    scores = []
    for frac in (0.25, 0.5, 0.75):
        t = duration * frac
        log = run(["ffmpeg", "-hide_banner", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1",
                   "-filter_complex",
                   f"[0:v]split=2[a][b];[b]scale={w // 2}:{h // 2},scale={w}:{h}[c];[a][c]ssim",
                   "-f", "null", "-"]).stderr
        m = re.search(r"All:([\d.]+)", log)
        if m:
            scores.append(float(m.group(1)))
    if not scores:
        return []
    avg = sum(scores) / len(scores)
    if avg > 0.985:
        return [check("upconversion", "info",
                      f"low spatial frequency content (round-trip SSIM {avg:.3f}) — possible SD upconversion")]
    return [check("upconversion", "pass", f"native detail present (round-trip SSIM {avg:.3f})")]


def reference_checks(src: str, ref: str, tmp: str) -> list:
    """Reference-based scan vs a source mezzanine: SSIM, PSNR, and VMAF as the
    perceptual (PVQ) model — VMAF/20 reported as a 1–5 MOS."""
    checks = []
    log = run(["ffmpeg", "-hide_banner", "-i", src, "-i", ref,
               "-filter_complex", "[0:v][1:v]ssim;[0:v][1:v]psnr", "-f", "null", "-"]).stderr
    ssim = re.search(r"SSIM.*All:([\d.]+)", log)
    psnr = re.search(r"PSNR.*average:([\d.inf]+)", log)
    if ssim:
        val = float(ssim.group(1))
        checks.append(check("reference_ssim", "pass" if val >= 0.95 else "warn",
                            f"SSIM {val:.4f} vs source mezzanine"))
    if psnr:
        p = psnr.group(1)
        pval = 99.0 if p == "inf" else float(p)
        checks.append(check("reference_psnr", "pass" if pval >= 35 else "warn",
                            f"PSNR {p} dB vs source mezzanine"))
    vmaf_log = os.path.join(tmp, "vmaf.json")
    v = run(["ffmpeg", "-hide_banner", "-i", src, "-i", ref, "-filter_complex",
             f"[0:v][1:v]libvmaf=log_fmt=json:log_path={vmaf_log}", "-f", "null", "-"])
    if v.returncode == 0 and os.path.exists(vmaf_log):
        try:
            data = json.load(open(vmaf_log))
            mean = data["pooled_metrics"]["vmaf"]["mean"]
            vmin = data["pooled_metrics"]["vmaf"]["min"]
            mos = round(mean / 20.0, 2)
            checks.append(check("reference_vmaf", "pass" if mean >= 80 else "warn",
                                f"VMAF {mean:.1f} (min {vmin:.1f}) — MOS {mos}/5.0"))
        except (KeyError, ValueError):
            pass
    return checks


def operational_metadata(src: str, meta: dict, profile: dict) -> list:
    """CEA-608/A53 captions, AFD, and Dolby Vision RPU side-data detection.
    DoVi canvas-match verification needs dovi_tool + RPU parsing — declared
    honestly as unverified when the strict profile asks for it."""
    checks = []
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#90",
               "-show_entries", "frame=side_data_list", "-of", "json", src])
    side = out.stdout or ""
    if "A53" in side or "Closed Captions" in side:
        checks.append(check("cc_metadata", "info", "CEA-608/A53 caption side data present (line-21 payload)"))
    if "Active Format Description" in side:
        checks.append(check("cc_metadata_afd", "info", "AFD operational metadata present"))

    dovi = any("DOVI" in str(s.get("side_data_list", "")) or
               s.get("codec_tag_string", "") in ("dvh1", "dvhe")
               for s in meta.get("streams", []))
    if dovi:
        checks.append(check("hdr_dolby_vision", "warn",
                            "Dolby Vision metadata present — dynamic canvas match requires dovi_tool "
                            "RPU parsing (unverified here)"))
    elif profile.get("constraints", {}).get("hdr_metadata_tracking"):
        checks.append(check("hdr_dolby_vision", "info",
                            "no Dolby Vision metadata (SDR delivery) — canvas-match rule not applicable"))
    return checks
