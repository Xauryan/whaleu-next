import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  accountDeletionCapability,
  INVENTORY_VERSION,
  ownerKeys,
} from '../src/account-deletion/contracts.js';

const readMigration = (name: string) =>
  readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
const oldName = '0173_account_deletion_follow_social.sql';
const newName = '0174_account_deletion_inventory_collation.sql';
const currentFunction = (sql: string) => {
  const body = sql.match(
    /CREATE OR REPLACE FUNCTION whaleu_account_deletion\.inventory_current\(request uuid\)[\s\S]*?END\$\$;/,
  )?.[0];
  assert.ok(body);
  return body;
};

test('0174 keeps immutable 0173 bytes and changes exactly four identifier sorts', async () => {
  const old = await readMigration(oldName);
  assert.equal(
    createHash('sha256').update(old).digest('hex'),
    'c5061212477b697bc16dd1e7da5f7b9f16d977782b39d07800d6362180013c53',
  );
  const next = currentFunction(await readMigration(newName));
  assert.equal((next.match(/COLLATE "C"/g) ?? []).length, 4);
  const reverted = next
    .replaceAll(
      'ORDER BY (n.nspname||\'.\'||c.relname) COLLATE "C"',
      "ORDER BY n.nspname||'.'||c.relname",
    )
    .replaceAll('ORDER BY relation COLLATE "C"', 'ORDER BY relation');
  assert.equal(reverted, currentFunction(old));
});

test('0174 retains the entire structural aggregate and adds only a qualified function profile', async () => {
  const old = await readMigration(oldName);
  const next = await readMigration(newName);
  const previous = old.match(
    /CREATE FUNCTION whaleu_account_deletion\.coordinator_shape\(\)[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(previous);
  const aggregate = previous.match(
    /json_hash\((coalesce\([\s\S]*?'\[\]'::jsonb\))\)\s+(FROM[\s\S]*?)\s*\$\$;/,
  );
  assert.ok(aggregate);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  assert.ok(
    normalize(next).includes(
      normalize(`'relations',(SELECT ${aggregate[1]} ${aggregate[2]})`),
    ),
  );
  assert.match(next, /account-deletion-inventory-order-0174-v1/);
  assert.match(next, /SET search_path=pg_catalog,pg_temp/);
  assert.match(
    next,
    /SET quote_all_identifiers=off SET IntervalStyle=postgres/,
  );
  assert.match(next, /inventory_current\(pg_catalog\.uuid\)'::regprocedure/);
  for (const field of [
    'prosrc',
    'prolang',
    'prokind',
    'provolatile',
    'proparallel',
    'proisstrict',
    'prosecdef',
    'proleakproof',
    'proretset',
    'proargnames',
    'proargmodes',
    'proconfig',
    'procost',
    'prorows',
  ])
    assert.ok(next.includes(`p.${field}`), field);
  for (const predicate of [
    "l.lanname='plpgsql'",
    'p.probin IS NULL',
    'p.prosqlbody IS NULL',
    'p.proargdefaults IS NULL',
    'p.pronargdefaults=0',
    'p.prosupport=0',
    'p.protrftypes IS NULL',
    'p.provariadic=0',
  ])
    assert.ok(next.includes(predicate), predicate);
  assert.doesNotMatch(
    next,
    /pg_get_functiondef|pg_get_function_identity_arguments/,
  );
  assert.equal((next.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
  assert.doesNotMatch(
    next,
    /CREATE TABLE|ALTER TABLE|INSERT INTO|UPDATE whaleu_|DELETE FROM|DISABLE TRIGGER|session_replication_role/,
  );
  assert.equal(INVENTORY_VERSION, 'account-deletion-local-0173-v1');
  assert.equal(ownerKeys.length, 7);
  assert.equal(accountDeletionCapability().status, 'unavailable');
});
