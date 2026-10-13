import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  adminDiscussionRemovalCommandSchema,
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalReceiptSchema,
  adminDiscussionRemovalRecoverySchema,
} from '../src/community/admin-discussion-removal/contracts.js';
import { adminDiscussionRemovalIntentHash } from '../src/community/admin-discussion-removal/evidence.js';
const actor = randomUUID(),
  post = randomUUID(),
  key = randomUUID();
const command = {
  clientRequestId: key,
  target: { kind: 'comment' as const, id: post },
  expectedTargetVersion: 'a'.repeat(64),
  action: 'remove_discussion' as const,
};
const base = {
  requestId: key,
  target: command.target,
  expectedTargetVersion: command.expectedTargetVersion,
  action: command.action,
};
test('administrator deletion is an exact child-kind independent intent without private author or policy expansions', () => {
  assert.deepEqual(adminDiscussionRemovalCommandSchema.parse(command), command);
  for (const patch of [
    { target: { kind: 'post', id: post } },
    { target: { kind: 'account', id: actor } },
    { target: { ...command.target, authorId: actor } },
    { expectedTargetVersion: 'A'.repeat(64) },
    { expectedTargetVersion: 0 },
    { action: 'reset_nickname' },
    { action: 'post_jury_removed' },
    { banUser: true },
    { reason: 'reason' },
    { grantId: randomUUID() },
    { subjectId: actor },
  ])
    assert.equal(
      adminDiscussionRemovalCommandSchema.safeParse({ ...command, ...patch })
        .success,
      false,
    );
  for (const field of Object.keys(command))
    assert.equal(
      adminDiscussionRemovalCommandSchema.safeParse(
        Object.fromEntries(
          Object.entries(command).filter(([key]) => key !== field),
        ),
      ).success,
      false,
    );
  const expected = createHash('sha256')
    .update(
      'whaleu:admin-discussion-removal-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
  assert.equal(adminDiscussionRemovalIntentHash(actor, command), expected);
  assert.notEqual(
    adminDiscussionRemovalIntentHash(randomUUID(), command),
    expected,
  );
  assert.notEqual(
    adminDiscussionRemovalIntentHash(actor, {
      ...command,
      target: { kind: 'reply', id: post },
    }),
    expected,
  );
  assert.ok(
    adminDiscussionRemovalManagementSchema.safeParse({
      target: command.target,
      targetVersion: command.expectedTargetVersion,
      canRemove: true,
    }).success,
  );
  assert.equal(
    adminDiscussionRemovalManagementSchema.safeParse({
      target: command.target,
      targetVersion: command.expectedTargetVersion,
      canRemove: true,
      subjectId: actor,
    }).success,
    false,
  );
});
test('strict immutable receipts and recovery expose no identity, deleted source preview or replacement intent', () => {
  const applied = {
    ...base,
    outcome: 'applied',
    eventId: randomUUID(),
    recordedAt: '2026-10-12T12:00:00.000Z',
  };
  for (const value of [
    applied,
    { ...base, outcome: 'rejected', code: 'ADMIN_DISCUSSION_REMOVAL_STALE' },
    {
      ...base,
      outcome: 'rejected',
      code: 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
    },
  ]) {
    assert.ok(adminDiscussionRemovalReceiptSchema.safeParse(value).success);
    assert.ok(
      adminDiscussionRemovalRecoverySchema.safeParse({
        state: 'recorded',
        receipt: value,
      }).success,
    );
    assert.equal(
      adminDiscussionRemovalReceiptSchema.safeParse({
        ...value,
        subjectId: actor,
      }).success,
      false,
    );
  }
  assert.ok(
    adminDiscussionRemovalRecoverySchema.safeParse({ state: 'not_recorded' })
      .success,
  );
  assert.equal(
    adminDiscussionRemovalReceiptSchema.safeParse({ ...applied, revision: 1 })
      .success,
    false,
  );
});
test('admin discussion-removal OpenAPI has only exact management, command, cancel and original-key recovery routes', async () => {
  const module = await import(
    new URL(
      '../.openapi-build/scripts/admin-discussion-removal-openapi-document.js',
      import.meta.url,
    ).href
  );
  const rendered = await module.renderAdminDiscussionRemovalOpenApiDocument();
  assert.equal(
    rendered,
    await readFile(
      new URL(
        '../../../docs/openapi/admin-discussion-removal.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const document = JSON.parse(rendered);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/v1/community/admin-discussion-removal/commands',
    '/v1/community/admin-discussion-removal/commands/cancel',
    '/v1/community/admin-discussion-removal/management',
    '/v1/community/admin-discussion-removal/requests/{requestId}',
  ]);
  const operation =
    document.paths['/v1/community/admin-discussion-removal/commands'].post;
  assert.equal(operation.operationId, 'adminDiscussionRemovalCommand');
});
