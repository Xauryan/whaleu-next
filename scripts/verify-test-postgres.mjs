/** Read-only admission for a newly started, disposable controlled-maintenance service. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function controlledTestDatabase(env) {
  assert.equal(env.NODE_ENV, 'test', 'Explicit NODE_ENV=test required');
  assert.equal(
    env.WHALEU_TEST_MAINTENANCE,
    'controlled',
    'Explicit test maintenance mode required',
  );
  const url = new URL(env.TEST_DATABASE_URL);
  assert.equal(url.protocol, 'postgresql:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(url.username, 'whaleu_test');
  assert.equal(url.search, '', 'Connection-option overrides are not accepted');
  return url.href;
}

export async function verifyControlledTestPostgres(env = process.env) {
  const client = new pg.Client({
    connectionString: controlledTestDatabase(env),
    application_name: 'controlled-test-admission',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    await client.connect();
    const {
      rows: [state],
    } = await client.query(`SELECT
      current_database() database, current_user principal,
      host(inet_server_addr()) address,
      current_setting('server_version_num')::integer version,
      current_setting('track_counts') track_counts,
      current_setting('autovacuum_freeze_max_age')::integer freeze_max_age,
      current_setting('autovacuum_multixact_freeze_max_age')::integer multixact_freeze_max_age,
      (SELECT setting FROM pg_settings WHERE name='autovacuum') autovacuum,
      (SELECT source FROM pg_settings WHERE name='autovacuum') autovacuum_source,
      EXTRACT(EPOCH FROM clock_timestamp()-pg_postmaster_start_time())::float8 uptime_seconds,
      (SELECT max(age(datfrozenxid)) FROM pg_database)::integer xid_age,
      (SELECT max(mxid_age(datminmxid)) FROM pg_database)::integer mxid_age,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\') application_schemas,
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','m','f')) public_tables,
      (SELECT count(*)::integer FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') other_clients,
      (SELECT count(*)::integer FROM pg_stat_activity WHERE backend_type='autovacuum worker') maintenance_workers`);
    assert.equal(state.database, 'whaleu_test');
    assert.equal(state.principal, 'whaleu_test');
    assert.ok(['127.0.0.1', '::1'].includes(state.address));
    assert.equal(state.version, 180006, 'Pinned PostgreSQL 18.6 required');
    assert.equal(state.track_counts, 'on');
    assert.equal(state.freeze_max_age, 200000000);
    assert.equal(state.multixact_freeze_max_age, 400000000);
    assert.equal(state.autovacuum, 'off');
    assert.equal(
      state.autovacuum_source,
      'command line',
      'No persistent configuration changes',
    );
    assert.ok(
      state.uptime_seconds >= 0 && state.uptime_seconds < 900,
      'Freshly started service required',
    );
    assert.ok(
      state.xid_age >= 0 && state.xid_age < 10000,
      'Fresh cluster transaction age required',
    );
    assert.ok(
      state.mxid_age >= 0 && state.mxid_age < 10000,
      'Fresh cluster multixact age required',
    );
    assert.equal(state.application_schemas, 0);
    assert.equal(state.public_tables, 0);
    assert.equal(state.other_clients, 0);
    assert.equal(state.maintenance_workers, 0);
    // Only metadata; never output the connection URL or credentials.
    process.stdout.write(
      `${JSON.stringify({ controlledTestDatabase: state })}\n`,
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyControlledTestPostgres();
