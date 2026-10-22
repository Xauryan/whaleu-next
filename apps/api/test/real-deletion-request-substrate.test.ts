import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  inspectNativeBirthShape,
  nativeBirthShapeSql,
} from '../src/account-deletion/real/native-birth-shape.js';
import {
  preparationCatalogBody,
  preparationCatalogBodySha256,
} from '../src/account-deletion/real/catalog.js';
import {
  requestCatalogBody,
  requestCatalogBodySha256,
} from '../src/account-deletion/real/request-catalog.js';
import {
  beginRealReauthentication,
  cancelRealRequest,
  commitRealAcceptance,
} from '../src/account-deletion/real/request-repository.js';

test('0182 finite collectors are byte-exact between executable migration and runtime qualifiers', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0182_real_deletion_request_authority.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const [name, body, hash] of [
    ['preparation', preparationCatalogBody, preparationCatalogBodySha256],
    ['request', requestCatalogBody, requestCatalogBodySha256],
  ] as const) {
    assert.equal(createHash('sha256').update(body).digest('hex'), hash);
    assert(
      sql.includes(
        `FUNCTION whaleu_real_deletion.${name}_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $catalog$${body}$catalog$`,
      ),
    );
  }
  assert.equal(typeof beginRealReauthentication, 'function');
  assert.equal(typeof cancelRealRequest, 'function');
  assert.equal(typeof commitRealAcceptance, 'function');
});
test('0182 collector owns exact external pointer triggers and retains referenced-index source limits', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0182_real_deletion_request_authority.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const name of [
    'real_deletion_pointer',
    'real_deletion_account_complete',
  ]) {
    assert(sql.includes(`TRIGGER ${name} `));
    assert(requestCatalogBody.includes(`'${name}'`));
  }
  for (const name of [
    'request_guard',
    'verification_complete',
    'account_pointer_guard',
    'account_complete',
  ])
    assert(requestCatalogBody.includes(`whaleu_real_deletion.${name}()`));
  assert(
    requestCatalogBody.includes('SELECT conindid id FROM constraint_sources'),
  );
  assert(
    requestCatalogBody.includes('ix.indexrelid IS NULL OR ix.source_oversized'),
  );
  assert(requestCatalogBody.includes('LIMIT 385'));
  assert(requestCatalogBody.includes('262144'));
});
test('birth shape uses only target-local limited sets and returns no erasure or admission authority', async () => {
  const scope = {
    accountId: '10000000-0000-4000-8000-000000000001',
    sessionId: '10000000-0000-4000-8000-000000000002',
    appId: 'wx0123456789abcdef',
    subject: 'local-test-subject',
  };
  let captured: unknown[] | undefined;
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('set_config(')) return { rows: [] };
      assert.equal(sql, nativeBirthShapeSql);
      captured = values;
      return { rows: [{ valid: true }] };
    },
  } as unknown as PoolClient;
  const result = await inspectNativeBirthShape(client, scope);
  assert.deepEqual(captured, [
    scope.accountId,
    scope.sessionId,
    scope.appId,
    scope.subject,
  ]);
  assert.equal(result.requiresCompleteOwnerCoverage, true);
  assert.equal(result.kind, 'native-birth-shape-only');
  assert.equal(result.rows, 13);
  assert(!JSON.stringify(result).includes(scope.subject));
  // Relative expiry, not equality of unrelated per-row clock_timestamp defaults.
  assert(nativeBirthShapeSql.includes("interval '604200 seconds'"));
  assert(nativeBirthShapeSql.includes("interval '2591400 seconds'"));
  assert(!nativeBirthShapeSql.includes('fixture_accounts'));
  assert(!nativeBirthShapeSql.includes('jsonb_agg'));
  for (const name of [
    'pending_causes',
    'cause_conversions',
    'dependency_events',
  ])
    assert(nativeBirthShapeSql.includes(`whaleu_official.${name}`));
});
test('unknown, null or non-exact birth result fails closed, never coerces truthiness', async () => {
  for (const rows of [
    [],
    [{ valid: null }],
    [{ valid: 'true' }],
    [{ valid: false }],
    [{ valid: true }, { valid: true }],
  ]) {
    const client = {
      async query(sql: string) {
        if (sql.includes("current_setting('transaction_isolation')"))
          return {
            rows: [
              {
                isolation: 'read committed',
                statement_timeout: '0',
                lock_timeout: '0',
              },
            ],
          };
        if (sql.includes('set_config(')) return { rows: [] };
        return { rows };
      },
    } as unknown as PoolClient;
    await assert.rejects(
      inspectNativeBirthShape(client, {
        accountId: '10000000-0000-4000-8000-000000000001',
        sessionId: '10000000-0000-4000-8000-000000000002',
        appId: 'wx0123456789abcdef',
        subject: 'local-test-subject',
      }),
      (e) =>
        e instanceof ApplicationError &&
        e.code === 'REAL_DELETION_SCOPE_UNAVAILABLE',
    );
  }
});

test('0182 preparation cleanup preserves linked evidence and caps retained rows without relaxing the original guard', async () => {
  const [sql, prior, service] = await Promise.all([
    readFile(
      new URL(
        '../migrations/0182_real_deletion_request_authority.sql',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        '../migrations/0181_identity_real_deletion_preparations.sql',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL('../src/account-deletion/real/service.ts', import.meta.url),
      'utf8',
    ),
  ]);
  const oldBody = prior.split('AS $guard$')[1]!.split('$guard$;')[0]!;
  assert(sql.includes('p.prosrc=$prior$' + oldBody + '$prior$'));
  assert(sql.includes('WHERE account_id=a.id LIMIT 64) retained'));
  assert(service.includes('LIMIT 64) limited'));
  assert(
    service.includes(
      'NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.requests r WHERE r.id=p.intent_id)',
    ),
  );
  assert(
    service.includes(
      'NOT EXISTS(SELECT 1 FROM whaleu_real_deletion.reauthentication_attempts a WHERE a.intent_id=p.intent_id)',
    ),
  );
  assert(service.includes('ORDER BY p.expires_at,p.intent_id LIMIT 4'));
  assert(
    sql.includes('CONSTRAINT TRIGGER real_admission_complete AFTER INSERT'),
  );
  const excluded = requestCatalogBody
    .split('WHERE p.oid NOT IN (')[1]!
    .split('\n')[0]!;
  assert.equal(
    excluded,
    "to_regprocedure('whaleu_real_deletion.preparation_protocol()'),to_regprocedure('whaleu_real_deletion.request_protocol()'))",
  );
});
