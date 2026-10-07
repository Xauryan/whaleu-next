import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  CampusController,
  type CampusView,
} from '../src/pages/campus/controller';
import type { CampusPage } from '../src/profile/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  campus,
  campusId,
  FakeProfileGateway,
  ownProfile,
} from './profile-helpers';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeProfileGateway(),
    views: CampusView[] = [];
  const controller = new CampusController(sessions, gateway, (view) =>
    views.push(view),
  );
  return {
    sessions,
    gateway,
    views,
    controller,
    view: () => views[views.length - 1]!,
  };
}
test('campus loading preserves unset selection and empty server directory without fake campuses', async () => {
  const s = setup();
  s.gateway.campusesImpl = async (query) => ({
    items: [],
    page: query.page,
    pageSize: query.pageSize,
    total: 0,
  });
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().selectedId, '');
  assert.equal(s.view().selectedName, '尚未选择校园');
  assert.equal(s.view().hasNext, false);
  assert.equal(s.view().hasPrevious, false);
});
test('campus search trims filters, resets page, supports pagination and blocks stale filters', async () => {
  const s = setup();
  s.gateway.campusesImpl = async (query) => ({
    items:
      query.page === 1
        ? Array.from({ length: 20 }, (_, index) =>
            campus({
              id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
            }),
          )
        : [campus()],
    page: query.page,
    pageSize: query.pageSize,
    total: 21,
  });
  await s.controller.load();
  assert.equal(s.view().hasNext, true);
  await s.controller.next();
  assert.equal(s.view().page, 2);
  assert.equal(s.view().hasNext, false);
  assert.equal(s.view().hasPrevious, true);
  s.controller.setQuery('  鲸鱼  ');
  s.controller.setDistrict('  海淀  ');
  await s.controller.previous();
  assert.equal(s.view().page, 2);
  assert.equal(s.view().searchDirty, true);
  await s.controller.search();
  assert.equal(s.view().page, 1);
  assert.equal(s.view().searchDirty, false);
  const searches = s.gateway.calls.filter((call) => call.method === 'campuses');
  assert.deepEqual(searches[searches.length - 1]?.body, {
    q: '鲸鱼',
    district: '海淀',
    page: 1,
    pageSize: 20,
  });
});
test('inactive campuses are visible but cannot be selected; active choices need explicit save', async () => {
  const s = setup();
  const inactive = '55555555-5555-4555-8555-555555555555';
  s.gateway.campusesImpl = async (query) => ({
    items: [campus(), campus({ id: inactive, isActive: false })],
    page: query.page,
    pageSize: query.pageSize,
    total: 2,
  });
  await s.controller.load();
  s.controller.choose(inactive);
  assert.equal(s.view().candidateId, '');
  s.controller.choose(campusId);
  assert.equal(s.view().selectedId, '');
  assert.equal(s.view().candidateId, campusId);
  s.controller.cancelSelection();
  assert.equal(s.view().candidateId, '');
  s.controller.choose(campusId);
  await s.controller.save();
  assert.equal(s.view().selectedId, campusId);
  assert.equal(s.view().candidateId, '');
  assert.deepEqual(
    s.gateway.calls.find((call) => call.method === 'select')?.body,
    { expectedRevision: 0, campusId },
  );
  assert.equal('verified' in s.view(), false);
});
test('campus selection handles concurrent revision conflict with explicit authoritative reload', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.choose(campusId);
  s.gateway.selectImpl = async () => {
    throw new ClientError('business', 'safe', {
      serverCode: 'PROFILE_REVISION_CONFLICT',
      httpStatus: 409,
    });
  };
  await s.controller.save();
  assert.equal(s.view().needsReload, true);
  assert.equal(s.view().selectedId, '');
  await s.controller.save();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'select').length,
    1,
  );
  s.gateway.current = ownProfile({ selectedCampus: campus(), revision: 1 });
  await s.controller.load();
  assert.equal(s.view().selectedId, campusId);
  assert.equal(s.view().candidateId, '');
  assert.equal(s.view().needsReload, false);
});
test('not-found/inactive rejection stays definite rather than claiming an uncertain save', async () => {
  for (const [code, kind, status, pattern] of [
    ['CAMPUS_NOT_FOUND', 'http', 404, /已不存在/],
    ['CAMPUS_UNAVAILABLE', 'business', 409, /暂不可选择/],
  ] as const) {
    const s = setup();
    await s.controller.load();
    s.controller.choose(campusId);
    s.gateway.selectImpl = async () => {
      throw new ClientError(kind, 'safe', {
        serverCode: code,
        httpStatus: status,
      });
    };
    await s.controller.save();
    assert.equal(s.view().needsReload, false);
    assert.match(s.view().error, pattern);
    assert.equal(s.view().selectedId, '');
  }
});
test('cancelled search suppresses late result, allows retry and account switch clears both selection and query', async () => {
  const s = setup(),
    late = deferred<CampusPage>();
  s.gateway.campusesImpl = () => late.promise;
  const pending = s.controller.load();
  await flush();
  s.controller.cancelOperation();
  await pending;
  assert.equal(s.view().loaded, false);
  late.resolve({ items: [campus()], page: 1, pageSize: 20, total: 1 });
  await flush();
  assert.equal(s.view().items.length, 0);
  s.gateway.campusesImpl = async (query) => ({
    items: [campus()],
    page: query.page,
    pageSize: query.pageSize,
    total: 1,
  });
  await s.controller.load();
  s.controller.choose(campusId);
  s.controller.setQuery('个人搜索');
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  assert.equal(s.view().candidateId, '');
  assert.equal(s.view().selectedId, '');
  assert.equal(s.view().q, '');
  assert.equal(s.view().items.length, 0);
});
test('duplicate save, hide/dispose and late mutation never mark the new page saved', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.choose(campusId);
  const late = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.selectImpl = () => late.promise;
  const pending = s.controller.save();
  await flush();
  await s.controller.save();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'select').length,
    1,
  );
  s.controller.dispose();
  const count = s.views.length;
  late.resolve(ownProfile({ revision: 1, selectedCampus: campus() }));
  await pending;
  assert.equal(s.views.length, count);
  assert.equal(s.view().items.length, 0);
});
test('invalid filters never dispatch and wrong returned campus/revision cannot be marked saved', async () => {
  const s = setup();
  s.controller.setQuery('x'.repeat(101));
  await s.controller.load();
  assert.equal(s.gateway.calls.length, 0);
  s.controller.setQuery('\ud800');
  await s.controller.search();
  assert.equal(s.gateway.calls.length, 0);
  s.controller.setQuery('');
  await s.controller.load();
  s.controller.choose(campusId);
  s.gateway.selectImpl = async () =>
    ownProfile({
      revision: 1,
      selectedCampus: campus({ id: '55555555-5555-4555-8555-555555555555' }),
    });
  await s.controller.save();
  assert.equal(s.view().needsReload, true);
  assert.equal(s.view().selectedId, '');
});
test('malformed error-code/status pairs cannot remove the uncertain mutation barrier', async () => {
  for (const code of [
    'CAMPUS_NOT_FOUND',
    'CAMPUS_UNAVAILABLE',
    'PROFILE_REVISION_CONFLICT',
    'ACCOUNT_BLOCKED',
  ]) {
    const s = setup();
    await s.controller.load();
    s.controller.choose(campusId);
    s.gateway.selectImpl = async () => {
      throw new ClientError('protocol', 'safe', {
        serverCode: code,
        httpStatus: 500,
      });
    };
    await s.controller.save();
    assert.equal(s.view().needsReload, true);
    assert.match(s.view().error, /保存结果尚未确认/);
    assert.ok(s.sessions.snapshot().credentials);
  }
});
