import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  adminPostRemovalCommandSchema,
  adminPostRemovalManagementSchema,
  adminPostRemovalReceiptSchema,
  adminPostRemovalRecoverySchema,
} from '../src/community/admin-removal/contracts.js';
import { adminPostRemovalIntentHash } from '../src/community/admin-removal/evidence.js';
const actor = randomUUID(),
  post = randomUUID(),
  key = randomUUID();
const command = {
  clientRequestId: key,
  target: { kind: 'post' as const, id: post },
  expectedTargetVersion: 'a'.repeat(64),
  action: 'remove_post' as const,
};
const base = {
  requestId: key,
  target: command.target,
  expectedTargetVersion: command.expectedTargetVersion,
  action: command.action,
};
test('administrator deletion is an exact post-only independent intent without private author or policy expansions', () => {
  assert.deepEqual(adminPostRemovalCommandSchema.parse(command), command);
  for (const patch of [
    { target: { kind: 'comment', id: post } },
    { target: { kind: 'reply', id: post } },
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
      adminPostRemovalCommandSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
  for (const field of Object.keys(command))
    assert.equal(
      adminPostRemovalCommandSchema.safeParse(
        Object.fromEntries(
          Object.entries(command).filter(([key]) => key !== field),
        ),
      ).success,
      false,
    );
  const expected = createHash('sha256')
    .update(
      'whaleu:admin-post-removal-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
  assert.equal(adminPostRemovalIntentHash(actor, command), expected);
  assert.notEqual(adminPostRemovalIntentHash(randomUUID(), command), expected);
  assert.ok(
    adminPostRemovalManagementSchema.safeParse({
      target: command.target,
      targetVersion: command.expectedTargetVersion,
      canRemove: true,
    }).success,
  );
  assert.equal(
    adminPostRemovalManagementSchema.safeParse({
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
    { ...base, outcome: 'rejected', code: 'ADMIN_POST_REMOVAL_STALE' },
    { ...base, outcome: 'rejected', code: 'ADMIN_POST_REMOVAL_CANCELLED' },
  ]) {
    assert.ok(adminPostRemovalReceiptSchema.safeParse(value).success);
    assert.ok(
      adminPostRemovalRecoverySchema.safeParse({
        state: 'recorded',
        receipt: value,
      }).success,
    );
    assert.equal(
      adminPostRemovalReceiptSchema.safeParse({ ...value, subjectId: actor })
        .success,
      false,
    );
  }
  assert.ok(
    adminPostRemovalRecoverySchema.safeParse({ state: 'not_recorded' }).success,
  );
  assert.equal(
    adminPostRemovalReceiptSchema.safeParse({ ...applied, revision: 1 })
      .success,
    false,
  );
});
test('admin post-removal OpenAPI has only exact management, command, cancel and original-key recovery routes', async () => {
  const module = await import(
    new URL(
      '../.openapi-build/scripts/admin-post-removal-openapi-document.js',
      import.meta.url,
    ).href
  );
  const rendered = await module.renderAdminPostRemovalOpenApiDocument();
  assert.equal(
    rendered,
    await readFile(
      new URL('../../../docs/openapi/admin-post-removal.json', import.meta.url),
      'utf8',
    ),
  );
  const document = JSON.parse(rendered);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    '/v1/community/admin-post-removal/commands',
    '/v1/community/admin-post-removal/commands/cancel',
    '/v1/community/admin-post-removal/management',
    '/v1/community/admin-post-removal/requests/{requestId}',
  ]);
  const operation =
    document.paths['/v1/community/admin-post-removal/commands'].post;
  assert.equal(operation.operationId, 'adminPostRemovalCommand');
});
