import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  decodeCapabilities,
  decodeCommentCapabilities,
  decodeCommentIntent,
  decodePostIntent,
  decodeReceipt,
  type Capabilities,
  type Receipt,
} from '../src/community/contract';
import { decodeReplyIntent } from '../src/community/discussion-contract';
import { reasonMessage } from '../src/community/controller';
import { FormationController } from '../src/community/formation-controller';
import { PollController } from '../src/community/poll-controller';
import { SavedMutationController } from '../src/community/saved-controller';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  FeedController,
  type FeedView,
} from '../src/pages/community-feed/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  capabilities,
  comment,
  commentCapabilities,
  commentId,
  formationPost,
  intent,
  optionOne,
  otherId,
  pollPost,
  post,
  postId,
  receipt,
  requestId,
  setup,
  spaceId,
} from './community-helpers';

const target: ComposeTarget = {
  operation: 'publish_post',
  spaceId,
  category: 'discussion',
};
const reviewUnavailable = () =>
  capabilities({
    publish: {
      availability: 'unavailable',
      reason: 'CONTENT_REVIEW_UNAVAILABLE',
    },
    canDisableComments: true,
  });

// These are client-only synthetic contracts. Real HTTP/PG acceptance uses the
// ordinary runtime providers separately; an allowed unit fixture is not issuance.
test('runtime publication remains unavailable even with eligible identity modes and comment-control authorization', () => {
  const value = decodeCapabilities(reviewUnavailable());
  assert.equal(value.publish.availability, 'unavailable');
  assert.deepEqual(value.authorModes, ['named', 'anonymous']);
  assert.equal(value.canDisableComments, true);
  assert.equal(value.mediaAvailability, 'unavailable');
  const commentValue = decodeCommentCapabilities(
    commentCapabilities({
      availability: 'unavailable',
      reason: 'CONTENT_REVIEW_UNAVAILABLE',
    }),
  );
  assert.equal(commentValue.availability, 'unavailable');
  assert.equal(commentValue.forcedAuthorMode, 'anonymous');
  for (const field of [
    'approvalDecisionId',
    'identityCampusId',
    'affiliationAssertionId',
    'topologyRevision',
    'phoneVerified',
    'studentNumber',
    'canManage',
  ]) {
    assert.throws(() => decodeCapabilities({ ...value, [field]: otherId }));
    assert.throws(() =>
      decodeCapabilities({
        ...value,
        publish: { ...value.publish, [field]: otherId },
      }),
    );
    assert.throws(() =>
      decodeCommentCapabilities({ ...commentValue, [field]: otherId }),
    );
  }
  assert.throws(() =>
    decodeCapabilities({ ...value, mediaAvailability: 'available' }),
  );
  assert.throws(() =>
    decodeCapabilities({
      ...value,
      publish: {
        availability: 'allowed',
        reason: 'CONTENT_REVIEW_UNAVAILABLE',
      },
    }),
  );
});

test('publication intents cannot carry approval, policy, identity or synchronization authority', () => {
  const root = {
    clientRequestId: requestId,
    text: '客户端只能提交内容与所选展示方式',
    imageAssetIds: [],
    authorMode: 'anonymous',
  };
  for (const field of [
    'approvalDecisionId',
    'approval',
    'policyRevision',
    'publicationScope',
    'identityCampusId',
    'affiliationVerified',
    'phoneVerified',
    'studentNumber',
    'crossRegionAllowed',
    'relatedSync',
  ]) {
    assert.throws(() => decodePostIntent({ ...intent(), [field]: true }));
    assert.throws(() => decodeCommentIntent({ ...root, [field]: true }));
    assert.throws(() =>
      decodeReplyIntent({ ...root, targetReplyId: null, [field]: true }),
    );
  }
});

test('missing approval and unknown authority never become terminal publication rejection receipts', () => {
  for (const code of [
    'CONTENT_REVIEW_UNAVAILABLE',
    'COMMUNITY_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'AUTHORIZATION_UNAVAILABLE',
  ])
    assert.throws(() =>
      decodeReceipt({
        requestId,
        operation: 'publish_post',
        outcome: 'rejected',
        code,
      }),
    );
  assert.match(reasonMessage('CONTENT_REVIEW_UNAVAILABLE'), /尚未开放审核/);
  assert.match(
    reasonMessage('IDENTITY_CAMPUS_REQUIRED'),
    /身份校区页面明确选择/,
  );
  assert.match(
    reasonMessage('STUDENT_VERIFICATION_REQUIRED'),
    /不要求学号认证/,
  );
  assert.match(
    reasonMessage('AFFILIATION_VERIFICATION_REQUIRED'),
    /不要求学号认证/,
  );
});

