import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { Cancellation, type HttpRequest } from '../src/platform/contracts';
import { SafetyChanges } from '../src/community/safety-changes';
import { HttpErrandsGateway } from '../src/errands/gateway';
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
const notice = (
  patch: Partial<
    Extract<ErrandNotice, { kind: 'accepted' | 'completed' }>
  > = {},
): ErrandNotice => ({
  noticeId: id,
  kind: 'accepted',
  orderId,
  createdAt: time,
  readAt: null,
  ...patch,
});
const administrative = (): ErrandNotice[] => [
  {
    noticeId: id,
    kind: 'admin_deleted',
    orderId,
    deletionReason: { status: 'provided', value: '合成删除原因' },
    createdAt: time,
    readAt: null,
  },
  {
    noticeId: otherId,
    kind: 'feature_restricted',
    restrictionId: orderId,
    eventId: '44444444-4444-4444-8444-444444444444',
    action: 'all',
    reason: '合成限制原因',
    startsAt: time,
    endsAt: null,
    createdAt: time,
    readAt: null,
  },
  {
    noticeId: '55555555-5555-4555-8555-555555555555',
    kind: 'feature_released',
    restrictionId: orderId,
    eventId: '66666666-6666-4666-8666-666666666666',
    action: 'accept',
    reason: '合成解除原因',
    releasedAt: time,
    createdAt: time,
    readAt: null,
  },
];
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
    hold.resolve(page({ items: administrative(), unreadCount: 3 }));
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

test('admin notifications remain local and only accepted/completed navigate to freshly authorized detail', async () => {
  const s = fixture();
  s.behavior.list = async () =>
    page({ items: administrative(), unreadCount: 3 });
  await s.controller.load();
  assert.deepEqual(s.view().items, administrative());
  assert.deepEqual(s.calls, ['list']);
  for (const item of s.view().items)
    assert.equal(s.controller.orderPath(item.noticeId), null);
  for (const kind of ['accepted', 'completed'] as const) {
    s.behavior.list = async () => page({ items: [notice({ kind })] });
    await s.controller.load();
    assert.equal(
      s.controller.orderPath(id),
      `/pages/errand-detail/errand-detail?orderId=${orderId}`,
    );
  }
  s.controller.dispose();
});

test('local administrative snapshots survive unrelated order detail 404 and acknowledge through the unchanged owner route', async () => {
  const s = setup(),
    transport = new ScriptedTransport(),
    api = new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    }),
    gateway = new HttpErrandNoticesGateway(api),
    orders = new HttpErrandsGateway(api);
  let view = initialErrandNoticesView();
  const controller = new ErrandNoticesController(
    { ...s.runtime, errandNotices: gateway },
    (next) => {
      view = next;
    },
  );
  transport.reply(page({ items: administrative(), unreadCount: 3 }));
  await controller.load();
  assert.equal(transport.requests.length, 1);
  assert.equal(controller.orderPath(id), null);
  transport.reply({ error: { code: 'ERRAND_NOT_FOUND' } }, 404);
  await assert.rejects(orders.detail(orderId, new Cancellation()));
  assert.deepEqual(view.items, administrative());
  for (const [index, item] of administrative().entries()) {
    transport.reply({
      noticeId: item.noticeId,
      readAt: time,
      unreadCount: 2 - index,
    });
    await controller.read(item.noticeId);
    assert.equal(view.items[index]!.readAt, time);
    assert.equal(view.unreadCount, 2 - index);
    const request: HttpRequest =
      transport.requests[transport.requests.length - 1]!;
    assert.equal(
      request.url,
      `https://api.example/v1/me/errand-notices/${item.noticeId}/read`,
    );
    assert.equal(request.method, 'PUT');
    assert.deepEqual(request.body, {});
  }
  assert.equal(view.items[0]!.kind, 'admin_deleted');
  if (view.items[0]!.kind === 'admin_deleted')
    assert.deepEqual(view.items[0]!.deletionReason, {
      status: 'provided',
      value: '合成删除原因',
    });
  controller.dispose();
});

for (const boundary of [
  'hide',
  'relogin',
  'account',
  'safety',
  'cancel',
] as const)
  test(`late administrative notice read cannot repopulate after ${boundary}`, async () => {
    const s = fixture(),
      hold = deferred<{
        noticeId: string;
        readAt: string;
        unreadCount: number;
      }>();
    s.behavior.list = async () =>
      page({ items: administrative(), unreadCount: 3 });
    await s.controller.load();
    s.behavior.read = () => hold.promise;
    const first = s.controller.read(id),
      repeated = s.controller.read(id);
    await flush();
    assert.equal(s.calls.filter((method) => method === 'read').length, 1);
    if (boundary === 'hide') s.runtime.privateViews!.clear();
    else if (boundary === 'relogin')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
    else if (boundary === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
    else if (boundary === 'safety')
      s.runtime.safetyChanges.invalidate(s.accountId);
    else s.controller.cancel();
    hold.resolve({ noticeId: id, readAt: time, unreadCount: 2 });
    await Promise.all([first, repeated]);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, 0);
    assert.equal(s.controller.orderPath(id), null);
    s.controller.dispose();
  });
