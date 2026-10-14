#!/usr/bin/env bash
# Local equivalent of CI's fresh container. No existing data directory or config is reused.
set -euo pipefail
[[ ${NODE_ENV:-} == test && ${WHALEU_TEST_MAINTENANCE:-} == controlled ]] || { echo 'Explicit test/controlled mode required' >&2; exit 64; }
[[ $# -gt 0 ]] || { echo 'Provide the bounded test command' >&2; exit 64; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${WHALEU_TEST_PG_PORT:-55432}
[[ $PORT =~ ^[0-9]+$ && $PORT -ge 1024 && $PORT -le 65535 ]] || exit 64
if [[ -n ${WHALEU_TEST_PG_BIN:-} ]]; then export PATH="$WHALEU_TEST_PG_BIN:$PATH"; fi
for tool in initdb pg_ctl createdb; do command -v "$tool" >/dev/null; done
exec 9>"${TMPDIR:-/tmp}/whaleu-controlled-test-$PORT.lock"
flock -n 9 || { echo 'Disposable test port lease is held' >&2; exit 73; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/whaleu-controlled-pg.XXXXXXXX")
DATA="$WORK/data"
SOCKET_DIR=''
case ${WHALEU_TEST_PG_PRIVATE_SOCKET:-0} in
  0) ;;
  1) SOCKET_DIR=$(mktemp -d /tmp/whaleu-pg-socket.XXXXXXXX) ;;
  *) echo 'Private test socket flag must be 0 or 1' >&2; exit 64 ;;
esac
started=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  local stopped=1
  if [[ $started == 1 ]]; then
    pg_ctl -D "$DATA" -m fast -w stop || { result=75; stopped=0; }
  fi
  if [[ -n $SOCKET_DIR && $stopped == 1 ]]; then rmdir "$SOCKET_DIR" || result=75; fi
  # Keep this invocation's files for failure diagnosis; no external data is removed.
  printf 'Disposable PostgreSQL files: %s\n' "$WORK"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
initdb -D "$DATA" -U whaleu_test --auth=trust --encoding=UTF8 --no-locale > "$WORK/initdb.log"
# Set before start so cleanup also handles a partially successful pg_ctl invocation.
started=1
pg_ctl -D "$DATA" -l "$WORK/postgres.log" -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories='$SOCKET_DIR' -c autovacuum=off -c timezone=UTC -c log_timezone=UTC" -w start
createdb -h 127.0.0.1 -p "$PORT" -U whaleu_test whaleu_test
export TEST_DATABASE_URL="postgresql://whaleu_test@127.0.0.1:$PORT/whaleu_test"
node "$ROOT/scripts/verify-test-postgres.mjs"
"$@"
