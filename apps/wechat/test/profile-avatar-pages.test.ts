import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
const source = (path: string) =>
  readFileSync(join(__dirname, '../src', path), 'utf8');
test('Profile uses the shared recoverable system picker and leaves dedicated chooseAvatar disabled', () => {
  const page = source('pages/profile/profile.ts'),
    template = source('pages/profile/profile.wxml');
  assert.doesNotMatch(template, /open-type="chooseAvatar"|bindchooseavatar/);
  assert.match(template, /bindtap="onChooseCustomAvatar"/);
  assert.match(page, /avatarController\?\.chooseCustomAvatar\(\)/);
  assert.match(template, /src="{{avatar\.previewSrc}}"/);
  assert.match(template, /src="{{avatarRead\.localSrc}}"/);
  assert.doesNotMatch(
    page + template,
    /wx\.previewImage|wx\.saveFile|face_url|https:\/\//,
  );
});
test('named feed/detail/thread/profile-post controls are lazy and a single reader window is composed per page', () => {
  for (const page of [
    'community-feed',
    'community-detail',
    'community-thread',
    'public-profile',
  ]) {
    const script = source(`pages/${page}/${page}.ts`),
      template = source(`pages/${page}/${page}.wxml`);
    assert.equal(script.match(/new NamedAvatarController\(/g)?.length, 1);
    assert.match(
      script,
      /onPageScroll\(\)[\s\S]*?namedAvatarController\?\.clear\(\)/,
    );
    assert.match(
      script,
      /onHide\(\)[\s\S]*?namedAvatarController\?\.dispose\(\)/,
    );
    assert.match(template, /named-avatar-preview/);
    assert.doesNotMatch(script, /new AvatarReadController|wx\.previewImage/);
  }
  const named = source('profile/named-avatar.ts');
  assert.match(named, /author\.kind !== 'named'/);
  assert.match(named, /pending\?\.profileId === author\.profileId/);
  const runtime = source('profile/avatar-runtime.ts');
  assert.match(runtime, /other !== reader\) other\.clear\(\)/);
  assert.match(runtime, /gateway \?\? unavailableAvatarGateway/);
});

