import { officialCanonicalDigest } from '../src/official-account-operations/profile.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OFFICIAL_PROFILE,
  scalarExcerpt,
  scalarTitle,
  escapeOfficialLiteral,
  compareOfficialScore,
  officialLiteral,
  boundedOfficialJson,
} from '../src/official-account-operations/profile.js';
test('official profile is bounded synthetic policy, unicode truncates before escape', () => {
  assert.equal(OFFICIAL_PROFILE.examined, 128);
  assert.equal(OFFICIAL_PROFILE.maintenanceMs, 20000);
  assert.equal(
    OFFICIAL_PROFILE.maintenanceBatches * OFFICIAL_PROFILE.batch,
    128,
  );
  assert.equal([...scalarExcerpt('😀'.repeat(61))].length, 61);
  assert.equal([...scalarTitle('😀'.repeat(51))].length, 50);
  assert.equal([...scalarTitle('😀'.repeat(51), true)].length, 54);
  assert.equal(
    escapeOfficialLiteral(scalarExcerpt('<'.repeat(61))),
    '&lt;'.repeat(60) + '…',
  );
  assert.equal(officialLiteral(64).safeParse('a'.repeat(64)).success, true);
  assert.equal(officialLiteral(64).safeParse('a'.repeat(65)).success, false);
  assert.equal(officialLiteral(64).safeParse('\ud800').success, false);
  assert.equal(officialLiteral(64).safeParse('a\0').success, false);
  assert.equal(
    compareOfficialScore('9007199254740992.0001', '9007199254740992.0000'),
    1,
  );
  assert.equal(compareOfficialScore('1.0000', '1.0000'), 0);
  assert.doesNotThrow(() => boundedOfficialJson('a'.repeat(262142)));
  assert.throws(() => boundedOfficialJson('a'.repeat(262143)));
});

test('persisted manifest hashes ignore JSONB object order without changing array order', () => {
  assert.equal(
    officialCanonicalDigest({ b: [{ y: 2, x: 1 }], a: 0 }),
    officialCanonicalDigest({ a: 0, b: [{ x: 1, y: 2 }] }),
  );
  assert.notEqual(
    officialCanonicalDigest([1, 2]),
    officialCanonicalDigest([2, 1]),
  );
});
