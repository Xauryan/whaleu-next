import { batchPublicationReference } from '../src/media/batch-publication';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { HttpCommunityGateway } from '../src/community/gateway';
import { decodeReceipt } from '../src/community/contract';
import {
  decodePublicationReview,
  type PublicationReview,
} from '../src/community/review-contract';
import type { PendingAttempt } from '../src/community/pending-attempt';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { Cancellation } from '../src/platform/contracts';
import {
  capabilities,
  commentCapabilities,
  commentId,
  intent,
  otherId,
  post,
  postId,
  receipt,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const absent = () =>
  new ClientError('http', 'Missing', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
const review = (
  status: PublicationReview['status'],
  operation: PublicationReview['operation'] = 'publish_post',
): PublicationReview => ({ requestId, operation, status });
const target: ComposeTarget = {
  operation: 'publish_post',
  spaceId,
  category: 'discussion',
};
function composer(composeTarget: ComposeTarget = target) {
  const s = setup(),
    views: ComposeView[] = [];
  let current: PublicationReview['status'] = 'pending';
  const submissions: PendingAttempt[] = [];
  Object.assign(s.gateway, {
    submitReview: async (attempt: PendingAttempt) => {
      submissions.push(attempt);
      return review(current, attempt.operation);
    },
    reviewStatus: async (attempt: PendingAttempt) =>
      review(current, attempt.operation),
  });
  s.gateway.receiptImpl = async () => {
    throw absent();
  };
  const controller = new ComposeController(s.runtime, composeTarget, (value) =>
    views.push(value),
  );
  return {
    ...s,
    controller,
    submissions,
    view: () => views[views.length - 1]!,
    setStatus: (status: PublicationReview['status']) => {
      current = status;
    },
  };
}

test('review DTO stays separate from terminal receipts and rejects private or mismatched fields', () => {
  for (const status of [
    'pending',
    'approved',
    'rejected',
    'unavailable',
    'settled',
    'cancelled',
  ] as const) {
    assert.equal(decodePublicationReview(review(status)).status, status);
    assert.throws(() => decodeReceipt(review(status)));
  }
  for (const value of [
    { ...review('pending'), text: 'private' },
    { ...review('pending'), status: 'created' },
    { ...review('pending'), requestId: 'invalid' },
  ])
    assert.throws(() => decodePublicationReview(value));
});

test('review HTTP endpoints bind exact original post/comment/reply request and require 200', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => s.sessions.snapshot(),
    }),
  );
  const attempts: PendingAttempt[] = [
    {
      version: 1,
      accountId: s.accountId,
      operation: 'publish_post',
      payload: intent({ authorMode: 'named' }),
    },
    {
      version: 1,
      accountId: s.accountId,
      operation: 'publish_comment',
      postId,
      payload: {
        clientRequestId: requestId,
        authorMode: 'named',
        text: 'exact',
        imageAssetIds: [],
      },
    },
    {
      version: 1,
      accountId: s.accountId,
      operation: 'publish_reply',
      postId,
      rootCommentId: commentId,
      payload: {
        clientRequestId: requestId,
        authorMode: 'named',
        text: 'exact',
        imageAssetIds: [],
        targetReplyId: null,
      },
    },
  ];
  const paths = [
    '/reviews/posts',
    `/reviews/posts/${postId}/comments`,
    `/reviews/comments/${commentId}/replies`,
  ];
  for (const [index, attempt] of attempts.entries()) {
    transport.reply(review('pending', attempt.operation));
    await gateway.submitReview(attempt, new Cancellation());
    assert.ok(transport.requests[index]!.url.endsWith(paths[index]!));
    assert.deepEqual(transport.requests[index]!.body, attempt.payload);
  }
  transport.reply(review('approved'));
  await gateway.reviewStatus(attempts[0]!, new Cancellation());
  assert.ok(
    transport.requests[3]!.url.endsWith(`/reviews/requests/${requestId}`),
  );
  transport.reply({ ...review('pending'), requestId: otherId });
  await assert.rejects(gateway.submitReview(attempts[0]!, new Cancellation()));
  transport.reply(review('pending'), 201);
  await assert.rejects(gateway.submitReview(attempts[0]!, new Cancellation()));
});

