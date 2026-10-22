import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { historicalRealDeletionAbsenceSql } from './support/historical-real-deletion-absence.js';
import {
  historicalRealDeletionPartials,
  historicalRealDeletionLookalikeSql,
} from './support/historical-real-deletion-partials.js';

const sha = (source: string) =>
  createHash('sha256').update(source).digest('hex');
const expectedFunctions = [
  'preparation_guard',
  'preparation_unavailable',
  'preparation_catalog',
  'preparation_protocol',
];
const expectedTriggers = ['preparation_guard', 'preparation_no_truncate'];

test('0181 object identities all require its exact new namespace; original migration bytes stay pinned', async () => {
  const migration = await readFile(
    new URL(
      '../migrations/0181_identity_real_deletion_preparations.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    sha(migration),
    '573a6d858e47ff10bd287ec5d7ce18f1724708422c6373d7f2f6cdd8b08fc8aa',
  );
  assert.deepEqual(
    [...migration.matchAll(/CREATE SCHEMA ([a-z_]+);/g)].map((m) => m[1]),
    ['whaleu_real_deletion'],
  );
  assert.deepEqual(
    [...migration.matchAll(/CREATE TABLE ([a-z_.]+)\(/g)].map((m) => m[1]),
    ['whaleu_real_deletion.preparations'],
  );
  assert.deepEqual(
    [...migration.matchAll(/CREATE FUNCTION ([a-z_.]+)\(/g)].map((m) => m[1]),
    expectedFunctions.map((name) => `whaleu_real_deletion.${name}`),
  );
  assert.deepEqual(
    [
      ...migration.matchAll(/CREATE TRIGGER ([a-z_]+)[^;]*? ON ([a-z_.]+)\s/g),
    ].map((m) => [m[1], m[2]]),
    expectedTriggers.map((name) => [name, 'whaleu_real_deletion.preparations']),
  );
  assert.doesNotMatch(migration, /\bALTER TABLE\b|\bCREATE TYPE\b/);
});

// Structural witness only: PostgreSQL integration owns actual catalog results.
// Parse the entire predicate so a broad prefix or missing clause cannot silently
// keep this source-level negative control green.
function absentNamespace(sql: string, namespaces: readonly string[]) {
  const match = sql.match(
    /^NOT EXISTS \(SELECT 1 FROM pg_namespace WHERE nspname='([a-z_]+)'\)$/,
  );
  assert.ok(match, 'Expected one exact namespace absence predicate');
  return !namespaces.includes(match[1]!);
}
test('exact namespace absence preserves predecessor/lookalike namespaces and rejects unledgered0181', () => {
  for (const namespaces of [
    [],
    ['whaleu_identity', 'whaleu_account_deletion'],
    ['whaleu_real_deletion_archive'],
    ['whaleu_real_deletions'],
  ])
    assert.equal(
      absentNamespace(historicalRealDeletionAbsenceSql, namespaces),
      true,
    );
  assert.equal(
    absentNamespace(historicalRealDeletionAbsenceSql, ['whaleu_real_deletion']),
    false,
  );
  const changedOwner = historicalRealDeletionAbsenceSql.replace(
    "nspname='whaleu_real_deletion'",
    "nspname='whaleu_account_deletion'",
  );
  assert.notEqual(changedOwner, historicalRealDeletionAbsenceSql);
  assert.equal(absentNamespace(changedOwner, ['whaleu_real_deletion']), true);
  assert.equal(
    absentNamespace(changedOwner, ['whaleu_account_deletion']),
    false,
  );
  assert.throws(() => absentNamespace('true', ['whaleu_real_deletion']));
  assert.throws(() =>
    absentNamespace(
      "NOT EXISTS (SELECT 1 FROM pg_namespace WHERE starts_with(nspname,'whaleu_real_deletion'))",
      ['whaleu_real_deletion_archive'],
    ),
  );
});

const successors = [
  {
    file: './support/historical-m1/boundary.ts',
    predecessor:
      'f6afa93928978d05814002eacc870470e6b5c62b2af1cbb34fa67a81409f365c',
    additions: [
      "import { historicalRealDeletionAbsenceSql } from '../historical-real-deletion-absence.js';\n",
      '    AND (${historicalRealDeletionAbsenceSql})\n',
    ],
  },
  {
    file: './support/historical-deletion-peer.ts',
    predecessor:
      '7a23b5079b09a0afaaef37f7265d8254299f141b4bc28916f0f8100ed0598f38',
    additions: [
      "import { historicalRealDeletionAbsenceSql } from './historical-real-deletion-absence.js';\n",
      '  AND (${historicalRealDeletionAbsenceSql})\n',
    ],
  },
  {
    file: './support/historical-lifecycle-identity/deletion.ts',
    predecessor:
      '781651a7885d477c3275c61f5bdde25aec3399bad468d1576b8b269fed9c9917',
    additions: [
      "import { historicalRealDeletionAbsenceSql } from '../historical-real-deletion-absence.js';\n",
      '  (${historicalRealDeletionAbsenceSql}) AS real_deletion_absent,\n',
      "          'real_deletion_absent',\n",
    ],
  },
] as const;
function assertOnlyAbsenceSuccessor(
  source: string,
  record: (typeof successors)[number],
) {
  for (const addition of record.additions) {
    assert.equal(source.split(addition).length, 2, addition);
    source = source.replace(addition, '');
  }
  assert.equal(sha(source), record.predecessor, record.file);
}
test('three historical guards add only namespace absence, retaining every predecessor predicate, fence and identity', async () => {
  for (const record of successors) {
    const source = await readFile(
      new URL(record.file, import.meta.url),
      'utf8',
    );
    assertOnlyAbsenceSuccessor(source, record);
    for (const addition of record.additions)
      assert.throws(() =>
        assertOnlyAbsenceSuccessor(source.replace(addition, ''), record),
      );
    // An altered historical destination must still fail the predecessor oracle.
    assert.ok(source.includes("'whaleu_test'"));
    assert.throws(() =>
      assertOnlyAbsenceSuccessor(
        source.replace("'whaleu_test'", "'whaleu_other'"),
        record,
      ),
    );
  }
});

test('partial controls cover empty namespace, sole relation, all four functions and both triggers without ledger edits', () => {
  assert.equal(historicalRealDeletionPartials.length, 8);
  assert.deepEqual(
    historicalRealDeletionPartials.map(([label]) => label),
    [
      'empty namespace',
      'preparations relation',
      ...expectedFunctions.map((name) => `${name} function`),
      ...expectedTriggers.map((name) => `${name} trigger`),
    ],
  );
  for (const [label, statement] of historicalRealDeletionPartials) {
    assert.ok(
      statement.startsWith('CREATE SCHEMA whaleu_real_deletion;'),
      label,
    );
    assert.doesNotMatch(statement, /schema_migrations|ALTER TABLE|GRANT|0181_/);
  }
  assert.match(
    historicalRealDeletionLookalikeSql,
    /CREATE SCHEMA whaleu_real_deletion_archive;/,
  );
  assert.doesNotMatch(
    historicalRealDeletionLookalikeSql,
    /whaleu_real_deletion[.;]/,
  );
});
