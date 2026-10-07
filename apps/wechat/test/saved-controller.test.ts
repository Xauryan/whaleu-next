import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Post } from '../src/community/contract';
import type { CommunityGateway } from '../src/community/gateway';
import {
  SavedMutationController,
  type SavedMutationView,
} from '../src/community/saved-controller';
import { PendingSavedStore } from '../src/community/saved-pending';
import type {
  PostUpdatePreferences,
  SavedIntent,
  SavedReceipt,
} from '../src/community/saved-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  otherId,
  post,
  postId,
  requestId,
  setup,
  tradingPost,
  tradingView,
} from './community-helpers';

const preferences = (
  overrides: Partial<PostUpdatePreferences> = {},
): PostUpdatePreferences => ({
  postId,
  savedUpdatesEnabled: true,
  externalUpdatesEnabled: true,
  revision: '0',
  canSetPreference: true,
  reason: null,
  inAppCapability: 'unavailable',
  externalCapability: 'unavailable',
  ...overrides,
});
const writablePost = (saved = false, value = post()): Post => ({
  ...value,
  saveCount: saved ? 1 : 0,
  viewer: {
    ...value.viewer,
    isSaved: saved,
    canSave: true,
    canSetUpdatePreference: true,
  },
});
const receipt = (value: SavedIntent): SavedReceipt => ({
  requestId: value.clientRequestId,
  operation: value.operation,
  postId: value.postId,
  desired: value.desired,
  channel: value.channel,
  outcome: 'applied',
});
function harness(loggedIn = true) {
  const s = setup(loggedIn),
    sent: SavedIntent[] = [],
    queried: string[] = [],
    preferenceReads: string[] = [],
    views: SavedMutationView[] = [];
  const behavior: {
    apply: CommunityGateway['applySaved'];
    recover: CommunityGateway['savedReceipt'];
    preferences: CommunityGateway['postUpdatePreferences'];
  } = {
    apply: async (value) => receipt(value),
    recover: async () => receipt(sent[sent.length - 1]!),
    preferences: async (id) => preferences({ postId: id }),
  };
  const gateway = Object.assign(s.gateway, {
    applySaved: (...args: Parameters<CommunityGateway['applySaved']>) => {
      sent.push(args[0]);
      return behavior.apply(...args);
    },
    savedReceipt: (...args: Parameters<CommunityGateway['savedReceipt']>) => {
      queried.push(args[0]);
      return behavior.recover(...args);
    },
    postUpdatePreferences: (
      ...args: Parameters<CommunityGateway['postUpdatePreferences']>
    ) => {
      preferenceReads.push(args[0]);
      return behavior.preferences(...args);
    },
  });
  const runtime = {
    ...s.runtime,
    gateway,
    pendingSaved: new PendingSavedStore(s.storage, 'synthetic'),
  };
  let settled = 0;
  const controller = new SavedMutationController(
    runtime,
    (view) => views.push(view),
    () => settled++,
  );
  return {
    ...s,
    gateway,
    runtime,
    behavior,
    controller,
    sent,
    queried,
    preferenceReads,
    view: () => views[views.length - 1]!,
    settled: () => settled,
  };
}

test('Saved mutations freeze account-owned exact intent before dispatch, collapse repeated taps and re-read after historical settlement', async () => {
  const s = harness(),
    pending = deferred<SavedReceipt>();
  s.behavior.apply = async (value) => {
    assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), {
      version: 1,
      accountId: s.accountId,
      ...value,
    });
    return pending.promise;
  };
  const running = s.controller.setSaved(writablePost(), true);
  await s.controller.setSaved(writablePost(), true);
  await s.controller.setSaved(writablePost(true), false);
  await flush();
  assert.equal(s.sent.length, 1);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().recoveryPostId, postId);
  pending.resolve(receipt(s.sent[0]!));
  await running;
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().preferences, null);
  assert.equal(s.settled(), 1);
});

