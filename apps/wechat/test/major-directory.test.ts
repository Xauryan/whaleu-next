import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import {
  HttpMajorDirectoryGateway,
  type MajorDirectoryGateway,
} from '../src/majors/gateway';
import {
  decodeMajor,
  decodeMajorSummary,
  decodeMajorDepartments,
  decodeMajorPage,
  decodeMajorDetail,
  decodeMajorQuery,
  type Major,
  type MajorPage,
  type MajorDetail,
  type MajorDepartments,
} from '../src/majors/contract';
import {
  MajorDirectoryController,
  type MajorDirectoryView,
  type MajorMode,
} from '../src/majors/controller';
import { setup as communitySetup } from './community-helpers';
import { ScriptedTransport, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  id,
  revision,
  catalogRevision,
  otherId,
  rootId,
  item as discussionItem,
} from './major-discussion-helpers';
const campusId = '44444444-4444-4444-8444-444444444444';
export const major = (patch: Partial<Major> = {}): Major => ({
  id,
  majorRevision: revision,
  catalogRevision,
  campusId,
  departmentId: 110,
  collegeName: '合成学院',
  majorName: '合成专业',
  summary: { kind: 'unavailable' },
  ...patch,
});
export const majorPage = (patch: Partial<MajorPage> = {}): MajorPage => ({
  catalogRevision,
  items: [major()],
  totalCount: 1,
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const departments = (): MajorDepartments => ({
  catalogRevision,
  items: [
    { departmentId: -10, name: '-10系' },
    { departmentId: 0, name: '0系' },
    { departmentId: 110, name: '110系' },
  ],
});
export const detail = (): MajorDetail => ({ catalogRevision, item: major() });
function gatewaySetup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  return {
    transport,
    gateway: new HttpMajorDirectoryGateway(
      new ApiClient('https://major.example', transport, sessions, {
        refresh: async () =>
          sessions.rotate(sessions.snapshot(), wireCredentials('b')),
      }),
    ),
  };
}
function harness(mode: MajorMode = 'directory') {
  const s = communitySetup(),
    queries: unknown[] = [],
    views: MajorDirectoryView[] = [];
  const impl: MajorDirectoryGateway = {
    departments: async () => departments(),
    list: async (query) => {
      queries.push(query);
      return majorPage();
    },
    detail: async () => detail(),
    related: async () => majorPage({ items: [major({ id: otherId })] }),
  };
  const runtime = { ...s.runtime, majors: impl };
  const controller = new MajorDirectoryController(runtime, mode, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    impl,
    queries,
    controller,
    view: () => views[views.length - 1]!,
  };
}
test('Major catalog owns source fields, full PG int32 department IDs, no Course whitelist or numeric scores', () => {
  for (const departmentId of [-2147483648, -10, 0, 55, 98, 110, 2147483647])
    assert.equal(
      decodeMajor(major({ departmentId })).departmentId,
      departmentId,
    );
  for (const departmentId of [0.5, -2147483649, 2147483648])
    assert.throws(() => decodeMajor(major({ departmentId })));
  assert.throws(() => decodeMajor({ ...major(), score: 5 }));
  assert.throws(() => decodeMajor({ ...major(), creatorId: id }));
  assert.throws(() => decodeMajor({ ...major(), departmentId: '110' }));
  assert.deepEqual(decodeMajorQuery({ departmentId: 110, keyword: '合成' }), {
    departmentId: 110,
    keyword: '合成',
  });
  assert.throws(() => decodeMajorQuery({ keyword: 'a'.repeat(101) }));
  assert.throws(() => decodeMajorQuery({ keyword: '😀'.repeat(51) }));
  assert.throws(() => decodeMajorQuery({ keyword: ' x ' }));
  assert.throws(() => decodeMajorQuery({ category: 'Course-only' }));
});
test('summary distinguishes unknown from accepted empty and validates complete visible hot root', () => {
  assert.deepEqual(decodeMajorSummary({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  assert.deepEqual(
    decodeMajorSummary({ kind: 'known', rootCount: 0, hotComment: null }),
    { kind: 'known', rootCount: 0, hotComment: null },
  );
  const summary = {
    kind: 'known',
    rootCount: 2,
    hotComment: { id: rootId, body: discussionItem().body, likes: 1 },
  };
  assert.deepEqual(decodeMajorSummary(summary), summary);
  for (const value of [
    { kind: 'unavailable', rootCount: 0 },
    { kind: 'known', rootCount: 1, hotComment: null },
    { ...summary, rootCount: 0 },
    {
      ...summary,
      hotComment: { ...summary.hotComment, body: '😀'.repeat(2001) },
    },
    { ...summary, hotComment: { ...summary.hotComment, authorId: id } },
  ])
    assert.throws(() => decodeMajorSummary(value));
});
test('strict directory envelopes reject duplicates, unsorted departments, stale item revision, identity leaks and impossible pages', () => {
  assert.deepEqual(decodeMajorDepartments(departments()), departments());
  assert.throws(() =>
    decodeMajorDepartments({
      ...departments(),
      items: departments().items.slice().reverse(),
    }),
  );
  assert.throws(() =>
    decodeMajorDetail({ ...detail(), catalogRevision: revision }),
  );
  assert.throws(() =>
    decodeMajorPage(majorPage({ items: [major(), major()], totalCount: 2 })),
  );
  assert.throws(() =>
    decodeMajorPage(majorPage({ continuation: 'more', nextCursor: null })),
  );
  assert.throws(() => decodeMajorPage({ ...majorPage(), authorId: id }));
});
test('authenticated directory gateway sends department and name together through independent Major routes', async () => {
  const s = gatewaySetup(),
    c = new Cancellation();
  s.transport.reply(departments());
  await s.gateway.departments(c);
  s.transport.reply(majorPage());
  await s.gateway.list({ departmentId: 110, keyword: '合成' }, null, c);
  s.transport.reply(detail());
  await s.gateway.detail(id, c);
  s.transport.reply(majorPage({ items: [major({ id: otherId })] }));
  await s.gateway.related(id, c);
  assert.deepEqual(
    s.transport.requests.map((r) => new URL(r.url).pathname),
    [
      '/v1/majors/departments',
      '/v1/majors',
      `/v1/majors/${id}`,
      `/v1/majors/${id}/related`,
    ],
  );
  const query = new URL(s.transport.requests[1]!.url).searchParams;
  assert.equal(query.get('departmentId'), '110');
  assert.equal(query.get('keyword'), '合成');
  assert.equal(
    new URL(s.transport.requests[3]!.url).searchParams.get('limit'),
    '5',
  );
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('directory gateway rejects wrong target, duplicate cursor, filter escape and unstable order', async () => {
  const s = gatewaySetup(),
    c = new Cancellation();
  s.transport.reply({ ...detail(), item: major({ id: otherId }) });
  await assert.rejects(s.gateway.detail(id, c));
  s.transport.reply(majorPage({ nextCursor: 'same', continuation: 'more' }));
  await assert.rejects(s.gateway.list({}, 'same', c));
  s.transport.reply(majorPage());
  await assert.rejects(s.gateway.list({ departmentId: 1 }, null, c));
  s.transport.reply(
    majorPage({ items: [major({ id: otherId }), major()], totalCount: 2 }),
  );
  await assert.rejects(s.gateway.list({}, null, c));
  s.transport.reply(majorPage());
  await assert.rejects(s.gateway.related(id, c));
  await assert.rejects(s.gateway.list({}, null, c, 51));
});
test('directory applies name and department only on explicit search, and presents server summary without fabricating zeros', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().items[0]?.summary.kind, 'unavailable');
  s.controller.setSearch(' 合成 ');
  s.controller.setDepartment(3);
  assert.deepEqual(s.queries, [{}]);
  await s.controller.search();
  assert.deepEqual(s.queries, [{}, { departmentId: 110, keyword: '合成' }]);
  assert.equal(s.view().appliedFilter, '110系 · 专业或学院：合成');
  assert.equal(
    s.controller.detailPath(id),
    `/pages/major-detail/major-detail?majorId=${id}`,
  );
  assert.equal(s.controller.detailPath(otherId), null);
  s.controller.dispose();
});
test('directory revision changes clear stale rows, unknown source stays unavailable, and no profile/student capability read gates browsing', async () => {
  const s = harness();
  s.impl.list = async () =>
    majorPage({ nextCursor: 'next', continuation: 'more' });
  await s.controller.load();
  assert.equal(s.view().canNext, true);
  s.impl.list = async () =>
    majorPage({
      catalogRevision: revision,
      items: [major({ catalogRevision: revision })],
    });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().restartRequired, true);
  assert.deepEqual(s.view().items, []);
  s.impl.departments = async () => {
    throw new ClientError('http', 'Unavailable', {
      serverCode: 'MAJOR_CATALOG_UNAVAILABLE',
      httpStatus: 503,
    });
  };
  await s.controller.reload();
  assert.equal(s.view().totalCount, null);
  assert.match(s.view().error, /不代表没有专业/);
  s.controller.dispose();
});
test('detail rereads source and related department priority; current failures clear stale detail and dependent routes', async () => {
  const s = harness('detail');
  await s.controller.load(id);
  assert.equal(s.view().relatedLoaded, true);
  assert.equal(s.view().detail?.item.id, id);
  assert.equal(
    s.controller.discussionPath(),
    `/pages/major-discussion/major-discussion?majorId=${id}`,
  );
  s.impl.related = async () =>
    majorPage({
      catalogRevision: revision,
      items: [major({ id: otherId, catalogRevision: revision })],
    });
  await s.controller.reloadRelated();
  assert.equal(s.view().detail, null);
  assert.equal(s.controller.discussionPath(), null);
  s.controller.dispose();
});
test('cancel, hide, account replacement and same-account login discard late directory and related callbacks', async () => {
  for (const reason of ['cancel', 'hide', 'login', 'account']) {
    const s = harness(),
      wait = deferred<MajorPage>();
    s.impl.list = () => wait.promise;
    const running = s.controller.load();
    await flush();
    if (reason === 'cancel') s.controller.cancel();
    else if (reason === 'hide') s.runtime.privateViews!.clear();
    else
      s.runtime.sessions.completeLogin(s.runtime.sessions.beginLogin(), {
        ...wireCredentials(),
        ...(reason === 'account' ? { accountId: otherId } : {}),
      });
    wait.resolve(majorPage());
    await running;
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().items, []);
    s.controller.dispose();
  }
});
test('failed or late related eligibility checks cannot preserve detail or navigate after hide', async () => {
  const s = harness('detail');
  s.impl.related = async () => {
    throw new ClientError('http', 'Unknown phone proof', {
      serverCode: 'VERIFICATION_UNAVAILABLE',
      httpStatus: 503,
    });
  };
  await s.controller.load(id);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().detail, null);
  assert.equal(s.controller.discussionPath(), null);
  s.controller.dispose();
  const t = harness('detail'),
    wait = deferred<MajorPage>();
  t.impl.related = () => wait.promise;
  const job = t.controller.load(id);
  await flush();
  t.runtime.privateViews!.clear();
  wait.resolve(majorPage({ items: [major({ id: otherId })] }));
  await job;
  assert.equal(t.view().detail, null);
  assert.deepEqual(t.view().relatedItems, []);
  t.controller.dispose();
});
