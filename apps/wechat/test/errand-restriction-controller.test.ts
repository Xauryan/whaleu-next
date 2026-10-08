import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ErrandRestrictionController,
  initialErrandRestrictionView,
} from '../src/errands/restriction-controller';
import type {
  ErrandRestrictionHistory,
  ErrandRestrictionPage,
} from '../src/errands/restriction-contract';
import {
  commandHarness,
  eventId,
  restriction,
  restrictionHistory,
  restrictionId,
  restrictionPage,
} from './errand-admin-command-helpers';
import {
  adminCursor,
  authorization,
  nextAdminCursor,
  publicProfileId,
} from './errand-admin-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
function fixture() {
  const h = commandHarness();
  h.controller.dispose();
  h.gateway.authorizationImpl = async () => authorization('developer');
  let view = initialErrandRestrictionView();
  const controller = new ErrandRestrictionController(h.runtime, (value) => {
    view = value;
  });
  return {
    ...h,
    controller,
    view: () => view,
    lists: () =>
      h.gateway.calls.filter((call) => call.method === 'restrictions'),
    histories: () =>
      h.gateway.calls.filter((call) => call.method === 'history'),
  };
}
function cleared(view: ReturnType<typeof initialErrandRestrictionView>): void {
  assert.equal(view.loaded, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.restriction, null);
  assert.deepEqual(view.events, []);
  assert.equal(view.recordedTotal, null);
  assert.equal(view.historyCoverage, null);
  assert.equal(view.canNext, false);
  assert.equal(view.canPrevious, false);
}
test('school/member cannot read global history or issue/release; untrusted route query also performs no request', async () => {
  for (const auth of [authorization('member'), authorization('school_admin')]) {
    const h = fixture();
    h.gateway.authorizationImpl = async () => auth;
    await h.controller.load();
    assert.equal(h.view().access, 'denied');
    assert.equal(h.lists().length, 0);
    assert.equal(h.controller.commandAuthority(), null);
    await h.controller.history(restrictionId);
    assert.equal(h.histories().length, 0);
    h.controller.dispose();
  }
  const h = fixture();
  await h.controller.load({ targetProfileId: publicProfileId });
  assert.equal(h.gateway.calls.length, 0);
  cleared(h.view());
  h.controller.dispose();
});
test('unknown pre-boundary history stays unknown even with exact zero local total and no events', async () => {
  const h = fixture();
  h.gateway.restrictionsImpl = async () =>
    restrictionPage({
      items: [],
      recordedTotal: { status: 'known', value: '0' },
    });
  await h.controller.load();
  assert.equal(h.view().loaded, true);
  assert.equal(h.view().historyCoverage, 'unknown_before_boundary');
  assert.deepEqual(h.view().recordedTotal, { status: 'known', value: '0' });
  h.gateway.restrictionsImpl = async () => restrictionPage();
  await h.controller.reload();
  h.gateway.historyImpl = async () => restrictionHistory({ events: [] });
  await h.controller.history(restrictionId);
  assert.equal(h.view().loaded, true);
  assert.deepEqual(h.view().events, []);
  assert.equal(h.view().historyCoverage, 'unknown_before_boundary');
  assert.equal(h.view().recordedTotal, null);
  h.controller.dispose();
});
test('history can page beyond 256 entries with bounded coordinate window and fresh Previous, no hidden all-history load', async () => {
  const h = fixture();
  const cursors = Array.from({ length: 36 }, (_, i) =>
    String(i + 1).padStart(43, 'a'),
  );
  h.gateway.historyImpl = async (_id, cursor) => {
    const index = cursor === null ? 0 : cursors.indexOf(cursor) + 1;
    return restrictionHistory({
      events: Array.from({ length: 10 }, (_, offset) => ({
        ...restrictionHistory().events[0]!,
        eventId: `00000000-0000-4000-8000-${String(index * 10 + offset).padStart(12, '0')}`,
        reason: `batch ${index}`,
      })),
      continuation: index < 35 ? 'more' : 'end',
      nextCursor: index < 35 ? cursors[index]! : null,
    });
  };
  await h.controller.load();
  await h.controller.history(restrictionId);
  for (let i = 0; i < 35; i++) await h.controller.next();
  assert.equal(h.view().pageNumber, 36);
  assert.equal(h.view().canNext, false);
  assert.equal(h.view().events.length, 10);
  const calls = h.histories().length;
  await h.controller.next();
  assert.equal(h.histories().length, calls);
  await h.controller.previous();
  assert.equal(h.view().pageNumber, 35);
  assert.equal(h.histories().length, calls + 1);
  assert.equal(h.histories()[h.histories().length - 1]!.args[1], cursors[33]);
  h.controller.dispose();
});
test('multiple simultaneous action restrictions expose one immutable release target and history identity only', async () => {
  const h = fixture();
  h.gateway.restrictionsImpl = async () =>
    restrictionPage({
      items: [
        restriction(),
        restriction({ restrictionId: eventId, action: 'publish' }),
      ],
      recordedTotal: { status: 'known', value: '2' },
    });
  await h.controller.load();
  assert.equal(h.controller.commandRestriction(restrictionId)?.action, 'all');
  assert.equal(h.controller.commandRestriction(eventId)?.action, 'publish');
  await h.controller.history(restrictionId);
  assert.equal(h.controller.commandRestriction(eventId), null);
  assert.equal(
    h.controller.commandRestriction(restrictionId)?.restrictionId,
    restrictionId,
  );
  h.controller.dispose();
});
test('query/filters clear old data synchronously; sparse list continuation and exact knownness are preserved', async () => {
  const h = fixture();
  h.gateway.restrictionsImpl = async (_query, cursor) =>
    restrictionPage(
      cursor === null
        ? { nextCursor: adminCursor, continuation: 'more' }
        : {
            items: [],
            recordedTotal: { status: 'unavailable' },
            nextCursor: nextAdminCursor,
            continuation: 'more',
          },
    );
  await h.controller.load();
  await h.controller.next();
  assert.equal(h.view().items.length, 0);
  assert.equal(h.view().canNext, true);
  assert.equal(h.view().recordedTotal?.status, 'unavailable');
  h.controller.setProfile(publicProfileId);
  cleared(h.view());
  await h.controller.search();
  assert.equal(h.lists()[h.lists().length - 1]!.args[1], null);
  assert.deepEqual(h.lists()[h.lists().length - 1]!.args[0], {
    state: 'all',
    targetProfileId: publicProfileId,
  });
  h.controller.dispose();
});
test('history permission revocation, role changes, 503 uncertainty and mismatched restrictions clear all administrative content', async () => {
  for (const failure of ['member', 'role', '503', 'wrong']) {
    const h = fixture();
    await h.controller.load();
    h.gateway.historyImpl = async () =>
      restrictionHistory({ continuation: 'more', nextCursor: adminCursor });
    await h.controller.history(restrictionId);
    if (failure === 'member')
      h.gateway.authorizationImpl = async () => authorization('member');
    if (failure === 'role')
      h.gateway.authorizationImpl = async () => authorization('super_admin');
    if (failure === '503')
      h.gateway.historyImpl = async () => {
        throw new ClientError('http', 'synthetic', {
          serverCode: 'AUTHORIZATION_UNAVAILABLE',
          httpStatus: 503,
        });
      };
    if (failure === 'wrong')
      h.gateway.historyImpl = async () =>
        restrictionHistory({
          restriction: restriction({ restrictionId: publicProfileId }),
        });
    await h.controller.next();
    cleared(h.view());
    assert.equal(h.view().access, 'unknown');
    assert.equal(h.controller.commandAuthority(), null);
    h.controller.dispose();
  }
});
test('scope, browse, Safety, account and hide invalidate old delayed history rendering', async () => {
  for (const boundary of [
    'scope',
    'browse',
    'safety',
    'epoch',
    'hide',
    'cancel',
  ]) {
    const h = fixture(),
      pending = deferred<ErrandRestrictionHistory>();
    await h.controller.load();
    h.gateway.historyImpl = () => pending.promise;
    const reading = h.controller.history(restrictionId);
    await flush();
    if (boundary === 'scope')
      h.runtime.directoryScopeChanges!.clear(h.accountId);
    if (boundary === 'browse')
      h.runtime.browsingScopeChanges!.clear(h.accountId);
    if (boundary === 'safety') h.runtime.safetyChanges!.invalidate(h.accountId);
    if (boundary === 'epoch')
      h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials());
    if (boundary === 'hide') h.runtime.privateViews!.clear();
    if (boundary === 'cancel') h.controller.cancel();
    pending.resolve(restrictionHistory());
    await reading;
    cleared(h.view());
    assert.equal(h.controller.commandAuthority(), null);
    h.controller.dispose();
  }
});
test('older list response cannot repopulate after a newer filter request', async () => {
  const h = fixture(),
    pending = deferred<ErrandRestrictionPage>();
  await h.controller.load();
  h.gateway.restrictionsImpl = () => pending.promise;
  const old = h.controller.reload();
  await flush();
  h.controller.setProfile(publicProfileId);
  h.gateway.restrictionsImpl = async () =>
    restrictionPage({
      items: [],
      recordedTotal: { status: 'known', value: '0' },
    });
  await h.controller.search();
  pending.resolve(restrictionPage());
  await old;
  assert.equal(h.view().loaded, true);
  assert.deepEqual(h.view().items, []);
  assert.equal(h.view().historyCoverage, 'unknown_before_boundary');
  h.controller.dispose();
});
