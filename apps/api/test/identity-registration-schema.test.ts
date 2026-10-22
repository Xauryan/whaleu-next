import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { retainRegistrationSchema } from '../src/identity/registration/readiness.js';
import {
  registrationCatalogBody,
  registrationCatalogBodySha256,
} from '../src/identity/registration/catalog.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  registrationGuardTablePrivileges,
  registrationGuardColumnPrivileges,
  registrationGuardFunctionPrivileges,
} from '../src/identity/registration/role-contract.js';
import { registrationSchemaFixture } from './support/registration-schema-fixture.js';
const denied = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'AUTH_NOT_CONFIGURED';

test('0179 catalog body is pinned exactly, excludes data and includes finite relations and causal schema', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0179_identity_registration_guard.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    sql.split('AS $catalog$')[1]?.split('$catalog$;')[0],
    registrationCatalogBody,
  );
  assert.equal(
    createHash('sha256').update(registrationCatalogBody).digest('hex'),
    registrationCatalogBodySha256,
  );
  for (const token of [
    'registration_guard_policy',
    'registration_guard_key_epochs',
    'registration_guards',
    'attisdropped',
    'convalidated',
    'conenforced',
    'tgisinternal',
    'unexpected-function',
    'LIMIT 129',
    'count(*)<=128',
    'max(bytes),0)<=32768',
    'sum(bytes),0)+greatest(count(*)-1,0)*2+2<=262144',
    'bool_and(NOT oversized)',
    'octet_length(c.reloptions::text)>16384',
    'octet_length(ic.reloptions::text)>16384',
    'ix.indexrelid IS NULL OR ix.source_oversized',
    'CASE WHEN i.source_oversized THEN NULL ELSE pg_get_indexdef',
    'indisvalid',
    'tgenabled',
    'p.prosrc',
    'unexpected-relation',
  ])
    assert.ok(registrationCatalogBody.includes(token));
  assert.ok(
    registrationCatalogBody.includes(
      "p.oid IS DISTINCT FROM to_regprocedure('whaleu_identity.registration_guard_protocol()')::oid",
    ),
  );
  assert.equal(
    registrationCatalogBody.includes('AND NOT t.tgisinternal'),
    false,
  );
  assert.equal(registrationCatalogBody.includes('pg_get_functiondef'), false);
  assert.match(sql, /0178_home_publication_protocol.sql/);
  assert.match(
    sql,
    /Registration guard namespace must be absent before installation/,
  );
  assert.equal(sql.includes('ALTER TABLE whaleu_account_deletion'), false);
});

function fixture(
  mutate: (sql: string, result: { rows: unknown[] }) => void = () => undefined,
) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      const result = registrationSchemaFixture(sql);
      assert.ok(result, 'Unknown statement ' + sql);
      mutate(sql, result);
      return result;
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, queries };
}

test('required schema proof survives until post-deferred finalization within existing 100/500 budgets', async () => {
  const f = fixture();
  try {
    await retainRegistrationSchema(f.tx);
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.queries.filter((q) => q.sql.includes('registration-schema-metadata-v1'))
        .length,
      2,
    );
    assert.ok(
      f.queries.findIndex((q) => q.sql === 'SET CONSTRAINTS ALL IMMEDIATE') <
        f.queries.findLastIndex((q) =>
          q.sql.includes('pg_try_advisory_xact_lock_shared'),
        ),
    );
    assert.match(
      f.queries.find((q) => q.sql.includes('pg_try_advisory_xact_lock_shared'))!
        .sql,
      /pg_try_advisory_xact_lock_shared/,
    );
    assert.ok(
      f.queries
        .filter((q) => q.sql.startsWith('SELECT set_config'))
        .some((q) => q.values[0] === '100ms' && q.values[1] === '1ms'),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('unmanaged clients cannot silently omit the final schema proof', async () => {
  const tx = {} as PoolClient;
  await assert.rejects(retainRegistrationSchema(tx), denied);
});

for (const failure of [
  'missing-metadata',
  'changed-body',
  'oversized-body',
  'budget-overflow',
  'security-definer',
  'unknown-marker',
  'catalog-drift',
] as const)
  test('schema qualification rejects ' + failure, async () => {
    const f = fixture((sql, result) => {
      if (sql.includes('registration-schema-metadata-v1')) {
        const row = result.rows[0] as {
          catalogFunction: { body: string; invoker: boolean };
          marker: { body: string };
        };
        if (failure === 'missing-metadata') result.rows = [];
        if (failure === 'changed-body') row.catalogFunction.body += ' -- drift';
        if (failure === 'oversized-body')
          row.catalogFunction.body = 'x'.repeat(16385);
        if (failure === 'security-definer') row.catalogFunction.invoker = false;
        if (failure === 'unknown-marker')
          row.marker.body = `SELECT '{}'::jsonb`;
      }
      if (
        failure === 'catalog-drift' &&
        sql === 'SELECT whaleu_identity.registration_guard_catalog() catalog'
      )
        result.rows = [{ catalog: 'b'.repeat(64) }];
      if (
        failure === 'budget-overflow' &&
        sql === 'SELECT whaleu_identity.registration_guard_catalog() catalog'
      )
        result.rows = [{ catalog: null }];
    });
    try {
      await assert.rejects(retainRegistrationSchema(f.tx), denied);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  });

test('schema mutation or lock contention after initial admission rejects at final proof', async () => {
  for (const cause of ['drift', 'lock'] as const) {
    let finalized = false;
    const f = fixture((sql, result) => {
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') finalized = true;
      if (
        finalized &&
        cause === 'lock' &&
        sql.includes('pg_try_advisory_xact_lock_shared')
      )
        result.rows = [{ locked: false }];
      if (
        finalized &&
        cause === 'drift' &&
        sql === 'SELECT whaleu_identity.registration_guard_catalog() catalog'
      )
        result.rows = [{ catalog: 'b'.repeat(64) }];
    });
    try {
      await retainRegistrationSchema(f.tx);
      await assert.rejects(checkTransactionDeadlines(f.tx), denied);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('registration privilege contract rejects broad table mutation and MAINTAIN capabilities', () => {
  assert.deepEqual(registrationGuardTablePrivileges, [
    {
      relation: 'whaleu_identity.registration_guard_policy',
      privilege: 'SELECT',
    },
    {
      relation: 'whaleu_identity.registration_guard_key_epochs',
      privilege: 'SELECT',
    },
    { relation: 'whaleu_identity.registration_guards', privilege: 'SELECT' },
  ]);
  assert.deepEqual(registrationGuardColumnPrivileges, [
    {
      relation: 'whaleu_identity.registration_guard_policy',
      column: 'slot',
      privilege: 'UPDATE',
    },
    {
      relation: 'whaleu_identity.registration_guard_key_epochs',
      column: 'epoch',
      privilege: 'UPDATE',
    },
  ]);
  assert.deepEqual(registrationGuardFunctionPrivileges, [
    'whaleu_identity.registration_guard_catalog()',
  ]);
  assert.ok(
    registrationGuardTablePrivileges.every(
      (grant) => grant.privilege === 'SELECT',
    ),
  );
});