test('post/comment/reply review keeps original body frozen and approved requires explicit same-key publish', async () => {
  const targets: ComposeTarget[] = [
    target,
    { operation: 'publish_comment', postId },
    {
      operation: 'publish_reply',
      postId,
      rootCommentId: commentId,
      targetReplyId: null,
    },
  ];
  for (const composeTarget of targets) {
    const s = composer(composeTarget);
    s.gateway.postImpl = async () =>
      post({ viewer: { ...post().viewer, isSelf: false } });
    s.gateway.commentCapabilitiesImpl = async () =>
      commentCapabilities({ authorModes: ['named'], forcedAuthorMode: null });
    await s.controller.load();
    s.controller.setAuthorMode('named');
    s.controller.setText('  exact\r\nbody  ');
    await s.controller.submit();
    assert.equal(s.view().reviewStatus, 'pending');
    assert.equal(s.view().frozen, true);
    const original = s.runtime.pending.load(s.accountId);
    assert.equal(original?.payload.text, '  exact\nbody  ');
    s.controller.setText('replacement');
    await s.controller.recover(true);
    assert.equal(s.submissions.length, 1);
    assert.equal(
      s.gateway.calls.some((call) => call.method.startsWith('publish')),
      false,
    );
    s.setStatus('approved');
    await s.controller.recover();
    assert.equal(s.view().reviewStatus, 'approved');
    assert.deepEqual(s.runtime.pending.load(s.accountId), original);
    assert.equal(
      s.gateway.calls.some((call) => call.method.startsWith('publish')),
      false,
    );
    const result = receipt({ operation: composeTarget.operation });
    s.gateway.publishPostImpl = async () => result;
    s.gateway.publishCommentImpl = async () => result;
    s.gateway.publishReplyImpl = async () => result;
    await s.controller.recover(true);
    assert.equal(s.runtime.pending.load(s.accountId), null);
    assert.equal(s.view().receiptStatus, '发布已确认');
  }
});

test('rejected/unavailable/absent review never releases pending protection or creates a new key', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('original');
  await s.controller.submit();
  const original = s.runtime.pending.load(s.accountId);
  s.setStatus('unavailable');
  await s.controller.recover(true);
  assert.equal(s.submissions.length, 2);
  assert.deepEqual(s.submissions[0], s.submissions[1]);
  Object.assign(s.gateway, {
    reviewStatus: async () => {
      throw absent();
    },
  });
  await s.controller.recover();
  assert.deepEqual(s.runtime.pending.load(s.accountId), original);
  await s.controller.recover(true);
  assert.equal(s.submissions.length, 3);
  Object.assign(s.gateway, { reviewStatus: async () => review('rejected') });
  await s.controller.recover();
  assert.equal(s.view().reviewStatus, 'rejected');
  assert.deepEqual(s.runtime.pending.load(s.accountId), original);
  s.gateway.publishPostImpl = async () => ({
    requestId,
    operation: 'publish_post',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  await s.controller.recover(true);
  assert.equal(s.runtime.pending.load(s.accountId), null);
});

test('unavailable capability and late review after account replacement cannot dispatch or reveal original body', async () => {
  const s = composer(),
    response = deferred<PublicationReview>();
  Object.assign(s.gateway, { submitReview: async () => response.promise });
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('private original');
  const sending = s.controller.submit();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  response.resolve(review('approved'));
  await sending;
  assert.equal(s.view().text, '');
  assert.equal(s.view().reviewStatus, '');
  assert.ok(s.runtime.pending.load(s.accountId));
  const blocked = composer();
  await blocked.controller.load();
  blocked.controller.setAuthorMode('named');
  blocked.controller.setText('blocked');
  blocked.gateway.capabilitiesImpl = async () =>
    capabilities({
      publish: {
        availability: 'unavailable',
        reason: 'CONTENT_REVIEW_UNAVAILABLE',
      },
    });
  await blocked.controller.submit();
  assert.equal(blocked.submissions.length, 0);
  assert.ok(blocked.runtime.pending.load(blocked.accountId));
});

test('settled status only resolves through exact terminal receipt and review mismatch stays frozen', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('original');
  await s.controller.submit();
  Object.assign(s.gateway, {
    reviewStatus: async () => ({
      ...review('approved'),
      operation: 'publish_reply',
    }),
  });
  await s.controller.recover(true);
  assert.ok(s.runtime.pending.load(s.accountId));
  assert.equal(
    s.gateway.calls.some((call) => call.method.startsWith('publish')),
    false,
  );
  s.setStatus('settled');
  Object.assign(s.gateway, { reviewStatus: async () => review('settled') });
  let reads = 0;
  s.gateway.receiptImpl = async () => {
    if (++reads === 1) throw absent();
    return receipt();
  };
  await s.controller.recover();
  assert.equal(reads, 2);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(s.view().receiptStatus, '发布已确认');
});

test('reopening uses the existing frozen body without persisting review status', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('original');
  await s.controller.submit();
  const before = s.runtime.pending.load(s.accountId);
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(s.runtime, null, (value) =>
    views.push(value),
  );
  await reopened.load();
  assert.equal(views[views.length - 1]!.reviewStatus, '');
  s.setStatus('approved');
  await reopened.recover();
  assert.equal(views[views.length - 1]!.reviewStatus, 'approved');
  assert.deepEqual(s.runtime.pending.load(s.accountId), before);
  assert.equal(s.submissions.length, 1);
});

function cancellation(attempt: PendingAttempt) {
  return {
    requestId: attempt.payload.clientRequestId,
    operation: attempt.operation,
    outcome: 'cancelled' as const,
    intentHash: batchPublicationReference(attempt).intentHash,
  };
}

