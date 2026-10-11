import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  reserveStudentSchema,
  submitStudentSchema,
  decideStudentSchema,
  studentApplicationSchema,
  studentReceiptSchema,
  studentQueueSchema,
} from '../src/verification/student/contracts.js';
const reserve = { clientRequestId: randomUUID(), campusId: randomUUID() };
test('student commands are closed, server-owned facts cannot be client assertions', () => {
  assert.deepEqual(reserveStudentSchema.parse(reserve), reserve);
  for (const field of [
    'accountId',
    'actorId',
    'schoolName',
    'issuer',
    'region',
    'role',
    'verified',
    'studentNumber',
    'imageUrl',
    'realName',
    'documentType',
  ])
    assert.equal(
      reserveStudentSchema.safeParse({ ...reserve, [field]: 'forged' }).success,
      false,
    );
  const submit = {
    clientRequestId: randomUUID(),
    expectedRevision: 1,
    evidence: {
      protocol: 'verification-evidence-media-v1',
      kind: 'verification-evidence-upload',
      assetId: randomUUID(),
    },
  };
  assert.equal(submitStudentSchema.safeParse(submit).success, true);
  assert.equal(
    submitStudentSchema.safeParse({
      ...submit,
      evidence: { imageUrl: 'https://example.invalid/private' },
    }).success,
    false,
  );
  assert.equal(
    submitStudentSchema.safeParse({
      ...submit,
      evidence: { ...submit.evidence, protocol: 'announcement-media-v1' },
    }).success,
    false,
  );
});
test('review rejection requires a bounded nonempty reason and accepted decisions never add private facts', () => {
  const base = {
    clientRequestId: randomUUID(),
    expectedRevision: 2,
    decision: 'rejected',
  };
  for (const reason of ['', '   ', 'x'.repeat(201), 'line\nline'])
    assert.equal(
      decideStudentSchema.safeParse({ ...base, reason }).success,
      false,
    );
  assert.equal(
    decideStudentSchema.parse({ ...base, reason: '  模糊，请重新提交  ' })
      .decision,
    'rejected',
  );
  assert.equal(
    decideStudentSchema.safeParse({
      ...base,
      decision: 'approved',
      studentNumber: 'fake',
    }).success,
    false,
  );
  assert.equal(
    studentReceiptSchema.safeParse({
      requestId: randomUUID(),
      applicationId: randomUUID(),
      revision: 3,
      state: 'approved',
      imageUrl: 'private',
    }).success,
    false,
  );
});
test('queue cursor is an immutable opaque application identity; output never grows private fields', () => {
  assert.equal(
    studentQueueSchema.parse({ page: '2', cursor: randomUUID() }).page,
    2,
  );
  assert.equal(
    studentQueueSchema.safeParse({ cursor: 'arbitrary-offset' }).success,
    false,
  );
  assert.equal(
    studentApplicationSchema.safeParse({ realName: 'unrequested' }).success,
    false,
  );
});
test('generated student OpenAPI includes private media, native mutations and scoped review paths', async () => {
  const raw = JSON.parse(
    await readFile(
      new URL(
        '../../../docs/openapi/student-verification.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { paths: Record<string, unknown> };
  for (const path of [
    '/v1/me/student-verification',
    '/v1/me/student-verification/applications',
    '/v1/me/student-verification/applications/{applicationId}/submit',
    '/v1/student-verification-review/regions/{regionId}/applications/{applicationId}/decision',
    '/v3/media/verification-evidence/applications/{applicationId}/descriptor',
  ])
    assert.ok(raw.paths[path], path);
  const submit = JSON.stringify(
    raw.paths[
      '/v1/me/student-verification/applications/{applicationId}/submit'
    ],
  );
  assert.match(submit, /verification-evidence-upload/);
  assert.match(submit, /additionalProperties/);
  assert.doesNotMatch(submit, /imageUrl|studentNumber|realName/);
});
