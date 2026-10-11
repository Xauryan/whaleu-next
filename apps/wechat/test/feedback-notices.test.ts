import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  decodeFeedbackNotice,
  decodeFeedbackNoticeTarget,
  decodeFeedbackNoticesList,
} from '../src/community/feedback-notices-contract';
import type {
  FeedbackNotice,
  FeedbackNoticeRead,
  FeedbackNoticeTarget,
} from '../src/community/feedback-notices-contract';
import { HttpFeedbackNoticesGateway } from '../src/community/feedback-notices-gateway';
import type { FeedbackNoticesGateway } from '../src/community/feedback-notices-gateway';
import {
  FeedbackNoticesController,
  initialFeedbackNoticesView,
} from '../src/pages/feedback-notices/controller';
import { Cancellation } from '../src/platform/contracts';
import {
  createdAt,
  otherId,
  post,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const notice = (patch: Partial<FeedbackNotice> = {}): FeedbackNotice => ({
  noticeId: requestId,
  kind: 'feedback_created',
  createdAt,
  readAt: null,
  ...patch,
});
const list = (nextCursor: string | null = null) => ({
  items: [notice()],
  nextCursor,
  unreadCount: 5,
});
function harness() {
  const s = setup();
  const calls: string[] = [],
    urls: string[] = [];
  const behavior: FeedbackNoticesGateway = {
    list: async () => list(),
    unread: async () => ({ unreadCount: 5 }),
    target: async (noticeId) => ({ noticeId, status: 'available', postId }),
    read: async (noticeId) => ({ noticeId, readAt: createdAt, unreadCount: 4 }),
  };
  const feedbackNotices: FeedbackNoticesGateway = {
    list: (...args) => {
      calls.push('list');
      return behavior.list(...args);
    },
    unread: (...args) => {
      calls.push('unread');
      return behavior.unread(...args);
    },
    target: (...args) => {
      calls.push('target');
      return behavior.target(...args);
    },
    read: (...args) => {
      calls.push('read');
      return behavior.read(...args);
    },
  };
  s.gateway.postImpl = async () => post({ category: 'feedback' });
  let view = initialFeedbackNoticesView();
  const runtime = { ...s.runtime, feedbackNotices };
  const controller = new FeedbackNoticesController(
    runtime,
    (next) => {
      view = next;
    },
    async (url) => {
      urls.push(url);
    },
  );
  return { ...s, behavior, calls, urls, runtime, controller, view: () => view };
}

test('feedback notice decoders reject historical identity/content and unavailable locators', () => {
  assert.deepEqual(decodeFeedbackNotice(notice()), notice());
  for (const key of ['postId', 'accountId', 'author', 'preview', 'feedback'])
    assert.throws(() => decodeFeedbackNotice({ ...notice(), [key]: otherId }), {
      kind: 'protocol',
    });
  assert.deepEqual(
    decodeFeedbackNoticeTarget({ noticeId: requestId, status: 'unavailable' }),
    { noticeId: requestId, status: 'unavailable' },
  );
  assert.throws(
    () =>
      decodeFeedbackNoticeTarget({
        noticeId: requestId,
        status: 'unavailable',
        postId,
      }),
    { kind: 'protocol' },
  );
  assert.throws(
    () => decodeFeedbackNoticesList({ ...list(), items: [notice(), notice()] }),
    { kind: 'protocol' },
  );
  assert.throws(
    () => decodeFeedbackNoticesList({ ...list(), unreadCount: 0 }),
    { kind: 'protocol' },
  );
});

test('feedback gateway uses authenticated owner routes and rejects mismatched target/notice responses', async () => {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport(),
    cancel = new Cancellation();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpFeedbackNoticesGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        throw new Error('No provider');
      },
    }),
  );
  transport.reply(list());
  await gateway.list(null, cancel);
  transport.reply({ noticeId: requestId, status: 'available', postId });
  await gateway.target(requestId, cancel);
  transport.reply({ noticeId: requestId, readAt: createdAt, unreadCount: 4 });
  await gateway.read(requestId, cancel);
  assert.deepEqual(
    transport.requests.map((r) => [r.method, new URL(r.url).pathname, r.body]),
    [
      ['GET', '/v1/me/feedback-notices', undefined],
      ['GET', `/v1/me/feedback-notices/${requestId}/target`, undefined],
      ['PUT', `/v1/me/feedback-notices/${requestId}/read`, {}],
    ],
  );
  assert.ok(transport.requests.every((r) => r.headers.Authorization));
  transport.reply({ noticeId: otherId, status: 'available', postId });
  await assert.rejects(gateway.target(requestId, cancel), { kind: 'protocol' });
  const before = transport.requests.length;
  await assert.rejects(gateway.target('../other', cancel), {
    kind: 'protocol',
  });
  await assert.rejects(gateway.list(null, cancel, 51), { kind: 'protocol' });
  assert.equal(transport.requests.length, before);
});

