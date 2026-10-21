import assert from 'node:assert/strict';
import {
  initialCoverReadView,
  type CoverReadView,
} from '../src/profile/cover-read-controller';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { PendingBlockStore } from '../src/community/block-pending';
import type { BlockMutationController } from '../src/community/block-controller';
import type { CommunityRuntime } from '../src/community/runtime';
import type { Cancellation } from '../src/platform/contracts';
import type { PublicProfileDetails } from '../src/profile/details-contract';
import {
  HttpProfileDetailsGateway,
  type ProfileDetailsGateway,
} from '../src/profile/details-gateway';
import type { PublicProfileController } from '../src/pages/public-profile/controller';
import {
  PublicDetailsController,
  initialPublicDetailsView,
} from '../src/pages/public-profile/public-details-controller';
import { blockIntent, blockResult } from './block-helpers';
import { commentId } from './community-helpers';
import { discoverySetup, profileId, publicProfile } from './discovery-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';

const details = (
  patch: Partial<Extract<PublicProfileDetails, { status: 'available' }>> = {},
): PublicProfileDetails => ({
  status: 'available',
  profileId,
  region: '合成地区',
  gender: 'female',
  age: 0,
  ...patch,
});

function fixture(loggedIn = true) {
  const s = discoverySetup(loggedIn);
  const calls: { id: string; cancel: Cancellation }[] = [];
  const behavior: Pick<ProfileDetailsGateway, 'public'> = {
    public: async (id) => details({ profileId: id }),
  };
  let view = initialPublicDetailsView();
  const controller = new PublicDetailsController(
    s.runtime,
    {
      public(id, cancel) {
        calls.push({ id, cancel });
        return behavior.public(id, cancel);
      },
    },
    (value) => {
      view = value;
    },
  );
  return { ...s, calls, behavior, controller, view: () => view };
}

test('public details only read a displayed available named profile, including public guest reads and age zero', async () => {
  const s = fixture(false);
  for (const profile of [
    null,
    { status: 'unavailable' as const, profileId },
    publicProfile({ profileId: 'anonymous-persona' }),
  ])
    await s.controller.setProfile(profile);
  assert.equal(s.calls.length, 0);
  await s.controller.setProfile(publicProfile());
  assert.deepEqual(s.view().details, details());
  assert.equal(s.view().details?.age, 0);
  await s.controller.setProfile(publicProfile());
  assert.equal(s.calls.length, 1, 'repeat profile renders coalesce');
  s.controller.dispose();
});

test('public details retain null fields and never fall back to private data or accept a mismatched/expanded response', async () => {
  const s = fixture();
  for (const result of [
    details({ region: null, gender: null, age: null }),
    { status: 'unavailable' as const, profileId },
    details({ profileId: commentId }),
    { ...details(), birthDate: 'synthetic-private-field' },
  ]) {
    s.controller.clear();
    s.behavior.public = async () => result;
    await s.controller.setProfile(publicProfile({ isOwn: true }));
    assert.deepEqual(
      s.view().details,
      'status' in result &&
        result.status === 'available' &&
        result.profileId === profileId &&
        !('birthDate' in result)
        ? result
        : null,
    );
  }
  s.controller.clear();
  s.behavior.public = async () => {
    throw new ClientError('network', 'Synthetic unavailable details');
  };
  await s.controller.setProfile(publicProfile({ isOwn: true }));
  assert.equal(s.view().details, null);
  const absent = new PublicDetailsController(
    s.runtime,
    undefined,
    () => undefined,
  );
  await absent.setProfile(publicProfile());
  absent.dispose();
  s.controller.dispose();
});

test('public details cancel superseded targets and ignore late previous-profile responses', async () => {
  const s = fixture();
  const old = deferred<PublicProfileDetails>();
  s.behavior.public = async (id) =>
    id === profileId ? old.promise : details({ profileId: id, region: null });
  const first = s.controller.setProfile(publicProfile());
  await flush();
  await s.controller.setProfile(publicProfile({ profileId: commentId }));
  assert.equal(s.calls[0]?.cancel.isCancelled, true);
  old.resolve(details());
  await first;
  assert.equal(s.view().details?.profileId, commentId);
  assert.equal(s.view().details?.region, null);
  await s.controller.setProfile({
    status: 'unavailable',
    profileId: commentId,
  });
  assert.equal(s.view().details, null);
  s.controller.dispose();
});

test('public details clear on actor or login epoch change, safety invalidation, cancel and root hide', async () => {
  for (const invalidation of [
    'actor',
    'epoch',
    'safety',
    'cancel',
    'root-hide',
    'dispose',
  ]) {
    const s = fixture();
    await s.controller.setProfile(publicProfile());
    assert.ok(s.view().details);
    s.controller.clear();
    const late = deferred<PublicProfileDetails>();
    s.behavior.public = async () => late.promise;
    const loading = s.controller.setProfile(publicProfile());
    await flush();
    if (invalidation === 'actor' || invalidation === 'epoch')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: invalidation === 'actor' ? commentId : s.accountId,
      });
    else if (invalidation === 'safety')
      s.runtime.safetyChanges.invalidate(s.accountId);
    else if (invalidation === 'cancel') s.controller.cancel();
    else if (invalidation === 'root-hide') s.runtime.privateViews!.clear();
    else s.controller.dispose();
    assert.equal(s.view().details, null, invalidation);
    assert.equal(
      s.calls[s.calls.length - 1]?.cancel.isCancelled,
      true,
      invalidation,
    );
    late.resolve(details());
    await loading;
    assert.equal(s.view().details, null, `${invalidation} late result`);
    assert.equal(
      s.calls.length,
      2,
      'invalidation cannot restart an old target',
    );
    s.controller.dispose();
  }
});