test('own Profile activates media only after current basics, revokes on failure or hide, and keeps actor-isolated metadata', async () => {
  const { ApiClient } = await import('../src/api/client.js');
  const { SessionStore } = await import('../src/auth/session.js');
  const { createProfileAvatarRuntime } =
    await import('../src/profile/avatar-runtime.js');
  const { PendingAvatarStore } =
    await import('../src/profile/avatar-pending.js');
  const { PROFILE_MEDIA_PROTOCOL } =
    await import('../src/profile/avatar-contract.js');
  const {
    FakeClock,
    MemoryStorage,
    ScriptedTransport,
    deferred,
    flush,
    response,
  } = await import('./helpers.js');
  const { wireCredentials } = await import('./identity-helpers.js');
  const { ownProfile } = await import('./profile-helpers.js');
  const { avatarIds, FakeAvatarGateway, FakeAvatarUpload } =
    await import('./support/avatar-fixtures.js');
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport(),
    storage = new MemoryStorage(),
    gateway = new FakeAvatarGateway();
  const api = new ApiClient('https://api.example.test', transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  const profileAvatar = createProfileAvatarRuntime({
    sessions,
    storage,
    origin: 'https://api.example.test',
    clock: new FakeClock(),
    newRequestId: async () => avatarIds.request,
    gateway,
    upload: new FakeAvatarUpload(),
    download: {
      async download(_current, _variant, _owner, principal) {
        principal.current();
        return { localId: 'own-avatar' };
      },
      async resolve() {
        return 'wxfile://tmp/own-avatar.png';
      },
      async release() {},
    },
  });
  type OwnPage = {
    data: { avatarRead: { localSrc: string }; avatar: { previewSrc: string } };
    avatarController: unknown;
    avatarReader: unknown;
    setData(patch: Record<string, unknown>): void;
    onShow(): void;
    onHide(): void;
    onReload(): void;
  };
  let definition: OwnPage | undefined;
  const previous = { Page: globalThis.Page, getApp: globalThis.getApp };
  globalThis.Page = ((value: object) => {
    definition = value as OwnPage;
  }) as typeof Page;
  globalThis.getApp = (() =>
    ({
      identity: { sessions, api },
      profileAvatar,
    }) as WhaleuApp) as typeof getApp;
  let page: OwnPage | undefined;
  try {
    await import('../src/pages/profile/profile.js');
    assert.ok(definition);
    page = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    const first = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => first.promise);
    page.onShow();
    await flush();
    assert.equal(gateway.currentReads.length, 0);
    assert.equal(page.avatarReader, undefined);
    first.resolve(response(ownProfile()));
    await flush();
    await flush();
    assert.ok(page.data.avatarRead.localSrc);
    assert.ok(page.avatarController);
    const pending = new PendingAvatarStore(storage, 'https://api.example.test');
    const record = pending.freezeCommand(avatarIds.actor, {
      protocol: PROFILE_MEDIA_PROTOCOL,
      clientRequestId: avatarIds.command,
      expectedRevision: 5,
      source: { kind: 'clear' },
    });
    const count = gateway.currentReads.length;
    const failed = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => failed.promise);
    page.onReload();
    assert.equal(page.data.avatarRead.localSrc, '');
    assert.equal(page.avatarController, undefined);
    await flush();
    failed.reject(new Error('Synthetic basics failure'));
    await flush();
    assert.equal(gateway.currentReads.length, count);
    assert.equal(page.avatarReader, undefined);
    assert.deepEqual(pending.load(avatarIds.actor), record);
    const old = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => old.promise);
    page.onReload();
    await flush();
    sessions.completeLogin(sessions.beginLogin(), {
      ...wireCredentials('b'),
      accountId: avatarIds.other,
    });
    const next = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => next.promise);
    page.onReload();
    await flush();
    old.resolve(response(ownProfile()));
    await flush();
    assert.equal(gateway.currentReads.length, count);
    assert.equal(page.avatarReader, undefined);
    next.resolve(response(ownProfile({ accountId: avatarIds.other })));
    await flush();
    await flush();
    assert.ok(page.data.avatarRead.localSrc);
    assert.ok(
      gateway.currentReads
        .slice(count)
        .every((actor) => actor === avatarIds.other),
    );
    assert.deepEqual(pending.load(avatarIds.actor), record);
    assert.equal(pending.load(avatarIds.other), null);
    const hidden = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => hidden.promise);
    page.onReload();
    await flush();
    page.onHide();
    const hiddenCount = gateway.currentReads.length;
    hidden.resolve(response(ownProfile({ accountId: avatarIds.other })));
    await flush();
    assert.equal(page.data.avatarRead.localSrc, '');
    assert.equal(page.data.avatar.previewSrc, '');
    assert.equal(page.avatarReader, undefined);
    assert.equal(gateway.currentReads.length, hiddenCount);
    assert.deepEqual(pending.load(avatarIds.actor), record);
  } finally {
    page?.onHide();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
  }
});

test('avatar handlers preserve v2 automatic post readers without clear or close side effects', () => {
  for (const page of ['community-detail', 'community-thread']) {
    const script = source(`pages/${page}/${page}.ts`);
    const handler = script.slice(
      script.indexOf('  onAuthorAvatar(event:'),
      script.indexOf('  onNamedAvatarClose()'),
    );
    assert.match(handler, /namedAvatarController\?\.open\(author\)/);
    assert.doesNotMatch(
      handler,
      /mediaGalleryController|mediaReadController|registry\./,
    );
  }
  const detail = source('pages/community-detail/community-detail.ts');
  const template = source('pages/community-detail/community-detail.wxml');
  assert.match(
    detail,
    /mediaReadController = getApp<WhaleuApp>\(\)\.mediaRead\?\.create/,
  );
  assert.match(
    detail,
    /if \(post\)[\s\S]*?mediaGalleryController\?\.select\(\{/,
  );
  assert.match(detail, /onPageScroll\(\)[\s\S]*?groupKind !== 'post'/);
  assert.match(template, /mediaRead\.localSrc/);
  assert.match(template, /查看帖子图片（{{post\.images\.length}} 张）/);
  assert.match(
    template,
    /wx:if="{{post\.images\.length &amp;&amp; mediaGallery\.groupKind !== 'post'}}"/,
  );
});
