import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  ErrandAdminController,
  type ErrandAdminView,
} from '../src/errands/admin-controller';
import { ErrandAdminEntryController } from '../src/errands/admin-entry';
import type { ErrandAdminPage } from '../src/errands/admin-contract';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { setup } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  adminCursor,
  adminOrder,
  adminPage,
  adminRegion,
  authorization,
  FakeErrandAdminGateway,
  nextAdminCursor,
  otherAdminRegion,
} from './errand-admin-helpers';
function harness(loggedIn = true) {
  const s = setup(loggedIn),
    gateway = new FakeErrandAdminGateway();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    errandAdmin: gateway,
    directoryScopeChanges: new PrivateViewLifecycle(),
    browsingScopeChanges: new PrivateViewLifecycle(),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  const renders: ErrandAdminView[] = [];
  const controller = new ErrandAdminController(runtime, (view) =>
    renders.push(view),
  );
  return {
    ...s,
    runtime,
    gateway,
    controller,
    renders,
    view: () => renders[renders.length - 1]!,
    reads: () => gateway.calls.filter((c) => c.method === 'list'),
  };
}
const cleared = (view: ErrandAdminView) => {
  assert.equal(view.loaded, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.total, null);
  assert.equal(view.canNext, false);
  assert.equal(view.canPrevious, false);
};
test('school grant fixes exact target independently from browse/current profile and preserves old completed tombstones', async () => {
  const h = harness();
  await h.controller.load();
  assert.equal(h.view().access, 'fixed');
  assert.equal(h.view().regionId, adminRegion);
  assert.equal(h.view().loaded, true);
  assert.equal(h.reads().length, 1);
  assert.equal(h.profiles.calls.length, 0);
  assert.equal(h.view().items[0]!.state, 'completed');
  assert.deepEqual(h.view().total, { status: 'known', value: '1' });
  h.controller.setRegion(otherAdminRegion);
  assert.equal(h.view().regionId, adminRegion);
  await h.controller.load({ regionId: otherAdminRegion });
  cleared(h.view());
  assert.equal(h.view().access, 'unknown');
  assert.equal(h.reads().length, 1);
  h.controller.dispose();
});
test('member, absent session, contradictory grants and untrusted deep-link scope never issue administrative reads', async () => {
  for (const auth of [
    authorization('member'),
    authorization('school_admin', []),
    authorization('school_admin', [adminRegion, otherAdminRegion]),
  ]) {
    const h = harness();
    h.gateway.authorizationImpl = async () => auth;
    await h.controller.load({ regionId: adminRegion });
    cleared(h.view());
    assert.equal(h.reads().length, 0);
    h.controller.dispose();
  }
  const h = harness(false);
  await h.controller.load({ regionId: adminRegion });
  assert.equal(h.gateway.calls.length, 0);
  cleared(h.view());
  h.controller.dispose();
  const broken = harness();
  await broken.controller.load({ campusId: adminRegion });
  assert.equal(broken.gateway.calls.length, 0);
  cleared(broken.view());
  broken.controller.dispose();
});
test('both global roles explicitly select target; scope change clears query/status/page and never reads browse identity', async () => {
  for (const role of ['developer', 'super_admin'] as const) {
    const h = harness();
    h.gateway.authorizationImpl = async () => authorization(role);
    const base = h.gateway.listImpl;
    h.gateway.listImpl = async (...args) => {
      const page = await base(...args);
      return { ...page, context: { ...page.context, management: 'global' } };
    };
    await h.controller.load();
    assert.equal(h.view().access, 'global');
    assert.equal(h.reads().length, 0);
    h.controller.setRegion(adminRegion);
    await h.controller.selectRegion();
    assert.equal(h.view().loaded, true);
    h.controller.setKeyword('123');
    await h.controller.search();
    assert.equal(h.view().numericSearch, true);
    assert.equal(h.view().total!.status, 'unavailable');
    await h.controller.chooseStatus('deleted');
    h.controller.setRegion(otherAdminRegion);
    cleared(h.view());
    await h.controller.selectRegion();
    assert.equal(h.view().regionId, otherAdminRegion);
    assert.equal(h.view().filter, 'all');
    assert.equal(h.view().keyword, '');
    assert.equal(h.profiles.calls.length, 0);
    h.controller.dispose();
  }
});
test('sparse continuation is independent of total and Previous performs a fresh request without cached bodies', async () => {
  const h = harness();
  let firstReads = 0;
  h.gateway.listImpl = async (query, cursor) =>
    cursor === null
      ? adminPage({
          context: { ...adminPage().context, ...query },
          items:
            firstReads++ === 0
              ? [adminOrder()]
              : [adminOrder({ title: 'Fresh changed title' })],
          continuation: 'more',
          nextCursor: adminCursor,
        })
      : cursor === adminCursor
        ? adminPage({
            items: [],
            continuation: 'more',
            nextCursor: nextAdminCursor,
            total: { status: 'unavailable' },
          })
        : adminPage({ items: [], total: { status: 'known', value: '0' } });
  await h.controller.load();
  await h.controller.next();
  assert.equal(h.view().pageNumber, 2);
  assert.equal(h.view().items.length, 0);
  assert.equal(h.view().canNext, true);
  assert.equal(h.view().canPrevious, true);
  assert.equal(h.view().total!.status, 'unavailable');
  await h.controller.previous();
  assert.equal(h.view().pageNumber, 1);
  assert.equal(h.view().items[0]!.title, 'Fresh changed title');
  assert.deepEqual(
    h.reads().map((c) => c.args[1]),
    [null, adminCursor, null],
  );
  await h.controller.next();
  await h.controller.next();
  assert.equal(h.view().pageNumber, 3);
  assert.equal(h.view().canNext, false);
  const count = h.reads().length;
  await h.controller.next();
  assert.equal(h.reads().length, count);
  h.controller.dispose();
});
test('query/status change cancels old page, clears counts immediately and sends first-page canonical context', async () => {
  const h = harness(),
    pending = deferred<ErrandAdminPage>();
  await h.controller.load();
  h.gateway.listImpl = async () => pending.promise;
  const old = h.controller.reload();
  await flush();
  cleared(h.view());
  h.controller.setKeyword(' New\r\nquery ');
  cleared(h.view());
  h.gateway.listImpl = async (query) =>
    adminPage({ context: { ...adminPage().context, ...query } });
  const newer = h.controller.chooseStatus('deleted');
  await newer;
  assert.equal(h.view().keyword, 'New\nquery');
  assert.equal(h.view().filter, 'deleted');
  pending.resolve(adminPage({ items: [adminOrder({ title: 'stale body' })] }));
  await old;
  assert.equal(h.view().items[0]!.title, adminOrder().title);
  assert.equal(h.reads()[h.reads().length - 1]!.args[1], null);
  h.controller.dispose();
});
test('authority change during paging, grant expiry after wait, protocol mismatch and cursor loop clear all data before recovery', async () => {
  for (const reason of [
    'role',
    'grant',
    'expiry',
    'protocol',
    'cursor',
  ] as const) {
    const h = harness();
    h.gateway.listImpl = async () =>
      adminPage({ continuation: 'more', nextCursor: adminCursor });
    await h.controller.load();
    if (reason === 'role')
      h.gateway.authorizationImpl = async () => authorization('member');
    if (reason === 'grant')
      h.gateway.authorizationImpl = async () =>
        authorization('school_admin', [otherAdminRegion]);
    const pending = deferred<ErrandAdminPage>();
    if (reason === 'expiry') h.gateway.listImpl = async () => pending.promise;
    if (reason === 'protocol')
      h.gateway.listImpl = async () => ({
        ...adminPage(),
        privateText: 'sentinel',
      });
    const task = h.controller.next();
    await flush();
    cleared(h.view());
    if (reason === 'expiry')
      pending.reject(
        new ClientError('http', 'Grant deadline elapsed', {
          serverCode: 'AUTHORIZATION_UNAVAILABLE',
          httpStatus: 503,
        }),
      );
    await task;
    cleared(h.view());
    assert.equal(h.view().access, 'unknown');
    assert.ok(h.view().error);
    h.controller.dispose();
  }
});
test('session/account/epoch, browse/identity scope, Safety, hide and explicit stop discard late callbacks and counts', async () => {
  for (const boundary of [
    'epoch',
    'account',
    'scope',
    'browse',
    'safety',
    'hide',
    'stop',
  ] as const) {
    const h = harness();
    await h.controller.load();
    const pending = deferred<ErrandAdminPage>();
    h.gateway.listImpl = async () => pending.promise;
    const task = h.controller.reload();
    await flush();
    if (boundary === 'epoch')
      h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials('b'));
    if (boundary === 'account')
      h.sessions.completeLogin(h.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherAdminRegion,
      });
    if (boundary === 'scope')
      h.runtime.directoryScopeChanges!.clear(h.accountId);
    if (boundary === 'browse')
      h.runtime.browsingScopeChanges!.clear(h.accountId);
    if (boundary === 'safety') h.runtime.safetyChanges!.invalidate(h.accountId);
    if (boundary === 'hide') h.runtime.privateViews!.clear();
    if (boundary === 'stop') h.controller.cancel();
    cleared(h.view());
    pending.resolve(adminPage());
    await task;
    cleared(h.view());
    h.controller.dispose();
  }
});
test('menu availability comes only from fresh role capabilities and clears with all lifecycle boundaries', async () => {
  const h = harness();
  let allowed = false;
  const entry = new ErrandAdminEntryController(h.runtime, (view) => {
    allowed = view.allowed;
  });
  await entry.load();
  assert.equal(allowed, true);
  h.runtime.browsingScopeChanges!.clear(h.accountId);
  assert.equal(allowed, false);
  h.gateway.authorizationImpl = async () => authorization('member');
  await entry.load();
  assert.equal(allowed, false);
  h.gateway.authorizationImpl = async () => authorization('developer');
  await entry.load();
  assert.equal(allowed, true);
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials('b'));
  assert.equal(allowed, false);
  entry.dispose();
  h.controller.dispose();
});
