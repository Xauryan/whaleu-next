import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  DiscussionMutationController,
  type DiscussionMutationView,
} from '../src/community/discussion-controller';
import type { DiscussionReceipt } from '../src/community/discussion-contract';
import { PendingDiscussionStore } from '../src/community/discussion-pending';
import {
  ComposeController,
  commentIdentity,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  commentCapabilities,
  otherId,
  post,
  postId,
  receipt,
  reply,
  replyId,
  requestId,
  setup,
} from './community-helpers';
const target: ComposeTarget = {
  operation: 'publish_reply',
  postId,
  rootCommentId: commentId,
  targetReplyId: null,
};
function compose(
  copySource: { kind: 'comment' | 'reply'; id: string } | null = null,
  targetOverride: ComposeTarget = target,
) {
  const s = setup(),
    views: ComposeView[] = [];
  const controller = new ComposeController(
    s.runtime,
    targetOverride,
    (view) => views.push(view),
    undefined,
    copySource,
  );
  return { ...s, controller, view: () => views[views.length - 1]! };
}
function mutation() {
  const s = setup(),
    views: DiscussionMutationView[] = [];
  let settled = 0;
  const controller = new DiscussionMutationController(
    s.runtime,
    (view) => views.push(view),
    () => settled++,
  );
  return {
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    settled: () => settled,
  };
}
const applied: DiscussionReceipt = {
  requestId,
  operation: 'set_reply_like',
  outcome: 'applied',
  resourceId: replyId,
  desired: true,
};
test('reply publication freezes original root/target/text before dispatch and survives not-found and reopen', async () => {
  const s = compose();
  await s.controller.load();
  assert.equal(s.view().replyTargetName, '合成匿名鲸鱼');
  s.controller.setText(' 原\r\n文字 ');
  s.gateway.publishReplyImpl = async (root, payload) => {
    assert.equal(root, commentId);
    assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload, payload);
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.submit();
  const frozen = s.runtime.pending.load(s.accountId)!;
  assert.equal(frozen.operation, 'publish_reply');
  assert.equal(frozen.payload.text, ' 原\n文字 ');
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(
    s.runtime,
    { operation: 'publish_comment', postId: otherId },
    (v) => views.push(v),
  );
  await reopened.load();
  assert.equal(views[views.length - 1]!.frozen, true);
  reopened.setText('changed');
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await reopened.recover();
  assert.deepEqual(s.runtime.pending.load(s.accountId), frozen);
  s.gateway.publishReplyImpl = async () =>
    receipt({ operation: 'publish_reply', resourceId: replyId });
  await reopened.recover(true);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.resourceRootCommentId, commentId);
});
test('draft and last committed mode precedence respect forced anonymity and parent fallback', () => {
  const preferences = {
    defaultCommentAnonymousEnabled: false,
    defaultCommentNonAnonymousEnabled: false,
  };
  assert.equal(
    commentIdentity(false, null, preferences, 'named', true).mode,
    'named',
  );
  assert.equal(
    commentIdentity(false, 'anonymous', preferences, 'named', false).mode,
    'anonymous',
  );
  assert.equal(
    commentIdentity(true, 'named', preferences, 'named', false).mode,
    'anonymous',
  );
  assert.equal(
    commentIdentity(false, null, preferences, null, true).mode,
    'anonymous',
  );
});
test('reply +1 copies text and preserves original target, never overrides existing draft or unknown attempt', async () => {
  const s = compose({ kind: 'reply', id: replyId });
  s.gateway.replyImpl = async () => reply({ text: 'copied' });
  await s.controller.load();
  assert.equal(s.view().text, 'copied');
  s.controller.setText('my draft');
  await s.controller.load();
  assert.equal(s.view().text, 'my draft');
  s.gateway.publishReplyImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.submit();
  await s.controller.load();
  assert.equal(s.view().text, 'my draft');
  assert.equal(s.view().frozen, true);
  const wrong = compose({ kind: 'reply', id: replyId }, {
    ...target,
    targetReplyId: replyId,
  } as ComposeTarget);
  await wrong.controller.load();
  assert.equal(wrong.view().loaded, false);
  const unavailable = compose({ kind: 'reply', id: replyId });
  unavailable.gateway.replyImpl = async () =>
    reply({ target: { status: 'unavailable' } });
  await unavailable.controller.load();
  assert.equal(unavailable.view().canSubmit, false);
});
test('reply identity uses dedicated comment capability, never post category permission', async () => {
  const s = compose();
  s.gateway.postImpl = async () =>
    post({
      viewer: {
        isSelf: false,
        canDelete: false,
        isLiked: false,
        canComment: true,
        isSaved: false,
        canSave: true,
        canSetUpdatePreference: true,
      },
    });
  s.gateway.commentCapabilitiesImpl = async () =>
    commentCapabilities({
      authorModes: ['named'],
      forcedAuthorMode: null,
      lastAuthorMode: 'named',
    });
  await s.controller.load();
  assert.equal(s.view().authorMode, 'named');
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'capabilities'),
    false,
  );
  s.controller.setText('allowed');
  assert.equal(s.view().canSubmit, true);
});
test('discussion mutation freezes persisted desired state, blocks opposite/repeated intents and recovers without live content', async () => {
  const s = mutation();
  s.gateway.discussionLikeImpl = async () => {
    const saved = s.runtime.pendingDiscussion.load(s.accountId);
    assert.equal(saved?.desired, true);
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.apply('set_reply_like', postId, commentId, replyId, true);
  await s.controller.apply('set_reply_like', postId, commentId, replyId, false);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'discussionLike').length,
    1,
  );
  assert.equal(s.view().frozen, true);
  const frozen = s.runtime.pendingDiscussion.load(s.accountId);
  assert.equal(
    new PendingDiscussionStore(s.storage, 'another-origin').load(s.accountId),
    null,
  );
  assert.equal(s.runtime.pendingDiscussion.load(otherId), null);
  s.gateway.discussionReceiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.recover();
  assert.deepEqual(s.runtime.pendingDiscussion.load(s.accountId), frozen);
  s.gateway.discussionReceiptImpl = async () => ({
    ...applied,
    desired: false,
  });
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  s.gateway.discussionReceiptImpl = async () => applied;
  await s.controller.recover();
  assert.equal(s.runtime.pendingDiscussion.load(s.accountId), null);
  assert.equal(s.settled(), 1);
});
test('reply and interaction storage failure prevents send; terminal removal failure retains protection', async () => {
  const s = mutation();
  s.storage.failWrite = true;
  await s.controller.apply('set_reply_like', postId, commentId, replyId, true);
  assert.equal(s.gateway.calls.length, 0);
  s.storage.failWrite = false;
  s.gateway.discussionLikeImpl = async () => {
    s.storage.failRemove = true;
    return applied;
  };
  await s.controller.apply('set_reply_like', postId, commentId, replyId, true);
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingDiscussion.load(s.accountId));
  const c = compose();
  await c.controller.load();
  c.controller.setText('text');
  c.storage.failWrite = true;
  await c.controller.submit();
  assert.equal(
    c.gateway.calls.some((call) => call.method === 'publishReply'),
    false,
  );
});
for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account',
  'switch-account',
] as const) {
  test(`discussion mutation ${lifecycle} clears ownership and preserves a dispatched unknown intent`, async () => {
    const s = mutation(),
      pending = deferred<DiscussionReceipt>();
    s.gateway.discussionLikeImpl = async () => pending.promise;
    const running = s.controller.apply(
      'set_reply_like',
      postId,
      commentId,
      replyId,
      true,
    );
    await flush();
    assert.ok(s.runtime.pendingDiscussion.load(s.accountId));
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    pending.resolve(applied);
    await running;
    assert.ok(s.runtime.pendingDiscussion.load(s.accountId));
    assert.equal(s.settled(), 0);
  });
  test(`reply publication ${lifecycle} retains frozen original payload and ignores late success`, async () => {
    const s = compose(),
      pending = deferred<ReturnType<typeof receipt>>();
    await s.controller.load();
    s.controller.setText('pending');
    s.gateway.publishReplyImpl = async () => pending.promise;
    const running = s.controller.submit();
    await flush();
    assert.ok(s.runtime.pending.load(s.accountId));
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    pending.resolve(
      receipt({ operation: 'publish_reply', resourceId: replyId }),
    );
    await running;
    assert.ok(s.runtime.pending.load(s.accountId));
    if (lifecycle !== 'cancel') assert.equal(s.view().text, '');
  });
}

