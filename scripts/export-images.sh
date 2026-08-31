#!/usr/bin/env bash
# Export the built Docker images to Backblaze B2 as portable restore artifacts.
#
#   bash scripts/export-images.sh              # export + upload
#   bash scripts/export-images.sh --local-only # write tarballs, skip upload
#
# WHY THIS EXISTS, given a Vultr snapshot already contains these images:
#
#   1. The Dockerfile is a RECIPE WITH A SHELF LIFE. It pins
#      `mediaconch=25.04-2`, but Debian rotates old package versions out of the
#      main archive. Months from now `apt-get install mediaconch=25.04-2` can
#      simply fail, and the "reproducible" build stops reproducing.
#   2. A snapshot is provider-locked. A tarball restores anywhere.
#   3. A snapshot contains .env — every B2/GMI/session secret. These tarballs do
#      not, so they are the safer artifact to retain or move.
#
# Restore:  docker load < waystation-worker-<id>-<date>.tar.gz
#
# This script never deletes anything and never touches a running container.
set -uo pipefail

SCRATCH="${TMPDIR:-/tmp}"
PREFIX="${IMAGE_ARCHIVE_PREFIX:-artifacts/images}"
LOCAL_ONLY=0
[ "${1:-}" = "--local-only" ] && LOCAL_ONLY=1

ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

# The B2 event rule fires on ObjectCreated under `transfers/`. Uploading a
# 372 MB tarball there would trigger the pipeline on a build artifact.
case "$PREFIX" in
  transfers/*|transfers) bad "refusing: '$PREFIX' collides with the B2 event-rule prefix" ;;
esac

echo "▶ Waystation image export"
echo "  destination prefix: $PREFIX/"
echo ""

command -v docker >/dev/null || bad "docker not found"
docker info >/dev/null 2>&1 || bad "docker daemon not reachable"

# Upload without assuming an aws CLI. The VPS has none, but it does have Docker
# and the worker image ships boto3 — the same path already used to query B2 from
# this host. Falls back to the CLI when present.
upload() {
  local file="$1" key="$2"
  set -a; . ./.env; set +a
  if command -v aws >/dev/null 2>&1; then
    aws --endpoint-url "$B2_S3_ENDPOINT" s3 cp "$file" "s3://$B2_BUCKET/$key" >/dev/null 2>&1
    return $?
  fi
  local img
  img=$(docker images -q waystation-worker:latest | head -1)
  [ -n "$img" ] || return 1
  docker run --rm \
    -e B2_S3_ENDPOINT -e B2_KEY_ID -e B2_APP_KEY -e B2_REGION -e B2_BUCKET \
    -e KEY="$key" -v "$file:/upload.bin:ro" "$img" python3 -c '
import os, boto3
s3 = boto3.client("s3", endpoint_url=os.environ["B2_S3_ENDPOINT"],
                  aws_access_key_id=os.environ["B2_KEY_ID"],
                  aws_secret_access_key=os.environ["B2_APP_KEY"],
                  region_name=os.environ["B2_REGION"])
s3.upload_file("/upload.bin", os.environ["B2_BUCKET"], os.environ["KEY"])
' >/dev/null 2>&1
}

MANIFEST="$SCRATCH/waystation-images-$(date -u +%Y%m%dT%H%M%SZ).json"
echo '{"exported_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","images":[' > "$MANIFEST"
FIRST=1

for IMG in waystation-worker:latest waystation-gateway:latest; do
  NAME="${IMG%%:*}"
  if ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "  ! $IMG not present locally — skipping"
    continue
  fi
  ID=$(docker images --no-trunc --format '{{.ID}}' "$IMG" | head -1 | sed 's/^sha256://' | cut -c1-12)
  CREATED=$(docker image inspect "$IMG" --format '{{.Created}}' | cut -c1-10)
  OUT="$SCRATCH/${NAME}-${ID}-${CREATED}.tar.gz"

  echo "▶ $IMG  (id ${ID}, built ${CREATED})"
  docker save "$IMG" 2>/dev/null | gzip -6 > "$OUT" || bad "docker save failed for $IMG"
  BYTES=$(wc -c < "$OUT" | tr -d ' ')
  # Digest the artifact so a restore can prove it loaded what it intended to.
  SHA=$(shasum -a 256 "$OUT" 2>/dev/null | cut -d' ' -f1 || sha256sum "$OUT" | cut -d' ' -f1)
  ok "$(basename "$OUT") — $(awk "BEGIN{printf \"%.0f\", $BYTES/1048576}") MB, sha256 ${SHA:0:16}…"

  [ "$FIRST" = 1 ] || echo ',' >> "$MANIFEST"
  FIRST=0
  printf '{"image":"%s","image_id":"%s","built":"%s","file":"%s","bytes":%s,"sha256":"%s"}' \
    "$IMG" "$ID" "$CREATED" "$(basename "$OUT")" "$BYTES" "$SHA" >> "$MANIFEST"

  if [ "$LOCAL_ONLY" = 0 ]; then
    if upload "$OUT" "$PREFIX/$(basename "$OUT")"; then
      ok "uploaded to s3://$B2_BUCKET/$PREFIX/$(basename "$OUT")"
    else
      echo "  ! upload failed — tarball retained at $OUT"
    fi
  fi
done

echo ']}' >> "$MANIFEST"
echo ""
ok "manifest: $MANIFEST"
if [ "$LOCAL_ONLY" = 0 ]; then
  upload "$MANIFEST" "$PREFIX/$(basename "$MANIFEST")" \
    && ok "manifest uploaded" || echo "  ! manifest upload failed"
fi

echo ""
echo "Restore on a fresh host:"
echo "  (fetch from s3://\$B2_BUCKET/$PREFIX/ with any S3 client)"
echo "  shasum -a 256 <file>            # compare against the manifest"
echo "  docker load < <file>"
echo "  docker compose -f docker-compose.prod.yml up -d"
