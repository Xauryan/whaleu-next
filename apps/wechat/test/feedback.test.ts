import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePost, decodePostIntent } from '../src/community/contract';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  FeedbackController,
  type FeedbackView,
} from '../src/pages/feedback/controller';
import { batchPublicationReference } from '../src/media/batch-publication';
import { ClientError } from '../src/api/errors';
import { decodeFeedbackContacts } from '../src/community/feedback-contract';
import {
  spaceId,
  requestId,
  intent,
  post,
  space,
  setup,
} from './community-helpers';
const payload = () =>
  decodePostIntent({
    ...intent({ category: 'feedback' }),
    feedback: { contacts: { wechat: 'contact', qq: '', phone: '' } },
  });
test('strict native feedback category retains contacts, bounds and exact recovery hash', () => {
  const body = payload();
  assert.deepEqual(
    body.feedback?.contacts,
    decodeFeedbackContacts({ wechat: 'contact', qq: '', phone: '' }),
  );
  assert.deepEqual(decodeFeedbackContacts({ wechat: '', qq: '', phone: '' }), {
    wechat: '',
    qq: '',
    phone: '',
  });
  for (const input of [
    { ...body, feedback: undefined },
    { ...body, category: 'discussion' },
    { ...body, allowAnonymousDm: false },
    {
      ...body,
      feedback: { contacts: { wechat: '中'.repeat(17), qq: '', phone: '' } },
    },
  ])
    assert.throws(() => decodePostIntent(input));
  const s = setup(),
    attempt = {
      version: 1 as const,
      accountId: s.accountId,
      operation: 'publish_post' as const,
      payload: body,
    };
  s.runtime.pending.freeze(attempt);
  assert.deepEqual(s.runtime.pending.load(s.accountId), attempt);
  assert.notEqual(
    batchPublicationReference(attempt).intentHash,
    batchPublicationReference({
      ...attempt,
      payload: {
        ...body,
        feedback: { contacts: { wechat: 'changed', qq: '', phone: '' } },
      },
    }).intentHash,
  );
});
test('feedback DTO has trusted category and public school metadata without contact or private identity', () => {
  const value = {
    ...post(),
    category: 'feedback',
    space: { id: spaceId, kind: 'global', name: 'feedback' },
    feedback: { authorSchool: '认证学校', hasContacts: true },
  };
  assert.equal(decodePost(value).feedback?.authorSchool, '认证学校');
  for (const patch of [
    { feedback: undefined },
    { feedback: { ...value.feedback, contacts: { phone: 'private' } } },
    { space: { ...value.space, kind: 'regional' } },
  ])
    assert.throws(() => decodePost({ ...value, ...patch }));
});
test('feedback draft, explicit contact consent and pending Review preserve anonymous identity and every field across reload', async () => {
  const s = setup();
  let view!: ComposeView;
  const submissions: unknown[] = [];
  Object.assign(s.gateway, {
    submitReview: async (attempt: unknown) => {
      submissions.push(attempt);
      return { requestId, operation: 'publish_post', status: 'pending' };
    },
    reviewStatus: async () => ({
      requestId,
      operation: 'publish_post',
      status: 'pending',
    }),
  });
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'missing', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const target = {
    operation: 'publish_post' as const,
    spaceId,
    category: 'feedback' as const,
  };
  let controller = new ComposeController(s.runtime, target, (v) => (view = v));
  await controller.load();
  controller.setText('公开建议');
  controller.setAuthorMode('anonymous');
  controller.setFeedbackField('wechat', 'exact-wechat');
  assert.equal(view.canSubmit, false);
  controller.setFeedbackConsent(true);
  assert.equal(view.canSubmit, true, view.blocker);
  assert.equal(view.canAddPoll, false);
  assert.equal(view.canChooseAnonymousDm, false);
  controller.dispose();
  controller = new ComposeController(s.runtime, target, (v) => (view = v));
  await controller.load();
  assert.equal(view.feedbackDraft.wechat, 'exact-wechat');
  assert.equal(view.feedbackDraft.consent, true);
  await controller.submit();
  assert.equal(view.reviewStatus, 'pending', view.error);
  const pending = s.runtime.pending.load(s.accountId)!;
  assert.equal(pending.payload.authorMode, 'anonymous');
  assert.equal(pending.operation, 'publish_post');
  if (pending.operation === 'publish_post')
    assert.equal(pending.payload.feedback?.contacts.wechat, 'exact-wechat');
  assert.equal(submissions.length, 1);
  controller.dispose();
  controller = new ComposeController(s.runtime, null, (v) => (view = v));
  await controller.load();
  assert.equal(view.frozen, true);
  assert.equal(view.feedbackDraft.wechat, 'exact-wechat');
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  controller.dispose();
});
test('feedback feed ignores browsing campus and requests only exact topic/category', async () => {
  const s = setup();
  let view!: FeedbackView;
  const topic = space({ kind: 'global', operatingRegionId: null });
  const row = post({
    category: 'feedback',
    space: topic,
    feedback: { authorSchool: null, hasContacts: false },
  });
  Object.assign(s.gateway, {
    feedbackTopic: async () => ({ topic: 'feedback', space: topic }),
    feed: async (query: { spaceId: string; category: string }) => {
      assert.deepEqual(query, { spaceId, category: 'feedback' });
      return { items: [row], nextCursor: null, continuation: 'end' };
    },
  });
  const controller = new FeedbackController(s.runtime, (v) => (view = v));
  await controller.load();
  assert.equal(view.loaded, true);
  assert.equal(view.posts.length, 1);
  controller.dispose();
});
