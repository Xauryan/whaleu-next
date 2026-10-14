import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  officialPreviewRequest,
  officialManualPreview,
  officialDraftCommand,
  officialPublishCommand,
} from '../src/official-account-operations/contracts.js';
import { decodeOfficialJson } from '../src/official-account-operations/http.js';
import { scalarExcerpt } from '../src/official-account-operations/profile.js';
test('strict official requests separate daily, test, manual and publish authority', () => {
  const programId = randomUUID(),
    expectedConfigRevision = 'a'.repeat(64);
  assert.equal(
    officialPreviewRequest.safeParse({
      programId,
      expectedConfigRevision,
      kind: 'daily_hot',
      limit: 30,
    }).success,
    true,
  );
  assert.equal(
    officialPreviewRequest.safeParse({
      programId,
      expectedConfigRevision,
      kind: 'daily_hot',
      limit: 31,
    }).success,
    false,
  );
  assert.equal(
    officialPreviewRequest.safeParse({
      programId,
      expectedConfigRevision,
      kind: 'test',
      limit: 1,
    }).success,
    false,
  );
  assert.equal(
    officialManualPreview.safeParse({
      programId,
      expectedConfigRevision,
      limit: 11,
    }).success,
    false,
  );
  assert.equal(
    officialManualPreview.safeParse({
      programId,
      expectedConfigRevision,
      city: true,
    }).success,
    false,
  );
  const draft = {
    requestId: randomUUID(),
    programId,
    previewId: randomUUID(),
    manifestHash: 'b'.repeat(64),
    expectedConfigRevision,
    acknowledgement: 'synthetic_draft_only',
  };
  assert.equal(officialDraftCommand.safeParse(draft).success, true);
  assert.equal(officialPublishCommand.safeParse(draft).success, false);
  assert.throws(() => decodeOfficialJson(Buffer.from('{"a":1,"a":2}')));
  assert.throws(() => decodeOfficialJson(Buffer.from('{"a":{"x":1,"x":2}}')));
  assert.throws(() => decodeOfficialJson(Buffer.from('{"a":"\\ud800"}')));
  assert.deepEqual(decodeOfficialJson(Buffer.from('{ "a" : [1,2] }')), {
    a: [1, 2],
  });
  assert.equal(scalarExcerpt('abc'), 'abc');
});
