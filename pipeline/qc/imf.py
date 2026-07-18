"""IMF package validation via Netflix's open-source Photon (Rule 4).
Wraps IMPAnalyzer as a subprocess when (a) the asset is an IMF package
(zip carrying ASSETMAP.xml), (b) a JVM exists, and (c) PHOTON_JAR points at
the Photon build. Every unmet precondition surfaces as an explicit finding —
never a silent skip."""
from __future__ import annotations

import os
import shutil
import zipfile

from .report import check
from .util import run


def is_imf_package(src: str) -> bool:
    try:
        return zipfile.is_zipfile(src) and any(
            n.upper().endswith("ASSETMAP.XML") for n in zipfile.ZipFile(src).namelist())
    except OSError:
        return False


def photon_checks(src: str, tmp: str, profile: dict) -> list:
    required = profile.get("photon_required", False)
    if not is_imf_package(src):
        if required:
            return [check("imf_photon", "info",
                          "single-file master (not an IMF package) — SMPTE ST 2067-21 / Photon "
                          "validation not applicable", "structural")]
        return []

    # Resolve a WORKING JVM: macOS ships a /usr/bin/java stub that exists but
    # fails at runtime ("Unable to locate a Java Runtime"), and brew's openjdk
    # is keg-only (not on PATH). Probe candidates with --version.
    java = None
    for cand in filter(None, [shutil.which("java"),
                              "/opt/homebrew/opt/openjdk/bin/java",
                              "/usr/local/opt/openjdk/bin/java"]):
        if os.path.exists(cand) and run([cand, "--version"], timeout=20).returncode == 0:
            java = cand
            break
    jar = os.environ.get("PHOTON_JAR")
    if not java or not jar or not os.path.exists(jar):
        missing = "JVM" if not java else "PHOTON_JAR"
        return [check("imf_photon", "warn" if required else "info",
                      f"IMF package detected but Photon unavailable ({missing} missing) — "
                      "ST 2067-21 App #2E validation skipped; run scripts/fetch-photon.sh",
                      "structural")]
    # PHOTON_JAR may be a single jar or a directory of jars (fetch-photon.sh)
    classpath = os.path.join(jar, "*") if os.path.isdir(jar) else jar

    imp_dir = os.path.join(tmp, "imf_package")
    with zipfile.ZipFile(src) as z:
        z.extractall(imp_dir)
    # If the zip wraps a single directory, descend into it.
    entries = os.listdir(imp_dir)
    root = os.path.join(imp_dir, entries[0]) if len(entries) == 1 else imp_dir

    r = run([java, "-cp", classpath, "com.netflix.imflibrary.app.IMPAnalyzer", root], timeout=900)
    # IMPAnalyzer logs via SLF4J: "[main] ERROR <logger> - <finding>"; strip
    # the logger prefix so the report carries the actual finding text.
    def finding(ln: str) -> str:
        return ln.split(" - ", 1)[-1].strip()
    lines = (r.stdout + r.stderr).splitlines()
    errors = [finding(ln) for ln in lines if "] ERROR " in ln or ln.strip().startswith("ERROR")][:10]
    warnings = [finding(ln) for ln in lines if "] WARN" in ln or "WARNING" in ln][:10]
    if not errors and not warnings and "IMPAnalyzer" not in (r.stdout + r.stderr):
        return [check("imf_photon", "warn" if required else "info",
                      "Photon produced no analysis output — JVM/classpath problem suspected",
                      "structural")]
    if errors:
        return [check("imf_photon", "fail",
                      f"Photon {len(errors)} error(s); first: {errors[0][:180]}", "structural")]
    if warnings:
        return [check("imf_photon", "warn",
                      f"Photon {len(warnings)} warning(s); first: {warnings[0][:180]}", "structural")]
    return [check("imf_photon", "pass", "Photon IMPAnalyzer: package conforms (ST 2067-21)", "structural")]
