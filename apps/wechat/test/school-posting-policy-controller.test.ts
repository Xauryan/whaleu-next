import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type {
  PostingPolicyCommand,
  PostingPolicyReceipt,
  PostingPolicyRecovery,
} from '../src/school-posting-policy/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  postingHarness,
  postingCommand,
  postingPolicy,
  postingView,
  postingReceipt,
  postingRegion,
  postingOther,
  postingRequest,
  postingRevisionId,
} from './school-posting-policy-helpers';

test('pending receipt recovery loads before current management authority and never installs historical policy as current', async () => {
  const s = postingHarness(),
    original = s.journal.write(
      wireCredentials().accountId,
      postingRegion,
      postingCommand(),
    );
  s.schools.capabilities = async () => {
    throw new Error('Must not block historical receipt recovery');
  };
  s.gateway.management = async () => {
    throw new Error('Must not overwrite current state from receipt');
  };
  const controller = s.create();
  await controller.load(postingOther);
  assert.equal(s.view().pending, true);
  assert.equal(s.view().pendingRegionId, postingRegion);
  s.gateway.recover = async () => ({
    state: 'recorded',
    requestId: postingRequest,
    receipt: postingReceipt(original.command),
  });
  await controller.recover();
  assert.equal(s.view().pending, false);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().form, null);
  assert.equal(s.journal.read(wireCredentials().accountId), null);
  assert.equal(s.calls.ids, 0);
  controller.dispose();
});

