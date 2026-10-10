import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  decodeUploadPrepare,
  decodeUploadRecovery,
  decodeUploadStatus,
  uploadRequestHash,
} from '../src/media/upload-contracts';
import {
  grant,
  hash,
  ids,
  notRecorded,
  observed,
  prepare,
  prepared,
  ready,
  recovery,
  terminal,
} from './support/media-upload-fixtures';

test('native request SHA exactly follows v2 server canonical field order and domain separator', () => {
  const canonical = {
    version: 2,
    actorAccountId: ids.actor,
    clientRequestId: prepare.clientRequestId,
    purpose: prepare.purpose,
    draftId: prepare.draftId,
    spaceId: prepare.spaceId,
    slot: prepare.slot,
    ordinal: prepare.ordinal,
    declaration: {
      mime: prepare.declaration.mime,
      bytes: prepare.declaration.bytes,
      sha256: prepare.declaration.sha256,
    },
  };
  assert.equal(
    hash,
    createHash('sha256')
      .update('whaleu-media-request:v2\n' + JSON.stringify(canonical))
      .digest('hex'),
  );
  assert.notEqual(uploadRequestHash(ids.other, prepare), hash);
  assert.notEqual(
    uploadRequestHash(ids.actor, {
      ...prepare,
      declaration: { ...prepare.declaration, sha256: 'b'.repeat(64) },
    }),
    hash,
  );
  assert.equal(
    decodeUploadPrepare(prepare).declaration.sha256,
    prepare.declaration.sha256,
  );
});
for (const extra of [
  'url',
  'headers',
  'formData',
  'key',
  'bearer',
  'grant',
  'localPath',
  'frames',
])
  test(`strict v2 rejects extra ${extra} fields`, () => {
    assert.throws(() =>
      decodeUploadPrepare({ ...prepare, [extra]: 'untrusted' }),
    );
    assert.throws(() => decodeUploadGrant({ ...grant, [extra]: 'untrusted' }));
    assert.throws(() =>
      decodeUploadObserved({ ...observed, [extra]: 'untrusted' }),
    );
    assert.throws(() =>
      decodeUploadStatus({ ...prepared(), [extra]: 'untrusted' }),
    );
  });
test('generation is a bounded PG bigint decimal string, never an unsafe number', () => {
  assert.equal(decodeUploadGrant(grant).generation, '9007199254740993');
  for (const generation of [
    1,
    9007199254740992,
    '0',
    '01',
    '-1',
    '9223372036854775808',
    '1e3',
  ])
    assert.throws(() => decodeUploadGrant({ ...grant, generation }));
  assert.equal(
    decodeUploadGrant({ ...grant, generation: '9223372036854775807' })
      .generation,
    '9223372036854775807',
  );
});
test('strict strategy/fixed method/deadline and observed receipt cannot imply ready', () => {
  for (const patch of [
    { strategy: 'raw-put-v1' },
    { method: 'PUT' },
    { fieldName: 'photo' },
    { maxBytes: 9999999 },
    { grantExpiresAt: grant.serverNow },
    { grantExpiresAt: grant.operationDeadlineAt + 1 },
    { expectedSha256: 'A'.repeat(64) },
  ])
    assert.throws(() => decodeUploadGrant({ ...grant, ...patch }));
  assert.equal(decodeUploadObserved(observed).next, 'finalize');
  assert.throws(() => decodeUploadObserved({ ...observed, status: 'ready' }));
  assert.throws(() => decodeUploadStatus({ ...ready(), bindBefore: 100 }));
  assert.throws(() =>
    decodeUploadRecovery({ ...recovery(terminal()), state: 'active' }),
  );
  assert.throws(() =>
    decodeUploadRecovery({ ...recovery(prepared()), state: 'bound_history' }),
  );
  assert.throws(() =>
    decodeUploadRecovery({ ...notRecorded, requestHash: hash }),
  );
});

test('v2 exact original request rejects uppercase UUIDs rather than silently normalizing identity', () => {
  assert.throws(() =>
    decodeUploadPrepare({
      ...prepare,
      draftId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    }),
  );
  assert.throws(() =>
    uploadRequestHash('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', prepare),
  );
});
