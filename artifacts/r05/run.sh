#!/usr/bin/env bash
# R05 baseline runner: executes each command, captures full output + exit code.
set -u
export PATH="/c/Users/kato55/AppData/Local/Temp/node-v24.19.0-win-x64:$PATH"
hash -r
cd /c/Temp/lhc-r05-baseline || exit 99
mkdir -p artifacts/r05
SUMMARY="artifacts/r05/EXIT_SUMMARY.txt"
: > "$SUMMARY"

run() {
  local name="$1"; shift
  local cmd="$*"
  local log="artifacts/r05/${name}.log"
  echo "### ${name} :: ${cmd}" | tee -a "$SUMMARY"
  # shellcheck disable=SC2086
  eval "$cmd" > "$log" 2>&1
  local ec=$?
  echo "EXIT ${ec}" | tee -a "$SUMMARY"
  echo "--" | tee -a "$SUMMARY"
}

for spec in "$@"; do
  name="${spec%%::*}"
  cmd="${spec#*::}"
  run "$name" "$cmd"
done
echo "DONE"
