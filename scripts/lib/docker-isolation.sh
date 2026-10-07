# shellcheck shell=bash
# Isolation rules for the Docker proofs. SOURCE this file; do not run it.
#
# The Docker daemon is SHARED with unrelated workloads (OrbiSphere, local dev), and
# the host sandbox used by scripts/run-proofs.mjs does NOT constrain what the daemon
# does on a script's behalf: once a script may reach the Docker socket it can ask the
# daemon to do anything. So the protection lives here, in the scripts:
#
#   * Nothing touches Docker unless the caller approved it explicitly:
#       WS_DOCKER_APPROVED=1     run Docker workloads at all   (runner: --docker)
#       WS_DOCKER_ALLOW_BUILD=1  permit `docker build`          (runner: --docker-build)
#       WS_DOCKER_ALLOW_PULL=1   permit `docker pull`           (runner: --docker-pull)
#     Builds and pulls reach external mirrors and are refused by default.
#   * WS_DOCKER_PLAN=1 prints the exact commands and executes NOTHING, not even
#     `docker info`. This is how the scripts are reviewed and tested without Docker.
#   * Every object a run creates is named for, and labelled with, a unique run id, and
#     cleanup removes ONLY objects carrying that label. No prune, no project-wide
#     `down -v`, no port-wide kill, no removal by a shared name.
#   * Images are never built into, tagged as, or removed under a shared name
#     (`latest`, `local`, `waystation-*`). An existing image is used only if its
#     application files are byte-identical to the working tree (ws_dk_verify_tree);
#     an image that does not match is a BLOCKER, never silently substituted.
#   * No repository .env, no env_file, no inherited credentials: containers receive
#     only the explicit synthetic variables the script passes with -e.
#   * Published ports bind 127.0.0.1 on a free ephemeral port; resources are capped.

# Resource caps for every container this library starts (proposal; tune on first approved run).
WS_DK_LIMITS=(--memory 1g --memory-swap 1g --cpus 1 --pids-limit 256 --security-opt no-new-privileges --cap-drop ALL)

# The docker executable is resolved ONCE, when this library is sourced, and every call uses that
# path ("$WS_DK_BIN"). Scripts must source this file BEFORE they change PATH: a later
# `PATH=/opt/homebrew/bin:$PATH` must not be able to swap in a different `docker`. A test (or a
# reviewer) can pin it explicitly with WS_DOCKER_BIN.
WS_DK_BIN="${WS_DOCKER_BIN:-$(command -v docker 2>/dev/null || true)}"

_ws_log() { printf '%s\n' "$*" >&2; }

# A name belongs to the run if it IS the run id or is "<run id>-<suffix>". A bare prefix match
# is not enough: run "wsproof-x-1-1" must not own "wsproof-x-1-12-worker".
_ws_owned() { local n="$1" id="${WS_DK_RUN_ID:-}"; [ -n "$id" ] || return 1; [ "$n" = "$id" ] && return 0; case "$n" in "$id"-*) return 0;; esac; return 1; }

# _ws_positionals "<options that take a value>" args...  ->  WS_POS (the non-option words)
_ws_positionals() {
  local valopts=" $1 " a skip=0; shift; WS_POS=()
  for a in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$a" in
      -*) case "$valopts" in *" $a "*) skip=1;; esac;;
      *) WS_POS+=("$a");;
    esac
  done
}
# every positional must belong to the run (and there must be at least one)
_ws_all_owned() { local t; [ "${#WS_POS[@]}" -ge 1 ] || return 1; for t in "${WS_POS[@]}"; do _ws_owned "$t" || return 1; done; return 0; }

# ws_dk_begin <short-name>: pick a unique run id, then refuse to continue unless approved.
ws_dk_begin() {
  WS_DK_NAME="$1"
  WS_DK_RUN_ID="wsproof-${1}-$(date +%s)-${RANDOM}"
  WS_DK_LABEL="wsproof.run=${WS_DK_RUN_ID}"
  WS_DK_CLEANED=0
  WS_DK_TOUCHED=0
  if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then
    _ws_log "PLAN MODE: no Docker command will be executed. Run id: ${WS_DK_RUN_ID}"
    return 0
  fi
  if [ "${WS_DOCKER_APPROVED:-0}" != 1 ]; then
    echo "SKIP - Docker proofs run only with explicit approval (WS_DOCKER_APPROVED=1, runner --docker); nothing was started."
    exit 0
  fi
  [ -n "$WS_DK_BIN" ] && [ -x "$WS_DK_BIN" ] || { echo "SKIP - docker not installed"; exit 0; }
  "$WS_DK_BIN" info >/dev/null 2>&1 || { echo "SKIP - docker daemon not reachable"; exit 0; }
}