test('explicit cancellation needs the exact durable fence, preserves draft and never starts a new request', async () => {
  const s = composer();
  Object.assign(s.gateway, {
    cancelReview: async (attempt: PendingAttempt) => cancellation(attempt),
  });
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('keep original draft');
  await s.controller.submit();
  assert.equal(s.view().canCancelReview, true);
  s.gateway.capabilitiesImpl = async () =>
    capabilities({
      publish: {
        availability: 'unavailable',
        reason: 'CONTENT_REVIEW_UNAVAILABLE',
      },
    });
  await s.controller.cancelReview();
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(s.view().text, 'keep original draft');
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.view().canCancelReview, false);
  assert.equal(
    s.runtime.drafts.load(s.accountId, `post:${spaceId}:discussion`)?.text,
    'keep original draft',
  );
  await s.controller.submit();
  assert.equal(s.submissions.length, 1);
});

test('wrong cancellation hash and uncertain cancellation keep the original barrier', async () => {
  const s = composer();
  Object.assign(s.gateway, {
    cancelReview: async (attempt: PendingAttempt) => ({
      ...cancellation(attempt),
      intentHash: 'f'.repeat(64),
    }),
  });
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('original');
  await s.controller.submit();
  const original = s.runtime.pending.load(s.accountId);
  await s.controller.cancelReview();
  assert.deepEqual(s.runtime.pending.load(s.accountId), original);
  assert.equal(s.view().frozen, true);
  Object.assign(s.gateway, {
    cancelReview: async () => {
      throw new ClientError('timeout', 'unknown');
    },
  });
  await s.controller.cancelReview();
  assert.deepEqual(s.runtime.pending.load(s.accountId), original);
  assert.equal(s.view().frozen, true);
});

test('cancelled review status recovers the fence; created receipt wins over cancellation', async () => {
  for (const alreadyCreated of [false, true]) {
    const s = composer();
    let cancels = 0;
    Object.assign(s.gateway, {
      cancelReview: async (attempt: PendingAttempt) => {
        cancels++;
        return alreadyCreated ? receipt() : cancellation(attempt);
      },
    });
    await s.controller.load();
    s.controller.setAuthorMode('named');
    s.controller.setText('original');
    await s.controller.submit();
    s.setStatus('cancelled');
    await s.controller.recover();
    assert.equal(cancels, 1);
    assert.equal(s.runtime.pending.load(s.accountId), null);
    assert.equal(
      s.view().receiptStatus,
      alreadyCreated ? '发布已确认' : '服务器已确认取消，原请求不能再发布',
    );
    assert.equal(s.view().text, alreadyCreated ? '' : 'original');
  }
});

test('late cancellation cannot clear original-account recovery after account replacement', async () => {
  const s = composer(),
    response = deferred<ReturnType<typeof cancellation>>();
  Object.assign(s.gateway, { cancelReview: async () => response.promise });
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('original');
  await s.controller.submit();
  const original = s.runtime.pending.load(s.accountId)!;
  const cancelling = s.controller.cancelReview();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  response.resolve(cancellation(original));
  await cancelling;
  assert.deepEqual(s.runtime.pending.load(s.accountId), original);
  assert.equal(s.view().text, '');
  assert.equal(s.view().canCancelReview, false);
});

test('cancel HTTP identifies the original intent and checks the exact durable fence', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => s.sessions.snapshot(),
    }),
  );
  const attempt: PendingAttempt = {
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: intent({ authorMode: 'named' }),
  };
  transport.reply(cancellation(attempt));
  await gateway.cancelReview(attempt, new Cancellation());
  assert.ok(
    transport.requests[0]!.url.endsWith(
      `/reviews/requests/${requestId}/cancel`,
    ),
  );
  assert.deepEqual(transport.requests[0]!.body, {
    operation: attempt.operation,
    intentHash: batchPublicationReference(attempt).intentHash,
  });
  transport.reply({ ...cancellation(attempt), intentHash: '0'.repeat(64) });
  await assert.rejects(gateway.cancelReview(attempt, new Cancellation()));
  transport.reply(receipt());
  assert.equal(
    (await gateway.cancelReview(attempt, new Cancellation())).outcome,
    'created',
  );
});

test('manual named-text capability blocks unsupported draft features without silently removing them', async () => {
  const s = composer();
  s.gateway.capabilitiesImpl = async () =>
    capabilities({ authorModes: ['named'] });
  await s.controller.load();
  s.controller.setAuthorMode('named');
  s.controller.setText('Plain text');
  s.controller.setAllowAnonymousDm(true);
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.view().allowAnonymousDm, true);
  assert.match(s.view().blocker, /纯文字审核/);
  await s.controller.submit();
  assert.equal(s.runtime.pending.load(s.accountId), null);
  s.controller.setAllowAnonymousDm(false);
  assert.equal(s.view().canSubmit, true);
});
