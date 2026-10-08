import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  decodeErrandNotice,
  decodeErrandNoticeRead,
  decodeErrandNoticesPage,
  decodeErrandUnread,
  ErrandNoticesController,
  HttpErrandNoticesGateway,
  initialErrandNoticesView,
  type ErrandNotice,
  type ErrandNoticesGateway,
  type ErrandNoticesPage,
} from '../src/errands/notices';
import { setup } from './community-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
const id = '11111111-1111-4111-8111-111111111111',
  orderId = '22222222-2222-4222-8222-222222222222',
  otherId = '33333333-3333-4333-8333-333333333333',
  time = '2026-10-08T12:00:00.000Z';
const notice = (patch: Partial<ErrandNotice> = {}): ErrandNotice => ({
  noticeId: id,
  kind: 'accepted',
  orderId,
  createdAt: time,
  readAt: null,
  ...patch,
});
const page = (patch: Partial<ErrandNoticesPage> = {}): ErrandNoticesPage => ({
  items: [notice()],
  nextCursor: null,
  unreadCount: 1,
  ...patch,
});
function fixture() {
  const s = setup();
  let view = initialErrandNoticesView();
  const calls: string[] = [];
  const behavior: ErrandNoticesGateway = {
    list: async () => page(),
    read: async (noticeId) => ({ noticeId, readAt: time, unreadCount: 0 }),
    unread: async () => ({ unreadCount: 1 }),
  };
  const gateway: ErrandNoticesGateway = {
    list: (...args) => {
      calls.push('list');
      return behavior.list(...args);
    },
    read: (...args) => {
      calls.push('read');
      return behavior.read(...args);
    },
    unread: (...args) => {
      calls.push('unread');
      return behavior.unread(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    errandNotices: gateway,
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  const controller = new ErrandNoticesController(runtime, (v) => {
    view = v;
  });
  return { ...s, runtime, controller, calls, behavior, view: () => view };
}
test('errand notices close every nested projection and reject counts/timestamps/unknown event variants', () => {
  assert.equal(decodeErrandNotice(notice()).kind, 'accepted');
  assert.equal(
    decodeErrandNotice(notice({ kind: 'completed' })).kind,
    'completed',
  );
  for (const raw of [
    { ...notice(), contacts: { wechat: 'private' } },
    { ...notice(), privateText: 'private' },
    { ...notice(), kind: 'deleted' },
    { ...notice(), createdAt: '2026-02-30T12:00:00Z' },
    { ...notice(), orderId: 'wrong' },
  ])
    assert.throws(() => decodeErrandNotice(raw));
  for (const raw of [
    page({ unreadCount: 0 }),
    page({ items: [notice(), notice()] }),
    page({ nextCursor: 'bad' }),
    { ...page(), privateText: 'private' },
  ])
    assert.throws(() => decodeErrandNoticesPage(raw));
  assert.throws(() =>
    decodeErrandNoticeRead({ noticeId: id, readAt: time, unreadCount: -1 }),
  );
  assert.throws(() =>
    decodeErrandUnread({ unreadCount: 1, contacts: 'private' }),
  );
});
test('real notices gateway authenticates, verifies exact target, bounds cursor and sends empty owner read body', async () => {
  const s = setup(),
    transport = new ScriptedTransport(),
    gateway = new HttpErrandNoticesGateway(
      new ApiClient('https://api.example', transport, s.sessions, {
        refresh: async () => {
          throw new Error('Unexpected refresh');
        },
      }),
    );
  transport.reply(page());
  await gateway.list(null, new Cancellation());
  assert.equal(
    transport.requests[0]!.url,
    'https://api.example/v1/me/errand-notices?limit=20',
  );
  assert.ok(transport.requests[0]!.headers.Authorization);
  assert.equal(transport.requests[0]!.body, undefined);
  transport.reply({ noticeId: id, readAt: time, unreadCount: 0 });
  await gateway.read(id, new Cancellation());
  assert.equal(transport.requests[1]!.method, 'PUT');
  assert.deepEqual(transport.requests[1]!.body, {});
  transport.reply({ noticeId: otherId, readAt: time, unreadCount: 0 });
  await assert.rejects(gateway.read(id, new Cancellation()));
  await assert.rejects(gateway.list('not-opaque', new Cancellation()));
  transport.reply({ unreadCount: 1 });
  assert.equal((await gateway.unread(new Cancellation())).unreadCount, 1);
});
test('notice list does not acknowledge and explicit owner read coalesces repeated taps', async () => {
  const s = fixture();
  await s.controller.load();
  assert.deepEqual(s.calls, ['list']);
  assert.equal(
    s.controller.orderPath(id),
    `/pages/errand-detail/errand-detail?orderId=${orderId}`,
  );
  assert.equal(s.controller.orderPath(otherId), null);
  const hold = deferred<{
    noticeId: string;
    readAt: string;
    unreadCount: number;
  }>();
  s.behavior.read = () => hold.promise;
  const first = s.controller.read(id),
    second = s.controller.read(id);
  await flush();
  assert.equal(s.calls.filter((v) => v === 'read').length, 1);
  assert.equal(s.view().items[0]!.readAt, null);
  hold.resolve({ noticeId: id, readAt: time, unreadCount: 0 });
  await Promise.all([first, second]);
  assert.equal(s.view().unreadCount, 0);
  assert.equal(s.view().items[0]!.readAt, time);
  s.controller.dispose();
});
for (const invalidation of ['hide', 'logout', 'relogin', 'safety'] as const)
  test(`late private notice list cannot repopulate after ${invalidation}`, async () => {
    const s = fixture(),
      hold = deferred<ErrandNoticesPage>();
    s.behavior.list = () => hold.promise;
    const load = s.controller.load();
    await flush();
    if (invalidation === 'hide') s.runtime.privateViews!.clear();
    else if (invalidation === 'logout') s.sessions.logout();
    else if (invalidation === 'relogin')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
    else s.runtime.safetyChanges.invalidate(s.accountId);
    hold.resolve(page());
    await load;
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, 0);
    assert.equal(s.controller.orderPath(id), null);
    s.controller.dispose();
  });
test('read uncertainty retains unread value for safe retry and definitive bad target clears owner list', async () => {
  const s = fixture();
  await s.controller.load();
  s.behavior.read = async () => {
    throw new ClientError('network', 'Synthetic loss');
  };
  await s.controller.read(id);
  assert.equal(s.view().unreadCount, 1);
  assert.equal(s.view().items[0]!.readAt, null);
  s.behavior.read = async () => ({
    noticeId: otherId,
    readAt: time,
    unreadCount: 0,
  });
  await s.controller.read(id);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().unreadCount, 0);
  s.controller.dispose();
});
test('explicit notice end prevents repeated final page fetches and cursor loops clear data', async () => {
  const s = fixture();
  await s.controller.load();
  await s.controller.more();
  await s.controller.more();
  assert.deepEqual(s.calls, ['list']);
  const cursor = 'a'.repeat(43);
  s.behavior.list = async () => page({ nextCursor: cursor });
  await s.controller.load();
  await s.controller.more();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().canMore, false);
  s.controller.dispose();
});

test('real backend ERRAND_NOT_FOUND 404 clears stale notice list, unread count and navigation', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpErrandNoticesGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    }),
  );
  let view = initialErrandNoticesView();
  const controller = new ErrandNoticesController(
    { ...s.runtime, errandNotices: gateway },
    (next) => {
      view = next;
    },
  );
  transport.reply(page());
  await controller.load();
  assert.equal(view.items.length, 1);
  assert.equal(view.unreadCount, 1);
  assert.ok(controller.orderPath(id));
  transport.reply({ error: { code: 'ERRAND_NOT_FOUND' } }, 404);
  await controller.read(id);
  assert.equal(view.loaded, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.unreadCount, 0);
  assert.equal(controller.orderPath(id), null);
  assert.doesNotMatch(view.status, /已读结果尚未确认/);
  controller.dispose();
});