# ws_dk <docker args...>: the only way these scripts invoke docker. Only the docker
# subcommand tokens are inspected (never the text of a `sh -c` script passed to a container).
ws_dk() {
  local sub="$1" sub2="${2:-}" arg prev="" id="${WS_DK_RUN_ID:-__unset__}" named=0 has_label=0 net_ok=0 saw_net=0
  case "$sub" in
    system|prune|commit|save|load|import|export|push|login|logout|tag|rmi|context|swarm|plugin|trust|manifest)
      _ws_log "REFUSED: docker $sub (not permitted in an isolated proof)"; return 97;;
  esac
  for arg in "$@"; do
    [ "$arg" = prune ] && { _ws_log "REFUSED: prune is never permitted"; return 97; }
    case "$arg" in
      --env-file|--env-file=*|-v|--volume|--volume=*|--mount|--mount=*|--privileged|--pid=host|--ipc=host|--net=host|--network=host|--userns=host|*docker.sock*|\
      --volumes-from|--volumes-from=*|--link|--link=*|--device|--device=*|--cap-add|--cap-add=*|--cgroup-parent|--cgroup-parent=*|--add-host|--add-host=*)
        _ws_log "REFUSED: docker $sub uses a host mount, env file, host namespace, device, added capability, link, host alias, privilege or the Docker socket ($arg)"; return 95;;
      --network=*|--net=*) saw_net=1; if [ "${arg#*=}" = none ] || _ws_owned "${arg#*=}"; then net_ok=1; else net_ok=0; fi;;
    esac
    case "$prev" in
      --network|--net) saw_net=1; if [ "$arg" = none ] || _ws_owned "$arg"; then net_ok=1; else net_ok=0; fi
                       [ "$arg" = host ] && { _ws_log "REFUSED: host namespace ($prev host)"; return 95; } ;;
      --pid|--ipc|--uts|--userns) [ "$arg" = host ] && { _ws_log "REFUSED: host namespace ($prev host)"; return 95; } ;;
      --name) _ws_owned "$arg" && named=1 ;;
      --label) [ "$arg" = "${WS_DK_LABEL:-__unset__}" ] && has_label=1 ;;
      -p|--publish) case "$arg" in 127.0.0.1:*) ;; *) _ws_log "REFUSED: published port not bound to 127.0.0.1 ($arg)"; return 95;; esac ;;
    esac
    prev="$arg"
  done
  case "$sub" in
    build)
      if [ "${WS_DOCKER_ALLOW_BUILD:-0}" != 1 ] && [ "${WS_DOCKER_PLAN:-0}" != 1 ]; then _ws_log "REFUSED: docker build is not authorized (WS_DOCKER_ALLOW_BUILD=1, runner --docker-build)"; return 96; fi
      local tagged=0 p2=""
      for arg in "$@"; do if [ "$p2" = "-t" ]; then case "$arg" in wsproof/*:"${id}") tagged=1;; *) tagged=0; break;; esac; fi; p2="$arg"; done
      [ "$tagged" = 1 ] || { _ws_log "REFUSED: docker build may tag only wsproof/<name>:${id}, never a shared name"; return 96; } ;;
    pull)
      if [ "${WS_DOCKER_ALLOW_PULL:-0}" != 1 ] && [ "${WS_DOCKER_PLAN:-0}" != 1 ]; then _ws_log "REFUSED: docker pull is not authorized (WS_DOCKER_ALLOW_PULL=1, runner --docker-pull)"; return 96; fi ;;
    run|create)
      [ "$named" = 1 ] || { _ws_log "REFUSED: docker $sub without a --name that is the run id or starts with '<run id>-'"; return 95; }
      [ "$has_label" = 1 ] || { _ws_log "REFUSED: docker $sub without the run label"; return 95; }
      [ "$saw_net" = 1 ] && [ "$net_ok" = 1 ] || { _ws_log "REFUSED: docker $sub must use --network none or this run's own network, never the default bridge or a shared network"; return 95; } ;;
    rm)      _ws_positionals "" "${@:2}";                         _ws_all_owned || { _ws_log "REFUSED: docker rm targets must ALL belong to this run"; return 94; } ;;
    stop|restart) _ws_positionals "-t --time" "${@:2}";            _ws_all_owned || { _ws_log "REFUSED: docker $sub targets must ALL belong to this run"; return 94; } ;;
    kill)    _ws_positionals "-s --signal" "${@:2}";               _ws_all_owned || { _ws_log "REFUSED: docker kill targets must ALL belong to this run"; return 94; } ;;
    exec)    _ws_positionals "-e --env -u --user -w --workdir --detach-keys" "${@:2}"
             [ "${#WS_POS[@]}" -ge 1 ] && _ws_owned "${WS_POS[0]}" || { _ws_log "REFUSED: docker exec container must belong to this run"; return 94; } ;;
    network|volume)
      case "$sub2" in
        create) [ "$has_label" = 1 ] || { _ws_log "REFUSED: docker $sub create without the run label"; return 94; }
                _ws_positionals "--label --driver -d --opt -o" "${@:3}"
                _ws_all_owned || { _ws_log "REFUSED: docker $sub create name must belong to this run"; return 94; } ;;
        rm) _ws_positionals "" "${@:3}"; _ws_all_owned || { _ws_log "REFUSED: docker $sub rm targets must ALL belong to this run"; return 94; } ;;
        *) _ws_log "REFUSED: docker $sub $sub2"; return 94;;
      esac ;;
    image)
      [ "$sub2" = inspect ] || { _ws_log "REFUSED: docker image $sub2 (only 'image inspect' is permitted)"; return 93; } ;;
    info|ps|logs|inspect|wait|port) ;;
    *) _ws_log "REFUSED: docker $sub (not on the allowlist)"; return 93;;
  esac
  if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then
    # stderr, so a caller's `>/dev/null` cannot hide what a plan would run
    printf 'PLAN docker %s\n' "$*" >&2
    [ "$sub" = build ] && [ "${WS_DOCKER_ALLOW_BUILD:-0}" != 1 ] && printf 'PLAN-NOTE: the build above would be REFUSED without --docker-build\n' >&2
    return 0
  fi
  case "$sub:$sub2" in build:*|run:*|create:*|network:create|volume:create) WS_DK_TOUCHED=1;; esac
  "$WS_DK_BIN" "$@"
}

# ws_dk_free_port: an unused loopback TCP port.
ws_dk_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
}

# ws_dk_resolve_image <env-var-name> <purpose>: a pre-existing local image, pinned by ID.
# Sets WS_DK_IMAGE_ID. A missing image is a BLOCKER (never built or pulled implicitly).
ws_dk_resolve_image() {
  local var="$1" purpose="$2" ref="${!1:-}"
  if [ -z "$ref" ]; then
    echo "SKIP - BLOCKED: ${var} is not set. Name an existing local ${purpose} image whose application files match this working tree (or authorize a build with --docker-build). No image was built or pulled."
    exit 0
  fi
  if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then ws_dk image inspect --format '{{.Id}}' "$ref"; WS_DK_IMAGE_ID="plan-image-id"; return 0; fi
  WS_DK_IMAGE_ID=$(ws_dk image inspect --format '{{.Id}}' "$ref" 2>/dev/null) || {
    echo "SKIP - BLOCKED: image '${ref}' (${var}) does not exist locally; nothing was built or pulled."; exit 0; }
}

# ws_dk_verify_tree <image-id> <worker|gateway>: the image's application files must equal this tree's.
# Prints BLOCKED and exits 0 (a SKIP, never a pass) if any file differs, so an old image can
# never silently stand in for current source.
ws_dk_verify_tree() {
  local image="$1" kind="$2" host_dir image_dir files
  case "$kind" in
    worker)  host_dir="$WEB/pipeline"; image_dir=/app;         files="requirements.txt worker.py qc policies" ;;
    gateway) host_dir="$WEB/gateway";  image_dir=/app/gateway; files="package.json tsconfig.json src" ;;
    *) _ws_log "ws_dk_verify_tree: unknown kind $kind"; return 2;;
  esac
  local want got
  want=$(cd "$host_dir" && find $files -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -exec shasum -a 256 {} + | sort -k2)
  if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then
    ws_dk run --rm --network none --name "${WS_DK_RUN_ID}-verify-${kind}" --label "${WS_DK_LABEL}" "${WS_DK_LIMITS[@]}" --entrypoint sh "$image" -c "cd ${image_dir} && find ${files} -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -exec sha256sum {} + | sort -k2"
    return 0
  fi
  got=$(ws_dk run --rm --network none --name "${WS_DK_RUN_ID}-verify-${kind}" --label "${WS_DK_LABEL}" "${WS_DK_LIMITS[@]}" --entrypoint sh "$image" -c "cd ${image_dir} && find ${files} -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -exec sha256sum {} + | sort -k2") || got=""
  if [ "$got" != "$want" ]; then
    echo "SKIP - BLOCKED: the ${kind} image does not contain this working tree's application files (differs in: $(diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | grep -c '^[<>]') lines). Not substituting it for current source; build is not authorized."
    exit 0
  fi
  echo "✓ ${kind} image ${image:0:19}… matches this working tree (application files byte-identical)"
}

# ws_dk_obtain_image <worker|gateway>: an image for the current source, WITHOUT touching shared tags.
#   1. WS_PROOF_<KIND>_IMAGE names an existing local image: it is pinned by ID and must
#      match this tree's application files (ws_dk_verify_tree), else BLOCKED.
#   2. Otherwise, only if `docker build` was authorized, build wsproof/<kind>:<run id>.
#   3. Otherwise BLOCKED (nothing built, nothing pulled). Sets WS_DK_IMAGE_ID.
ws_dk_obtain_image() {
  local kind="$1" var ref
  case "$kind" in worker) var=WS_PROOF_WORKER_IMAGE;; gateway) var=WS_PROOF_GATEWAY_IMAGE;; *) return 2;; esac
  ref="${!var:-}"
  if [ -n "$ref" ]; then
    ws_dk_resolve_image "$var" "$kind"
    ws_dk_verify_tree "$WS_DK_IMAGE_ID" "$kind"
    return 0
  fi
  if [ "${WS_DOCKER_ALLOW_BUILD:-0}" = 1 ] || [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then
    local tag="wsproof/${kind}:${WS_DK_RUN_ID}"
    WS_DK_BUILT_TAGS="${WS_DK_BUILT_TAGS:-} ${tag}"
    if [ "$kind" = worker ]; then ws_dk build -t "$tag" --label "${WS_DK_LABEL}" "$WEB/pipeline" || { echo "FAIL: ${kind} image build"; exit 1; }
    else ws_dk build -t "$tag" --label "${WS_DK_LABEL}" -f "$WEB/gateway/Dockerfile" "$WEB" || { echo "FAIL: ${kind} image build"; exit 1; }; fi
    if [ "${WS_DOCKER_PLAN:-0}" = 1 ]; then WS_DK_IMAGE_ID="plan-image-id"; else WS_DK_IMAGE_ID=$(ws_dk image inspect --format '{{.Id}}' "$tag"); fi
    return 0
  fi
  echo "SKIP - BLOCKED: no suitable ${kind} image. Set ${var} to an existing local image whose application files match this working tree, or authorize a build (--docker-build, which needs external network access). Nothing was built or pulled."
  exit 0
}

# ws_dk_cleanup: remove ONLY objects carrying this run's label, by id. Idempotent.
ws_dk_cleanup() {
  [ "${WS_DK_CLEANED:-0}" = 1 ] && return 0
  WS_DK_CLEANED=1
  [ "${WS_DOCKER_PLAN:-0}" = 1 ] && { printf 'PLAN cleanup: remove containers, networks and volumes labelled %s (and nothing else)\n' "$WS_DK_LABEL"; return 0; }
  [ -n "${WS_DK_RUN_ID:-}" ] || return 0
  [ "${WS_DK_TOUCHED:-0}" = 1 ] || return 0      # this run created nothing: do not even query the daemon
  local id
  for id in $("$WS_DK_BIN" ps -aq --filter "label=${WS_DK_LABEL}" 2>/dev/null); do "$WS_DK_BIN" rm -f "$id" >/dev/null 2>&1 || true; done
  for id in $("$WS_DK_BIN" network ls -q --filter "label=${WS_DK_LABEL}" 2>/dev/null); do "$WS_DK_BIN" network rm "$id" >/dev/null 2>&1 || true; done
  for id in $("$WS_DK_BIN" volume ls -q --filter "label=${WS_DK_LABEL}" 2>/dev/null); do "$WS_DK_BIN" volume rm "$id" >/dev/null 2>&1 || true; done
  local tag; for tag in ${WS_DK_BUILT_TAGS:-}; do case "$tag" in wsproof/*:"${WS_DK_RUN_ID}") "$WS_DK_BIN" image rm "$tag" >/dev/null 2>&1 || true;; esac; done
}
