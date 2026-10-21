import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAccountPolicyCaptureSources as collect } from './check-account-policy-sql.mjs';

const relation = 'whaleu_profile.cover_edits';
const receipt = 'whaleu_profile.cover_command_receipts';
const create = (
  table = relation,
  trigger = 'account_policy_consumer_capture',
) =>
  `CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION whaleu_safety.account_policy_consumer_capture();`;
const migration = (sql, name = '0001_test.sql') => ({ name, sql });

test('capture inventory includes later migration owners in sorted exact relation order', () => {
  assert.deepEqual(
    collect([
      migration(create(receipt), '0163_cover.sql'),
      migration(create(), '0136_baseline.sql'),
    ]),
    [receipt, relation],
  );
});

test('capture inventory retains supported INSERT OR UPDATE row captures', () => {
  assert.deepEqual(
    collect([
      migration(create().replace('AFTER INSERT', 'AFTER INSERT OR UPDATE')),
    ]),
    [relation],
  );
});

test('capture inventory rejects duplicate migration filenames and duplicate source triggers', () => {
  assert.throws(
    () => collect([migration(create()), migration(create(receipt))]),
    /Duplicate migration name/,
  );
  for (const trigger of [
    'account_policy_consumer_capture',
    'alternate_capture',
  ]) {
    assert.throws(
      () => collect([migration(create() + create(relation, trigger))]),
      /Duplicate capture source/,
    );
  }
});

test('capture inventory applies exact trigger drops and allows a later explicit recreation', () => {
  const drop = `DROP TRIGGER account_policy_consumer_capture ON ${relation};`;
  assert.deepEqual(
    collect([migration(create()), migration(drop, '0002_drop.sql')]),
    [],
  );
  assert.deepEqual(
    collect([
      migration(create()),
      migration(drop + create(), '0002_replace.sql'),
    ]),
    [relation],
  );
});

test('capture deletion changes the exact set rather than preserving the historical owner', () => {
  const actual = collect([
    migration(create() + create(receipt)),
    migration(
      `DROP TRIGGER IF EXISTS account_policy_consumer_capture ON ${relation} RESTRICT;`,
      '0002_drop.sql',
    ),
  ]);
  assert.deepEqual(actual, [receipt]);
  assert.throws(
    () => assert.deepEqual(actual, [receipt, relation]),
    assert.AssertionError,
  );
});

test('untracked or repeated capture drops fail closed even with IF EXISTS', () => {
  for (const optional of ['', 'IF EXISTS ']) {
    assert.throws(
      () =>
        collect([
          migration(
            `DROP TRIGGER ${optional}account_policy_consumer_capture ON ${relation};`,
          ),
        ]),
      /Untracked capture DROP/,
    );
  }
  assert.throws(
    () =>
      collect([
        migration(
          create() +
            `DROP TRIGGER account_policy_consumer_capture ON ${relation}; DROP TRIGGER IF EXISTS account_policy_consumer_capture ON ${relation};`,
        ),
      ]),
    /Untracked capture DROP/,
  );
});

test('unrelated trigger drops cannot remove a capture registry entry', () => {
  assert.deepEqual(
    collect([
      migration(
        create() + `DROP TRIGGER IF EXISTS unrelated_guard ON ${relation};`,
      ),
    ]),
    [relation],
  );
});

test('comments and quoted SQL literals do not manufacture capture sources', () => {
  const sql = `-- ${create(receipt)}\n/* outer /* nested */ ${create(receipt)} */\nSELECT '${create(receipt)}'; SELECT E'escaped\\'quote;'; ${create()}`;
  assert.deepEqual(collect([migration(sql)]), [relation]);
});

test('unsupported timing, row shape, conditions and replacement syntax fail closed', () => {
  for (const sql of [
    create().replace('AFTER INSERT', 'BEFORE INSERT'),
    create().replace('FOR EACH ROW', 'FOR EACH STATEMENT'),
    create().replace('EXECUTE FUNCTION', 'WHEN (true) EXECUTE FUNCTION'),
    create().replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER'),
    create().replace('EXECUTE FUNCTION', 'EXECUTE PROCEDURE'),
    create().replace(
      'whaleu_safety.account_policy_consumer_capture',
      '"whaleu_safety" . "account_policy_consumer_capture"',
    ),
  ]) {
    assert.throws(
      () => collect([migration(sql)]),
      /Unsupported capture CREATE/,
    );
  }
});

test('redirecting a known capture trigger to another function fails closed', () => {
  const redirected = create()
    .replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER')
    .replace(
      'whaleu_safety.account_policy_consumer_capture()',
      'whaleu_safety.other_guard()',
    );
  assert.throws(
    () => collect([migration(create() + redirected)]),
    /redirected or replaced/,
  );
});

test('dynamic capture DDL is rejected rather than guessed or silently ignored', () => {
  for (const sql of [
    `DO $$ BEGIN EXECUTE '${create()}'; END $$;`,
    `DO $$ BEGIN EXECUTE 'DROP TRIGGER account_policy_consumer_capture ON ${relation}'; END $$;`,
  ]) {
    assert.throws(() => collect([migration(sql)]), /Dynamic capture DDL/);
  }
  assert.throws(
    () =>
      collect([
        migration(
          create(relation, 'alternate_capture') +
            `DO $$ BEGIN EXECUTE 'DROP TRIGGER alternate_capture ON ${relation}'; END $$;`,
        ),
      ]),
    /Dynamic capture DDL/,
  );
});

test('implicit deletion of a captured table, schema or function requires explicit review', () => {
  for (const sql of [
    `DROP TABLE ${relation};`,
    `DROP TABLE IF EXISTS ${relation} CASCADE;`,
    'DROP SCHEMA whaleu_profile CASCADE;',
    'DROP FUNCTION whaleu_safety.account_policy_consumer_capture() CASCADE;',
    'DROP OWNED BY whaleu_test CASCADE;',
  ]) {
    assert.throws(
      () => collect([migration(create() + sql)]),
      /Implicit capture deletion/,
    );
  }
  assert.deepEqual(
    collect([
      migration(create() + 'DROP TABLE whaleu_profile.cover_edits_archive;'),
    ]),
    [relation],
  );
});

test('unsupported capture relation renames and disable operations fail closed', () => {
  for (const sql of [
    `ALTER TABLE ${relation} RENAME TO replaced;`,
    `ALTER TABLE ${relation} DISABLE TRIGGER ALL;`,
    `ALTER TRIGGER account_policy_consumer_capture ON ${relation} RENAME TO replaced;`,
  ]) {
    assert.throws(
      () => collect([migration(create() + sql)]),
      /Unsupported capture lifecycle/,
    );
  }
});

test('unterminated comments, quotes and dollar bodies cannot hide later capture DDL', () => {
  for (const sql of [
    "SELECT 'unfinished",
    'DO $$ unfinished',
    '/* unfinished',
  ]) {
    assert.throws(() => collect([migration(sql)]), /Unterminated SQL/);
  }
});
