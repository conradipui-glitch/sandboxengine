#!/usr/bin/env bash
# FIN-04 — rollback companion for deploy/vps/deliver-all.sh.
#
# Returns the stand to a PREVIOUS full commit SHA and rebuilds ONLY the images
# named on the command line (engine, authored, studio). It runs ON the stand.
#
# Hard rules (same as the delivery script):
#   * the target is a FULL 40-hex commit SHA and is mandatory;
#   * --images is mandatory: nothing is rebuilt that was not explicitly named;
#   * the target commit must exist locally after fetch, the reset is read back
#     and the tree must be clean before any write;
#   * secrets come only from deploy/vps/.env on the stand (--env-file); this
#     file contains no key or token, only variable NAMES;
#   * gate, blog and Iva are never touched;
#   * --dry-run prints the whole sequence and executes NOTHING.
#
# Usage:
#   deploy/vps/deliver-rollback.sh <full-40-hex-sha> --images engine,authored,studio
#                                  [--dry-run] [--repo <dir>] [--env-file <path>]
#
# Exit codes: 0 = rolled back, 1 = input/precondition failure, 2 = rollback failure.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${LHC_REPO:-$(cd "$SELF_DIR/../.." && pwd)}"
ENV_FILE="${LHC_ENV_FILE:-deploy/vps/.env}"
COMPOSE_FILE="deploy/vps/docker-compose.yml"
REMOTE="origin"
REMOTE_REF="${LHC_DELIVERY_REF:-origin/HEAD}"
DRY_RUN=0
TARGET=""
IMAGES_ARG=""
IMAGES=()
PIN_VERIFIED=0

# Services rebuildable here. Anything else (gate, nginx-only pieces, blog, Iva)
# is out of scope on purpose.
KNOWN_IMAGES=(engine authored studio)
REQUIRED_ENV_KEYS=(LH_PUBLIC_MISSION_SESSION_SECRET)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
die()  { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
fail_rollback() { printf 'FAIL: %s\n' "$*" >&2; exit 2; }

run() {
  printf '  + %s\n' "$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  "$@"
}

capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s' '<dry-run>'
    return 0
  fi
  "$@"
}

require_verified_pin() {
  if [ "$PIN_VERIFIED" -ne 1 ]; then
    die "refusing to write: the rollback target is not verified yet (fail-closed)"
  fi
}

need_arg() { [ -n "${2:-}" ] || die "option $1 requires a value"; }

usage() { sed -n '2,28p' "$0"; }

is_known_image() {
  local wanted="$1" known
  for known in "${KNOWN_IMAGES[@]}"; do
    [ "$wanted" = "$known" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --images)    need_arg "$1" "${2:-}"; IMAGES_ARG="$2"; shift ;;
    --repo)      need_arg "$1" "${2:-}"; REPO="$2"; shift ;;
    --env-file)  need_arg "$1" "${2:-}"; ENV_FILE="$2"; shift ;;
    --ref)       need_arg "$1" "${2:-}"; REMOTE_REF="$2"; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          die "unknown option: $1" ;;
    *)
      [ -z "$TARGET" ] || die "unexpected extra argument: $1"
      TARGET="$1"
      ;;
  esac
  shift
done

[ -n "$TARGET" ] || die "usage: deliver-rollback.sh <full-40-hex-sha> --images engine,authored,studio [--dry-run]"
case "$TARGET" in
  *[!0-9a-f]*) die "the rollback target must be a lowercase hexadecimal commit SHA, got: $TARGET" ;;
esac
[ "${#TARGET}" -eq 40 ] || die "the rollback target must be a FULL 40-hex commit SHA, got \"$TARGET\" (${#TARGET} chars)"

[ -n "$IMAGES_ARG" ] || die "--images is mandatory: name exactly the images to rebuild (engine, authored, studio)"
IFS=',' read -r -a IMAGES <<< "$IMAGES_ARG"
for image in "${IMAGES[@]}"; do
  is_known_image "$image" || die "unknown image \"$image\" (allowed: ${KNOWN_IMAGES[*]})"
done

