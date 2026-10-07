import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../src/community/controller';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import type { Post } from '../src/community/contract';
import type { Formation } from '../src/community/formation-contract';
import {
  FormationController,
  FormationContactsController,
  initialFormationView,
  initialFormationContactsView,
} from '../src/community/formation-controller';
import {
  TradingContactsController,
  initialTradingContactsView,
} from '../src/community/trading-controller';
import {
  IdentityOverlayController,
  PrivateViewLifecycle,
  initialOverlayView,
  type IdentityItem,
  type IdentityPrivacyGateway,
} from '../src/identity-privacy/overlay';
import {
  DetailController,
  initialDetailView,
} from '../src/pages/community-detail/controller';
import {
  FeedController,
  initialFeedView,
} from '../src/pages/community-feed/controller';
import {
  SavedController,
  initialSavedView,
} from '../src/pages/community-saved/controller';
import {
  ThreadController,
  initialThreadView,
} from '../src/pages/community-thread/controller';
import {
  UpdatesBadgeController,
  UpdatesController,
  initialUpdatesBadgeView,
  initialUpdatesView,
} from '../src/pages/community-updates/controller';
import type { Cancellation } from '../src/platform/contracts';
import {
  ballotId,
  commentId,
  createdAt,
  formation,
  formationPost,
  otherId,
  post,
  postId,
  requestId,
  setup,
  tradingPost,
} from './community-helpers';
import { deferred, FakeClock, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { update, updates } from './updates-helpers';

function harness() {
  const s = setup();
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  const runtime: CommunityRuntime = { ...s.runtime, safetyChanges };
  s.gateway.savedImpl = async () => ({
    items: [{ post: post(), savedAt: createdAt, saveEpochId: requestId }],
    nextCursor: null,
    visibleSavedCount: 1,
  });
  s.gateway.updatesImpl = async () => updates();
  s.gateway.updatesUnreadImpl = async () => ({ unreadCount: 3 });
  return { ...s, runtime, safetyChanges };
}

interface ProbeView extends CommunityView {
  readonly snapshot: string;
}
class ProbeController extends CommunityController<ProbeView> {
  resets = 0;
  invalidations = 0;
  privateSnapshot = '';
  constructor(runtime: CommunityRuntime, render: (view: ProbeView) => void) {
    super(runtime, () => ({ ...initialCommunityView(), snapshot: '' }), render);
  }
  protected override resetPrivate(): void {
    this.resets += 1;
    this.privateSnapshot = '';
  }
  protected override onSafetyInvalidated(): void {
    this.invalidations += 1;
    assert.equal(this.view.snapshot, '');
    assert.equal(this.privateSnapshot, '');
  }
  async load(work: (cancel: Cancellation) => Promise<string>): Promise<void> {
    await this.run(work, (snapshot) => {
      this.privateSnapshot = snapshot;
      this.update({ snapshot });
    });
  }
}

test('scoped invalidation cancels old callbacks and clears private fields before the read-owner hook without disposing', async () => {
  const s = harness();
  let view: ProbeView = { ...initialCommunityView(), snapshot: '' };
  const controller = new ProbeController(s.runtime, (next) => (view = next));
  await controller.load(async () => 'visible');
  const late = deferred<string>();
  let cancellation: Cancellation | undefined;
  const loading = controller.load((cancel) => {
    cancellation = cancel;
    return late.promise;
  });
  await flush();
  s.safetyChanges.invalidate(otherId);
  assert.equal(view.snapshot, 'visible');
  assert.equal(cancellation?.isCancelled, false);
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(view.snapshot, '');
  assert.equal(view.busy, false);
  assert.equal(cancellation?.isCancelled, true);
  assert.equal(controller.privateSnapshot, '');
  assert.equal(controller.invalidations, 1);
  late.resolve('must never return');
  await loading;
  assert.equal(view.snapshot, '');
  await controller.load(async () => 'fresh ordinary-owner result');
  assert.equal(view.snapshot, 'fresh ordinary-owner result');
  controller.dispose();
  const invalidations = controller.invalidations;
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(controller.invalidations, invalidations);
});

test('scoped invalidation isolates listener failures and unsubscribes without clearing unrelated accounts', () => {
  const privateViews = new PrivateViewLifecycle();
  const safety = new SafetyChanges(privateViews);
  const calls: string[] = [];
  privateViews.subscribe((accountId) => calls.push(`overlay:${accountId}`));
  safety.subscribe(() => {
    throw new Error('Synthetic render failure');
  });
  const unsubscribe = safety.subscribe((accountId) => calls.push(accountId));
  assert.doesNotThrow(() => safety.invalidate(otherId));
  assert.deepEqual(calls, [`overlay:${otherId}`, otherId]);
  unsubscribe();
  safety.invalidate(postId);
  assert.deepEqual(calls, [`overlay:${otherId}`, otherId, `overlay:${postId}`]);
});

interface ReadOwner {
  readonly readMethod: string;
  readonly dispose: () => void;
  readonly load: () => Promise<void>;
  readonly populated: () => void;
  readonly cleared: () => void;
}
const readOwners: Record<string, (runtime: CommunityRuntime) => ReadOwner> = {
  feed(runtime) {
    let view = initialFeedView();
    const controller = new FeedController(runtime, (next) => (view = next));
    return {
      readMethod: 'feed',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => assert.equal(view.posts.length, 1),
      cleared: () => {
        assert.deepEqual(view.posts, []);
        assert.equal(view.canLoadMore, false);
      },
    };
  },
  detail(runtime) {
    let view = initialDetailView();
    let parent: Post | null = null;
    const controller = new DetailController(
      runtime,
      postId,
      (next) => (view = next),
      (next) => (parent = next),
    );
    return {
      readMethod: 'post',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => {
        assert.ok(view.post);
        assert.equal(view.comments.length, 1);
        assert.ok(parent);
      },
      cleared: () => {
        assert.equal(view.post, null);
        assert.equal(parent, null);
        assert.deepEqual(view.comments, []);
        assert.equal(view.locatedComment, null);
        assert.equal(view.locatedReplyId, '');
        assert.equal(view.deleteTarget, null);
      },
    };
  },
  thread(runtime) {
    let view = initialThreadView();
    const controller = new ThreadController(
      runtime,
      postId,
      commentId,
      null,
      (next) => (view = next),
    );
    return {
      readMethod: 'post',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => {
        assert.ok(view.post);
        assert.ok(view.root);
        assert.equal(view.replies.length, 1);
      },
      cleared: () => {
        assert.equal(view.post, null);
        assert.equal(view.root, null);
        assert.deepEqual(view.replies, []);
        assert.deepEqual(view.contextReplies, []);
        assert.equal(view.locatedReply, null);
        assert.equal(view.deleteReplyId, '');
      },
    };
  },
  Saved(runtime) {
    let view = initialSavedView();
    const controller = new SavedController(runtime, (next) => (view = next));
    return {
      readMethod: 'saved',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => {
        assert.equal(view.items.length, 1);
        assert.equal(view.visibleSavedCount, 1);
      },
      cleared: () => {
        assert.deepEqual(view.items, []);
        assert.equal(view.visibleSavedCount, 0);
        assert.equal(view.canLoadMore, false);
      },
    };
  },
  Updates(runtime) {
    let view = initialUpdatesView();
    const controller = new UpdatesController(
      runtime,
      (next) => (view = next),
      async () => undefined,
    );
    return {
      readMethod: 'updates',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => {
        assert.equal(view.items.length, 1);
        assert.equal(view.unreadCount, 1);
      },
      cleared: () => {
        assert.deepEqual(view.items, []);
        assert.equal(view.unreadCount, 0);
        assert.equal(view.canLoadMore, false);
      },
    };
  },
  'Updates badge'(runtime) {
    let view = initialUpdatesBadgeView();
    const controller = new UpdatesBadgeController(
      runtime,
      (next) => (view = next),
    );
    return {
      readMethod: 'updatesUnread',
      load: () => controller.load(),
      dispose: () => controller.dispose(),
      populated: () => assert.equal(view.unreadCount, 3),
      cleared: () => assert.equal(view.unreadCount, 0),
    };
  },
};
for (const [name, create] of Object.entries(readOwners)) {
  test(`${name} clears content, target previews and counts synchronously on own safety changes only`, async () => {
    const s = harness();
    const owner = create(s.runtime);
    await owner.load();
    owner.populated();
    s.safetyChanges.invalidate(otherId);
    owner.populated();
    // The owner must wait for its fresh ordinary read, never apply local relationship guesses.
    const unavailable = async (): Promise<never> => {
      throw new ClientError('forbidden', 'Current visibility unavailable');
    };
    s.gateway.feedImpl = unavailable;
    s.gateway.postImpl = unavailable;
    s.gateway.savedImpl = unavailable;
    s.gateway.updatesImpl = unavailable;
    s.gateway.updatesUnreadImpl = unavailable;
    const priorReads = s.gateway.calls.filter(
      (call) => call.method === owner.readMethod,
    ).length;
    s.safetyChanges.invalidate(s.accountId);
    owner.cleared();
    await flush();
    await flush();
    owner.cleared();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === owner.readMethod).length,
      priorReads + 1,
    );
    owner.dispose();
  });
}

