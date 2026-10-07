import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  FormationController,
  FormationContactsController,
  type FormationView,
  type FormationContactsView,
} from '../src/community/formation-controller';
import { PendingFormationJoinStore } from '../src/community/formation-pending';
import {
  MineController,
  type MineView,
} from '../src/pages/community-mine/controller';
import type {
  FormationReceipt,
  Formation,
} from '../src/community/formation-contract';
import {
  formation,
  formationPost,
  formationReceipt,
  postId,
  requestId,
  otherId,
  ballotId,
  createdAt,
  setup,
} from './community-helpers';
import { deferred, flush, FakeClock } from './helpers';
import { wireCredentials } from './identity-helpers';
const joined = (): Formation =>
  formation({
    memberCount: 2,
    status: 'full',
    members: [
      ...formation().members,
      {
        id: ballotId,
        author: {
          kind: 'named',
          profileId: requestId,
          displayName: '合成成员',
          avatar: null,
        },
        isCreator: false,
        joinedAt: createdAt,
        viewer: { isSelf: true },
      },
    ],
    viewer: {
      isMember: true,
      isCreator: false,
      canJoin: false,
      reason: 'FORMATION_ALREADY_JOINED',
      canReadContacts: true,
    },
  });
function harness() {
  const s = setup();
  const views: FormationView[] = [];
  const controller = new FormationController(s.runtime, postId, (v) =>
    views.push(v),
  );
  return {
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    load: () => controller.load(formationPost()),
  };
}
function fill(s: ReturnType<typeof harness>) {
  s.controller.setContact('wechat', 'synthetic-join');
  s.controller.setConsent(true);
}
test('join persists contact-sharing intent before dispatch, double taps create no duplicate seat, current roster is re-read', async () => {
  const s = harness();
  await s.load();
  fill(s);
  let calls = 0;
  s.gateway.joinFormationImpl = async (_post, intent) => {
    calls++;
    assert.equal(
      s.runtime.pendingFormations.load(s.accountId)?.payload.contacts.wechat,
      'synthetic-join',
    );
    assert.equal(intent.contactSharing, 'members_v1');
    s.gateway.formationImpl = async () => joined();
    return formationReceipt();
  };
  await Promise.all([s.controller.join(), s.controller.join()]);
  assert.equal(calls, 1);
  assert.equal(s.view().formation?.memberCount, 2);
  assert.equal(s.view().canJoin, false);
  assert.equal(s.runtime.pendingFormations.load(s.accountId), null);
  assert.deepEqual(s.view().contacts, { wechat: '', qq: '', phone: '' });
});
test('no consent, blank contact, full group, phone and restriction gates cannot dispatch; no student gate is invented', async () => {
  for (const reason of [
    'FORMATION_FULL',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNITY_ACTION_RESTRICTED',
    'FORMATION_UNAVAILABLE',
  ]) {
    const s = harness();
    s.gateway.formationImpl = async () =>
      formation({
        status:
          reason === 'FORMATION_FULL'
            ? 'full'
            : reason === 'FORMATION_UNAVAILABLE'
              ? 'unavailable'
              : 'open',
        capacity: reason === 'FORMATION_FULL' ? 1 : 2,
        viewer: {
          isMember: false,
          isCreator: false,
          canJoin: false,
          reason,
          canReadContacts: false,
        },
      });
    await s.load();
    fill(s);
    await s.controller.join();
    assert.equal(
      s.gateway.calls.some((c) => c.method === 'joinFormation'),
      false,
    );
  }
  const s = harness();
  await s.load();
  s.controller.setContact('wechat', 'synthetic');
  await s.controller.join();
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'joinFormation'),
    false,
  );
  s.controller.setConsent(true);
  s.controller.setContact('wechat', '');
  await s.controller.join();
  assert.equal(s.view().contactConsent, false);
});
test('timeout, receipt not found, cancellation and restart retain exact original account/origin key and payload', async () => {
  const s = harness();
  await s.load();
  fill(s);
  s.gateway.joinFormationImpl = async () => {
    throw new ClientError('network', 'lost response');
  };
  await s.controller.join();
  const original = s.runtime.pendingFormations.load(s.accountId)!;
  assert.equal(s.view().frozen, true);
  s.controller.cancel();
  s.controller.dispose();
  const store = new PendingFormationJoinStore(s.storage, 'synthetic');
  assert.deepEqual(store.load(s.accountId), original);
  assert.equal(
    new PendingFormationJoinStore(s.storage, 'different').load(s.accountId),
    null,
  );
  const views: FormationView[] = [];
  const reopened = new FormationController(
    { ...s.runtime, pendingFormations: store },
    postId,
    (v) => views.push(v),
  );
  await reopened.load(null);
  s.gateway.formationReceiptImpl = async () => {
    throw new ClientError('business', 'missing', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await reopened.recover();
  assert.deepEqual(store.load(s.accountId), original);
  s.gateway.joinFormationImpl = async (target, intent) => {
    assert.equal(target, postId);
    assert.deepEqual(intent, original.payload);
    return formationReceipt();
  };
  await reopened.recover(true);
  assert.equal(store.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.formation, null);
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'formation').length,
    1,
  );
});
test('hidden-parent recovery reveals no contacts/roster and own-membership status never settles unknown receipt', async () => {
  const s = harness();
  s.runtime.pendingFormations.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    payload: {
      clientRequestId: requestId,
      contacts: { wechat: 'secret-input', qq: '', phone: '' },
      contactSharing: 'members_v1',
    },
  });
  await s.controller.load(null);
  assert.equal(s.view().frozen, true);
  assert.equal(JSON.stringify(s.view()).includes('secret-input'), false);
  await s.controller.inspectOwnMembership();
  assert.ok(s.runtime.pendingFormations.load(s.accountId));
  assert.match(s.view().ownStatus, /仍需通过回执/);
  await s.controller.recover();
  assert.equal(s.runtime.pendingFormations.load(s.accountId), null);
  assert.equal(s.view().formation, null);
  assert.equal(
    s.gateway.calls.some((c) =>
      ['post', 'formation', 'formationContacts'].includes(c.method),
    ),
    false,
  );
});
test('storage failure, same-tick cancel and account replacement prevent first dispatch; late result cannot clear original journal', async () => {
  const s = harness();
  await s.load();
  fill(s);
  let operation = s.controller.join();
  s.controller.cancel();
  await operation;
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'joinFormation'),
    false,
  );
  await s.load();
  fill(s);
  s.storage.failWrite = true;
  await s.controller.join();
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'joinFormation'),
    false,
  );
  s.storage.failWrite = false;
  await s.load();
  fill(s);
  const late = deferred<FormationReceipt>();
  s.gateway.joinFormationImpl = () => late.promise;
  operation = s.controller.join();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  await operation;
  late.resolve(formationReceipt());
  await flush();
  assert.equal(s.view().formation, null);
  assert.equal(s.view().contacts.wechat, '');
  assert.ok(s.runtime.pendingFormations.load(s.accountId));
});
test('malformed and mismatched receipts plus failed terminal cleanup preserve original join; stale successful roster fails closed', async () => {
  const s = harness();
  await s.load();
  fill(s);
  s.gateway.joinFormationImpl = async () =>
    formationReceipt({ requestId: otherId });
  await s.controller.join();
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingFormations.load(s.accountId));
  s.storage.failRemove = true;
  await s.controller.recover();
  assert.ok(s.runtime.pendingFormations.load(s.accountId));
  s.storage.failRemove = false;
  await s.controller.recover();
  assert.equal(s.runtime.pendingFormations.load(s.accountId), null);
  assert.equal(s.view().canJoin, false);
  assert.equal(s.view().formation, null);
  assert.match(s.view().error, /格式异常/);
});
test('other-post unknown join blocks new membership and own-publications has recovery navigation', async () => {
  const s = harness();
  s.runtime.pendingFormations.freeze({
    version: 1,
    accountId: s.accountId,
    postId: otherId,
    payload: {
      clientRequestId: requestId,
      contacts: { wechat: 'original', qq: '', phone: '' },
      contactSharing: 'members_v1',
    },
  });
  await s.load();
  fill(s);
  await s.controller.join();
  assert.equal(s.view().recoveryPostId, otherId);
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'joinFormation'),
    false,
  );
  const views: MineView[] = [];
  await new MineController(s.runtime, (v) => views.push(v)).load();
  assert.equal(views[views.length - 1]!.formationRecoveryPostId, otherId);
});
function contactHarness() {
  const s = setup(),
    clock = new FakeClock(),
    views: FormationContactsView[] = [],
    copied: string[] = [];
  s.gateway.formationImpl = async () => joined();
  const controller = new FormationContactsController(
    s.runtime,
    (v) => views.push(v),
    async (text) => {
      copied.push(text);
    },
    clock,
  );
  controller.load(formationPost(joined()));
  return {
    ...s,
    clock,
    views,
    copied,
    controller,
    view: () => views[views.length - 1]!,
  };
}
test('contacts are never persisted, each copy re-fetches parent membership and current contacts, historical text copied verbatim', async () => {
  const s = contactHarness();
  s.gateway.formationContactsImpl = async () => ({
    postId,
    members: [
      {
        membershipId: otherId,
        contacts: { wechat: '  原文\n', qq: '', phone: '' },
      },
    ],
  });
  await s.controller.reveal();
  assert.equal(s.view().rows[0]?.contacts.wechat, '  原文\n');
  const stored = JSON.stringify([...s.storage.data]);
  assert.equal(stored.includes('原文'), false);
  s.gateway.formationContactsImpl = async () => ({
    postId,
    members: [
      {
        membershipId: otherId,
        contacts: { wechat: 'fresh', qq: '', phone: '' },
      },
    ],
  });
  await s.controller.copy(otherId, 'wechat');
  assert.deepEqual(s.copied, ['fresh']);
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'formationContacts').length,
    2,
  );
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'formation').length,
    2,
  );
  s.gateway.formationContactsImpl = async () => {
    throw new ClientError('forbidden', 'revoked');
  };
  await s.controller.copy(otherId, 'wechat');
  assert.deepEqual(s.copied, ['fresh']);
  assert.deepEqual(s.view().rows, []);
});
test('member contacts clear on display lease expiry, modal close, parent unavailable, root hide and login/logout', async () => {
  const s = contactHarness();
  await s.controller.reveal();
  assert.equal(s.view().open, true);
  s.clock.advance(60000);
  assert.equal(s.view().open, false);
  assert.deepEqual(s.view().rows, []);
  await s.controller.reveal();
  s.controller.dismiss();
  assert.deepEqual(s.view().rows, []);
  await s.controller.reveal();
  s.controller.load(null);
  assert.deepEqual(s.view().rows, []);
  s.controller.load(formationPost(joined()));
  await s.controller.reveal();
  s.sessions.logout();
  assert.deepEqual(s.view().rows, []);
  assert.equal(s.view().enabled, false);
  const hidden = contactHarness();
  await hidden.controller.reveal();
  hidden.runtime.privateViews!.clear();
  assert.deepEqual(hidden.view().rows, []);
  const calls = hidden.gateway.calls.length;
  await hidden.controller.reveal();
  assert.equal(hidden.gateway.calls.length, calls);
});
test('late contact response after close/account/parent replacement never renders or copies; missing member is not exposed', async () => {
  const s = contactHarness(),
    late = deferred<Awaited<ReturnType<typeof s.gateway.formationContacts>>>();
  s.gateway.formationContactsImpl = () => late.promise;
  const reading = s.controller.copy(otherId, 'wechat');
  await flush();
  s.controller.dismiss();
  late.resolve({
    postId,
    members: [
      {
        membershipId: otherId,
        contacts: { wechat: 'late-private', qq: '', phone: '' },
      },
    ],
  });
  await reading;
  assert.deepEqual(s.copied, []);
  assert.deepEqual(s.view().rows, []);
  s.gateway.formationContactsImpl = async () => ({
    postId,
    members: [
      {
        membershipId: requestId,
        contacts: { wechat: 'unlisted-private', qq: '', phone: '' },
      },
    ],
  });
  await s.controller.reveal();
  assert.deepEqual(s.view().rows, []);
});
test('creator publicly remains anonymous and contact controller rejects roster identity replacement', async () => {
  const s = contactHarness();
  s.gateway.formationImpl = async () => ({
    ...joined(),
    members: joined().members.map((m) =>
      m.isCreator
        ? {
            ...m,
            author: {
              kind: 'named',
              profileId: requestId,
              displayName: 'leaked',
              avatar: null,
            },
          }
        : m,
    ),
  });
  await s.controller.reveal();
  assert.deepEqual(s.view().rows, []);
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'formationContacts'),
    false,
  );
});
test('late contact response crossing access expiry cannot copy/render and unrelated refresh never extends original contact lease', async () => {
  for (const refresh of [false, true]) {
    const s = contactHarness();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials(),
      expiresAt: 2000,
      refreshExpiresAt: 100000,
    });
    s.controller.load(formationPost(joined()));
    const late =
      deferred<Awaited<ReturnType<typeof s.gateway.formationContacts>>>();
    s.gateway.formationContactsImpl = () => late.promise;
    const operation = s.controller.copy(otherId, 'wechat');
    await flush();
    s.clock.advance(2000);
    if (refresh)
      s.sessions.rotate(s.sessions.snapshot(), {
        ...wireCredentials('b'),
        expiresAt: 90000,
        refreshExpiresAt: 100000,
      });
    late.resolve({
      postId,
      members: [
        {
          membershipId: otherId,
          contacts: { wechat: 'expired-private', qq: '', phone: '' },
        },
      ],
    });
    await operation;
    assert.deepEqual(s.copied, []);
    assert.deepEqual(s.view().rows, []);
    assert.equal(s.view().open, false);
  }
});
test('join retains overlong input without native truncation, validates byte fields and never sends a shortened contact', async () => {
  const s = harness();
  await s.load();
  s.controller.setContact('wechat', 'x'.repeat(101));
  s.controller.setConsent(true);
  await s.controller.join();
  assert.equal(s.view().contacts.wechat.length, 101);
  assert.match(s.view().error, /微信.*100.*字节/);
  assert.equal(
    s.gateway.calls.some((c) => c.method === 'joinFormation'),
    false,
  );
  s.controller.setContact('wechat', '合'.repeat(34));
  s.controller.setConsent(true);
  await s.controller.join();
  assert.match(s.view().error, /微信.*字节/);
});