test('unavailable publication does not gate feed continuation, readable detail, likes, saves, preferences, poll votes or formation joining', async () => {
  const s = setup(),
    composeViews: ComposeView[] = [],
    detailViews: DetailView[] = [],
    feedViews: FeedView[] = [];
  s.gateway.capabilitiesImpl = async () => reviewUnavailable();
  s.gateway.commentCapabilitiesImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'VERIFICATION_UNAVAILABLE',
      httpStatus: 503,
    });
  };
  const compose = new ComposeController(s.runtime, target, (view) =>
    composeViews.push(view),
  );
  await compose.load();
  compose.setText('只能保存草稿');
  compose.setRestricted(true);
  assert.equal(composeViews[composeViews.length - 1]?.canDisableComments, true);
  assert.equal(composeViews[composeViews.length - 1]?.canSubmit, false);
  assert.match(composeViews[composeViews.length - 1]!.blocker, /尚未开放审核/);
  await compose.submit();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  assert.equal(s.runtime.pending.load(s.accountId), null);

  const readable = post({ viewer: { ...post().viewer, canComment: false } });
  s.gateway.postImpl = async () => readable;
  s.gateway.feedImpl = async (query) => ({
    items: [readable],
    nextCursor: query.cursor ? null : 'next',
    continuation: query.cursor ? 'end' : 'available',
  });
  const feed = new FeedController(s.runtime, (view) => feedViews.push(view));
  await feed.load();
  assert.equal(feedViews[feedViews.length - 1]?.canLoadMore, true);
  await feed.more();
  assert.equal(feedViews[feedViews.length - 1]?.posts[0]?.text, readable.text);
  assert.equal(feedViews[feedViews.length - 1]?.continuation, 'end');
  const detail = new DetailController(s.runtime, postId, (view) =>
    detailViews.push(view),
  );
  await detail.load();
  await detail.setLiked(true);
  assert.equal(detailViews[detailViews.length - 1]?.post?.viewer.isLiked, true);
  assert.equal(
    detailViews[detailViews.length - 1]?.post?.viewer.canComment,
    false,
  );
  assert.equal(detailViews[detailViews.length - 1]?.post?.text, readable.text);
  const saved = new SavedMutationController(s.runtime, () => undefined);
  await saved.load(readable);
  await saved.setSaved(readable, true);
  await saved.setPreference('saved', false);
  const poll = new PollController(s.runtime, postId, () => undefined);
  await poll.load({ ...pollPost(), viewer: readable.viewer });
  await poll.select(optionOne);
  const formation = new FormationController(s.runtime, postId, () => undefined);
  await formation.load({
    ...formationPost(),
    viewer: { ...formationPost().viewer, canComment: false },
  });
  formation.setContact('wechat', 'consented-synthetic-contact');
  formation.setConsent(true);
  await formation.join();
  for (const method of ['like', 'applySaved', 'castBallot', 'joinFormation'])
    assert.ok(
      s.gateway.calls.some((call) => call.method === method),
      method,
    );
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'capabilities').length,
    1,
  );
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'commentCapabilities'),
    false,
  );
  for (const controller of [compose, feed, detail, saved, poll, formation])
    controller.dispose();
});

test('root and reply identity choices follow their own capability result, without a local cross-region or student-number gate', async () => {
  for (const operation of ['publish_comment', 'publish_reply'] as const) {
    const s = setup(),
      views: ComposeView[] = [];
    const named = {
      kind: 'named' as const,
      profileId: otherId,
      displayName: '合成公开作者',
      avatar: null,
    };
    s.gateway.postImpl = async () =>
      post({ author: named, viewer: { ...post().viewer, isSelf: false } });
    s.gateway.commentImpl = async () => comment({ author: named });
    s.gateway.capabilitiesImpl = async () => {
      throw new Error('Post permission must not gate comment identity');
    };
    s.gateway.commentCapabilitiesImpl = async () =>
      commentCapabilities({
        authorModes: ['named', 'anonymous'],
        forcedAuthorMode: null,
      });
    const controller = new ComposeController(
      s.runtime,
      operation === 'publish_comment'
        ? { operation, postId }
        : { operation, postId, rootCommentId: commentId, targetReplyId: null },
      (view) => views.push(view),
    );
    await controller.load();
    controller.setAuthorMode('anonymous');
    controller.setText('按服务端允许的身份参与');
    assert.equal(views[views.length - 1]?.canSubmit, true);
    await controller.submit();
    const sent = s.gateway.calls.find(
      (call) =>
        call.method ===
        (operation === 'publish_comment' ? 'publishComment' : 'publishReply'),
    );
    assert.ok(sent);
    assert.equal(
      (sent.args[1] as { authorMode: string }).authorMode,
      'anonymous',
    );
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'capabilities'),
      false,
    );
    controller.dispose();
  }
});

test('original receipt recovery bypasses missing publication facts and does not settle an unavailable review response', async () => {
  const s = setup(),
    views: ComposeView[] = [];
  const pending = {
    version: 1 as const,
    accountId: s.accountId,
    operation: 'publish_post' as const,
    payload: intent(),
  };
  s.runtime.pending.freeze(pending);
  s.gateway.capabilitiesImpl = async () => {
    throw new Error('No capability lookup during recovery');
  };
  s.gateway.postImpl = async () => {
    throw new Error('No parent lookup during recovery');
  };
  const controller = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  await controller.load();
  s.gateway.receiptImpl = async () =>
    ({
      requestId,
      operation: 'publish_post',
      outcome: 'rejected',
      code: 'CONTENT_REVIEW_UNAVAILABLE',
    }) as Receipt;
  await controller.recover();
  assert.equal(views[views.length - 1]?.frozen, true);
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.gateway.receiptImpl = async () => receipt();
  await controller.recover();
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['receipt', 'receipt'],
  );
  controller.dispose();
});

test('late capability responses cannot revive a draft after account/login replacement or root hide', async () => {
  for (const lifecycle of ['login', 'hide']) {
    const s = setup(),
      views: ComposeView[] = [],
      delayed = deferred<Capabilities>();
    s.gateway.capabilitiesImpl = () => delayed.promise;
    const controller = new ComposeController(s.runtime, target, (view) =>
      views.push(view),
    );
    const loading = controller.load();
    await flush();
    if (lifecycle === 'login')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    else s.runtime.privateViews!.clear();
    delayed.resolve(reviewUnavailable());
    await loading;
    assert.equal(views[views.length - 1]?.loaded, false);
    assert.equal(views[views.length - 1]?.text, '');
    assert.equal(views[views.length - 1]?.canDisableComments, false);
    assert.equal(views[views.length - 1]?.canSubmit, false);
    controller.dispose();
  }
});