test('pin conflict settles a terminal receipt, while lost pin response blocks unpin and replacement', async () => {
  const s = mutation();
  s.gateway.pinCommentImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.apply(
    'set_comment_pin',
    postId,
    commentId,
    commentId,
    true,
  );
  await s.controller.apply(
    'set_comment_pin',
    postId,
    commentId,
    commentId,
    false,
  );
  await s.controller.apply('set_comment_pin', postId, otherId, otherId, true);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'pinComment').length,
    1,
  );
  s.gateway.discussionReceiptImpl = async () => ({
    requestId,
    operation: 'set_comment_pin',
    outcome: 'rejected',
    code: 'COMMENT_PIN_CONFLICT',
  });
  await s.controller.recover();
  assert.equal(s.runtime.pendingDiscussion.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.match(s.view().receiptStatus, /先取消原置顶/);
  assert.equal(s.settled(), 1);
});
test('same-tick cancel prevents reply and desired-state dispatch before persistence', async () => {
  const s = mutation();
  const interacting = s.controller.apply(
    'set_reply_like',
    postId,
    commentId,
    replyId,
    true,
  );
  s.controller.cancel();
  await interacting;
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.runtime.pendingDiscussion.load(s.accountId), null);
  const c = compose();
  await c.controller.load();
  c.controller.setText('not sent');
  const publishing = c.controller.submit();
  c.controller.cancel();
  await publishing;
  assert.equal(
    c.gateway.calls.some((call) => call.method === 'publishReply'),
    false,
  );
  assert.equal(c.runtime.pending.load(c.accountId), null);
});
test('discussion storage is separate from existing publication and ballot namespaces', async () => {
  const s = mutation();
  s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_comment',
    postId,
    payload: {
      clientRequestId: requestId,
      text: 'old C1',
      imageAssetIds: [],
      authorMode: 'named',
    },
  });
  s.runtime.pendingBallots.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    payload: { clientRequestId: requestId, optionIds: [otherId] },
  });
  s.gateway.discussionLikeImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.apply('set_reply_like', postId, commentId, replyId, true);
  assert.ok(s.runtime.pending.load(s.accountId));
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  assert.ok(s.runtime.pendingDiscussion.load(s.accountId));
  s.gateway.discussionReceiptImpl = async () => applied;
  await s.controller.recover();
  assert.ok(s.runtime.pending.load(s.accountId));
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  assert.equal(s.runtime.pendingDiscussion.load(s.accountId), null);
});
