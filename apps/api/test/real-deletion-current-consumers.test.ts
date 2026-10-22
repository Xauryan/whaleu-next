import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApplicationError } from '../src/http/application-error.js';
import { preparationCatalogBody } from '../src/account-deletion/real/catalog.js';
import { requestCatalogBody } from '../src/account-deletion/real/request-catalog.js';
import { inspectPreparationSchema } from '../src/account-deletion/real/qualification.js';
import { inspectRequestSchema } from '../src/account-deletion/real/request-qualification.js';
import {
  historicalRealRequestAbsenceSql,
  historicalRealRequestPartials,
} from './support/historical-real-request-absence.js';
import { restoreAcceptedHistoricalConfig } from './support/historical-lifecycle-identity/config-compatibility.js';

const configInput = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
};
const ring = JSON.stringify({
  version: 1,
  activeEpoch: 'synthetic',
  keys: [{ epoch: 'synthetic', keyHex: '11'.repeat(32) }],
});
test('0182 new-request configuration is closed by default and never establishes an admission owner', () => {
  assert.equal(
    loadConfig(configInput).REAL_ACCOUNT_DELETION_NEW_REQUESTS,
    'disabled',
  );
  for (const input of [
    {},
    { REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only' },
    { IDENTITY_DELETION_DIGEST_KEYRING: ring },
  ])
    assert.throws(
      () =>
        loadConfig({
          ...configInput,
          ...input,
          REAL_ACCOUNT_DELETION_NEW_REQUESTS: 'qualified_owner',
        }),
      /New real requests require preparation entry and IDENTITY_DELETION_DIGEST_KEYRING; these do not qualify an admission owner/,
    );
  const configured = loadConfig({
    ...configInput,
    REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only',
    REAL_ACCOUNT_DELETION_NEW_REQUESTS: 'qualified_owner',
    IDENTITY_DELETION_DIGEST_KEYRING: ring,
  });
  assert.equal(
    configured.REAL_ACCOUNT_DELETION_NEW_REQUESTS,
    'qualified_owner',
  );
  for (const value of ['', 'enabled', 'true', 'erase', 'automatic'])
    assert.throws(
      () =>
        loadConfig({
          ...configInput,
          REAL_ACCOUNT_DELETION_NEW_REQUESTS: value,
        }),
      /Invalid configuration fields: REAL_ACCOUNT_DELETION_NEW_REQUESTS/,
    );
});

test('exact0182 config restoration rejects changed, duplicated and missing request spans', async () => {
  const source = await readFile(
    new URL('../src/config/config.ts', import.meta.url),
    'utf8',
  );
  restoreAcceptedHistoricalConfig(Buffer.from(source));
  for (const changed of [
    source.replace(
      ".enum(['disabled', 'qualified_owner'])",
      ".enum(['disabled', 'enabled'])",
    ),
    source.replace(
      "config.REAL_ACCOUNT_DELETION_NEW_REQUESTS === 'qualified_owner'",
      "config.REAL_ACCOUNT_DELETION_NEW_REQUESTS === 'disabled'",
    ),
    source.replace('  REAL_ACCOUNT_DELETION_NEW_REQUESTS: z\n', ''),
    source.replace(
      '  REAL_ACCOUNT_DELETION_NEW_REQUESTS: z\n',
      '  REAL_ACCOUNT_DELETION_NEW_REQUESTS: z\n  REAL_ACCOUNT_DELETION_NEW_REQUESTS: z\n',
    ),
    source + '\n',
  ]) {
    assert.notEqual(changed, source);
    assert.throws(() => restoreAcceptedHistoricalConfig(Buffer.from(changed)));
  }
});

const seal = 'f'.repeat(64);
for (const kind of ['preparation', 'request'] as const) {
  const expected: Record<string, unknown> =
    kind === 'preparation'
      ? {
          version: 2,
          protocol: 'real-account-deletion-preparation-v2',
          migration: '0182_real_deletion_request_authority.sql',
          acceptance: 'unavailable',
          catalog: seal,
        }
      : {
          version: 1,
          protocol: 'real-account-deletion-request-v1',
          migration: '0182_real_deletion_request_authority.sql',
          admission: 'separate_owner_required',
          catalog: seal,
        };
  const inspect =
    kind === 'preparation' ? inspectPreparationSchema : inspectRequestSchema;
  const fixture = (protocol: Record<string, unknown>, bodySuffix = '') => {
    let catalogReads = 0;
    const tx = {
      async query(sql: string) {
        if (sql.includes(`real-${kind}-schema-metadata-v1`))
          return {
            rows: [
              {
                catalogFunction: {
                  body:
                    (kind === 'preparation'
                      ? preparationCatalogBody
                      : requestCatalogBody) + bodySuffix,
                  invoker: true,
                  sql: true,
                  config: ['search_path=pg_catalog'],
                  scalar: true,
                  safe: true,
                  stable: true,
                },
                marker: {
                  body: `SELECT '${JSON.stringify(protocol)}'::jsonb`,
                  invoker: true,
                  sql: true,
                  config: ['search_path=pg_catalog'],
                  scalar: true,
                  safe: true,
                  immutable: true,
                  sameOwner: true,
                },
              },
            ],
          };
        assert.equal(
          sql,
          `SELECT whaleu_real_deletion.${kind}_catalog() catalog`,
        );
        catalogReads++;
        return { rows: [{ catalog: seal }] };
      },
    } as unknown as PoolClient;
    return { tx, reads: () => catalogReads };
  };
  test(`0182 ${kind} qualifier requires the full exact protocol, not a partial marker`, async () => {
    const good = fixture(expected);
    assert.equal(await inspect(good.tx), seal);
    assert.equal(good.reads(), 1);
    const invalid: Record<string, unknown>[] = [{ ...expected, extra: true }];
    for (const field of Object.keys(expected)) {
      const missing = { ...expected };
      delete missing[field];
      invalid.push(
        missing,
        { ...expected, [field]: null },
        { ...expected, [field]: 'unknown' },
      );
    }
    invalid.push({
      ...expected,
      migration: '0181_identity_real_deletion_preparations.sql',
    });
    for (const protocol of invalid) {
      const bad = fixture(protocol);
      await assert.rejects(
        inspect(bad.tx),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'REAL_DELETION_UNAVAILABLE',
      );
      assert.equal(
        bad.reads(),
        0,
        'Invalid metadata must not invoke the collector',
      );
    }
    await assert.rejects(
      inspect(fixture(expected, '\n').tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'REAL_DELETION_UNAVAILABLE',
    );
  });
}

test('0182 historical sentinel covers exact newly installed identities without touching0180/0181', async () => {
  const sql = await readFile(
    new URL(
      '../migrations/0182_real_deletion_request_authority.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    createHash('sha256').update(sql).digest('hex'),
    '9c0e6e4f38179aa4d928bbdba7cb8d30150c894df96700b2401091f1df533c62',
  );
  assert.deepEqual(
    [...sql.matchAll(/CREATE SCHEMA ([a-z_]+);/g)].map((m) => m[1]),
    ['whaleu_real_deletion_admission'],
  );
  assert.deepEqual(
    [
      ...sql.matchAll(
        /ALTER TABLE (whaleu_identity\.[a-z_]+) ADD COLUMN ([a-z_]+)/g,
      ),
    ].map((m) => [m[1], m[2]]),
    [['whaleu_identity.accounts', 'real_deletion_request_id']],
  );
  assert.deepEqual(
    [
      ...sql.matchAll(
        /ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT ([a-z_]+)/g,
      ),
    ].map((m) => m[1]),
    ['deletion_authority_unambiguous'],
  );
  assert.deepEqual(
    [
      ...sql.matchAll(
        /CREATE (?:CONSTRAINT )?TRIGGER ([a-z_]+)[^;]*? ON whaleu_identity.accounts\s/g,
      ),
    ].map((m) => m[1]),
    ['real_deletion_pointer', 'real_deletion_account_complete'],
  );
  assert.equal(historicalRealRequestPartials.length, 6);
  for (const identity of [
    'whaleu_real_deletion_admission',
    'whaleu_identity.accounts',
    'real_deletion_request_id',
    'deletion_authority_unambiguous',
    'accounts_real_deletion_request_id_fkey',
    'real_deletion_pointer',
    'real_deletion_account_complete',
  ])
    assert.ok(historicalRealRequestAbsenceSql.includes(`'${identity}'`));
  assert.doesNotMatch(
    historicalRealRequestAbsenceSql,
    /LIKE|starts_with|regexp|GRANT|ALTER|CREATE|schema_migrations/,
  );
  for (const [, statement] of historicalRealRequestPartials)
    assert.doesNotMatch(
      statement,
      /schema_migrations|GRANT|session_epoch|session_replication_role|DISABLE TRIGGER/,
    );
});