test('feedback list and pagination neither fetch content nor mark read; available targets use ordinary exact post navigation', async () => {
  const s = harness();
  s.behavior.list = async () => list('next');
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.deepEqual(s.calls, ['list']);
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.storage.data.size, 0);
  s.behavior.list = async () => ({
    items: [notice({ noticeId: otherId })],
    unreadCount: 5,
    nextCursor: null,
  });
  await s.controller.more();
  assert.equal(s.view().items.length, 2);
  await s.controller.open(requestId);
  assert.deepEqual(s.urls, [
    `/pages/community-detail/community-detail?postId=${postId}`,
  ]);
  assert.deepEqual(s.calls, ['list', 'list', 'target']);
  assert.deepEqual(
    s.gateway.calls.map((x) => x.method),
    ['post'],
  );
  assert.equal(s.view().items[0]!.readAt, null);
});

test('inaccessible and wrong-category feedback targets cannot navigate or expose cached content', async () => {
  const s = harness();
  await s.controller.load();
  s.behavior.target = async (noticeId) => ({ noticeId, status: 'unavailable' });
  await s.controller.open(requestId);
  assert.equal(s.view().items[0]!.available, false);
  assert.equal(s.gateway.calls.length, 0);
  assert.deepEqual(s.urls, []);
  await s.controller.acknowledge(requestId);
  assert.equal(s.calls.includes('read'), false);
  const wrong = harness();
  await wrong.controller.load();
  wrong.gateway.postImpl = async () => post();
  await wrong.controller.open(requestId);
  assert.deepEqual(wrong.urls, []);
  assert.equal(wrong.view().items.length, 0);
});

test('revoked or unavailable super-admin authority clears existing list and unread count', async () => {
  for (const code of [
    'AUTHORIZATION_REQUIRED',
    'AUTHORIZATION_UNAVAILABLE',
    'NOTICE_NOT_FOUND',
  ]) {
    const s = harness();
    await s.controller.load();
    s.behavior.target = async () => {
      throw new ClientError('business', 'Authority unavailable', {
        serverCode: code,
      });
    };
    await s.controller.open(requestId);
    assert.equal(s.view().items.length, 0);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().unreadCount, 0);
    assert.deepEqual(s.urls, []);
  }
});

test('lost feedback read response stays uncertain and retry reconciles canonical first-read state', async () => {
  const s = harness();
  await s.controller.load();
  let committed = false;
  s.behavior.read = async (noticeId) => {
    if (!committed) {
      committed = true;
      throw new ClientError('timeout', 'Committed response lost');
    }
    return { noticeId, readAt: createdAt, unreadCount: 4 };
  };
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, null);
  assert.equal(s.view().unreadCount, 5);
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, createdAt);
  assert.equal(s.view().unreadCount, 4);
  await s.controller.acknowledge(requestId);
  assert.equal(s.calls.filter((x) => x === 'read').length, 2);
});

test('feedback navigation is invalidated on hide, cancel, new load and replacement login', async () => {
  for (const change of ['hide', 'cancel', 'load', 'login'] as const) {
    const s = harness();
    await s.controller.load();
    const pending = deferred<FeedbackNoticeTarget>();
    s.behavior.target = () => pending.promise;
    const opening = s.controller.open(requestId);
    await flush();
    await s.controller.open(requestId);
    assert.equal(s.calls.filter((x) => x === 'target').length, 1);
    if (change === 'hide') s.controller.dispose();
    if (change === 'cancel') s.controller.cancel();
    if (change === 'load') await s.controller.load();
    if (change === 'login')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    pending.resolve({ noticeId: requestId, status: 'available', postId });
    await opening;
    await flush();
    assert.deepEqual(s.urls, []);
    assert.equal(s.gateway.calls.length, 0);
  }
});

test('feedback read callback after disposal cannot restore private list or counts', async () => {
  const s = harness();
  await s.controller.load();
  const pending = deferred<FeedbackNoticeRead>();
  s.behavior.read = () => pending.promise;
  const reading = s.controller.acknowledge(requestId);
  await flush();
  s.controller.dispose();
  pending.resolve({ noticeId: requestId, readAt: createdAt, unreadCount: 4 });
  await reading;
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().unreadCount, 0);
});
