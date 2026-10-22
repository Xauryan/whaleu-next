import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { historicalEpochAbsenceSql } from './support/historical-epoch-absence.js';
import { historicalDeletionPeerCatalogSql } from './support/historical-deletion-peer.js';

const migration = await readFile(
  new URL(
    '../migrations/0180_identity_session_revocation_epoch.sql',
    import.meta.url,
  ),
  'utf8',
);
const expectedColumns = [
  ['whaleu_identity.accounts', 'session_revocation_epoch'],
  ['whaleu_identity.sessions', 'issued_revocation_epoch'],
];
const expectedConstraints = [
  'session_epoch_account_nonnegative',
  'session_epoch_issued_nonnegative',
];
const expectedTriggers = [
  ['whaleu_identity.accounts', 'session_epoch_account'],
  ['whaleu_identity.sessions', 'session_epoch_issued'],
];
const expectedFunctions = [
  'session_epoch_account_guard',
  'session_epoch_issued_guard',
  'session_epoch_protocol',
];

test('historical absence pins every actual new0180 relation/column/constraint/trigger/function identity', () => {
  assert.deepEqual(
    [
      ...migration.matchAll(
        /ALTER TABLE (whaleu_identity\.[a-z_]+) ADD COLUMN ([a-z_]+)/g,
      ),
    ].map((match) => [match[1], match[2]]),
    expectedColumns,
  );
  assert.deepEqual(
    [...migration.matchAll(/CONSTRAINT (session_epoch_[a-z_]+) CHECK/g)].map(
      (match) => match[1],
    ),
    expectedConstraints,
  );
  assert.deepEqual(
    [
      ...migration.matchAll(
        /CREATE TRIGGER (session_epoch_[a-z_]+)[^;]*? ON (whaleu_identity\.[a-z_]+)/g,
      ),
    ].map((match) => [match[2], match[1]]),
    expectedTriggers,
  );
  assert.deepEqual(
    [
      ...migration.matchAll(
        /CREATE FUNCTION whaleu_identity\.(session_epoch_[a-z_]+)\(/g,
      ),
    ].map((match) => match[1]),
    expectedFunctions,
  );
  assert.doesNotMatch(migration, /\bCREATE (?:TABLE|TYPE)\b/);
  for (const [relation, name] of [...expectedColumns, ...expectedTriggers]) {
    assert.ok(historicalEpochAbsenceSql.includes(`'${relation}'`), relation);
    assert.ok(historicalEpochAbsenceSql.includes(`'${name}'`), name);
  }
  for (const name of [...expectedConstraints, ...expectedFunctions])
    assert.ok(historicalEpochAbsenceSql.includes(`'${name}'`), name);
  assert.ok(
    historicalEpochAbsenceSql.includes(
      "p.pronamespace=to_regnamespace('whaleu_identity')",
    ),
  );
  assert.doesNotMatch(historicalEpochAbsenceSql, /LIKE|starts_with|regexp/);
  assert.ok(
    historicalDeletionPeerCatalogSql.includes(historicalEpochAbsenceSql),
  );
});

test('exact175 and174 catalog checks retain the epoch absence conjunction and both table fences', async () => {
  for (const file of [
    './support/historical-m1/boundary.ts',
    './support/historical-deletion-peer.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(source.includes('AND (${historicalEpochAbsenceSql})'), file);
    assert.match(
      source,
      /LOCK TABLE whaleu_identity\.accounts[\s\S]*?whaleu_identity\.sessions[\s\S]*?IN ACCESS SHARE MODE NOWAIT/,
    );
  }
});
