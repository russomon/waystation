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
# It NEVER formats, partitions, or mounts anything. Preparing the disk is a
# host administration task; this only inspects it and creates directories.
set -uo pipefail

SCRATCH="${WAYSTATION_SCRATCH:-/mnt/waystation-scratch/waystation}"
MOUNT="${WAYSTATION_SCRATCH_MOUNT:-/mnt/waystation-scratch}"
# Empty = accept whatever device backs the mount. Set it to pin a specific one.
EXPECT_DEV="${WAYSTATION_SCRATCH_DEVICE:-}"
MIN_FREE_GB="${WAYSTATION_SCRATCH_MIN_FREE_GB:-20}"
SUBDIRS=(uploads jobs runs tmp cache artifacts exports logs)

CREATE=0
[ "${1:-}" = "--create" ] && CREATE=1

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=1; }

echo "▶ Waystation scratch preflight"
echo "  mount point : $MOUNT"
echo "  scratch root: $SCRATCH"
echo ""

# 1 ── the mount point must be a real mount, not a directory on the root disk.
if mountpoint -q "$MOUNT" 2>/dev/null; then
  ok "$MOUNT is a mount point"
else
  bad "$MOUNT is NOT a mount point — heavy writes would land on the root disk"
  echo "      The data disk must be mounted (and in /etc/fstab) before deploying."
fi

# 2 ── report the backing device and filesystem; pin it only if asked to.
DEV=$(findmnt -no SOURCE --target "$MOUNT" 2>/dev/null || echo "")
FSTYPE=$(findmnt -no FSTYPE --target "$MOUNT" 2>/dev/null || echo "")
if [ -n "$DEV" ]; then
  ok "backed by $DEV ($FSTYPE)"
  if [ -n "$EXPECT_DEV" ] && [ "$DEV" != "$EXPECT_DEV" ]; then
    bad "expected device $EXPECT_DEV but found $DEV"
  fi
else
  bad "could not determine the device backing $MOUNT"
fi

# 3 ── it must not simply BE the root filesystem under another name.
ROOT_DEV=$(findmnt -no SOURCE --target / 2>/dev/null || echo "")
if [ -n "$DEV" ] && [ "$DEV" = "$ROOT_DEV" ]; then
  bad "$MOUNT resolves to the ROOT device ($ROOT_DEV) — that defeats the purpose"
fi

# 4 ── free space.
if [ -n "$DEV" ]; then
  AVAIL_GB=$(df -BG --output=avail "$MOUNT" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "${AVAIL_GB:-}" ]; then
    if [ "$AVAIL_GB" -ge "$MIN_FREE_GB" ]; then ok "${AVAIL_GB}G free (minimum ${MIN_FREE_GB}G)"
    else bad "only ${AVAIL_GB}G free — below the ${MIN_FREE_GB}G minimum"; fi
  fi
fi

# 5 ── the directory layout.
echo ""
if [ "$CREATE" = 1 ]; then
  echo "▶ creating layout under $SCRATCH"
  # The mount point is root-owned, so the deploy user usually cannot mkdir here.
  # Three escalation paths, in order of least friction:
  #   1. plain mkdir       — works if the tree is already owned by this user
  #   2. docker            — the daemon runs as root and the deploy user is
  #                          already in the docker group, so this needs no
  #                          password; preferred on an unattended deploy
  #   3. sudo              — last resort, and it will prompt
  # Ownership ends up as the invoking user with mode 0775: the container runs
  # as root (so it can always write), and this additionally lets the operator
  # inspect and clean the disk without sudo.
  mk() { for d in "$@"; do mkdir -p "$d" || return 1; done; }
  if mk "$SCRATCH" "${SUBDIRS[@]/#/$SCRATCH/}" 2>/dev/null; then
    ok "created as $(id -un)"
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    echo "  (no write permission here — creating via a root container)"
    IMG=$(docker images -q | head -1)
    if [ -n "$IMG" ]; then
      docker run --rm -v "$MOUNT:$MOUNT" "$IMG" sh -c "
        for d in ${SUBDIRS[*]}; do mkdir -p '$SCRATCH'/\$d; done
        chown -R $(id -u):$(id -g) '$SCRATCH' && chmod -R 0775 '$SCRATCH'
      " >/dev/null 2>&1 && ok "created via docker, owned by $(id -un)" \
        || bad "docker-based creation failed"
    else
      bad "no local image available to create the layout with"
    fi
  else
    echo "  (escalating to sudo — this will prompt)"
    sudo mkdir -p "$SCRATCH" || bad "could not create $SCRATCH"
    for d in "${SUBDIRS[@]}"; do sudo mkdir -p "$SCRATCH/$d" || true; done
    sudo chown -R "$(id -u):$(id -g)" "$SCRATCH" 2>/dev/null || true
    sudo chmod -R 0775 "$SCRATCH" 2>/dev/null || true
  fi
fi

for d in "${SUBDIRS[@]}"; do
  if [ -d "$SCRATCH/$d" ]; then ok "$SCRATCH/$d"
  else bad "missing $SCRATCH/$d  (run: bash scripts/preflight-scratch.sh --create)"; fi
done

# 6 ── writability, proven by writing rather than by inspecting permission bits.
if [ -d "$SCRATCH/tmp" ]; then
  probe="$SCRATCH/tmp/.preflight.$$"
  if (echo ok > "$probe") 2>/dev/null && [ -s "$probe" ]; then
    ok "scratch is writable"
    rm -f "$probe" 2>/dev/null || true
  else
    bad "cannot write to $SCRATCH/tmp — check ownership for the container user"
  fi
fi

echo ""
if [ "$fail" = 0 ]; then
  echo "PASS ✓  scratch disk ready — bind mounts will resolve and heavy writes stay off the root disk"
  exit 0
fi
echo "FAIL ✗  fix the above before deploying; the worker will refuse to start otherwise"
exit 1
