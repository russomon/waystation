#!/usr/bin/env bash
# Pure Phase 3 package/metadata reducers. Synthetic fixtures prove behavior,
# not acceptance by a broadcaster, IMF application profile, or Dolby program.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"

PYTHONPATH="$ROOT/pipeline" "$PY" - <<'PYEOF'
import base64
import hashlib
import os
import stat
import tempfile
import zipfile

from qc import deep_package, imf, profiles


profile = profiles.get("waystation_house_xdcam_hd_422_v1")
assert profile["policy_pack"]["version"] == "1.4.0"
assert profile["delivery_template"]["kind"] == "house_profile"
assert "not a broadcaster specification" in profile["delivery_template"]["scope"]
assert deep_package.template_check(profile)[0]["decision"]["authority"] == "deterministic_advisory"

meta = {"format": {"format_name": "mxf", "tags": {
    "material_package_umid": "0x060a...", "operational_pattern_ul": "060e..."}},
    "streams": [{"index": 0, "id": "0x2", "codec_type": "video",
                 "codec_name": "mpeg2video", "color_transfer": "smpte2084",
                 "color_primaries": "bt2020", "color_space": "bt2020nc",
                 "color_range": "tv", "side_data_list": [{
                     "side_data_type": "Mastering display metadata"}]}]}
prior = [{"name": "mediainfo_wrapper", "facts": {
    "color_transfer": "smpte2084", "color_primaries": "bt2020",
    "color_space": "bt2020nc", "color_range": "tv",
    "hdr_format": "SMPTE ST 2086"}}]
mxf = {item["name"]: item for item in deep_package.mxf_checks(meta, prior, profile)}
assert mxf["mxf_deep_fact_inventory"]["status"] == "info"
assert mxf["mxf_deep_unsupported_facts"]["decision"]["outcome"] == "not_checked"
assert "AS-11" in " ".join(mxf["mxf_deep_unsupported_facts"]["observation"]["value"]["not_checked"])
hdr = {item["name"]: item for item in deep_package.metadata_checks(meta, prior, profile)}
assert hdr["hdr_metadata_discovery"]["observation"]["value"]["hdr_marker_observed"] is True
assert hdr["hdr_metadata_cross_validation"]["status"] == "info"
assert hdr["dolby_metadata_discovery"]["decision"]["outcome"] == "not_checked"

contradictory = [{"name": "mediainfo_wrapper", "facts": {
    **prior[0]["facts"], "color_transfer": "arib-std-b67"}}]
bad_hdr = {item["name"]: item for item in deep_package.metadata_checks(
    meta, contradictory, profile)}
assert bad_hdr["hdr_metadata_cross_validation"]["status"] == "warn"
assert bad_hdr["hdr_metadata_cross_validation"]["decision"]["authority"] == "deterministic_advisory"


def package(path, *, wrong_hash=False, unresolved=False):
    essence = b"bounded IMF proof essence"
    digest = hashlib.sha256(essence).digest()
    if wrong_hash:
        digest = b"x" * 32
    essence_id = "urn:uuid:11111111-2222-4333-8444-555555555555"
    ref_id = "urn:uuid:99999999-2222-4333-8444-555555555555" if unresolved else essence_id
    assetmap = f'''<AssetMap xmlns="urn:waystation:proof"><AssetList>
      <Asset><Id>urn:uuid:pkl</Id><ChunkList><Chunk><Path>PKL.xml</Path></Chunk></ChunkList></Asset>
      <Asset><Id>urn:uuid:cpl</Id><ChunkList><Chunk><Path>CPL.xml</Path></Chunk></ChunkList></Asset>
      <Asset><Id>{essence_id}</Id><ChunkList><Chunk><Path>video.mxf</Path></Chunk></ChunkList></Asset>
    </AssetList></AssetMap>'''
    pkl = f'''<PackingList xmlns="urn:waystation:proof"><AssetList><Asset>
      <Id>{essence_id}</Id><Hash Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">{base64.b64encode(digest).decode()}</Hash>
      <OriginalFileName>video.mxf</OriginalFileName>
    </Asset></AssetList></PackingList>'''
    cpl = f'''<CompositionPlaylist xmlns="urn:waystation:proof">
      <ApplicationIdentification>urn:waystation:unqualified-proof-profile</ApplicationIdentification>
      <TrackFileId>{ref_id}</TrackFileId>
    </CompositionPlaylist>'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ASSETMAP.xml", assetmap)
        archive.writestr("PKL.xml", pkl)
        archive.writestr("CPL.xml", cpl)
        archive.writestr("video.mxf", essence)


with tempfile.TemporaryDirectory() as tmp:
    good = os.path.join(tmp, "good.zip")
    package(good)
    checks = {item["name"]: item for item in imf.package_checks(good, profile)}
    assert checks["imf_package_structure"]["status"] == "info", checks
    assert len(checks["imf_package_asset_hashes"]["observation"]["value"]["verified"]) == 1
    assert checks["imf_application_profile"]["decision"]["outcome"] == "not_checked"

    bad = os.path.join(tmp, "bad.zip")
    package(bad, wrong_hash=True, unresolved=True)
    checks = {item["name"]: item for item in imf.package_checks(bad, profile)}
    assert checks["imf_package_structure"]["status"] == "warn"
    assert checks["imf_package_asset_hashes"]["status"] == "warn"
    assert all(item["status"] != "fail" for item in checks.values())

    unsafe = os.path.join(tmp, "unsafe.zip")
    with zipfile.ZipFile(unsafe, "w") as archive:
        archive.writestr("../ASSETMAP.xml", "<AssetMap/>")
    unsafe_check = imf.package_checks(unsafe, profile)[0]
    assert unsafe_check["status"] == "warn"
    assert unsafe_check["observation"]["value"]["unsafe_paths"] == ["../ASSETMAP.xml"]

    partial = os.path.join(tmp, "partial.zip")
    with zipfile.ZipFile(partial, "w") as archive:
        archive.writestr("ASSETMAP.xml", "<AssetMap/>")
    partial_check = imf.package_checks(partial, profile)[0]
    assert partial_check["status"] == "warn"
    assert partial_check["observation"]["value"]["required_manifests_missing"] == [
        "PackingList", "CompositionPlaylist"]

    symlink = os.path.join(tmp, "symlink.zip")
    link_info = zipfile.ZipInfo("linked.xml")
    link_info.create_system = 3
    link_info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(symlink, "w") as archive:
        archive.writestr("ASSETMAP.xml", "<AssetMap/>")
        archive.writestr(link_info, "../../outside")
    symlink_check = imf.package_checks(symlink, profile)[0]
    assert symlink_check["status"] == "warn"
    assert symlink_check["observation"]["value"]["unsafe_paths"] == ["linked.xml"]

print("PASS bounded MXF/IMF/HDR/Dolby evidence + house-template provenance")
PYEOF
