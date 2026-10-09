import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingAdminDeletionContext,
  decodeRatingDeletionContext,
  decodeRatingDeletionLocator,
  decodeRatingAdminDeletionIntent,
  decodeRatingAdminDeletionReceipt,
  matchRatingAdminDeletionReceipt,
  matchRatingDeletionContext,
  ratingOwnerDeletionIntent,
  ratingDeletionPath,
} from '../src/ratings/deletion-contract';
import { decodeRatingIntent } from '../src/ratings/contract';
import { decodeRatingReplyIntent } from '../src/ratings/discussion-contract';
import {
  decodeRatingCommandIntent,
  isRatingAdminDeletionIntent,
} from '../src/ratings/pending';
import { otherId, requestId, revision } from './ratings-helpers';
import {
  adminContext,
  adminIntent,
  adminReceipt,
  deletionContext,
  locator,
  token,
} from './ratings-r3a-helpers';
for (const reply of [false, true]) {
  test(`R3A ${reply ? 'reply' : 'comment'} minimal contexts reject identity/body and cross-chain fields`, () => {
    assert.deepEqual(
      decodeRatingDeletionContext(deletionContext(reply)),
      deletionContext(reply),
    );
    assert.deepEqual(
      decodeRatingAdminDeletionContext(adminContext(reply)),
      adminContext(reply),
    );
    for (const leak of [
      { body: 'secret' },
      { author: { accountId: otherId } },
      { role: 'admin' },
      { allowedActions: { delete: true } },
      { profileId: otherId },
    ]) {
      assert.throws(() =>
        decodeRatingDeletionContext({ ...deletionContext(reply), ...leak }),
      );
      assert.throws(() =>
        decodeRatingAdminDeletionContext({ ...adminContext(reply), ...leak }),
      );
    }
    assert.throws(() => decodeRatingDeletionContext(adminContext(reply)));
    assert.throws(() =>
      decodeRatingAdminDeletionContext(deletionContext(reply)),
    );
    for (const contextRevision of ['', token + 'x', revision, ' '.repeat(43)])
      assert.throws(() =>
        decodeRatingAdminDeletionContext({
          ...adminContext(reply),
          contextRevision,
        }),
      );
    for (const field of ['subjectId', 'rootId', 'targetId'] as const)
      assert.throws(() =>
        matchRatingDeletionContext(locator(reply), {
          ...deletionContext(reply),
          [field]: otherId,
        }),
      );
    assert.throws(() =>
      decodeRatingDeletionLocator({ ...locator(reply), actor: otherId }),
    );
    assert.match(
      ratingDeletionPath(locator(reply)),
      /^\/pages\/rating-deletion\/rating-deletion\?/,
    );
  });
  test(`R3A ${reply ? 'reply' : 'comment'} admin command cannot impersonate owner and has strict CAS/token`, () => {
    const intent = adminIntent(reply);
    assert.deepEqual(decodeRatingAdminDeletionIntent(intent), intent);
    assert.equal(
      isRatingAdminDeletionIntent(decodeRatingCommandIntent(intent)),
      true,
    );
    for (const extra of [
      { regionId: otherId },
      { actorId: otherId },
      { authorId: otherId },
      { role: 'admin' },
      { occurredAt: 'now' },
      { body: 'secret' },
    ])
      assert.throws(() =>
        decodeRatingAdminDeletionIntent({
          ...intent,
          payload: { ...intent.payload, ...extra },
        }),
      );
    for (const field of Object.keys(intent.payload)) {
      const payload = { ...intent.payload } as Record<string, unknown>;
      delete payload[field];
      assert.throws(() =>
        decodeRatingAdminDeletionIntent({ ...intent, payload }),
      );
    }
    assert.throws(() => decodeRatingIntent(intent));
    assert.throws(() => decodeRatingReplyIntent(intent));
    const owner = ratingOwnerDeletionIntent(deletionContext(reply), requestId);
    assert.deepEqual(
      reply ? decodeRatingReplyIntent(owner) : decodeRatingIntent(owner),
      owner,
    );
    assert.throws(() => decodeRatingAdminDeletionIntent(owner));
  });
  test(`R3A ${reply ? 'reply' : 'comment'} receipt matches key, operation, target/root/subject and excludes sensitive details`, () => {
    const intent = adminIntent(reply),
      receipt = adminReceipt(intent);
    assert.deepEqual(decodeRatingAdminDeletionReceipt(receipt), receipt);
    matchRatingAdminDeletionReceipt(intent, receipt);
    for (const field of [
      'requestId',
      'subjectId',
      'rootId',
      'targetId',
    ] as const)
      assert.throws(() =>
        matchRatingAdminDeletionReceipt(intent, {
          ...receipt,
          [field]: otherId,
        }),
      );
    assert.throws(() =>
      matchRatingAdminDeletionReceipt(intent, {
        ...receipt,
        operation: reply ? 'admin_delete_comment' : 'admin_delete_reply',
      }),
    );
    assert.throws(() =>
      matchRatingAdminDeletionReceipt(intent, { ...receipt, outcome: 'noop' }),
    );
    matchRatingAdminDeletionReceipt(intent, {
      ...receipt,
      outcome: 'noop',
      revision,
    });
    for (const extra of [
      { body: 'secret' },
      { actorId: otherId },
      { authorId: otherId },
      { grantId: otherId },
      { origin: 'school' },
    ])
      assert.throws(() =>
        decodeRatingAdminDeletionReceipt({ ...receipt, ...extra }),
      );
    for (const code of [
      'RATING_NOT_FOUND',
      'RATING_REVISION_CONFLICT',
      'PHONE_VERIFICATION_REQUIRED',
      'SAFETY_ACTION_RESTRICTED',
    ])
      assert.equal(
        decodeRatingAdminDeletionReceipt({
          requestId,
          operation: intent.operation,
          outcome: 'rejected',
          code,
        }).outcome,
        'rejected',
      );
    for (const code of [
      'RATING_DELETION_CONTEXT_CHANGED',
      'AUTHORIZATION_UNAVAILABLE',
      'AFFILIATION_VERIFICATION_REQUIRED',
    ])
      assert.throws(() =>
        decodeRatingAdminDeletionReceipt({
          requestId,
          operation: intent.operation,
          outcome: 'rejected',
          code,
        }),
      );
  });
}