test('a stale pre-block feed response cannot replace the fresh owner read, and unblock does not dispose the page', async () => {
  const s = harness();
  let view = initialFeedView();
  const controller = new FeedController(s.runtime, (next) => (view = next));
  const late = deferred<Awaited<ReturnType<typeof s.gateway.feed>>>();
  s.gateway.feedImpl = () => late.promise;
  const oldLoad = controller.load();
  await flush();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'feed').length,
    1,
  );
  s.gateway.feedImpl = async () => ({
    items: [],
    nextCursor: null,
    continuation: 'end',
  });
  s.safetyChanges.invalidate(s.accountId);
  await flush();
  late.resolve({ items: [post()], nextCursor: null, continuation: 'end' });
  await oldLoad;
  await flush();
  assert.equal(view.posts.length, 0);
  // These anonymous rows are supplied by the ordinary owner after unblock; no hidden author filter exists here.
  s.gateway.feedImpl = async () => ({
    items: [post()],
    nextCursor: null,
    continuation: 'end',
  });
  s.safetyChanges.invalidate(s.accountId);
  await flush();
  await flush();
  assert.equal(view.posts[0]?.author.kind, 'anonymous');
  controller.dispose();
});

test('invalidating an old account after a switch cannot cancel or purge the current account and leaves durable pending ownership intact', async () => {
  const s = harness();
  const pending = s.runtime.pendingSaved.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    operation: 'set_post_saved',
    desired: true,
    channel: null,
    clientRequestId: requestId,
  });
  let view: ProbeView = { ...initialCommunityView(), snapshot: '' };
  const controller = new ProbeController(s.runtime, (next) => (view = next));
  await controller.load(async () => 'first account');
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  await controller.load(async () => 'replacement account');
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(view.snapshot, 'replacement account');
  assert.equal(controller.invalidations, 0);
  assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), pending);
  assert.equal(s.runtime.pendingSaved.load(otherId), null);
  s.safetyChanges.invalidate(otherId);
  assert.equal(view.snapshot, '');
  assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), pending);
  controller.dispose();
});

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

