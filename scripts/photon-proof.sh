#!/usr/bin/env bash
# Rule 4 proof: Netflix's Photon (IMPAnalyzer) wrapped as a subprocess.
#   - an IMF package (zip carrying ASSETMAP.xml) is detected as such
#   - Photon EXECUTES against it and its findings parse into the report
#   - a non-conformant package fails with Photon's real ST 2067-21 schema
#     error, and under the netflix profile that finding is a BLOCKER
# Setup once: brew install openjdk maven && bash scripts/fetch-photon.sh
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$WEB/pipeline/.venv/bin/python"
export PHOTON_JAR="${PHOTON_JAR:-$WEB/vendor/photon}"

if [ ! -d "$PHOTON_JAR" ] && [ ! -f "$PHOTON_JAR" ]; then
  echo "SKIP — Photon not fetched. Run: brew install openjdk maven && bash scripts/fetch-photon.sh"
  exit 0
fi

"$PY" - <<'PYEOF'
import os, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(os.environ.get("PHOTON_JAR", "")), "..", "pipeline"))
from qc import imf, profiles, report

ASSETMAP = '''<?xml version="1.0" encoding="UTF-8"?>
<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <Id>urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</Id>
  <Creator>Waystation</Creator>
  <VolumeCount>1</VolumeCount>
  <IssueDate>2026-07-18T00:00:00-00:00</IssueDate>
  <Issuer>Waystation</Issuer>
  <AssetList>
    <Asset>
      <Id>urn:uuid:11111111-2222-4333-8444-555555555555</Id>
      <PackingList>true</PackingList>
      <ChunkList><Chunk><Path>PKL_test.xml</Path></Chunk></ChunkList>
    </Asset>
  </AssetList>
</AssetMap>
'''
PKL_BROKEN = ('<?xml version="1.0"?>'
              '<PackingList xmlns="http://www.smpte-ra.org/schemas/2067-2/2016/PKL"></PackingList>')

ok = True
def need(cond, msg):
    global ok
    if not cond:
        print(f"  FAIL: {msg}"); ok = False

with tempfile.TemporaryDirectory() as tmp:
    imp = os.path.join(tmp, "imp"); os.makedirs(imp)
    open(os.path.join(imp, "ASSETMAP.xml"), "w").write(ASSETMAP)
    open(os.path.join(imp, "PKL_test.xml"), "w").write(PKL_BROKEN)
    z = os.path.join(tmp, "imp.zip")
    with zipfile.ZipFile(z, "w") as zf:
        for f in os.listdir(imp):
            zf.write(os.path.join(imp, f), f)

    need(imf.is_imf_package(z), "IMF package not detected")
    need(not imf.is_imf_package(__file__), "non-zip misdetected as IMF")

    checks = imf.photon_checks(z, tmp, profiles.get("netflix"))
    c = checks[0]
    print(f"  imf_photon: {c['status']} — {c['detail'][:150]}")
    need(c["status"] == "fail", "non-conformant package must fail")
    need("cvc-" in c["detail"], "Photon's real schema-validation error not surfaced")

    tiered = report.finalize({"checks": checks}, profiles.get("netflix"))
    need(tiered["tiers"]["BLOCKER"] == 1, "Photon failure must be a BLOCKER under netflix")
    print(f"  tiers under netflix: {tiered['tiers']}")

print("PASS ✓  Photon executes, findings parse, non-conformant IMF = BLOCKER" if ok else "FAIL")
sys.exit(0 if ok else 1)
PYEOF
