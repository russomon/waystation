"""Task 1 — Container & Structural Integrity.
Timecode/DTS continuity, wrapper-vs-payload comparison, multipart heuristics,
frame-rate law (native rates, VFR, pulldown, field order via idet), and an
ABR (HLS/DASH) manifest lint for packaged deliveries."""
from __future__ import annotations

import os
import re
import statistics
import xml.etree.ElementTree as ET

from .report import check, violation
from .util import analysis_windows, fps_label, fps_value, run

_MULTIPART_RE = re.compile(r"(?:^|[\s_\-.])(?:part|pt|reel|disc|disk|cd)[\s_\-.]?\d+", re.I)


def timecode_checks(src: str) -> list:
    """DTS monotonicity + timeline-gap scan over the first ~1200 video packets.
    Backwards jumps and random gaps are exactly what breaks downstream conform."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "packet=dts_time", "-of", "csv=p=0",
               "-read_intervals", "%+#1200", src])
    ts = []
    for ln in out.stdout.splitlines():
        v = ln.strip().rstrip(",")
        if v and v != "N/A":
            try:
                ts.append(float(v))
            except ValueError:
                pass
    if len(ts) < 10:
        return [check("timecode_continuity", "info", "too few timestamped packets to scan", "structural")]
    deltas = [b - a for a, b in zip(ts, ts[1:])]
    backwards = sum(1 for d in deltas if d < 0)
    med = statistics.median(d for d in deltas if d > 0) if any(d > 0 for d in deltas) else 0
    gaps = sum(1 for d in deltas if med and d > 2.5 * med)
    if backwards or gaps:
        return [check("timecode_continuity", "warn",
                      f"{backwards} backwards jump(s), {gaps} timeline gap(s) in {len(ts)} packets", "structural")]
    return [check("timecode_continuity", "pass",
                  f"{len(ts)} packets scanned, monotonic, no gaps", "structural")]


def container_checks(meta: dict, key: str, profile: dict) -> list:
    """Wrapper header vs payload attributes + multipart-delivery detection."""
    checks = []
    fmt = meta.get("format", {})
    fdur = float(fmt.get("duration", 0) or 0)
    sdur = max((float(s.get("duration", 0) or 0) for s in meta.get("streams", [])), default=0.0)
    if fdur and sdur and abs(fdur - sdur) > max(0.5, 0.02 * fdur):
        checks.append(check("container_metadata", "warn",
                            f"header duration {fdur:.2f}s vs payload {sdur:.2f}s — possible incomplete transfer",
                            "structural"))
    else:
        checks.append(check("container_metadata", "pass",
                            f"{fmt.get('format_name', '?')}, header/payload durations agree", "structural"))

    base = os.path.basename(key or "")
    if _MULTIPART_RE.search(base):
        checks.append(violation("multipart_delivery", not profile["allow_multipart"],
                                f'"{base}" parses as a split/multi-part delivery', "structural"))
    else:
        checks.append(check("multipart_delivery", "pass", "single long-play asset", "structural"))
    return checks


def framerate_checks(src: str, meta: dict, profile: dict) -> list:
    """Native-rate law: allowed-rate list, VFR flag, interlace field order and
    3:2 pulldown cadence via a bounded idet pass."""
    checks = []
    vstreams = [s for s in meta.get("streams", []) if s.get("codec_type") == "video"]
    if not vstreams:
        return checks
    v = vstreams[0]
    avg, real = v.get("avg_frame_rate", "0/1"), v.get("r_frame_rate", "0/1")

    # idet: field order + repeated-field (telecine) cadence. Cadence breaks
    # happen at edit points ANYWHERE, so sample ~200 frames at several offsets
    # across the timeline and aggregate, rather than only the opening seconds.
    duration = float(meta.get("format", {}).get("duration", 0) or 0)
    offsets = [s for s, _ in analysis_windows(duration, window=8.0, min_windows=1, max_total=40.0)]
    tff = bff = prog = rep_n = rep_t = rep_b = 0
    for off in offsets:
        cmd = ["ffmpeg", "-hide_banner"]
        if off > 0:
            cmd += ["-ss", f"{off:.2f}"]
        cmd += ["-i", src, "-map", "0:v:0", "-vf", "idet", "-frames:v", "200", "-an", "-f", "null", "-"]
        log = run(cmd).stderr
        m = re.search(r"Multi frame detection: TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)", log)
        if m:
            tff += int(m.group(1)); bff += int(m.group(2)); prog += int(m.group(3))
        r = re.search(r"Repeated Fields: Neither:\s*(\d+)\s*Top:\s*(\d+)\s*Bottom:\s*(\d+)", log)
        if r:
            rep_n += int(r.group(1)); rep_t += int(r.group(2)); rep_b += int(r.group(3))
    if tff + bff + prog == 0:
        prog = 1
    if rep_n + rep_t + rep_b == 0:
        rep_n = 1

    declared_field_order = str(v.get("field_order") or "").lower()
    declared_interlaced = declared_field_order not in ("", "unknown", "progressive")
    # The broadcast baseline treats the encoded stream's field-order flag as a
    # wrapper fact and idet as sampled picture evidence. Synthetic or low-motion
    # interlaced material can look progressive to idet even when correctly
    # flagged TFF, so either source is sufficient to classify the delivery.
    interlaced = ((tff + bff) > prog
                  or (profile.get("name") == "us_broadcast_xdcam_hd_422_v1"
                      and declared_interlaced))
    if interlaced and tff and bff:
        checks.append(check("field_order", "warn",
                            f"mixed field order (TFF {tff} / BFF {bff}) — possible cadence reversal", "structural"))
    else:
        checks.append(check("field_order", "pass" if not interlaced else "info",
                            "progressive" if not interlaced
                            else ("top-field-first" if declared_field_order in ("tt", "tb") or tff >= bff
                                  else "bottom-field-first"), "structural"))

    total_rep = rep_n + rep_t + rep_b
    pulldown = total_rep > 0 and (rep_t + rep_b) / total_rep > 0.10
    if pulldown:
        checks.append(violation("pulldown", not profile["allow_pulldown"],
                                f"3:2 pulldown cadence detected ({rep_t + rep_b}/{total_rep} repeated fields)",
                                "structural"))
    else:
        checks.append(check("pulldown", "pass", "no repeated-field cadence", "structural"))

    label = fps_label(avg, interlaced)
    allowed = profile["framerates"]
    if allowed is not None:
        if label in allowed:
            checks.append(check("framerate", "pass", f"{label} — native rate on the allowed list", "structural"))
        else:
            checks.append(violation("framerate", True,
                                    f"{label} is not an allowed delivery rate {allowed}", "structural"))
    else:
        checks.append(check("framerate", "pass", f"{label}", "structural"))

    if abs(fps_value(avg) - fps_value(real)) > 0.01 * max(fps_value(real), 1):
        checks.append(violation("vfr", not profile["allow_vfr"],
                                f"variable frame rate (avg {avg} vs container {real}) — conversion suspected",
                                "structural"))
    if interlaced and not profile["allow_interlaced"]:
        checks.append(violation("interlaced_content", True,
                                f"interlaced content ({label}); profile requires progressive", "structural"))
    return checks


def abr_lint(path: str) -> list:
    """Minimal HLS/DASH package lint: syntax, segment declarations, alignment
    flags, and bitrate-ladder burst spikes (adjacent variant > 2.5x jump)."""
    checks = []
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except OSError as e:
        return [check("abr_manifest", "fail", f"unreadable manifest: {e}", "structural")]

    if path.lower().endswith(".m3u8"):
        if not text.lstrip().startswith("#EXTM3U"):
            return [check("abr_manifest", "fail", "missing #EXTM3U header", "structural")]
        bandwidths = [int(m) for m in re.findall(r"BANDWIDTH=(\d+)", text)]
        segs = len(re.findall(r"^#EXTINF:", text, re.M))
        uris = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
        problems = []
        if segs and len(uris) < segs:
            problems.append(f"{segs} #EXTINF entries but only {len(uris)} segment URIs")
        if segs and "#EXT-X-ENDLIST" not in text:
            problems.append("no #EXT-X-ENDLIST (unterminated VOD playlist)")
        ladder = sorted(bandwidths)
        spikes = sum(1 for a, b in zip(ladder, ladder[1:]) if a and b / a > 2.5)
        if spikes:
            problems.append(f"{spikes} bitrate burst spike(s) >2.5x between adjacent variants")
        if problems:
            checks.append(check("abr_manifest", "warn", "; ".join(problems), "structural"))
        else:
            checks.append(check("abr_manifest", "pass",
                                f"HLS: {len(bandwidths)} variant(s), {segs} segment(s) declared", "structural"))
    elif path.lower().endswith(".mpd"):
        try:
            root = ET.fromstring(text)
            ns = root.tag.split("}")[0] + "}" if "}" in root.tag else ""
            reps = root.findall(f".//{ns}Representation")
            unaligned = [a for a in root.findall(f".//{ns}AdaptationSet")
                         if a.get("segmentAlignment", "true").lower() != "true"]
            if not reps:
                checks.append(check("abr_manifest", "warn", "DASH MPD has no Representations", "structural"))
            elif unaligned:
                checks.append(check("abr_manifest", "warn",
                                    f"{len(unaligned)} AdaptationSet(s) without segmentAlignment", "structural"))
            else:
                checks.append(check("abr_manifest", "pass", f"DASH: {len(reps)} representation(s), aligned",
                                    "structural"))
        except ET.ParseError as e:
            checks.append(check("abr_manifest", "fail", f"MPD XML syntax error: {e}", "structural"))
    return checks
