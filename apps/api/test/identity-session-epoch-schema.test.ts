import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
} from '../src/identity/session-epoch-contract.js';
const migration = await readFile(
  new URL(
    '../migrations/0180_identity_session_revocation_epoch.sql',
    import.meta.url,
  ),
  'utf8',
);
test('epoch trigger bodies and closed marker are exactly the runtime-qualified constants', () => {
  for (const body of [
    sessionEpochAccountBody,
    sessionEpochIssuedBody,
    sessionEpochMarkerBody,
  ])
    assert.ok(migration.includes('$epoch$' + body + '$epoch$'));
  assert.match(
    sessionEpochAccountBody,
    /NEW\.session_revocation_epoch IS DISTINCT FROM 0::bigint/,
  );
  assert.match(
    sessionEpochAccountBody,
    /NEW\.session_revocation_epoch IS DISTINCT FROM OLD\.session_revocation_epoch/,
  );
  assert.match(
    sessionEpochIssuedBody,
    /NEW\.id,NEW\.account_id,NEW\.issued_revocation_epoch/,
  );
  assert.match(sessionEpochIssuedBody, /FOR SHARE NOWAIT/);
  assert.match(sessionEpochMarkerBody, /"bumpAuthority":"unavailable"/);
});
test('successor qualifies all 22 exact prior signatures before preserving their bodies and adding equality', () => {
  assert.equal((migration.match(/DO \$qualify\$/g) ?? []).length, 22);
  assert.equal(
    (migration.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length,
    22,
  );
  assert.equal((migration.match(/AND p\.prosrc=\$prior\$/g) ?? []).length, 22);
  assert.equal(
    (migration.match(/p\.oid=to_regprocedure\('/g) ?? []).length,
    22,
  );
  assert.equal(
    (migration.match(/p\.proargnames IS NOT DISTINCT FROM/g) ?? []).length,
    22,
  );
  assert.match(migration, /pg_get_expr\(p\.proargdefaults,0\)='NULL::uuid'/);
  assert.match(migration, /0179_identity_registration_guard\.sql/);
  assert.doesNotMatch(
    migration,
    /GRANT |SECURITY DEFINER|DISABLE TRIGGER|SET session_revocation_epoch|UPDATE whaleu_identity\.accounts/,
  );
});
test('runtime qualification includes trigger event columns and fixed body byte ceilings', async () => {
  const source = await readFile(
    new URL('../src/identity/session-epoch.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /t\.tgattr=''::int2vector/);
  assert.match(source, /t\.tgoldtable IS NULL AND t\.tgnewtable IS NULL/);
  assert.match(source, /octet_length\(p\.prosrc\)<=4096/);
  assert.match(source, /octet_length\(c\.conbin::text\)<=512/);
  assert.match(source, /c\.convalidated AND c\.conenforced/);
  assert.doesNotMatch(source, /MAINTAIN|LOCK TABLE|Number\(/);
});
