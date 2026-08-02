"""Availability and provenance for optional preservation-oriented CLI tools.

QCTools and MediaConch are installed as headless plumbing in the Docker worker.
No Waystation reducer or MediaConch policy is active yet, so this module only
records what is available and emits an explicit FYI that the media was not
checked by either tool. Installation must never be presented as clearance.
"""
from __future__ import annotations

import os
import shutil
import subprocess

from .report import check
from .util import run


_TOOLS = (
    {
        "tool": "qcli",
        "name": "QCTools qcli",
        "check": "qctools_analytics",
        "version_args": ["-v"],
        "version_env": "QCTOOLS_VERSION",
        "revision_env": "QCTOOLS_COMMIT",
        "scope": "headless frame-level analytics report generation",
    },
    {
        "tool": "mediaconch",
        "name": "MediaConch",
        "check": "mediaconch_policy",
        "version_args": ["--Version"],
        "version_env": "MEDIACONCH_PACKAGE_VERSION",
        "revision_env": None,
        "scope": "policy conformance for supported preservation formats",
    },
)


def _first_line(output: str) -> str:
    return next((line.strip() for line in output.splitlines() if line.strip()), "unknown")[:240]


def inventory() -> list[dict]:
    """Return structured tool availability without analyzing the media."""
    items = []
    for spec in _TOOLS:
        executable = shutil.which(spec["tool"])
        item = {
            "tool": spec["tool"],
            "name": spec["name"],
            "available": False,
            "state": "not_checked",
            "version": None,
            "executable": executable,
            "scope": spec["scope"],
            "configured_version": os.environ.get(spec["version_env"]) or None,
            "source_revision": (
                os.environ.get(spec["revision_env"]) or None
                if spec["revision_env"] else None
            ),
        }
        if not executable:
            item["reason"] = "executable not found"
            items.append(item)
            continue
        try:
            result = run([executable, *spec["version_args"]], timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            item["reason"] = f"version probe failed: {str(exc)[:160]}"
            items.append(item)
            continue
        output = "\n".join(filter(None, [result.stdout, result.stderr]))
        if result.returncode != 0:
            item["reason"] = f"version probe exited {result.returncode}: {_first_line(output)}"
            items.append(item)
            continue
        item.update({
            "available": True,
            "state": "available_not_active",
            "version": _first_line(output),
        })
        items.append(item)
    return items


def checks(tools: list[dict] | None = None) -> list[dict]:
    """Emit FYIs only; no policy or reducer is active in this installation step."""
    tools = tools if tools is not None else inventory()
    by_name = {item["tool"]: item for item in tools}
    out = []
    for spec in _TOOLS:
        item = by_name[spec["tool"]]
        if item["available"]:
            detail = (
                f"{item['version']} available; {spec['scope']} is installed but no "
                "Waystation reducer/policy is active - media not checked by this tool"
            )
        else:
            detail = (
                f"{spec['name']} unavailable ({item.get('reason', 'unknown reason')}) - "
                f"{spec['scope']} not checked"
            )
        out.append(check(spec["check"], "info", detail, "structural"))
    return out
