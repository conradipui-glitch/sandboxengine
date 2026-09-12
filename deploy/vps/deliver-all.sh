#!/usr/bin/env bash
# FIN-04 — fail-closed, coordinated delivery of Engine + Studio + Site to the
# team stand (85.137.95.104.sslip.io). This script runs ON the stand.
#
# Hard rules (docs/RUNBOOK.md §15, docs/FIN-CHECKLIST.md:40):
#   * the pin is a FULL 40-hex commit SHA and is mandatory;
#   * nothing is written until the pin was fetched, proven to be a descendant
#     of the current remote head (fast-forward only), reset to, read back and
#     the working tree is clean — any doubt aborts before the first write;
#   * no secret value ever lives in this file: deploy/vps/.env on the stand is
#     the only source of values and is handed to compose with --env-file; the
#     script only knows variable NAMES;
#   * gate, blog and Iva are never restarted here — the compose services
#     touched are exactly engine, authored and studio;
#   * --site is opt-in and requires --site-root; without it Site is reported
#     as skipped, never silently "delivered";
#   * --dry-run prints the whole sequence of commands and executes NOTHING.
#
# Usage:
#   deploy/vps/deliver-all.sh <full-40-hex-sha> [--site --site-root <dir>] [--dry-run]
#                             [--repo <dir>] [--env-file <path>] [--ref <remote-ref>]
#
# Exit codes: 0 = delivered, 1 = input/precondition failure, 2 = delivery failure.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="${LHC_REPO:-$(cd "$SELF_DIR/../.." && pwd)}"
ENV_FILE="${LHC_ENV_FILE:-deploy/vps/.env}"
COMPOSE_FILE="deploy/vps/docker-compose.yml"
REMOTE="origin"
# Ветка доставки. Клон на стенде может не иметь origin/HEAD (его создаёт только
# git clone с --no-single-branch), поэтому по умолчанию берём ветку, на которой
# стоит рабочий каталог стенда: доставка идёт в неё, а пин проверяется по ней.
REMOTE_REF="${LHC_DELIVERY_REF:-}"
WITH_SITE=0
SITE_ROOT=""
DRY_RUN=0
PIN=""
PIN_VERIFIED=0

if [ -z "$REMOTE_REF" ]; then
  LOCAL_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
  REMOTE_REF="origin/${LOCAL_BRANCH}"
fi

# Keys that must exist (by NAME only) in deploy/vps/.env. Values are never read
# or printed by this script — compose resolves them from the file.
REQUIRED_ENV_KEYS=(LH_PUBLIC_MISSION_SESSION_SECRET)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
die()  { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
fail_delivery() { printf 'FAIL: %s\n' "$*" >&2; exit 2; }

# run: the ONLY way a state-changing command is issued. In dry-run it prints
# the command and returns without executing it.
run() {
  printf '  + %s\n' "$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  "$@"
}

# capture: read-only command substitution. In dry-run it prints a marker and
# executes nothing, so a dry-run never touches the stand.
capture() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s' '<dry-run>'
    return 0
  fi
  "$@"
}

# Guard placed at the top of every delivery step: no write may run before the
# pin was verified fail-closed.
require_verified_pin() {
  if [ "$PIN_VERIFIED" -ne 1 ]; then
    die "refusing to write: the delivered pin is not verified yet (fail-closed)"
  fi
}

need_arg() { [ -n "${2:-}" ] || die "option $1 requires a value"; }

usage() {
  sed -n '2,30p' "$0"
}

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --site)      WITH_SITE=1 ;;
    --site-root) need_arg "$1" "${2:-}"; SITE_ROOT="$2"; shift ;;
    --repo)      need_arg "$1" "${2:-}"; REPO="$2"; shift ;;
    --env-file)  need_arg "$1" "${2:-}"; ENV_FILE="$2"; shift ;;
    --ref)       need_arg "$1" "${2:-}"; REMOTE_REF="$2"; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          die "unknown option: $1" ;;
    *)
      [ -z "$PIN" ] || die "unexpected extra argument: $1"
      PIN="$1"
      ;;
  esac
  shift
done

[ -n "$PIN" ] || die "usage: deliver-all.sh <full-40-hex-sha> [--site --site-root <dir>] [--dry-run]"
case "$PIN" in
  *[!0-9a-f]*) die "the pin must be a lowercase hexadecimal commit SHA, got: $PIN" ;;
esac
[ "${#PIN}" -eq 40 ] || die "the pin must be a FULL 40-hex commit SHA (short SHAs are refused), got \"$PIN\" (${#PIN} chars)"
if [ "$WITH_SITE" -eq 1 ] && [ -z "$SITE_ROOT" ]; then
  die "--site requires --site-root <dir> (otherwise Site is reported as skipped)"
fi

log "== FIN-04 delivery =="
log "repo:       $REPO"
log "pin:        $PIN"
log "env file:   $ENV_FILE  (values are read by compose only, never printed here)"
log "compose:    $COMPOSE_FILE"
log "site:       $([ "$WITH_SITE" -eq 1 ] && printf 'enabled (%s)' "$SITE_ROOT" || printf 'skipped (no --site)')"
log "dry-run:    $([ "$DRY_RUN" -eq 1 ] && printf yes || printf no)"

# ---------------------------------------------------------------------------
# preflight (dry-run safe: no filesystem requirement of the stand)
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
# STEP 1 — fail-closed pin: fetch, ancestry, reset, read-back, clean tree
# ---------------------------------------------------------------------------
log "== STEP 1: verify pin (fail-closed) =="
run git fetch --prune "$REMOTE"

