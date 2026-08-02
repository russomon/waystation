#!/usr/bin/env bash
# Preservation CLI plumbing proof: explicit missing/present states and provenance.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"

cd "$WEB"
"$PY" - <<'PYEOF'
import os
import stat
import sys
import tempfile

sys.path.insert(0, os.path.join(os.getcwd(), "pipeline"))
from qc import archive_tools

ok = True

def need(condition, message):
    global ok
    if not condition:
        print(f"  FAIL: {message}")
        ok = False

def install(path, output):
    with open(path, "w") as handle:
        handle.write("#!/bin/sh\n")
        handle.write("printf '%s\\n' " + repr(output) + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)

with tempfile.TemporaryDirectory() as tmp:
    old_path = os.environ.get("PATH", "")
    old_qversion = os.environ.get("QCTOOLS_VERSION")
    old_qcommit = os.environ.get("QCTOOLS_COMMIT")
    old_mversion = os.environ.get("MEDIACONCH_PACKAGE_VERSION")
    try:
        os.environ["PATH"] = tmp
        missing_inventory = archive_tools.inventory()
        missing_checks = archive_tools.checks(missing_inventory)
        print("  missing:", ", ".join(f"{c['name']}={c['status']}" for c in missing_checks))
        need(all(not item["available"] and item["state"] == "not_checked"
                 for item in missing_inventory), "missing tools must be structured as not_checked")
        need(all(c["status"] == "info" and c.get("tier") == "FYI"
                 for c in missing_checks), "missing tools must emit FYI, never pass")
        need(all("not checked" in c["detail"].lower() for c in missing_checks),
             "missing-tool detail must say not checked")

        install(os.path.join(tmp, "qcli"), "qcli 1.4+proof (deadbeef)")
        install(os.path.join(tmp, "mediaconch"), "MediaConch Command Line Interface 25.04")
        os.environ["QCTOOLS_VERSION"] = "1.4+proof"
        os.environ["QCTOOLS_COMMIT"] = "deadbeef"
        os.environ["MEDIACONCH_PACKAGE_VERSION"] = "25.04-2"

        present_inventory = archive_tools.inventory()
        present_checks = archive_tools.checks(present_inventory)
        print("  present:", ", ".join(item["version"] for item in present_inventory))
        need(all(item["available"] and item["state"] == "available_not_active"
                 for item in present_inventory), "present tools must remain available_not_active")
        need(present_inventory[0]["source_revision"] == "deadbeef",
             "QCTools source revision must be preserved")
        need(present_inventory[1]["configured_version"] == "25.04-2",
             "MediaConch package version must be preserved")
        need(all(c["status"] == "info" and "not checked" in c["detail"].lower()
                 for c in present_checks), "installed plumbing must not become a clean pass")
    finally:
        os.environ["PATH"] = old_path
        for key, value in (
            ("QCTOOLS_VERSION", old_qversion),
            ("QCTOOLS_COMMIT", old_qcommit),
            ("MEDIACONCH_PACKAGE_VERSION", old_mversion),
        ):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

print("PASS ✓  archive CLI availability + provenance plumbing" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
