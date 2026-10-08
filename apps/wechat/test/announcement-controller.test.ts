import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type {
  AnnouncementOwnerPopup,
  AnnouncementPage,
  AnnouncementReceipt,
} from '../src/announcements/contract';
import {
  announcementHarness,
  announcementId,
  bodyText,
  campusId,
  changes,
  otherId,
  popup,
  revision,
  summary,
  token,
} from './announcement-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
test('guest list/detail are public, no identity/phone gate or read marker; body and count are transient', async () => {
  const s = announcementHarness(false);
  await s.controller.load({ campusId });
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().changesNotice, '最近30天新公告 9007199254740993 条');
  assert.ok(s.controller.detailPath(announcementId)?.includes(campusId));
  await s.popupController.load(campusId);
  assert.equal(s.popupView().popup, null);
  assert.ok(
    s.calls.every(
      (call) => call.method !== 'ownerPopup' && call.method !== 'acknowledge',
    ),
  );
  s.controller.dispose();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().changes, null);
  assert.equal(s.storage.data.size, 0);
  const d = announcementHarness(false, 'detail');
  await d.controller.load({ campusId, announcementId });
  assert.equal(d.view().detail?.bodyText, bodyText);
  d.runtime.privateViews?.clear();
  assert.equal(d.view().detail, null);
  assert.equal(d.storage.data.size, 0);
});
test('current-page replacement supports Next/Previous and restart without duplicate append or old bodies', async () => {
  const s = announcementHarness();
  s.behavior.list = async (campus, cursor) => ({
    context: { campusId: campus },
    items: [
      summary({ id: cursor ? otherId : announcementId, isLatest: !cursor }),
    ],
    continuation: cursor ? 'end' : 'more',
    nextCursor: cursor ? null : token(),
  });
  await s.controller.load({});
  await s.controller.next();
  assert.equal(s.view().items[0]?.id, otherId);
  assert.equal(s.view().pageNumber, 2);
  await s.controller.previous();
  assert.equal(s.view().items[0]?.id, announcementId);
  assert.equal(
    s.calls.filter((call) => call.method === 'list').slice(-1)[0]?.args[1],
    null,
  );
  s.behavior.list = async () => {
    throw new ClientError('business', 'changed', {
      serverCode: 'DISCOVERY_RESTART_REQUIRED',
    });
  };
  await s.controller.next();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().restartRequired, true);
  assert.equal(s.view().canPrevious, false);
});
test('latest acknowledged and unknown history suppress popup; no older unseen queue or marker on manual reads', async () => {
  const s = announcementHarness();
  for (const status of ['acknowledged', 'unavailable'] as const) {
    s.behavior.ownerPopup = async () => ({
      context: { campusId: null },
      candidate: popup(),
      acknowledgement: { status, acknowledgedAt: null },
    });
    await s.popupController.load(null);
    assert.equal(s.popupView().popup, null);
  }
  assert.equal(s.popupView().acknowledgement, 'unavailable');
  assert.equal(s.calls.filter((c) => c.method === 'acknowledge').length, 0);
});
test('explicit close uses exact ID/revision once; lost response closes locally without false seen state or reopen', async () => {
  const s = announcementHarness();
  await s.popupController.load(campusId);
  assert.equal(s.popupView().popup?.id, announcementId);
  const pending = deferred<AnnouncementReceipt>();
  s.behavior.acknowledge = async () => pending.promise;
  const closing = s.popupController.close();
  assert.equal(s.popupView().popup, null);
  assert.equal(s.popupView().acknowledgement, 'pending');
  await s.popupController.close();
  await flush();
  assert.equal(s.calls.filter((c) => c.method === 'acknowledge').length, 1);
  assert.deepEqual(s.calls.slice(-1)[0]?.args.slice(0, 3), [
    campusId,
    announcementId,
    revision,
  ]);
  pending.reject(new ClientError('network', 'lost'));
  await closing;
  assert.equal(s.popupView().acknowledgement, 'unconfirmed');
  assert.equal(s.popupView().popup, null);
  const count = s.calls.length;
  await s.popupController.load(campusId);
  await s.popupController.loadSelectedCampus();
  assert.equal(s.calls.length, count);
  assert.equal(s.storage.data.size, 0);
});
test('session replacement, same-account login, guest transitions, safety, scope, hide and newer read fence stale bodies', async () => {
  for (const change of [
    'logout',
    'relogin',
    'safety',
    'scope',
    'hide',
    'newer',
  ] as const) {
    const s = announcementHarness(),
      pending = deferred<AnnouncementPage>();
    s.behavior.list = async () => pending.promise;
    const read = s.controller.load({ campusId });
    await flush();
    if (change === 'logout') s.sessions.logout();
    else if (change === 'relogin')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('new'));
    else if (change === 'safety')
      s.runtime.safetyChanges.invalidate(s.accountId);
    else if (change === 'scope') s.runtime.browsingScopeChanges.clear();
    else if (change === 'hide') s.runtime.privateViews?.clear();
    else {
      s.behavior.list = async () => ({
        context: { campusId: null },
        items: [],
        continuation: 'end',
        nextCursor: null,
      });
      await s.controller.load({});
    }
    pending.resolve({
      context: { campusId },
      items: [summary()],
      continuation: 'end',
      nextCursor: null,
    });
    await read;
    assert.deepEqual(s.view().items, [], change);
    assert.equal(s.controller.detailPath(announcementId), null, change);
    assert.equal(
      s.calls.some((c) => c.method === 'acknowledge'),
      false,
      change,
    );
  }
  const guest = announcementHarness(false),
    pending = deferred<AnnouncementPage>();
  guest.behavior.list = async () => pending.promise;
  const reading = guest.controller.load({});
  await flush();
  guest.sessions.completeLogin(guest.sessions.beginLogin(), wireCredentials());
  pending.resolve({
    context: { campusId: null },
    items: [summary()],
    continuation: 'end',
    nextCursor: null,
  });
  await reading;
  assert.deepEqual(guest.view().items, []);
});
test('close then hide or account/scope replacement cannot issue late command or resurrect a stale popup', async () => {
  const s = announcementHarness();
  await s.popupController.load(null);
  const closing = s.popupController.close();
  s.runtime.browsingScopeChanges.clear();
  await closing;
  assert.equal(s.calls.filter((c) => c.method === 'acknowledge').length, 0);
  assert.equal(s.popupView().popup, null);
  const pending = deferred<AnnouncementOwnerPopup>();
  s.behavior.ownerPopup = async () => pending.promise;
  const reading = s.popupController.load(null);
  await flush();
  s.popupController.dispose();
  pending.resolve({
    context: { campusId: null },
    candidate: popup(),
    acknowledgement: { status: 'unseen', acknowledgedAt: null },
  });
  await reading;
  assert.equal(s.popupView().popup, null);
});
test('optional recent-count only degrades network errors; authorization/context/protocol failures clear earlier list', async () => {
  for (const failure of [
    new ClientError('auth-required', 'denied'),
    new ClientError('forbidden', 'blocked', { serverCode: 'ACCOUNT_BLOCKED' }),
    new ClientError('business', 'campus', { serverCode: 'CAMPUS_NOT_FOUND' }),
    new ClientError('protocol', 'bad'),
  ]) {
    const s = announcementHarness();
    s.behavior.changes = async () => {
      throw failure;
    };
    await s.controller.load({});
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.controller.detailPath(announcementId), null);
  }
  const s = announcementHarness();
  s.behavior.changes = async () => {
    throw new ClientError('network', 'offline');
  };
  await s.controller.load({});
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().changes, null);
  assert.match(s.view().changesNotice, /暂不可确认/);
  s.behavior.changes = async () => changes();
});