test('native public-profile waits for current available profile and clears opt-in chips on loading, block recovery and hide', async () => {
  const nativeGlobal = globalThis as typeof globalThis & { wx: typeof wx };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
    publicRead: HttpProfileDetailsGateway.prototype.public,
  };
  type ProfilePage = {
    data: {
      loaded: boolean;
      publicDetails: ReturnType<typeof initialPublicDetailsView>;
      coverRead: CoverReadView;
    };
    controller?: PublicProfileController;
    blockMutations?: BlockMutationController;
    setData(patch: object): void;
    onLoad(query: { profileId: string }): void;
    onShow(): void;
    onHide(): void;
    onReload(): void;
  };
  let definition: ProfilePage | undefined;
  globalThis.Page = ((value: unknown) => {
    definition = value as ProfilePage;
  }) as typeof Page;
  await import('../src/pages/public-profile/public-profile.js');
  assert.ok(definition);
  const s = discoverySetup();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    pendingBlocks: new PendingBlockStore(s.storage, 'public-details'),
    blocks: {
      apply: async (intent) => blockResult(intent),
      receipt: async () => blockResult(),
      list: async () => ({ items: [], nextCursor: null }),
      state: async () => blockResult().current!,
    },
  };
  const requests: string[] = [];
  let result = Promise.resolve(details());
  HttpProfileDetailsGateway.prototype.public = async function (id) {
    requests.push(id);
    return result;
  };
  const coverReads: { id: string; expanded: boolean }[] = [];
  const app = {
    community: runtime,
    identity: { api: {} },
    profileCover: {
      createReader(render: (value: CoverReadView) => void) {
        return {
          async load(id: string, expanded: boolean) {
            coverReads.push({ id, expanded });
            render({
              ...initialCoverReadView(),
              status: 'ready',
              localSrc: 'wxfile://tmp/public-cover.png',
            });
          },
          clear() {
            render(initialCoverReadView());
          },
          dispose() {
            render(initialCoverReadView());
          },
        };
      },
    },
  };
  globalThis.getApp = (() => app) as typeof getApp;
  nativeGlobal.wx = {} as typeof wx;
  const page: ProfilePage = {
    ...definition,
    data: { ...definition.data },
    setData(patch) {
      this.data = { ...this.data, ...patch };
    },
  };
  try {
    const profileGate = deferred<ReturnType<typeof publicProfile>>();
    s.behavior.profile = async () => profileGate.promise;
    page.onLoad({ profileId });
    page.onShow();
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(coverReads.length, 0);
    profileGate.resolve(publicProfile());
    await flush();
    assert.equal(page.data.loaded, true);
    assert.deepEqual(page.data.publicDetails.details, details());
    assert.deepEqual(requests, [profileId]);
    assert.deepEqual(coverReads, [{ id: profileId, expanded: true }]);
    assert.equal(page.data.coverRead.localSrc, 'wxfile://tmp/public-cover.png');
    const late = deferred<PublicProfileDetails>();
    result = late.promise;
    page.onReload();
    assert.equal(page.data.publicDetails.details, null);
    assert.equal(page.data.coverRead.localSrc, '');
    await flush();
    runtime.pendingBlocks!.freeze({
      version: 1,
      accountId: s.accountId,
      intent: blockIntent(),
    });
    page.blockMutations!.load();
    assert.equal(page.data.publicDetails.details, null);
    assert.equal(page.data.coverRead.localSrc, '');
    late.resolve(details());
    await flush();
    assert.equal(page.data.publicDetails.details, null);
    assert.equal(page.data.coverRead.localSrc, '');
    const readsBeforeHide = requests.length;
    const coverReadsBeforeHide = coverReads.length;
    page.onHide();
    page.onShow();
    await flush();
    assert.equal(page.data.publicDetails.details, null);
    assert.equal(page.data.coverRead.localSrc, '');
    assert.equal(coverReads.length, coverReadsBeforeHide);
    assert.equal(
      requests.length,
      readsBeforeHide,
      'pending block prevents reads',
    );
  } finally {
    page.onHide();
    HttpProfileDetailsGateway.prototype.public = previous.publicRead;
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    nativeGlobal.wx = previous.wx;
  }
});

test('public profile markup shows real UID and only opt-in public fields with explicit null guards', () => {
  const root = join(__dirname, '../src/pages/public-profile');
  const markup = readFileSync(join(root, 'public-profile.wxml'), 'utf8');
  const source = readFileSync(join(root, 'public-profile.ts'), 'utf8');
  assert.match(markup, /UID \{\{profile\.publicUid\.formatted\}\}/);
  for (const field of ['region', 'gender', 'age'])
    assert.ok(markup.includes(`publicDetails.details.${field} !== null`));
  assert.match(
    markup,
    /publicDetails\.details\.profileId === profile\.profileId/,
  );
  assert.match(markup, /!block\.busy &amp;&amp; !block\.frozen/);
  assert.doesNotMatch(
    source,
    /\.own\(|\/v1\/me\/profile-details|birthDate|latitude|longitude/,
  );
});
