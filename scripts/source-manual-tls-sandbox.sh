#!/usr/bin/env bash
# Dedicated disposable CI owner. Never use a global Docker prune or trust-store update.
set -euo pipefail
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || { echo 'Verified CI run identity required' >&2; exit 1; }
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" ]] || exit 1
state="$RUNNER_TEMP/whaleu-source-manual-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
cleanup() {
  [[ -d "$state" ]] || return 0
  if [[ -f "$state/container-id" && -f "$state/owner" ]]; then
    local id owner actual
    id="$(cat "$state/container-id")"; owner="$(cat "$state/owner")"
    [[ "$id" =~ ^[a-f0-9]{64}$ && "$owner" =~ ^[a-f0-9]{32}$ ]] || return 1
    if docker inspect "$id" >/dev/null 2>&1; then
      actual="$(docker inspect --format '{{index .Config.Labels "whaleu.source-manual-owner"}}' "$id")"
      [[ "$actual" == "$owner" ]] || { echo 'Refusing cleanup of an unowned container' >&2; return 1; }
      docker rm --force --volumes "$id" >/dev/null
    fi
  fi
  rm -rf -- "$state"
}
if [[ "${1:-}" == cleanup ]]; then cleanup; exit; fi
[[ "${1:-}" == run ]] || { echo 'Expected run or cleanup' >&2; exit 1; }
mkdir -m 700 "$state"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
openssl rand -hex 16 > "$state/owner"
# Temporary CA is trusted only by this Node invocation. No system trust changes.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=WhaleU disposable source review CA' -keyout "$state/ca.key" -out "$state/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$state/server.key" -out "$state/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost,IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$state/server.ext"
openssl x509 -req -in "$state/server.csr" -CA "$state/ca.crt" -CAkey "$state/ca.key" -CAcreateserial -days 1 -sha256 -extfile "$state/server.ext" -out "$state/server.crt" >/dev/null 2>&1
chmod 600 "$state"/*.key
owner="$(cat "$state/owner")"
# Empty host port chooses an unused port, bound only on IPv4 loopback.
docker run --detach --network bridge --label "whaleu.source-manual-owner=$owner" \
  --publish 127.0.0.1::5432 --mount "type=bind,src=$state,dst=/tls,readonly" \
  -e POSTGRES_USER=whaleu_test -e POSTGRES_PASSWORD=local_ci_only -e POSTGRES_DB=whaleu_test \
  --entrypoint bash postgres:18.6-bookworm -ec \
  'mkdir -m 700 /tmp/source-review-tls; cp /tls/server.key /tls/server.crt /tmp/source-review-tls/; chown -R postgres:postgres /tmp/source-review-tls; chmod 600 /tmp/source-review-tls/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/source-review-tls/server.crt -c ssl_key_file=/tmp/source-review-tls/server.key -c autovacuum=off' > "$state/container-id"
id="$(cat "$state/container-id")"
[[ "$id" =~ ^[a-f0-9]{64}$ ]] || exit 1
# Require TCP: the entrypoint temporary initialization server is Unix-socket-only.
for attempt in $(seq 1 60); do
  if docker exec "$id" pg_isready -h 127.0.0.1 -U whaleu_test -d whaleu_test >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 60 ]] || { echo 'Disposable TLS database did not become ready' >&2; exit 1; }
  sleep 1
done
binding="$(docker port "$id" 5432/tcp)"
[[ "$binding" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || exit 1
export TEST_DATABASE_URL="postgresql://whaleu_test:local_ci_only@127.0.0.1:${BASH_REMATCH[1]}/whaleu_test"
# Bind the optional test-only server admission to this exact owned container.
actual_owner="$(docker inspect --format '{{index .Config.Labels "whaleu.source-manual-owner"}}' "$id")"
actual_id="$(docker inspect --format '{{.Id}}' "$id")"
[[ "$actual_owner" == "$owner" && "$actual_id" == "$id" ]] || exit 1
docker inspect --format '{{json .NetworkSettings.Networks}}' "$id" > "$state/networks.json"
export TEST_READING_DOCKER_TARGET="$(node --input-type=module - "$state/networks.json" "$id" "$owner" "$binding" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
const [file,containerId,owner,binding]=process.argv.slice(2);
assert.match(containerId,/^[a-f0-9]{64}$/);
assert.match(owner,/^[a-f0-9]{32}$/);
const networks=JSON.parse(readFileSync(file,'utf8'));
assert.deepEqual(Object.keys(networks),['bridge']);
const serverAddress=networks.bridge.IPAddress;
assert.equal(isIP(serverAddress),4);
assert.equal(serverAddress.split('.').map(Number).join('.'),serverAddress);
const match=/^127\.0\.0\.1:([0-9]+)$/.exec(binding);
assert.ok(match);
const port=Number(match[1]);
assert.ok(Number.isInteger(port)&&port>=1&&port<=65535);
const url=new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');
assert.equal(Number(url.port),port);
assert.equal(url.pathname,'/whaleu_test');
process.stdout.write(JSON.stringify({version:1,containerId,owner,serverAddress,host:'127.0.0.1',port,database:'whaleu_test'}));
JS
)"
[[ -n "$TEST_READING_DOCKER_TARGET" ]] || exit 1
export NODE_ENV=production
# The existing official image host authentication requires a real password.
export TEST_READING_LOGIN_AUTH=password
export NODE_EXTRA_CA_CERTS="$state/ca.crt"
# Positive TLS/identity evidence. Connection parameters never go to stdout.
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { Pool } from 'pg';
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000});
try { const {rows}=await pool.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()'); assert.equal(rows[0]?.ssl,true); assert.match(rows[0]?.version??'',/^TLSv1\.[23]$/); } finally {await pool.end();}
JS
# Negative CA admission is a separate process without this per-process CA trust.
env -u NODE_EXTRA_CA_CERTS node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { Pool } from 'pg';
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000});
try { await assert.rejects(async()=>{const client=await pool.connect();client.release();},error=>['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code)); } finally {await pool.end();}
JS
npm run test:source-manual:production
npm run test:reading-worker:production -w @whaleu/api
