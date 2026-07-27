#!/usr/bin/env bash
# Build the Waystation client and export a reviewed, pinned static release.
#
#   scripts/export-client.sh [--target DIR] [--api-base URL] [--public-base PATH]
#
# Waystation owns and builds the client; OrbitWebsite consumes a generated
# artifact. Only build output crosses the repository boundary — no source. The
# release carries a manifest (source commit, build time, expected public base,
# expected API base, SHA-256 of every file) so the deployed bundle can always be
# traced back to the exact commit that produced it, and rolled back to a known
# one.
#
# Cloudflare Pages builds OrbitWebsite/orbitolive, and Astro copies public/
# through verbatim, so exporting into public/waystation/ is what actually
# publishes the app — setting Vite's base alone publishes nothing.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="/Users/Shared/Orbit/Code/OrbitWebsite/orbitolive/public/waystation"
API_BASE="https://api.orbitolive.com/api"
PUBLIC_BASE="/waystation/"
# All-cloud hosted deployment: pin compute and hide the selector.
FORCE_COMPUTE="cloud"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=$2; shift 2;;
    --api-base) API_BASE=$2; shift 2;;
    --public-base) PUBLIC_BASE=$2; shift 2;;
    --force-compute) FORCE_COMPUTE=$2; shift 2;;
    *) echo "unknown argument: $1"; exit 2;;
  esac
done

cd "$WEB"
COMMIT=$(git rev-parse HEAD)
DIRTY=$(git status --porcelain | head -c 1)
[ -z "$DIRTY" ] || echo "⚠ worktree is dirty — the release manifest will record commit $COMMIT, which does NOT match what is being built"

echo "▶ building wasm"
npm run build:wasm >/tmp/export-wasm.log 2>&1 || { echo "✗ wasm build failed"; tail -20 /tmp/export-wasm.log; exit 1; }
echo "▶ building client (base=$PUBLIC_BASE)"
WAYSTATION_PUBLIC_BASE="$PUBLIC_BASE" npm -w client run build >/tmp/export-client.log 2>&1 \
  || { echo "✗ client build failed"; tail -20 /tmp/export-client.log; exit 1; }

DIST="$WEB/client/dist"
[ -f "$DIST/index.html" ] || { echo "✗ no index.html in $DIST"; exit 1; }

# Point the built page at the production gateway. This is the ONE line that
# decides which API the deployed app talks to.
"$WEB/pipeline/.venv/bin/python" - "$DIST/index.html" "$API_BASE" "$FORCE_COMPUTE" <<'PY'
import re, sys
path, api, compute = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding="utf-8").read()
for name, value in (("waystation-api", api), ("waystation-compute", compute)):
    s, n = re.subn(rf'<meta name="{name}"[^>]*/>',
                   f'<meta name="{name}" content="{value}" />', s)
    if n != 1:
        print(f"\u2717 expected exactly one {name} meta tag, found {n}"); sys.exit(1)
open(path, "w", encoding="utf-8").write(s)
PY

echo "▶ verifying the build"
fail=0
# Root-absolute asset references would 404 under /waystation/ — the single most
# likely way to ship a broken release.
if grep -qE '(src|href)="/assets/' "$DIST/index.html"; then
  echo "  ✗ index.html references root /assets/ — wrong base"; fail=1; fi
grep -q "$PUBLIC_BASE" "$DIST/index.html" || { echo "  ✗ index.html does not reference $PUBLIC_BASE"; fail=1; }
grep -q "$API_BASE" "$DIST/index.html" || { echo "  ✗ production API base not embedded"; fail=1; }
grep -q "name=\"waystation-compute\" content=\"$FORCE_COMPUTE\"" "$DIST/index.html" \
  || { echo "  ✗ compute target not pinned to $FORCE_COMPUTE"; fail=1; }
WASM=$(find "$DIST" -name '*.wasm' | head -1)
[ -n "$WASM" ] || { echo "  ✗ no .wasm in the build"; fail=1; }
# The wasm URL is baked into the bundle; it must also carry the public base.
if [ -n "$WASM" ] && ! grep -rq "${PUBLIC_BASE}assets/$(basename "$WASM")" "$DIST/assets/"*.js; then
  echo "  ✗ wasm URL in the bundle does not resolve under $PUBLIC_BASE"; fail=1; fi
[ "$fail" = 0 ] || { echo "✗ refusing to export a broken build"; exit 1; }

echo "▶ writing release manifest"
"$WEB/pipeline/.venv/bin/python" - "$DIST" "$COMMIT" "$API_BASE" "$PUBLIC_BASE" "${DIRTY:+dirty}" <<'PY'
import hashlib, json, os, subprocess, sys
dist, commit, api, base, dirty = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], bool(sys.argv[5])
files = {}
for root, _dirs, names in os.walk(dist):
    for n in sorted(names):
        p = os.path.join(root, n)
        rel = os.path.relpath(p, dist)
        if rel == "release-manifest.json":
            continue
        files[rel] = hashlib.sha256(open(p, "rb").read()).hexdigest()
manifest = {
    "product": "waystation-client",
    "manifest_version": "waystation-release/1.0",
    "source_commit": commit,
    "source_worktree_dirty": dirty,
    "built_at": subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
                               capture_output=True, text=True).stdout.strip(),
    "expected_public_base": base,
    "expected_api_base": api,
    "files": files,
}
with open(os.path.join(dist, "release-manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2, sort_keys=True)
print(f"  {len(files)} files, commit {commit[:8]}{' (DIRTY)' if dirty else ''}")
PY

echo "▶ exporting to $TARGET"
mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$DIST/." "$TARGET/"
echo "✓ exported $(find "$TARGET" -type f | wc -l | tr -d ' ') files"
echo
echo "  Review the diff in OrbitWebsite, then commit the pinned release there."
echo "  Verify with: OrbitWebsite/scripts/verify-waystation-release.sh"