test('uncertain save freezes original payload/key, blocks double taps/edits/refresh, and retries only explicitly with original bytes', async () => {
  const s = postingHarness(),
    controller = s.create(),
    sent: PostingPolicyCommand[] = [];
  s.gateway.save = async (_region, command) => {
    sent.push(command);
    throw new ClientError('timeout', 'Unknown result');
  };
  await controller.load();
  controller.setSwitch('unverifiedPostEnabled', true);
  controller.setCategories(['pets', 'discussion']);
  controller.setExpiryKind('at');
  controller.setValidUntil('2027-01-01T00:00:00Z');
  const save = controller.save();
  await controller.save();
  await save;
  assert.equal(s.calls.ids, 1);
  assert.equal(sent.length, 1);
  const original = s.journal.read(wireCredentials().accountId)!;
  controller.setCategories(['research']);
  controller.setSwitch('unverifiedPostEnabled', false);
  controller.setValidUntil('2028-01-01T00:00:00Z');
  await controller.refresh();
  await controller.save();
  await controller.recover();
  assert.equal(sent.length, 1);
  assert.equal(s.view().pending, true);
  assert.deepEqual(s.journal.read(wireCredentials().accountId), original);
  s.gateway.save = async (_region, command) => {
    sent.push(command);
    return postingReceipt(command);
  };
  await controller.recover(true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(
    sent[1]!.policy.expiry.kind === 'at' && sent[1]!.policy.expiry.validUntil,
    '2027-01-01T00:00:00Z',
  );
  assert.equal(s.calls.ids, 1);
  assert.equal(s.view().pending, false);
  assert.equal(s.view().loaded, false);
  controller.dispose();
});

test('unknown/corrupt storage blocks dispatch and never replaces a potentially persisted operation', async () => {
  const s = postingHarness(),
    controller = s.create();
  await controller.load();
  controller.setExpiryKind('policy_exempt');
  s.storage.failWrite = true;
  await controller.save();
  assert.equal(s.calls.saves.length, 0);
  assert.equal(s.view().storageBlocked, true);
  await controller.save();
  assert.equal(s.calls.ids, 1);
  s.storage.failWrite = false;
  controller.dispose();
  s.journal.write(wireCredentials().accountId, postingRegion, postingCommand());
  const key = [...s.storage.data.keys()][0]!;
  s.storage.data.set(key, { version: 1, unsafe: true });
  const reopened = s.create();
  await reopened.load();
  assert.equal(s.view().storageBlocked, true);
  assert.equal(s.view().form, null);
  assert.equal(s.storage.data.has(key), true);
  reopened.dispose();
});

test('receipt/hash/request mismatch and failed cleanup keep the exact pending command recoverable', async () => {
  const s = postingHarness(),
    original = s.journal.write(
      wireCredentials().accountId,
      postingRegion,
      postingCommand(),
    ),
    controller = s.create();
  await controller.load();
  s.gateway.recover = async () => ({
    state: 'recorded',
    requestId: postingRequest,
    receipt: { ...postingReceipt(), requestHash: 'f'.repeat(64) },
  });
  await controller.recover();
  assert.deepEqual(s.journal.read(wireCredentials().accountId), original);
  s.gateway.cancel = async () => ({
    state: 'cancelled',
    requestId: postingOther,
    requestHash: original.requestHash,
  });
  await controller.cancelPending();
  assert.equal(s.view().pending, true);
  s.gateway.recover = async () => ({
    state: 'recorded',
    requestId: postingRequest,
    receipt: postingReceipt(),
  });
  s.storage.failRemove = true;
  await controller.recover();
  assert.equal(s.view().storageBlocked, true);
  assert.ok(s.journal.read(wireCredentials().accountId));
  controller.dispose();
  s.storage.failRemove = false;
  const reopened = s.create();
  await reopened.load();
  await reopened.recover();
  assert.equal(s.view().pending, false);
  reopened.dispose();
});

test('dispose before UUID completion prevents journal/write; late save completion after hide cannot settle or render', async () => {
  const s = postingHarness(),
    key = deferred<string>(),
    first = s.create(() => key.promise);
  await first.load();
  first.setExpiryKind('policy_exempt');
  const save = first.save();
  first.dispose();
  key.resolve(postingRequest);
  await save;
  assert.equal(s.calls.saves.length, 0);
  assert.equal(s.journal.read(wireCredentials().accountId), null);
  const receipt = deferred<PostingPolicyReceipt>(),
    second = s.create();
  s.gateway.save = async () => receipt.promise;
  await second.load();
  second.setExpiryKind('policy_exempt');
  const inFlight = second.save();
  await flush();
  const pending = s.journal.read(wireCredentials().accountId)!;
  assert.ok(pending);
  second.dispose();
  const third = s.create();
  await third.load();
  receipt.resolve(postingReceipt(pending.command));
  await inFlight;
  assert.equal(s.view().pending, true);
  assert.equal(s.view().form, null);
  assert.ok(s.journal.read(wireCredentials().accountId));
  third.dispose();
});

test('login epoch changes scrub private state and fence recovery-to-write continuation even for same account', async () => {
  const s = postingHarness(),
    waiting = deferred<PostingPolicyRecovery>();
  s.journal.write(wireCredentials().accountId, postingRegion, postingCommand());
  const controller = s.create();
  await controller.load();
  s.gateway.recover = async () => waiting.promise;
  const retry = controller.recover(true);
  const epoch = s.sessions.beginLogin();
  s.sessions.completeLogin(epoch, wireCredentials('b'));
  waiting.resolve({ state: 'not_recorded', requestId: postingRequest });
  await retry;
  assert.equal(s.calls.saves.length, 0);
  assert.equal(s.view().pending, false);
  assert.equal(s.view().pendingSummary, '');
  assert.equal(s.view().form, null);
  assert.ok(s.journal.read(wireCredentials().accountId));
  controller.dispose();
});

test('late prior-account and prior-page read callbacks cannot install an editable source', async () => {
  const s = postingHarness(),
    waiting = deferred<ReturnType<typeof postingView>>();
  s.gateway.management = async () => waiting.promise;
  const controller = s.create(),
    load = controller.load();
  await flush();
  s.sessions.logout();
  waiting.resolve(postingView());
  await load;
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().form, null);
  controller.dispose();
});

test('untrusted and related-sync sources remain read-only; expired trusted policy requires a future expiry or explicit exemption', async () => {
  const s = postingHarness();
  for (const current of [
    postingView({
      revision: 1,
      revisionId: postingRevisionId,
      state: 'unavailable',
      editable: false,
      blocker: 'untrusted_source',
    }),
    postingView({
      revision: 1,
      revisionId: postingRevisionId,
      state: 'active',
      editable: false,
      blocker: 'related_sync_unsupported',
      policy: { ...postingPolicy(), effectiveAt: '2026-01-01T00:00:00Z' },
    }),
  ]) {
    s.gateway.management = async () => current;
    const controller = s.create();
    await controller.load();
    assert.equal(s.view().form, null);
    assert.ok(s.view().blocker);
    controller.setExpiryKind('policy_exempt');
    await controller.save();
    assert.equal(s.calls.saves.length, 0);
    controller.dispose();
  }
  s.gateway.management = async () =>
    postingView({
      revision: 1,
      revisionId: postingRevisionId,
      state: 'expired',
      policy: {
        ...postingPolicy(),
        effectiveAt: '2026-01-01T00:00:00Z',
        expiry: { kind: 'at', validUntil: '2026-02-01T00:00:00Z' },
      },
    });
  const controller = s.create();
  await controller.load();
  await controller.save();
  assert.equal(s.calls.ids, 0);
  assert.match(s.view().error, /未来/);
  controller.setValidUntil('2027-01-01T00:00:00Z');
  await controller.save();
  assert.equal(s.calls.saves[0]!.expectedRevision, 1);
  assert.equal(s.view().pending, false);
  controller.dispose();
});