test('formation roster, contact snapshots and pending contact-copy callbacks clear together without deleting join recovery', async () => {
  const s = harness();
  const clock = new FakeClock();
  let view = initialFormationView();
  let contacts = initialFormationContactsView();
  const copied: string[] = [];
  s.gateway.formationImpl = async () => joined();
  const controller = new FormationController(
    s.runtime,
    postId,
    (next) => (view = next),
  );
  const contactController = new FormationContactsController(
    s.runtime,
    (next) => (contacts = next),
    async (text) => {
      copied.push(text);
    },
    clock,
  );
  const parent = formationPost(joined());
  await controller.load(parent);
  contactController.load(parent);
  await contactController.reveal();
  assert.equal(view.formation?.members.length, 2);
  assert.equal(contacts.open, true);
  assert.ok(contacts.rows.length);
  const pending = s.runtime.pendingFormations.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    payload: {
      clientRequestId: requestId,
      contacts: { wechat: 'account-owned pending', qq: '', phone: '' },
      contactSharing: 'members_v1',
    },
  });
  const late =
    deferred<Awaited<ReturnType<typeof s.gateway.formationContacts>>>();
  s.gateway.formationContactsImpl = () => late.promise;
  const copying = contactController.copy(otherId, 'wechat');
  await flush();
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(view.formation, null);
  assert.deepEqual(contacts.rows, []);
  assert.equal(contacts.open, false);
  assert.equal(contacts.enabled, false);
  assert.equal(clock.timers, 0);
  late.resolve({
    postId,
    members: [
      {
        membershipId: otherId,
        contacts: { wechat: 'stale contact', qq: '', phone: '' },
      },
    ],
  });
  await copying;
  assert.deepEqual(copied, []);
  assert.deepEqual(contacts.rows, []);
  assert.deepEqual(s.runtime.pendingFormations.load(s.accountId), pending);
  controller.dispose();
  contactController.dispose();
});

