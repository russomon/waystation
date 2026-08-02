"""Bounded QCTools analytics for the broadcast baseline.

QCTools is an evidence collector, not a compliance engine. The reducer exposes
validated frame measurements and report hashes as advisory facts. Missing,
failed, or malformed analysis is always explicit ``not_checked``.
"""
from __future__ import annotations

import gzip
import hashlib
import math
import os
import shutil
import statistics
import subprocess
import xml.etree.ElementTree as ET

from .report import policy_check
from .util import run


SCHEMA_VERSION = "waystation-qctools-evidence/1.0"
VALIDATED_METRICS = (
    "lavfi.signalstats.YMIN",
    "lavfi.signalstats.YMAX",
    "lavfi.signalstats.YAVG",
    "lavfi.signalstats.YDIF",
    "lavfi.signalstats.BRNG",
    "lavfi.signalstats.TOUT",
    "lavfi.signalstats.VREP",
)


def _policy(profile: dict) -> dict:
    pack = profile["policy_pack"]
    return {"id": pack["id"], "version": pack["version"],
            "effective_sha256": pack["effective_sha256"]}


def _version() -> str:
    result = run(["qcli", "-v"], timeout=10)
    output = "\n".join(filter(None, [result.stdout, result.stderr]))
    return next((line.strip() for line in output.splitlines() if line.strip()), "unknown")[:240]


def _not_checked(profile: dict, detail: str, observed: dict | None = None) -> dict:
    version = "unavailable"
    if shutil.which("qcli"):
        try:
            version = _version()
        except (OSError, subprocess.TimeoutExpired):
            version = "unavailable"
    return policy_check(
        "qctools_analytics", "info", detail, "signal",
        policy=_policy(profile),
        expectation={"value": "bounded advisory frame analytics"},
        observation={"value": observed, "state": "not_checked"},
        evidence=[],
        provenance={"tool": "qcli", "version": version,
                    "configured_version": os.environ.get("QCTOOLS_VERSION") or None,
                    "source_revision": os.environ.get("QCTOOLS_COMMIT") or None,
                    "method": "bounded excerpts; signalstats XML reducer",
                    "schema_version": SCHEMA_VERSION},
        authority="deterministic_advisory",
    )


def analysis_windows(duration: float, window_seconds: float, max_windows: int) -> list[tuple[float, float]]:
    """Evenly cover the timeline with a fixed upper bound on decoded seconds."""
    duration = max(float(duration or 0), 0.0)
    window_seconds = max(float(window_seconds), 0.5)
    max_windows = max(1, int(max_windows))
    if not duration:
        return []
    if duration <= window_seconds:
        return [(0.0, duration)]
    starts = [i * (duration - window_seconds) / max(max_windows - 1, 1)
              for i in range(max_windows)]
    return [(round(start, 3), round(min(window_seconds, duration - start), 3))
            for start in starts]


def parse_report(path: str) -> dict:
    """Reduce only the QCTools XML tags validated by the fixture proof."""
    values: dict[str, list[float]] = {name: [] for name in VALIDATED_METRICS}
    frame_count = 0
    with gzip.open(path, "rb") as handle:
        for _event, elem in ET.iterparse(handle, events=("end",)):
            if elem.tag.rsplit("}", 1)[-1] == "frame" and elem.attrib.get("media_type") == "video":
                frame_count += 1
                for child in elem:
                    if child.tag.rsplit("}", 1)[-1] != "tag":
                        continue
                    key = child.attrib.get("key")
                    if key not in values:
                        continue
                    try:
                        value = float(child.attrib.get("value", ""))
                    except ValueError:
                        continue
                    if math.isfinite(value):
                        values[key].append(value)
                elem.clear()
    if frame_count < 1:
        raise ValueError("QCTools report contained no video frames")
    metrics = {}
    for name, samples in values.items():
        if not samples:
            continue
        metrics[name] = {
            "samples": len(samples),
            "minimum": round(min(samples), 6),
            "maximum": round(max(samples), 6),
            "mean": round(statistics.fmean(samples), 6),
        }
    if not metrics:
        raise ValueError("QCTools report contained no validated signalstats measurements")
    return {"frames": frame_count, "metrics": metrics}