test('save capability is independent of author-self, completed trading and comments restrictions; no-op and denied actions do not send', async () => {
  const s = harness(),
    own = writablePost();
  await s.controller.setSaved(own, false);
  await s.controller.setSaved(
    { ...own, viewer: { ...own.viewer, canSave: false } },
    true,
  );
  await s.controller.setSaved(own, 'true' as unknown as boolean);
  assert.equal(s.sent.length, 0);
  await s.controller.setSaved(
    {
      ...own,
      commentsPolicy: 'restricted',
      viewer: { ...own.viewer, canComment: false },
    },
    true,
  );
  assert.equal(s.sent.length, 1);
  s.runtime.newRequestId = async () => otherId;
  const resolved = writablePost(
    false,
    tradingPost({
      trading: tradingView({ resolution: 'resolved', urgency: 'urgent' }),
    }),
  );
  await s.controller.setSaved(resolved, true);
  assert.equal(s.sent.length, 2);
  const guest = harness(false);
  await guest.controller.setSaved(writablePost(), true);
  await guest.controller.load(writablePost());
  assert.equal(guest.sent.length, 0);
  assert.equal(guest.preferenceReads.length, 0);
});

test('per-post preference controls stay independent, require current capability and retain honest unavailable delivery', async () => {
  const s = harness();
  await s.controller.setPreference('saved', false);
  assert.equal(s.sent.length, 0);
  await s.controller.load(writablePost());
  assert.equal(s.view().preferences?.inAppCapability, 'unavailable');
  assert.equal(s.view().preferences?.externalCapability, 'unavailable');
  await s.controller.setPreference('saved', true);
  await s.controller.setPreference('other' as 'saved', false);
  assert.equal(s.sent.length, 0);
  await s.controller.setPreference('saved', false);
  assert.deepEqual(s.sent[0], {
    clientRequestId: requestId,
    operation: 'set_post_update_preference',
    postId,
    desired: false,
    channel: 'saved',
  });
  assert.equal(s.view().preferences, null);
  s.behavior.preferences = async () =>
    preferences({
      savedUpdatesEnabled: false,
      externalUpdatesEnabled: true,
      revision: '1',
    });
  await s.controller.load(writablePost());
  s.runtime.newRequestId = async () => otherId;
  await s.controller.setPreference('external', false);
  assert.equal(s.sent[1]?.channel, 'external');
  assert.equal(s.sent[1]?.desired, false);
  assert.equal(s.settled(), 2);
  s.behavior.preferences = async () =>
    preferences({
      canSetPreference: false,
      reason: 'PHONE_VERIFICATION_REQUIRED',
    });
  await s.controller.load(writablePost());
  await s.controller.setPreference('saved', false);
  const disallowed = writablePost();
  s.behavior.preferences = async () => preferences();
  await s.controller.load({
    ...disallowed,
    viewer: { ...disallowed.viewer, canSetUpdatePreference: false },
  });
  await s.controller.setPreference('external', false);
  assert.equal(s.sent.length, 2);
});

for (const operation of [
  'save',
  'saved-preference',
  'external-preference',
] as const) {
  test(`${operation} lost response survives restart and hidden parent; not-found cannot unlock opposite or other-channel intent`, async () => {
    const s = harness();
    await s.controller.load(writablePost());
    s.behavior.apply = async () => {
      throw new ClientError('timeout', 'safe');
    };
    if (operation === 'save') await s.controller.setSaved(writablePost(), true);
    else
      await s.controller.setPreference(
        operation === 'saved-preference' ? 'saved' : 'external',
        false,
      );
    const saved = s.runtime.pendingSaved.load(s.accountId)!;
    assert.ok(saved);
    await s.controller.setSaved(writablePost(true), false);
    await s.controller.setPreference('saved', false);
    await s.controller.setPreference('external', false);
    assert.equal(s.sent.length, 1);
    s.controller.dispose();
    const views: SavedMutationView[] = [];
    const reopened = new SavedMutationController(
      {
        ...s.runtime,
        pendingSaved: new PendingSavedStore(s.storage, 'synthetic'),
      },
      (view) => views.push(view),
    );
    await reopened.load(null);
    assert.equal(views[views.length - 1]!.frozen, true);
    assert.equal(views[views.length - 1]!.recoveryPostId, postId);
    assert.equal(views[views.length - 1]!.preferences, null);
    assert.equal(s.preferenceReads.length, 1);
    s.behavior.recover = async () => {
      throw new ClientError('http', 'safe', {
        httpStatus: 404,
        serverCode: 'REQUEST_NOT_FOUND',
      });
    };
    await reopened.recover();
    assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), saved);
    assert.deepEqual(s.queried, [saved.clientRequestId]);
    s.behavior.recover = async () => ({ ...receipt(saved), postId: otherId });
    await reopened.recover();
    assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), saved);
    s.behavior.apply = async (value) => {
      assert.deepEqual(value, s.sent[0]);
      return receipt(value);
    };
    await reopened.recover(true);
    assert.equal(s.sent.length, 2);
    assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
    assert.equal(views[views.length - 1]!.frozen, false);
    assert.equal(s.preferenceReads.length, 1);
    reopened.dispose();
  });
}

