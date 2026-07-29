#!/usr/bin/env bash
# Preflight for the Waystation scratch data disk.
#
#   bash scripts/preflight-scratch.sh            # validate only (read-only)
#   bash scripts/preflight-scratch.sh --create    # validate, then create the layout
#
# Why this exists: the worker does heavy ffmpeg/QC work in temporary directories.
# On the hosted deployment those must land on the dedicated data disk, never on
# the root filesystem and never in the container's writable layer.
#
# The compose file binds the scratch path with `create_host_path: false`, so a
# missing directory makes the container refuse to start rather than silently
# filling the root disk. This script is the friendly version of that check: it
# explains what is wrong instead of leaving you reading a mount error.
#
# Configuration (all optional):
#   WAYSTATION_SCRATCH         scratch root. Default /mnt/waystation-scratch/waystation.
#                              THIS is the source of truth — the filesystem to
#                              validate is DERIVED from it, so an override moves
#                              the checks with it and cannot drift from what
#                              Docker actually binds.
#   WAYSTATION_SCRATCH_MOUNT   optional PIN. When set, the mount point backing
#                              WAYSTATION_SCRATCH must be exactly this, else fail.
#   WAYSTATION_SCRATCH_DEVICE  optional PIN on the backing device (e.g. /dev/vdb1).
#   WAYSTATION_SCRATCH_MIN_FREE_GB  default 20.
#
# It NEVER formats, partitions, or mounts anything. Preparing the disk is a
# host administration task; this only inspects it and creates directories.
set -uo pipefail

SCRATCH="${WAYSTATION_SCRATCH:-/mnt/waystation-scratch/waystation}"
PIN_MOUNT="${WAYSTATION_SCRATCH_MOUNT:-}"
EXPECT_DEV="${WAYSTATION_SCRATCH_DEVICE:-}"
MIN_FREE_GB="${WAYSTATION_SCRATCH_MIN_FREE_GB:-20}"
SUBDIRS=(uploads jobs runs tmp cache artifacts exports logs)
MODE=0775

CREATE=0
[ "${1:-}" = "--create" ] && CREATE=1

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }
note() { printf '    %s\n' "$*"; }

# The scratch root may not exist yet (that is what --create is for), so resolve
# checks against its nearest EXISTING ancestor. findmnt --target needs a real
# path; walking up keeps the derivation honest instead of guessing.
nearest_existing() {
  local p="$1"
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -e "$p" ]; do p="$(dirname "$p")"; done
  printf '%s' "${p:-/}"
}

if ! command -v findmnt >/dev/null 2>&1; then
  echo "▶ Waystation scratch preflight"
  echo ""
  echo "  \033[33m!\033[0m findmnt not found — this preflight targets the Linux deployment host."
  echo "    macOS/dev machines do not need a scratch disk: docker-compose.yml is"
  echo "    unchanged and only docker-compose.prod.yml binds the data disk."
  echo "    Run this on the VPS."
  exit 0
fi

ANCHOR="$(nearest_existing "$SCRATCH")"
MOUNT="$(findmnt -no TARGET --target "$ANCHOR" 2>/dev/null || echo "")"
DEV="$(findmnt -no SOURCE --target "$ANCHOR" 2>/dev/null || echo "")"
FSTYPE="$(findmnt -no FSTYPE --target "$ANCHOR" 2>/dev/null || echo "")"
ROOT_DEV="$(findmnt -no SOURCE --target / 2>/dev/null || echo "")"

echo "▶ Waystation scratch preflight"
echo "  scratch root : $SCRATCH"
echo "  resolved via : $ANCHOR"
echo "  backing mount: ${MOUNT:-<unresolved>}"
echo ""

# 1 ── the filesystem backing the scratch root must not be the root filesystem.
#      This is the check that actually matters; everything else is detail.
if [ -z "$DEV" ]; then
  bad "could not determine the filesystem backing $SCRATCH"
elif [ "$DEV" = "$ROOT_DEV" ]; then
  bad "$SCRATCH is backed by the ROOT filesystem ($ROOT_DEV) — heavy writes would fill /"
  note "Mount the data disk, or point WAYSTATION_SCRATCH at a path on it."
else
  ok "backed by $DEV ($FSTYPE) at $MOUNT — not the root filesystem"
fi

# 2 ── the backing mount must be a genuine mount point.
if [ -n "$MOUNT" ] && mountpoint -q "$MOUNT" 2>/dev/null; then
  ok "$MOUNT is a mount point"
else
  bad "${MOUNT:-the resolved path} is NOT a mount point"
fi

# 3 ── optional pins. These exist to catch drift, so a mismatch is a hard fail.
if [ -n "$PIN_MOUNT" ]; then
  if [ "$MOUNT" = "$PIN_MOUNT" ]; then
    ok "pinned mount point matches ($PIN_MOUNT)"
  else
    bad "WAYSTATION_SCRATCH_MOUNT is pinned to '$PIN_MOUNT' but $SCRATCH is backed by '${MOUNT:-<unresolved>}'"
    note "The pin and the scratch path disagree — Docker would bind the scratch"
    note "path while this check validated a different filesystem. Fix one of them."
  fi
fi
if [ -n "$EXPECT_DEV" ]; then
  if [ "$DEV" = "$EXPECT_DEV" ]; then ok "pinned device matches ($EXPECT_DEV)"
  else bad "WAYSTATION_SCRATCH_DEVICE is pinned to '$EXPECT_DEV' but found '${DEV:-<unresolved>}'"; fi
fi