def analyze(src: str, tmp: str, duration: float, profile: dict) -> tuple[list[dict], dict]:
    rules = profile["broadcast_policy"]["qctools"]
    provenance = {
        "tool": "qcli",
        "version": "unavailable",
        "configured_version": os.environ.get("QCTOOLS_VERSION") or None,
        "source_revision": os.environ.get("QCTOOLS_COMMIT") or None,
        "method": "bounded FFV1/PCM excerpts; qcli stats-only signalstats; XML reducer",
        "schema_version": SCHEMA_VERSION,
    }
    if not shutil.which("qcli"):
        finding = _not_checked(profile, "QCTools qcli unavailable; analytics not checked")
        return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": []}
    try:
        provenance["version"] = _version()
    except (OSError, subprocess.TimeoutExpired) as exc:
        finding = _not_checked(profile, f"QCTools version probe failed; analytics not checked: {str(exc)[:160]}")
        return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": []}
    windows = analysis_windows(duration, rules["window_seconds"], rules["max_windows"])
    if not windows:
        finding = _not_checked(profile, "media duration unavailable; QCTools analytics not checked")
        return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": []}

    observations = []
    artifacts = []
    for index, (start, length) in enumerate(windows, 1):
        sample = os.path.join(tmp, f"qctools-sample-{index}.mkv")
        report = os.path.join(tmp, f"qctools-sample-{index}.qctools.xml.gz")
        try:
            excerpt = run([
                "ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
                "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "ffv1", "-level", "3",
                "-c:a", "pcm_s24le", sample,
            ], timeout=max(120, int(length * 20)))
        except (OSError, subprocess.TimeoutExpired) as exc:
            finding = _not_checked(profile, f"bounded QCTools excerpt failed; analytics not checked: {str(exc)[:160]}")
            finding["provenance"] = provenance
            return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": artifacts}
        if excerpt.returncode != 0 or not os.path.exists(sample):
            finding = _not_checked(
                profile, f"bounded QCTools excerpt {index} failed; analytics not checked",
                {"window": [start, length], "returncode": excerpt.returncode,
                 "stderr": excerpt.stderr.strip()[:200]},
            )
            finding["provenance"] = provenance
            return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": artifacts}
        try:
            result = run([
                "qcli", "-y", "-s", "-f", "signalstats", "-i", sample, "-o", report,
            ], timeout=max(180, int(length * 30)))
        except (OSError, subprocess.TimeoutExpired) as exc:
            finding = _not_checked(profile, f"QCTools execution failed; analytics not checked: {str(exc)[:160]}")
            finding["provenance"] = provenance
            return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": artifacts}
        if result.returncode != 0 or not os.path.exists(report) or os.path.getsize(report) == 0:
            finding = _not_checked(
                profile, f"QCTools report {index} failed; analytics not checked",
                {"window": [start, length], "returncode": result.returncode,
                 "stderr": result.stderr.strip()[:200]},
            )
            finding["provenance"] = provenance
            return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": artifacts}
        try:
            reduced = parse_report(report)
        except (OSError, EOFError, ET.ParseError, ValueError) as exc:
            finding = _not_checked(profile, f"QCTools report malformed; analytics not checked: {str(exc)[:160]}")
            finding["provenance"] = provenance
            return [finding], {"schema_version": SCHEMA_VERSION, "state": "not_checked", "artifacts": artifacts}
        with open(report, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        artifact = {"id": f"qctools:window-{index}", "kind": "qctools_xml_gzip",
                    "sha256": digest, "bytes": os.path.getsize(report),
                    "time_range": {"start_seconds": start, "end_seconds": round(start + length, 3)}}
        artifacts.append(artifact)
        observations.append({"window": artifact["time_range"], **reduced})

    finding = policy_check(
        "qctools_analytics", "info",
        f"QCTools measured {sum(x['frames'] for x in observations)} frame(s) across "
        f"{len(observations)} bounded timeline window(s); advisory pending corpus calibration",
        "signal", policy=_policy(profile),
        expectation={"value": "capture validated measurements without a compliance verdict",
                     "maximum_windows": rules["max_windows"],
                     "window_seconds": rules["window_seconds"]},
        observation={"value": observations}, evidence=artifacts,
        provenance=provenance, authority="deterministic_advisory",
    )
    return [finding], {"schema_version": SCHEMA_VERSION, "state": "measured_advisory",
                       "provenance": provenance, "artifacts": artifacts,
                       "windows": observations}
