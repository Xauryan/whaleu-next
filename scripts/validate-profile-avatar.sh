#!/usr/bin/env bash
# Frozen local acceptance. The caller supplies the existing isolated PostgreSQL
# wrapper and prepared evidence directory; no credentials or .env are loaded.
# Main PG's 4500-second ceiling is aggregate scheduling headroom, not a change to
# any test, statement, lock, proof, retention, lease, performance or capacity limit.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: bash scripts/validate-profile-avatar.sh POSTGRES_WRAPPER FROZEN_EVIDENCE' >&2
  exit 2
fi
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
WRAPPER=$1
EVIDENCE=$(cd "$2" && pwd -P)
TREE=$(cat "$EVIDENCE/tree.txt")
BASE=$(cat "$EVIDENCE/baseline.txt")
verify() {
  (
    cd "$REPO"
    sha256sum --quiet -c "$EVIDENCE/source.sha256"
    test "$(git rev-parse HEAD)" = "$BASE"
    GIT_INDEX_FILE="$EVIDENCE/index" git diff --quiet
    test "$(GIT_INDEX_FILE="$EVIDENCE/index" git write-tree)" = "$TREE"
    test -z "$(GIT_INDEX_FILE="$EVIDENCE/index" git ls-files --others --exclude-standard | grep -v '^node_modules$' || true)"
  )
}
run() {
  local name=$1 cwd=$2
  shift 2
  verify
  printf '%s START %s cwd=%s command=' "$(date -u +%FT%TZ)" "$name" "$cwd" >> "$EVIDENCE/results.log"
  printf '%q ' "$@" >> "$EVIDENCE/results.log"
  printf '\n' >> "$EVIDENCE/results.log"
  set +e
  (cd "$cwd"; "$@") > "$EVIDENCE/$name.log" 2>&1
  local result=$?
  set -e
  printf '%s END %s exit=%s\n' "$(date -u +%FT%TZ)" "$name" "$result" >> "$EVIDENCE/results.log"
  verify
  sha256sum "$EVIDENCE/$name.log" >> "$EVIDENCE/logs.sha256"
  test "$result" = 0
}
run cheap "$REPO" timeout 600 npm run check
run format "$REPO" timeout 180 npm run format:check
# Keep timeout INSIDE the wrapper, so its EXIT/finally cleanup always runs.
run integration "$REPO/apps/api" "$WRAPPER" timeout 4500 env WHALEU_RATINGS_CI_DIAGNOSTICS=1 WHALEU_SCALABLE_PROFILE_CI_DIAGNOSTICS=1 npm run test:integration
run semantic "$REPO/apps/api" "$WRAPPER" timeout 600 npm run test:semantic:integration
verify
printf '%s ALL_VALIDATION_PASSED\n' "$(date -u +%FT%TZ)" >> "$EVIDENCE/results.log"