test('original save A must settle before unsave B receives a new ID; late A cannot clear B or update newer current state', async () => {
  const s = harness(),
    a = deferred<SavedReceipt>(),
    b = deferred<SavedReceipt>();
  s.behavior.apply = (value) =>
    value.clientRequestId === requestId ? a.promise : b.promise;
  const runningA = s.controller.setSaved(writablePost(), true);
  await flush();
  const frozenA = s.runtime.pendingSaved.load(s.accountId)!;
  s.controller.cancel();
  await runningA;
  await s.controller.setSaved(writablePost(true), false);
  assert.equal(s.sent.length, 1);
  s.behavior.recover = async () => receipt(frozenA);
  await s.controller.recover();
  assert.equal(s.settled(), 1);
  s.runtime.newRequestId = async () => otherId;
  const runningB = s.controller.setSaved(writablePost(true), false);
  await flush();
  const frozenB = s.runtime.pendingSaved.load(s.accountId)!;
  assert.equal(frozenB.clientRequestId, otherId);
  assert.equal(frozenB.desired, false);
  a.resolve(receipt(frozenA));
  await flush();
  assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), frozenB);
  assert.equal(s.settled(), 1);
  b.resolve(receipt(frozenB));
  await runningB;
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  assert.equal(s.settled(), 2);
});

test('terminal rejections release only exact original target while malformed or mutable receipts retain recovery', async () => {
  const s = harness();
  s.behavior.apply = async (value) => ({ ...receipt(value), desired: false });
  await s.controller.setSaved(writablePost(), true);
  const saved = s.runtime.pendingSaved.load(s.accountId)!;
  assert.ok(saved);
  for (const result of [
    { ...receipt(saved), saveCount: 1 },
    {
      ...receipt(saved),
      outcome: 'rejected' as const,
      code: 'POST_NOT_FOUND',
      postId: otherId,
    },
    {
      ...receipt(saved),
      outcome: 'rejected' as const,
      code: 'POST_NOT_FOUND',
      desired: false,
    },
  ]) {
    s.behavior.recover = async () => result;
    await s.controller.recover();
    assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), saved);
    assert.equal(s.settled(), 0);
  }
  s.behavior.recover = async () => ({
    ...receipt(saved),
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  await s.controller.recover();
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.settled(), 1);
});

test('write/readback failure prevents dispatch, failed removal keeps frozen state and corrupt journal cannot be overwritten', async () => {
  const s = harness();
  s.storage.failWrite = true;
  await s.controller.setSaved(writablePost(), true);
  assert.equal(s.sent.length, 0);
  s.storage.failWrite = false;
  s.behavior.apply = async (value) => {
    s.storage.failRemove = true;
    return receipt(value);
  };
  await s.controller.setSaved(writablePost(), true);
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingSaved.load(s.accountId));
  assert.equal(s.settled(), 0);
  s.storage.failRemove = false;
  await s.controller.recover();
  assert.equal(s.settled(), 1);
  s.storage.set(`whaleu.community.saved.pending.v1:synthetic:${s.accountId}`, {
    desired: false,
  });
  await s.controller.load(writablePost());
  assert.equal(s.view().frozen, true);
  await s.controller.setSaved(writablePost(), true);
  assert.equal(s.sent.length, 1);
  assert.equal(s.preferenceReads.length, 0);
  const dropped = harness();
  dropped.runtime.pendingSaved = new PendingSavedStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'synthetic',
  );
  await dropped.controller.setSaved(writablePost(), true);
  assert.equal(dropped.sent.length, 0);
});

