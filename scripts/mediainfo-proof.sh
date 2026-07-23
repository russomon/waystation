#!/usr/bin/env bash
# MediaInfo proof: optional dependency behavior + MXF OP1a / AS-11 findings.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"

"$PY" - <<'PYEOF'
import json
import os
import shlex
import stat
import sys
import tempfile

sys.path.insert(0, os.path.join(os.getcwd(), "pipeline"))
from qc import mediainfo, profiles, report

ok = True

def need(cond, msg):
    global ok
    if not cond:
        print(f"  FAIL: {msg}")
        ok = False

with tempfile.TemporaryDirectory() as tmp:
    src = os.path.join(tmp, "master.mxf")
    open(src, "wb").write(b"not-real-media")

    old_path = os.environ.get("PATH", "")
    os.environ["PATH"] = tmp
    missing = mediainfo.checks(src, profiles.get("netflix"))[0]
    print(f"  missing tool: {missing['status']} — {missing['detail']}")
    need(missing["name"] == "mediainfo_wrapper" and missing["status"] == "info",
         "missing mediainfo must be an explicit FYI")

    fake = os.path.join(tmp, "mediainfo")
    def install(payload):
        with open(fake, "w") as f:
            f.write("#!/bin/sh\n")
            f.write("printf '%s\\n' ")
            f.write(shlex.quote(json.dumps(payload)))
            f.write("\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)

    op1a_payload = {"media": {"track": [
        {"@type": "General", "Format": "MXF", "Format_Profile": "OP-1a", "extra_AS11_Core": "present"},
        {"@type": "Video", "HDR_Format": "Dolby Vision", "HDR_Format_Profile": "dvhe.08.06"},
    ]}}
    install(op1a_payload)
    passed = mediainfo.checks(src, profiles.get("netflix"))
    by_name = {c["name"]: c for c in passed}
    print(f"  op1a: {by_name['mxf_op1a']['status']} — {by_name['mxf_op1a']['detail']}")
    need(by_name["mediainfo_wrapper"]["status"] == "pass", "MediaInfo wrapper should pass on JSON payload")
    need(by_name["mxf_op1a"]["status"] == "pass", "OP1a MXF should pass")
    need(by_name["as11_dpp_metadata"]["status"] == "pass", "AS-11 metadata should be detected")
    need(by_name["mediainfo_hdr"]["status"] == "info", "HDR metadata should be surfaced")

    bad_payload = {"media": {"track": [
        {"@type": "General", "Format": "MXF", "Format_Profile": "OP-Atom"},
        {"@type": "Audio", "Format": "Dolby E"},
    ]}}
    install(bad_payload)
    failed = mediainfo.checks(src, profiles.get("netflix"))
    by_name = {c["name"]: c for c in failed}
    tiered = report.finalize({"checks": failed}, profiles.get("netflix"))
    print(f"  non-op1a: {by_name['mxf_op1a']['status']} — {by_name['mxf_op1a']['detail']}")
    need(by_name["mxf_op1a"]["status"] == "fail", "non-OP1a MXF should fail under netflix")
    need(tiered["tiers"]["BLOCKER"] == 1, "non-OP1a MXF should become one BLOCKER")
    need(by_name["dolby_audio_metadata"]["status"] == "info", "Dolby audio caveat should be surfaced")

    os.environ["PATH"] = old_path

print("PASS ✓  MediaInfo optional wrapper + MXF OP1a / AS-11 findings" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