test('global management requires explicit active campus selection and server-derived region, never a browsing preference', async () => {
  const s = postingHarness();
  s.schools.capabilities = async () => ({ management: 'global', region: null });
  s.gateway.management = async (regionId) => {
    s.calls.management.push(regionId);
    return postingView({
      context: {
        regionId: postingRegion,
        regionName: '合成学校',
        management: 'global',
      },
    });
  };
  s.profiles.campuses = async () => ({
    page: 1,
    pageSize: 20,
    total: 2,
    items: [
      {
        id: postingOther,
        institutionId: null,
        institutionName: '合成学校',
        fullName: '合成校区',
        shortName: null,
        district: '',
        isActive: true,
      },
      {
        id: postingRequest,
        institutionId: null,
        institutionName: '停用学校',
        fullName: '停用校区',
        shortName: null,
        district: '',
        isActive: false,
      },
    ],
  });
  const controller = s.create();
  await controller.load();
  assert.deepEqual(s.calls.management, []);
  await controller.chooseCampus(postingOther);
  assert.deepEqual(s.calls.management, []);
  await controller.searchCampuses();
  await controller.chooseCampus(postingRequest);
  assert.deepEqual(s.calls.management, []);
  await controller.chooseCampus(postingOther);
  assert.deepEqual(s.calls.management, [postingRegion]);
  assert.equal(s.view().regionId, postingRegion);
  assert.equal(s.view().editable, true);
  controller.dispose();
});

test('version conflict retains original request without automatic rebase and explicit cancellation unlocks only a fresh read', async () => {
  const s = postingHarness(),
    controller = s.create();
  s.gateway.save = async () => {
    throw new ClientError('business', 'Conflict', {
      serverCode: 'SCHOOL_POSTING_POLICY_REVISION_CONFLICT',
    });
  };
  await controller.load();
  controller.setExpiryKind('policy_exempt');
  await controller.save();
  assert.equal(s.view().pending, true);
  assert.match(s.view().error, /不会自动覆盖/);
  await controller.save();
  assert.equal(s.calls.ids, 1);
  await controller.cancelPending();
  assert.equal(s.view().pending, false);
  assert.equal(s.view().form, null);
  assert.equal(s.journal.read(wireCredentials().accountId), null);
  await controller.refresh();
  assert.equal(s.view().loaded, true);
  controller.dispose();
});

test('write acknowledgment lost after local persistence cannot dispatch or replace the original command', async () => {
  const s = postingHarness(),
    controller = s.create();
  await controller.load();
  controller.setExpiryKind('policy_exempt');
  const set = s.storage.set.bind(s.storage);
  let fail = true;
  s.storage.set = (key, value) => {
    set(key, value);
    if (fail) {
      fail = false;
      throw new Error('Lost storage acknowledgment');
    }
  };
  await controller.save();
  assert.equal(s.calls.saves.length, 0);
  const original = s.journal.read(wireCredentials().accountId)!;
  assert.ok(original);
  assert.equal(s.view().storageBlocked, true);
  controller.dispose();
  const reopened = s.create();
  await reopened.load();
  assert.equal(s.view().pending, true);
  await reopened.recover(true);
  assert.deepEqual(s.calls.saves, [original.command]);
  assert.equal(s.calls.ids, 1);
  reopened.dispose();
});

test('revoked authority clears editing but retains owner recovery; cancel honestly reports an already committed save', async () => {
  const s = postingHarness(),
    controller = s.create();
  await controller.load();
  controller.setExpiryKind('policy_exempt');
  s.gateway.save = async () => {
    throw new ClientError('forbidden', 'Grant revoked');
  };
  await controller.save();
  const original = s.journal.read(wireCredentials().accountId)!;
  assert.equal(s.view().editable, false);
  assert.equal(s.view().form, null);
  assert.equal(s.view().pending, true);
  s.gateway.cancel = async () => ({
    state: 'recorded',
    requestId: postingRequest,
    receipt: postingReceipt(original.command),
  });
  await controller.cancelPending();
  assert.equal(s.view().pending, false);
  assert.match(s.view().status, /已保存为版本/);
  assert.doesNotMatch(s.view().status, /已取消/);
  assert.equal(s.view().loaded, false);
  controller.dispose();
});