for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account',
  'switch-account',
] as const) {
  for (const operation of ['save', 'preference'] as const) {
    test(`${operation} ${lifecycle} ignores late success, clears private preferences and preserves original recovery`, async () => {
      const s = harness(),
        pending = deferred<SavedReceipt>();
      await s.controller.load(writablePost());
      s.behavior.apply = async () => pending.promise;
      const running =
        operation === 'save'
          ? s.controller.setSaved(writablePost(), true)
          : s.controller.setPreference('external', false);
      await flush();
      const saved = s.runtime.pendingSaved.load(s.accountId)!;
      assert.ok(saved);
      if (lifecycle === 'cancel') s.controller.cancel();
      else if (lifecycle === 'dispose') s.controller.dispose();
      else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
      else if (lifecycle === 'logout') s.sessions.logout();
      else
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('b'),
          accountId: lifecycle === 'same-account' ? s.accountId : otherId,
        });
      pending.resolve(receipt(saved));
      await running;
      assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), saved);
      assert.equal(s.settled(), 0);
      if (lifecycle !== 'cancel') assert.equal(s.view().preferences, null);
      if (lifecycle === 'switch-account') {
        assert.equal(s.runtime.pendingSaved.load(otherId), null);
        await s.controller.recover();
        assert.equal(s.queried.length, 0);
      }
    });
  }
}

test('same-tick cancellation and a replaced login while request ID is pending never persist or dispatch', async () => {
  const s = harness();
  const running = s.controller.setSaved(writablePost(), true);
  s.controller.cancel();
  await running;
  assert.equal(s.sent.length, 0);
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  const id = deferred<string>();
  s.runtime.newRequestId = () => id.promise;
  const next = s.controller.setSaved(writablePost(), true);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  id.resolve(requestId);
  await next;
  await flush();
  assert.equal(s.sent.length, 0);
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  assert.equal(s.runtime.pendingSaved.load(otherId), null);
});

test('ordinary same-session token refresh preserves the pending owner and allows exact receipt settlement', async () => {
  const s = harness(),
    pending = deferred<SavedReceipt>();
  s.behavior.apply = async () => pending.promise;
  const running = s.controller.setSaved(writablePost(), true);
  await flush();
  const saved = s.runtime.pendingSaved.load(s.accountId)!;
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  assert.equal(s.view().frozen, true);
  pending.resolve(receipt(saved));
  await running;
  assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
  assert.equal(s.settled(), 1);
  assert.equal(s.sent.length, 1);
});

test('replacing visible parent invalidates late preference reads and cannot expose old post settings', async () => {
  const s = harness(),
    pending = deferred<PostUpdatePreferences>();
  s.behavior.preferences = (id) =>
    id === postId
      ? pending.promise
      : Promise.resolve(
          preferences({ postId: id, savedUpdatesEnabled: false }),
        );
  const old = s.controller.load(writablePost());
  await flush();
  await s.controller.load(writablePost(false, post({ id: otherId })));
  pending.resolve(preferences());
  await old;
  assert.equal(s.view().preferences?.postId, otherId);
  assert.equal(s.view().preferences?.savedUpdatesEnabled, false);
  await s.controller.load(null);
  assert.equal(s.view().preferences, null);
  await s.controller.setPreference('external', false);
  assert.equal(s.sent.length, 0);
});

for (const channel of ['saved', 'external'] as const) {
  test(`${channel} enable A settles before disable B uses a fresh key and stale A cannot replace current opposite preference`, async () => {
    const s = harness(),
      old = deferred<SavedReceipt>();
    const key =
      channel === 'saved' ? 'savedUpdatesEnabled' : 'externalUpdatesEnabled';
    s.behavior.preferences = async () => preferences({ [key]: false });
    await s.controller.load(writablePost());
    s.behavior.apply = () => old.promise;
    const runningA = s.controller.setPreference(channel, true);
    await flush();
    const a = s.runtime.pendingSaved.load(s.accountId)!;
    s.controller.cancel();
    await runningA;
    await s.controller.setPreference(channel, false);
    assert.equal(s.sent.length, 1);
    s.behavior.recover = async () => receipt(a);
    await s.controller.recover();
    s.behavior.preferences = async () =>
      preferences({ [key]: true, revision: '1' });
    await s.controller.load(writablePost());
    s.runtime.newRequestId = async () => otherId;
    s.behavior.apply = async (value) => receipt(value);
    await s.controller.setPreference(channel, false);
    assert.equal(s.sent.length, 2);
    assert.equal(s.sent[1]!.clientRequestId, otherId);
    assert.equal(s.sent[1]!.desired, false);
    s.behavior.preferences = async () =>
      preferences({ [key]: false, revision: '2' });
    await s.controller.load(writablePost());
    old.resolve(receipt(a));
    await flush();
    assert.equal(s.view().preferences?.[key], false);
    assert.equal(s.view().preferences?.revision, '2');
    assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
    assert.equal(s.settled(), 2);
  });
}