if [ "$DRY_RUN" -eq 0 ]; then
  git cat-file -e "${PIN}^{commit}" 2>/dev/null || die "pin ${PIN} is not a commit in this checkout after fetch"
fi

CURRENT_REMOTE="$(capture git rev-parse "$REMOTE_REF")"
log "current remote head ($REMOTE_REF): $CURRENT_REMOTE"

if [ "$DRY_RUN" -eq 0 ]; then
  if ! git merge-base --is-ancestor "$CURRENT_REMOTE" "$PIN"; then
    die "fail-closed: $REMOTE_REF ($CURRENT_REMOTE) is NOT an ancestor of pin $PIN — refusing a non-fast-forward delivery"
  fi
fi

run git reset --hard "$PIN"

HEAD_SHA="$(capture git rev-parse HEAD)"
DIRTY="$(capture git status --porcelain)"
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$HEAD_SHA" = "$PIN" ] || die "read-back mismatch: HEAD is $HEAD_SHA but the pin is $PIN"
  [ -z "$DIRTY" ] || die "working tree is not clean after reset: $(printf '%s' "$DIRTY" | tr '\n' ' ')"
fi
PIN_VERIFIED=1
if [ "$DRY_RUN" -eq 1 ]; then
  log "pin verified (dry-run: not executed)"
else
  log "pin verified: HEAD=$HEAD_SHA tree=clean"
fi

# ---------------------------------------------------------------------------
# STEP 2 — Engine + authored (one command: they share the engine image/Dockerfile)
# ---------------------------------------------------------------------------
deliver_engine() {
  require_verified_pin
  log "== STEP 2: Engine + authored =="
  run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build engine authored
  run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate engine authored
}

# ---------------------------------------------------------------------------
# STEP 3 — Studio
# ---------------------------------------------------------------------------
deliver_studio() {
  require_verified_pin
  log "== STEP 3: Studio =="
  run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build studio
  run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps studio
}

# ---------------------------------------------------------------------------
# STEP 4 — Site (opt-in; a separate Cloudflare repository, never silently claimed)
# ---------------------------------------------------------------------------
deliver_site() {
  if [ "$WITH_SITE" -ne 1 ]; then
    log "== STEP 4: Site — пропущено (нет флага --site) =="
    SITE_STATUS="пропущено (нет --site)"
    SITE_SHA="-"
    return 0
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ ! -d "$SITE_ROOT" ]; then
    die "site root not found: $SITE_ROOT"
  fi
  require_verified_pin
  log "== STEP 4: Site (--site) =="
  SITE_SHA="$(capture git -C "$SITE_ROOT" rev-parse HEAD || true)"
  # `npm --prefix <root> run deploy` runs the site's own deploy script in its
  # root (BASELINE.md documents `npm run deploy` / wrangler); tokens stay in
  # that repository's own environment, never here.
  run npm --prefix "$SITE_ROOT" run deploy
  SITE_STATUS="доставлено"
}

# ---------------------------------------------------------------------------
# read-back helpers
# ---------------------------------------------------------------------------
probe_port() { # port [path]
  local port="$1" path="${2:-/}" code
  code="$(capture curl -s -o /dev/null -w '%{http_code}' --max-time "${LHC_PROBE_TIMEOUT:-5}" "http://127.0.0.1:${port}${path}" || true)"
  printf '%s' "${code:-000}"
}

container_image() { # container
  capture docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true
}

container_health() { # container
  capture docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# execute
# ---------------------------------------------------------------------------
deliver_engine
deliver_studio
SITE_STATUS="пропущено (нет --site)"
SITE_SHA="-"
deliver_site

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
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "component" "image / identity" "health" "sha (read-back)" "loopback"
printf '%-10s-+-%-34s-+-%-16s-+-%-18s-+-%s\n' "----------" "----------------------------------" "----------------" "------------------" "---------------"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "engine"   "${ENGINE_IMG:-<none>}"   "${ENGINE_HEALTH:-<n/a>}"   "$READBACK_SHA" "127.0.0.1:8742 healthz -> $PORT_8742"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "authored" "${AUTHORED_IMG:-<none>}" "${AUTHORED_HEALTH:-<n/a>}" "$READBACK_SHA" "127.0.0.1:8746 healthz -> $PORT_8746"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "studio"   "${STUDIO_IMG:-<none>}"   "${STUDIO_HEALTH:-<none>}"  "$READBACK_SHA" "127.0.0.1:8740 / -> $PORT_8740"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "site"     "${SITE_STATUS}"          "-"                         "${SITE_SHA}" "-"
printf '%-10s | %-34s | %-16s | %-18s | %s\n' "gate"     "not touched by this script" "-" "-" "127.0.0.1:8744 (unchanged)"

log ""
log "delivered pin: $READBACK_SHA (requested $PIN)"
if [ "$DRY_RUN" -eq 1 ]; then
  log "worktree:      (dry-run: not inspected)"
else
  log "worktree:      $([ -z "$READBACK_DIRTY" ] && printf clean || printf 'DIRTY: %s' "$(printf '%s' "$READBACK_DIRTY" | tr '\n' ' ')")"
fi
log "gate / blog / Iva: untouched by this script."

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN: nothing above was executed."
  exit 0
fi

if [ "$READBACK_SHA" != "$PIN" ]; then
  fail_delivery "read-back mismatch after delivery: HEAD=$READBACK_SHA requested=$PIN"
fi
if [ -n "$READBACK_DIRTY" ]; then
  fail_delivery "working tree is not clean after delivery"
fi
log "OK: delivery complete at $PIN (engine+authored+studio$([ "$WITH_SITE" -eq 1 ] && printf '+site' || printf ''))"
