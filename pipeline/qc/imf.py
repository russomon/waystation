"""IMF package validation via Netflix's open-source Photon (Rule 4).
Wraps IMPAnalyzer as a subprocess when (a) the asset is an IMF package
(zip carrying ASSETMAP.xml), (b) a JVM exists, and (c) PHOTON_JAR points at
the Photon build. Every unmet precondition surfaces as an explicit finding —
never a silent skip."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import posixpath
import shutil
import stat
import zipfile
import xml.etree.ElementTree as ET

from .report import check, policy_check
from .util import run


PACKAGE_SCHEMA_VERSION = "waystation-imf-package-evidence/1.0"
DEFAULT_MAX_ENTRIES = 4096
DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _text(element: ET.Element | None) -> str | None:
    value = "" if element is None else "".join(element.itertext()).strip()
    return value or None


def _child(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element if _local(item.tag) == name), None)


def _descendants(element: ET.Element, name: str) -> list[ET.Element]:
    return [item for item in element.iter() if _local(item.tag) == name]


def _safe_name(name: str) -> bool:
    normalized = posixpath.normpath(name.replace("\\", "/"))
    return bool(name) and not name.startswith(("/", "\\")) and normalized != ".." \
        and not normalized.startswith("../")


def _unsafe_member(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    return not _safe_name(info.filename) or stat.S_ISLNK(mode)


def _assetmap_name(name: str) -> bool:
    return posixpath.basename(name).upper() in {"ASSETMAP", "ASSETMAP.XML"}


def _limits(profile: dict) -> tuple[int, int, int]:
    rules = ((profile.get("broadcast_policy") or {}).get("deep_package") or {})
    return (
        int(rules.get("max_entries", DEFAULT_MAX_ENTRIES)),
        int(rules.get("max_manifest_bytes", DEFAULT_MAX_MANIFEST_BYTES)),
        int(rules.get("max_hash_bytes", DEFAULT_MAX_HASH_BYTES)),
    )


def _policy(profile: dict) -> dict:
    pack = profile.get("policy_pack") or {}
    return {"id": pack.get("id") or profile.get("name") or "imf_structural_inventory",
            "version": pack.get("version") or "1.0",
            "profile": profile.get("name") or "unknown",
            "effective_sha256": pack.get("effective_sha256")}


def _package_finding(name: str, status: str, detail: str, profile: dict, *,
                     expected: object, observed: object, evidence: list[dict],
                     not_checked: bool = False) -> dict:
    return policy_check(
        name, status, detail, "structural", policy=_policy(profile),
        expectation={"value": expected},
        observation={"state": "not_checked" if not_checked else "observed", "value": observed},
        evidence=evidence,
        provenance={"tool": "waystation", "version": PACKAGE_SCHEMA_VERSION,
                    "method": "bounded ZIP central-directory and namespace-agnostic XML inspection"},
        authority="deterministic_advisory",
    )


def is_imf_package(src: str) -> bool:
    try:
        if not zipfile.is_zipfile(src):
            return False
        with zipfile.ZipFile(src) as archive:
            return any(_assetmap_name(name) for name in archive.namelist())
    except (OSError, zipfile.BadZipFile):
        return False


def _manifest_roots(archive: zipfile.ZipFile, max_manifest_bytes: int) -> tuple[dict[str, ET.Element], list[str]]:
    roots: dict[str, ET.Element] = {}
    errors: list[str] = []
    for info in archive.infolist():
        if info.is_dir() or not info.filename.lower().endswith((".xml", "assetmap")):
            continue
        if info.file_size > max_manifest_bytes:
            errors.append(f"{info.filename}: manifest exceeds {max_manifest_bytes} bytes")
            continue
        try:
            raw = archive.read(info)
            if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
                raise ET.ParseError("DTD/entity declarations are not accepted")
            roots[info.filename] = ET.fromstring(raw)
        except (ET.ParseError, OSError, RuntimeError, zipfile.BadZipFile, EOFError) as exc:
            errors.append(f"{info.filename}: XML parse failed ({str(exc)[:120]})")
    return roots, errors


def _asset_map(roots: dict[str, ET.Element]) -> tuple[dict[str, str], list[str]]:
    assets: dict[str, str] = {}
    manifests = []
    for name, root in roots.items():
        if _local(root.tag) != "AssetMap":
            continue
        manifests.append(name)
        base = posixpath.dirname(name)
        for asset in _descendants(root, "Asset"):
            asset_id = _text(_child(asset, "Id"))
            path = _text(next(iter(_descendants(asset, "Path")), None))
            if asset_id and path:
                assets[asset_id] = posixpath.normpath(posixpath.join(base, path))
    return assets, manifests


def _packing_assets(roots: dict[str, ET.Element]) -> tuple[list[dict], list[str]]:
    assets = []
    manifests = []
    for name, root in roots.items():
        if _local(root.tag) != "PackingList":
            continue
        manifests.append(name)
        for asset in _descendants(root, "Asset"):
            asset_id = _text(_child(asset, "Id"))
            hash_element = _child(asset, "Hash")
            digest = _text(hash_element)
            algorithm = (_text(_child(asset, "HashAlgorithm"))
                         or (hash_element.get("Algorithm") if hash_element is not None else None))
            original = _text(_child(asset, "OriginalFileName"))
            if asset_id:
                assets.append({"id": asset_id, "hash": digest,
                               "hash_algorithm": algorithm, "original_filename": original})
    return assets, manifests


def _cpl_refs(roots: dict[str, ET.Element]) -> tuple[list[str], list[str], list[str]]:
    refs: list[str] = []
    profiles: list[str] = []
    manifests = []
    for name, root in roots.items():
        if _local(root.tag) != "CompositionPlaylist":
            continue
        manifests.append(name)
        refs.extend(filter(None, (_text(item) for item in _descendants(root, "TrackFileId"))))
        profiles.extend(filter(None, (_text(item) for item in _descendants(root, "ApplicationIdentification"))))
    return refs, profiles, manifests


def _hash_name(value: str | None, decoded: bytes) -> str | None:
    normalized = str(value or "").lower().replace("-", "")
    if "sha256" in normalized or (not normalized and len(decoded) == 32):
        return "sha256"
    if "sha1" in normalized or (not normalized and len(decoded) == 20):
        return "sha1"
    return None


def _verify_hashes(archive: zipfile.ZipFile, packing: list[dict], asset_paths: dict[str, str],
                   max_hash_bytes: int) -> dict:
    by_name = {info.filename: info for info in archive.infolist()}
    verified, mismatches, skipped = [], [], []
    for item in packing:
        path = asset_paths.get(item["id"]) or item.get("original_filename")
        digest_text = item.get("hash")
        if not path or not digest_text or path not in by_name:
            skipped.append({"id": item["id"], "path": path, "reason": "path/hash unavailable"})
            continue
        info = by_name[path]
        if info.file_size > max_hash_bytes:
            skipped.append({"id": item["id"], "path": path, "bytes": info.file_size,
                            "reason": f"asset exceeds bounded hash limit {max_hash_bytes}"})
            continue
        try:
            expected = base64.b64decode(digest_text, validate=True)
        except (ValueError, TypeError):
            skipped.append({"id": item["id"], "path": path, "reason": "hash is not valid base64"})
            continue
        algorithm = _hash_name(item.get("hash_algorithm"), expected)
        if not algorithm:
            skipped.append({"id": item["id"], "path": path, "reason": "unsupported hash algorithm"})
            continue
        hasher = hashlib.new(algorithm)
        with archive.open(info) as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                hasher.update(chunk)
        result = {"id": item["id"], "path": path, "algorithm": algorithm,
                  "bytes": info.file_size}
        if hasher.digest() == expected:
            verified.append(result)
        else:
            mismatches.append(result)
    return {"verified": verified, "mismatches": mismatches, "skipped": skipped,
            "max_hash_bytes": max_hash_bytes}


def package_checks(src: str, profile: dict) -> list[dict]:
    """Inspect a ZIP-carried IMF package without extracting essence files."""
    if not is_imf_package(src):
        return []
    max_entries, max_manifest_bytes, max_hash_bytes = _limits(profile)
    try:
        with zipfile.ZipFile(src) as archive:
            infos = archive.infolist()
            unsafe = [item.filename for item in infos if _unsafe_member(item)]
            if len(infos) > max_entries or unsafe:
                observed = {"entries": len(infos), "max_entries": max_entries,
                            "unsafe_paths": unsafe[:20]}
                return [_package_finding(
                    "imf_package_structure", "warn",
                    "IMF package central directory exceeds safety bounds or contains unsafe paths",
                    profile, expected="bounded entries and traversal-safe member paths",
                    observed=observed,
                    evidence=[{"id": "zip:central-directory", "kind": "package_inventory"}],
                )]
            roots, errors = _manifest_roots(archive, max_manifest_bytes)
            asset_paths, assetmaps = _asset_map(roots)
            packing, packing_lists = _packing_assets(roots)
            cpl_refs, application_ids, cpls = _cpl_refs(roots)
            required_missing = [label for label, values in (
                ("AssetMap", assetmaps), ("PackingList", packing_lists),
                ("CompositionPlaylist", cpls)) if not values]
            errors.extend(f"required IMF manifest missing: {label}" for label in required_missing)
            names = {item.filename for item in infos}
            missing_paths = sorted({path for path in asset_paths.values() if path not in names})
            known_ids = set(asset_paths) | {item["id"] for item in packing}
            unresolved_refs = sorted(set(cpl_refs) - known_ids)
            inventory = {
                "entries": len(infos), "assetmaps": assetmaps,
                "packing_lists": packing_lists, "composition_playlists": cpls,
                "asset_count": len(asset_paths), "packing_asset_count": len(packing),
                "cpl_track_file_references": len(cpl_refs),
                "missing_paths": missing_paths[:100],
                "unresolved_track_file_ids": unresolved_refs[:100],
                "xml_errors": errors[:50], "application_identifiers": application_ids[:20],
                "required_manifests_missing": required_missing,
                "bounds": {"max_entries": max_entries,
                           "max_manifest_bytes": max_manifest_bytes},
            }
            manifest_digest = hashlib.sha256(json.dumps(
                {name: ET.tostring(root, encoding="unicode") for name, root in roots.items()},
                sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            problems = len(errors) + len(missing_paths) + len(unresolved_refs)
            structural = _package_finding(
                "imf_package_structure", "warn" if problems else "info",
                f"IMF manifest inventory has {problems} structural/reference problem(s)"
                if problems else "IMF manifests and bounded references are structurally consistent; "
                "application-profile conformance is not inferred",
                profile,
                expected="parseable AssetMap/PKL/CPL manifests with resolvable local references",
                observed=inventory,
                evidence=[{"id": "imf:manifest-set", "kind": "xml_manifest_inventory",
                           "sha256": manifest_digest,
                           "hash_scope": "normalized_parsed_xml_set"}],
            )
            hashes = _verify_hashes(archive, packing, asset_paths, max_hash_bytes)
            hash_checked = bool(hashes["verified"] or hashes["mismatches"])
            hash_finding = _package_finding(
                "imf_package_asset_hashes", "warn" if hashes["mismatches"] else "info",
                f"{len(hashes['mismatches'])} bounded PKL asset hash mismatch(es)"
                if hashes["mismatches"] else
                f"verified {len(hashes['verified'])} bounded PKL asset hash(es); "
                f"{len(hashes['skipped'])} not checked",
                profile, expected="PKL hashes match package members within configured byte bound",
                observed=hashes,
                evidence=[{"id": "imf:pkl-hashes", "kind": "bounded_hash_verification"}],
                not_checked=not hash_checked,
            )
            app_finding = _package_finding(
                "imf_application_profile", "info",
                "application identifier(s) disclosed; complete application-profile conformance "
                "requires Photon or another qualified profile validator"
                if application_ids else "application profile not established by structural inspection",
                profile, expected="qualified application-profile rules and analyzer result",
                observed={"application_identifiers": application_ids[:20],
                          "structural_validity_is_not_profile_conformance": True},
                evidence=[{"id": "imf:cpl-application-identification",
                           "kind": "xml_manifest_fields"}],
                not_checked=True,
            )
            return [structural, hash_finding, app_finding]
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        return [_package_finding(
            "imf_package_structure", "warn", f"IMF package could not be inspected: {str(exc)[:160]}",
            profile, expected="readable bounded ZIP package", observed={"error": str(exc)[:300]},
            evidence=[{"id": "zip:central-directory", "kind": "package_inventory"}],
            not_checked=True,
        )]


def _safe_extract(archive: zipfile.ZipFile, destination: str, max_entries: int) -> None:
    infos = archive.infolist()
    unsafe = [item.filename for item in infos if _unsafe_member(item)]
    if len(infos) > max_entries or unsafe:
        raise ValueError("IMF package exceeds entry bound or contains an unsafe member path")
    archive.extractall(destination)


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
        try:
            _safe_extract(z, imp_dir, _limits(profile)[0])
        except ValueError as exc:
            return [check("imf_photon", "fail" if required else "warn",
                          f"IMF package rejected before Photon: {exc}", "structural")]
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