# 4 ── free space.
if [ -n "$DEV" ]; then
  AVAIL_GB=$(df -BG --output=avail "$ANCHOR" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "${AVAIL_GB:-}" ]; then
    if [ "$AVAIL_GB" -ge "$MIN_FREE_GB" ]; then ok "${AVAIL_GB}G free (minimum ${MIN_FREE_GB}G)"
    else bad "only ${AVAIL_GB}G free — below the ${MIN_FREE_GB}G minimum"; fi
  fi
fi

# 5 ── create the layout, trying the least-privileged strategy first and
#      FALLING THROUGH on failure. Each strategy returns non-zero if it did not
#      fully succeed, so `a || b || c` reaches sudo even when Docker is present
#      but unusable (no local image, daemon refusing, etc).
apply_mode() { chmod "$MODE" "$SCRATCH" 2>/dev/null && \
               for d in "${SUBDIRS[@]}"; do chmod "$MODE" "$SCRATCH/$d" 2>/dev/null || return 1; done; }

try_plain() {
  mkdir -p "$SCRATCH" 2>/dev/null || return 1
  for d in "${SUBDIRS[@]}"; do mkdir -p "$SCRATCH/$d" 2>/dev/null || return 1; done
  # mkdir honours umask (commonly 022 → 0755), so the promised mode has to be
  # applied explicitly. Without this the script's own docs would be wrong.
  apply_mode || return 1
  ok "created as $(id -un), mode $MODE"
}

try_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  # Use an image that is ALREADY local. Never pull: creating directories must
  # not depend on the network, and a fresh VPS may have no images at all — in
  # which case this returns non-zero and the sudo path takes over.
  local img; img="$(docker images -q 2>/dev/null | head -1)"
  [ -n "$img" ] || { note "(docker has no local image — falling through)"; return 1; }
  note "(no write permission — creating via a local root container)"
  docker run --rm -v "$MOUNT:$MOUNT" "$img" sh -c "
    set -e
    for d in ${SUBDIRS[*]}; do mkdir -p '$SCRATCH'/\$d; done
    chown -R $(id -u):$(id -g) '$SCRATCH'
    chmod -R $MODE '$SCRATCH'
  " >/dev/null 2>&1 || { note "(docker creation failed — falling through to sudo)"; return 1; }
  ok "created via docker, owned by $(id -un), mode $MODE"
}

try_sudo() {
  command -v sudo >/dev/null 2>&1 || return 1
  note "(escalating to sudo — this may prompt)"
  sudo mkdir -p "$SCRATCH" || return 1
  for d in "${SUBDIRS[@]}"; do sudo mkdir -p "$SCRATCH/$d" || return 1; done
  sudo chown -R "$(id -u):$(id -g)" "$SCRATCH" || return 1
  sudo chmod -R "$MODE" "$SCRATCH" || return 1
  ok "created via sudo, owned by $(id -un), mode $MODE"
}

echo ""
# GATE: never create anything once validation has already failed. Without this,
# `--create` would cheerfully mkdir -p a tree on the ROOT filesystem (or on a
# path whose mount/device pin disagreed) and then report the failure — having
# already built the thing the check exists to prevent. Refuse first, and leave
# the filesystem exactly as it was found.
if [ "$CREATE" = 1 ] && [ "$fail" != 0 ]; then
  echo "REFUSING TO CREATE — validation failed above."
  note "Nothing was created. $SCRATCH was NOT touched."
  note "Fix the mount, the scratch path, or the pins, then re-run with --create."
  echo ""
  echo "FAIL ✗  refusing to create scratch directories on an unvalidated location"
  exit 1
fi

if [ "$CREATE" = 1 ]; then
  echo "▶ creating layout under $SCRATCH"
  # A partially-created tree is not unsafe — these are empty directories, and a
  # later strategy simply completes them (mkdir -p and chmod are idempotent).
  try_plain || try_docker || try_sudo || bad "could not create the layout by any available method"
fi

# 6 ── the layout itself, and that it carries the mode the docs promise.
for d in "${SUBDIRS[@]}"; do
  if [ -d "$SCRATCH/$d" ]; then
    actual=$(stat -c '%a' "$SCRATCH/$d" 2>/dev/null || stat -f '%Lp' "$SCRATCH/$d" 2>/dev/null || echo "?")
    if [ "$actual" = "${MODE#0}" ] || [ "$actual" = "$MODE" ]; then ok "$SCRATCH/$d ($actual)"
    else bad "$SCRATCH/$d (mode $actual, expected $MODE — re-run with --create to fix)"; fi
  else
    bad "missing $SCRATCH/$d  (run: bash scripts/preflight-scratch.sh --create)"
  fi
done

# 7 ── writability, proven by writing rather than by reading permission bits.
if [ -d "$SCRATCH/tmp" ]; then
  probe="$SCRATCH/tmp/.preflight.$$"
  if (echo ok > "$probe") 2>/dev/null && [ -s "$probe" ]; then
    ok "scratch is writable by $(id -un)"
    rm -f "$probe" 2>/dev/null || true
  else
    bad "cannot write to $SCRATCH/tmp as $(id -un) — check ownership"
    note "The worker container runs as root and would still write, but the"
    note "operator should be able to inspect and clean the disk too."
  fi
fi

echo ""
if [ "$fail" = 0 ]; then
  echo "PASS ✓  scratch ready — bind mounts will resolve and heavy writes stay off the root disk"
  exit 0
fi
echo "FAIL ✗  fix the above before deploying; the worker will refuse to start otherwise"
exit 1