test('trading contact reads and copies cannot restore a snapshot after named safety invalidation', async () => {
  const s = harness();
  let view = initialTradingContactsView();
  const copied: string[] = [];
  const controller = new TradingContactsController(
    s.runtime,
    (next) => (view = next),
    async (text) => {
      copied.push(text);
    },
  );
  controller.load(tradingPost());
  await controller.reveal();
  assert.ok(view.contacts);
  const late =
    deferred<Awaited<ReturnType<typeof s.gateway.tradingContacts>>>();
  s.gateway.tradingContactsImpl = () => late.promise;
  const copying = controller.copy('wechat');
  await flush();
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(view.contacts, null);
  assert.equal(view.enabled, false);
  late.resolve({ postId, contacts: { wechat: 'stale', qq: '', phone: '' } });
  await copying;
  assert.deepEqual(copied, []);
  assert.equal(view.contacts, null);
  controller.dispose();
});

test('Updates invalidation cancels delayed target resolution before any navigation', async () => {
  const s = harness();
  let view = initialUpdatesView();
  const navigated: string[] = [];
  const controller = new UpdatesController(
    s.runtime,
    (next) => (view = next),
    async (url) => {
      navigated.push(url);
    },
  );
  await controller.load();
  const late = deferred<Awaited<ReturnType<typeof s.gateway.updateTarget>>>();
  s.gateway.updateTargetImpl = () => late.promise;
  const opening = controller.open(requestId);
  await flush();
  s.gateway.updatesImpl = async () => updates([]);
  s.safetyChanges.invalidate(s.accountId);
  assert.deepEqual(view.items, []);
  late.resolve({
    noticeId: requestId,
    status: 'available',
    target: update().target,
  });
  await opening;
  assert.deepEqual(navigated, []);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'post'),
    false,
  );
  controller.dispose();
});

test('identity overlays clear by account before content reload; stale identity results cannot revive them and the overlay remains usable', async () => {
  const s = harness();
  const clock = new FakeClock();
  let view = initialOverlayView();
  const identity: IdentityItem = {
    target: { kind: 'post', id: postId },
    status: 'available',
    authorMode: 'anonymous',
    identity: {
      accountId: otherId,
      nickname: 'synthetic',
      avatar: null,
      studentNumber: null,
      studentNumberStatus: 'unavailable',
    },
  };
  const gateway: IdentityPrivacyGateway = {
    authorization: async () => ({
      role: 'developer',
      management: { global: true, operatingRegionIds: [] },
      identityView: { allowed: true, maxBatchSize: 20 },
    }),
    identities: async () => [identity],
  };
  const controller = new IdentityOverlayController(
    s.sessions,
    gateway,
    clock,
    (next) => (view = next),
    s.runtime.privateViews,
  );
  const targets = [
    { kind: 'post' as const, id: postId, authorMode: 'anonymous' as const },
  ];
  await controller.show(targets);
  assert.ok(view.items[postId]);
  s.safetyChanges.invalidate(otherId);
  assert.ok(view.items[postId]);
  let overlayClearedBeforeRead = false;
  s.safetyChanges.subscribe(() => {
    overlayClearedBeforeRead = Object.keys(view.items).length === 0;
  });
  s.safetyChanges.invalidate(s.accountId);
  assert.equal(overlayClearedBeforeRead, true);
  assert.deepEqual(view.items, {});
  assert.equal(view.developerEnabled, false);
  assert.equal(clock.timers, 0);
  const late = deferred<readonly IdentityItem[]>();
  gateway.identities = () => late.promise;
  const loading = controller.show(targets);
  await flush();
  s.safetyChanges.invalidate(s.accountId);
  late.resolve([identity]);
  await loading;
  assert.deepEqual(view.items, {});
  gateway.identities = async () => [identity];
  await controller.show(targets);
  assert.ok(view.items[postId]);
  controller.dispose();
});