log "== FIN-04 rollback =="
log "repo:       $REPO"
log "target SHA: $TARGET"
log "images:     ${IMAGES[*]}  (only these are rebuilt)"
log "env file:   $ENV_FILE  (values are read by compose only, never printed here)"
log "dry-run:    $([ "$DRY_RUN" -eq 1 ] && printf yes || printf no)"

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  [ -d "$REPO/.git" ] || die "not a git checkout: $REPO"
  cd "$REPO"
  [ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
  [ -f "$ENV_FILE" ] || die "secrets file not found on the stand: $ENV_FILE"
  for key in "${REQUIRED_ENV_KEYS[@]}"; do
    grep -q "^${key}=" "$ENV_FILE" || die "$ENV_FILE does not define ${key} (the stand file is the only source of secrets)"
  done
  log "secrets file: present, keys by name: ${REQUIRED_ENV_KEYS[*]} (values not printed)"
fi

# ---------------------------------------------------------------------------
# STEP 1 — fail-closed target: fetch, existence, reset, read-back, clean tree
# ---------------------------------------------------------------------------
log "== STEP 1: verify rollback target (fail-closed) =="
run git fetch --prune "$REMOTE"

if [ "$DRY_RUN" -eq 0 ]; then
  git cat-file -e "${TARGET}^{commit}" 2>/dev/null || die "rollback target ${TARGET} is not a commit in this checkout after fetch"
fi

CURRENT_REMOTE="$(capture git rev-parse "$REMOTE_REF")"
log "current remote head ($REMOTE_REF): $CURRENT_REMOTE"

run git reset --hard "$TARGET"

HEAD_SHA="$(capture git rev-parse HEAD)"
DIRTY="$(capture git status --porcelain)"
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$HEAD_SHA" = "$TARGET" ] || die "read-back mismatch: HEAD is $HEAD_SHA but the target is $TARGET"
  [ -z "$DIRTY" ] || die "working tree is not clean after reset: $(printf '%s' "$DIRTY" | tr '\n' ' ')"
fi
PIN_VERIFIED=1
if [ "$DRY_RUN" -eq 1 ]; then
  log "target verified (dry-run: not executed)"
else
  log "target verified: HEAD=$HEAD_SHA tree=clean"
fi

# ---------------------------------------------------------------------------
# STEP 2 — rebuild ONLY the named images and recreate ONLY their services
# ---------------------------------------------------------------------------
rollback_images() {
  require_verified_pin
  log "== STEP 2: rebuild named images =="
  for image in "${IMAGES[@]}"; do
    log "-- image: $image"
    run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build "$image"
    run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$image"
  done
}

# ---------------------------------------------------------------------------
# read-back helpers
# ---------------------------------------------------------------------------
probe_port() {
  local port="$1" path="${2:-/}" code
  code="$(capture curl -s -o /dev/null -w '%{http_code}' --max-time "${LHC_PROBE_TIMEOUT:-5}" "http://127.0.0.1:${port}${path}" || true)"
  printf '%s' "${code:-000}"
}

container_image() { capture docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true; }
container_health() { capture docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# execute
# ---------------------------------------------------------------------------
rollback_images

log "== read-back =="
READBACK_SHA="$(capture git rev-parse HEAD)"
READBACK_DIRTY="$(capture git status --porcelain)"
ENGINE_IMG="$(container_image lhc-engine)"
AUTHORED_IMG="$(container_image lhc-authored)"
STUDIO_IMG="$(container_image lhc-studio)"
ENGINE_HEALTH="$(container_health lhc-engine)"
AUTHORED_HEALTH="$(container_health lhc-authored)"
STUDIO_HEALTH="$(container_health lhc-studio)"
PORT_8740="$(probe_port 8740 /)"
PORT_8742="$(probe_port 8742 /healthz)"
PORT_8746="$(probe_port 8746 /healthz)"

printf '\n'
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "component" "image / choice" "health" "sha (read-back)" "loopback"
printf '%-10s-+-%-34s-+-%-16s-+-%-18s-+-%s\n' "----------" "----------------------------------" "----------------" "------------------" "---------------"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "engine"   "$(printf '%s%s' "${ENGINE_IMG:-<none>}"   "$(is_known_image engine   && printf '' || printf ' (not rebuilt)')")"   "${ENGINE_HEALTH:-<n/a>}"   "$READBACK_SHA" "127.0.0.1:8742 healthz -> $PORT_8742"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "authored" "$(printf '%s%s' "${AUTHORED_IMG:-<none>}" "$(is_known_image authored && printf '' || printf ' (not rebuilt)')")" "${AUTHORED_HEALTH:-<n/a>}" "$READBACK_SHA" "127.0.0.1:8746 healthz -> $PORT_8746"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "studio"   "$(printf '%s%s' "${STUDIO_IMG:-<none>}"   "$(is_known_image studio   && printf '' || printf ' (not rebuilt)')")"   "${STUDIO_HEALTH:-<none>}"  "$READBACK_SHA" "127.0.0.1:8740 / -> $PORT_8740"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "gate"     "not touched by this script" "-" "-" "127.0.0.1:8744 (unchanged)"

log ""
log "rolled back to: $READBACK_SHA (requested $TARGET); images rebuilt: ${IMAGES[*]}"
if [ "$DRY_RUN" -eq 1 ]; then
  log "worktree:       (dry-run: not inspected)"
else
  log "worktree:       $([ -z "$READBACK_DIRTY" ] && printf clean || printf 'DIRTY: %s' "$(printf '%s' "$READBACK_DIRTY" | tr '\n' ' ')")"
fi
log "gate / blog / Iva: untouched by this script."

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN: nothing above was executed."
  exit 0
fi

if [ "$READBACK_SHA" != "$TARGET" ]; then
  fail_rollback "read-back mismatch after rollback: HEAD=$READBACK_SHA requested=$TARGET"
fi
if [ -n "$READBACK_DIRTY" ]; then
  fail_rollback "working tree is not clean after rollback"
fi
log "OK: rollback complete at $TARGET (rebuilt: ${IMAGES[*]})"
