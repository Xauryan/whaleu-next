import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  initialDiscussionMediaPage,
  type DiscussionMediaPageView,
  type RatingDiscussionMediaPageController,
} from '../src/ratings/discussion-media-page-controller';
import {
  mediaNoticeHarness,
  noticeKinds,
  noticeRoute,
} from './rating-discussion-media-notice-helpers';
import { credentials, deferred, flush } from './helpers';
import { accountId } from './identity-helpers';
import {
  commentId,
  otherId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
import {
  registerNative,
  renderNativePageText,
} from './framework7-rating-recovery-render';

for (const kind of noticeKinds) {
  for (const fail of ['', 'thread', 'position'] as const)
    test(`${kind}: preview and ${fail || 'successful content'} load never acknowledge, including reload`, async (t) => {
      const h = mediaNoticeHarness();
      t.after(() => h.controller.dispose());
      h.state.fail = fail;
      await h.controller.load(noticeRoute(kind));
      assert.ok(h.view().noticePreview);
      assert.equal(h.view().rows.length, fail ? 0 : 2);
      assert.equal(h.view().noticeRead?.status, 'ready');
      assert.equal(h.view().noticeRead?.canAcknowledge, true);
      assert.deepEqual(h.marks, []);
      assert.ok(h.calls.includes(`notice:${kind}:${otherId}`));
      await h.controller.reload();
      await h.controller.more();
      assert.deepEqual(h.marks, []);
      const before = [...h.calls];
      const contentError = h.view().error;
      await h.controller.acknowledgeNotice(h.key());
      assert.deepEqual(h.marks, [{ kind, id: otherId }]);
      assert.deepEqual(
        h.calls,
        before,
        'bookkeeping never reopens or grants content',
      );
      assert.equal(h.view().noticeRead?.status, 'read');
      assert.equal(h.view().noticeRead?.readAt, timestamp);
      assert.equal(h.view().noticeRead?.unreadCount, 7);
      assert.equal(h.view().noticeRead?.canAcknowledge, false);
      assert.equal(h.view().error, contentError);
      await h.controller.acknowledgeNotice(h.key());
      assert.equal(h.marks.length, 1);
    });

  test(`${kind}: unavailable notice permits only explicit original-owner bookkeeping, not content`, async (t) => {
    const h = mediaNoticeHarness();
    t.after(() => h.controller.dispose());
    h.state.fail = 'unavailable';
    await h.controller.load(noticeRoute(kind));
    assert.equal(h.view().noticePreview, null);
    assert.deepEqual(h.view().rows, []);
    assert.equal(h.view().canCompose, false);
    assert.equal(h.calls.includes('thread'), false);
    assert.deepEqual(h.marks, []);
    await h.controller.acknowledgeNotice(h.key());
    assert.deepEqual(h.marks, [{ kind, id: otherId }]);
    assert.equal(h.view().noticeRead?.status, 'read');
    assert.deepEqual(h.view().rows, []);
    assert.equal(h.view().canCompose, false);
  });

  for (const raw of [
    undefined,
    { noticeId: targetId, readAt: timestamp, unreadCount: 0 },
    { noticeId: otherId, readAt: null, unreadCount: 0 },
    { noticeId: otherId, readAt: timestamp, unreadCount: -1 },
    { noticeId: otherId, readAt: timestamp, unreadCount: 0.5 },
    { noticeId: otherId, readAt: timestamp },
    { noticeId: otherId, readAt: timestamp, unreadCount: 0, extra: true },
  ])
    test(`${kind}: malformed or unmatched receipt ${JSON.stringify(raw)} stays unknown and retries the original owner`, async (t) => {
      const h = mediaNoticeHarness();
      t.after(() => h.controller.dispose());
      await h.controller.load(noticeRoute(kind));
      const key = h.key();
      h.state.read = async () => raw;
      await h.controller.acknowledgeNotice(key);
      assert.equal(h.view().noticeRead?.status, 'unknown');
      assert.equal(h.view().noticeRead?.readAt, null);
      assert.equal(h.view().noticeRead?.unreadCount, null);
      assert.equal(h.view().noticeRead?.canAcknowledge, true);
      await h.controller.reload();
      assert.equal(h.key(), key);
      assert.equal(h.view().noticeRead?.status, 'unknown');
      h.state.read = null;
      await h.controller.acknowledgeNotice(key);
      assert.deepEqual(h.marks, [
        { kind, id: otherId },
        { kind, id: otherId },
      ]);
      assert.equal(h.view().noticeRead?.unreadCount, 7);
    });
}

test('missing owner gateway and missing read context remain explicitly unavailable', async (t) => {
  const missing = mediaNoticeHarness(false),
    expired = mediaNoticeHarness();
  t.after(() => {
    missing.controller.dispose();
    expired.controller.dispose();
  });
  await missing.controller.load(noticeRoute());
  assert.equal(missing.view().rows.length, 2);
  assert.equal(missing.view().noticeRead?.status, 'unavailable');
  await missing.controller.acknowledgeNotice(missing.key());
  assert.deepEqual(missing.marks, []);
  expired.state.fail = 'context';
  await expired.controller.load(noticeRoute());
  assert.equal(expired.view().noticeRead?.status, 'unavailable');
  await expired.controller.acknowledgeNotice(expired.key());
  assert.deepEqual(expired.marks, []);
});

test('busy, wrong key, composer, gallery and cancellation confirmation cannot acknowledge', async (t) => {
  const h = mediaNoticeHarness(),
    wait = deferred<void>();
  t.after(() => h.controller.dispose());
  h.state.threadWait = wait.promise;
  const loading = h.controller.load(noticeRoute());
  await flush();
  const key = h.key();
  assert.equal(h.view().busy, true);
  await h.controller.acknowledgeNotice(key);
  assert.deepEqual(h.marks, []);
  wait.resolve();
  await loading;
  await h.controller.acknowledgeNotice(`${key}:stale`);
  await h.controller.compose();
  assert.equal(h.view().composerOpen, true);
  assert.equal(h.view().noticeRead?.canAcknowledge, false);
  await h.controller.acknowledgeNotice(key);
  h.controller.closeComposer();
  await h.controller.openImage(commentId);
  assert.equal(h.view().gallery.open, true);
  assert.equal(h.view().noticeRead?.canAcknowledge, false);
  await h.controller.acknowledgeNotice(key);
  h.controller.closeImage();
  h.controller.requestCancel();
  assert.equal(h.view().noticeRead?.canAcknowledge, false);
  await h.controller.acknowledgeNotice(key);
  h.controller.dismissCancel();
  assert.deepEqual(h.marks, []);
  await h.controller.acknowledgeNotice(key);
  assert.equal(h.marks.length, 1);
});

const invalidations = [
  'hide',
  'account',
  'session-aba',
  'scope',
  'browsing',
  'privacy',
  'target',
  'expiry',
  'replacement',
] as const;
for (const invalidation of invalidations)
  test(`${invalidation}: late explicit receipt cannot restore a stale owner or canonical count`, async (t) => {
    const h = mediaNoticeHarness(),
      response = deferred<unknown>();
    t.after(() => h.controller.dispose());
    await h.controller.load(noticeRoute());
    const oldKey = h.key();
    h.state.read = () => response.promise;
    const pending = h.controller.acknowledgeNotice(oldKey);
    await flush();
    assert.equal(h.view().noticeRead?.status, 'pending');
    await h.controller.acknowledgeNotice(oldKey);
    assert.equal(h.marks.length, 1);
    switch (invalidation) {
      case 'hide':
        h.controller.hide();
        break;
      case 'account':
        h.sessions.completeLogin(
          h.sessions.beginLogin(),
          credentials(targetId),
        );
        break;
      case 'session-aba':
        h.sessions.completeLogin(
          h.sessions.beginLogin(),
          credentials(accountId, 'new'),
        );
        break;
      case 'scope':
        h.directoryScopeChanges.clear();
        break;
      case 'browsing':
        h.browsingScopeChanges.clear();
        break;
      case 'privacy':
        h.privateViews.clear();
        break;
      case 'target':
        h.runtime.ratingTargetChanges!.publish({ targetId, revision });
        break;
      case 'expiry':
        h.clock.advance(300_001);
        break;
      case 'replacement':
        await h.controller.load(
          noticeRoute('like-updates', targetId, {
            kind: 'campus',
            campusId: revision,
          }),
        );
        break;
    }
    response.resolve({ noticeId: otherId, readAt: timestamp, unreadCount: 0 });
    await pending;
    if (invalidation === 'replacement') {
      assert.notEqual(h.key(), oldKey);
      assert.equal(h.view().noticeRead?.status, 'ready');
      assert.equal(h.view().noticeRead?.unreadCount, null);
    } else assert.equal(h.view().noticeRead, null);
    await h.controller.acknowledgeNotice(oldKey);
    assert.equal(h.marks.length, 1);
  });

for (const stage of ['contextWait', 'noticeWait', 'threadWait'] as const)
  test(`${stage}: hide while loading never automatically mutates or restores notice controls`, async (t) => {
    const h = mediaNoticeHarness(),
      wait = deferred<void>();
    t.after(() => h.controller.dispose());
    h.state[stage] = wait.promise;
    const loading = h.controller.load(noticeRoute());
    await flush();
    h.controller.hide();
    wait.resolve();
    await loading;
    assert.deepEqual(h.marks, []);
    assert.equal(h.view().noticeRead, null);
    assert.deepEqual(h.view().rows, []);
  });

test('recovery barrier precedes context, preview and manual acknowledgment; direct routes have no notice owner', async (t) => {
  const h = mediaNoticeHarness();
  t.after(() => h.controller.dispose());
  h.storage.set(
    `whaleu.ratings.pending.v1:https://notice-test.invalid:${accountId}`,
    { corrupt: true },
  );
  await h.controller.load(noticeRoute());
  assert.deepEqual(h.calls, []);
  assert.equal(h.view().noticeRead?.status, 'unavailable');
  await h.controller.acknowledgeNotice(h.key());
  assert.deepEqual(h.marks, []);
  h.storage.data.clear();
  await h.controller.load({ scope: 'global', targetId, rootId: commentId });
  assert.equal(h.view().noticeRead, null);
  await h.controller.load({ ...noticeRoute(), rootId: commentId });
  assert.equal(h.view().noticeRead, null);
  assert.match(h.view().error, /路径无效/);
});

test('transport failure remains unknown without a count; retry does not infer target access', async (t) => {
  const h = mediaNoticeHarness();
  t.after(() => h.controller.dispose());
  h.state.fail = 'notice';
  await h.controller.load(noticeRoute('subscription-updates'));
  h.state.read = async () => {
    throw Error('synthetic lost response');
  };
  await h.controller.acknowledgeNotice(h.key());
  assert.equal(h.view().noticeRead?.status, 'unknown');
  assert.equal(h.view().noticeRead?.unreadCount, null);
  assert.equal(h.view().canCompose, false);
  h.state.read = null;
  await h.controller.acknowledgeNotice(h.key());
  assert.deepEqual(h.marks, [
    { kind: 'subscription-updates', id: otherId },
    { kind: 'subscription-updates', id: otherId },
  ]);
  assert.deepEqual(h.view().rows, []);
});

type NativePage = {
  data: DiscussionMediaPageView;
  controller?: RatingDiscussionMediaPageController;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onReadNotice(event: { detail?: { interactionKey?: unknown } }): void;
  setData(patch: Partial<DiscussionMediaPageView>, complete?: () => void): void;
};
type ButtonInstance = {
  data: { active: boolean; pageVisible: boolean };
  properties: { interactionKey: string; disabled: boolean; loading: boolean };
  triggerEvent(name: string, detail: { interactionKey?: unknown }): void;
};
type ButtonDefinition = {
  data: ButtonInstance['data'];
  methods: {
    onPress(
      this: ButtonInstance,
      event: { currentTarget: { dataset: { interactionKey: string } } },
    ): void;
  };
  pageLifetimes: {
    hide(this: ButtonInstance): void;
    show(this: ButtonInstance): void;
  };
};

for (const kind of noticeKinds)
  test(`${kind}: real Page and F7 press keep original interaction identity; render/load/show are nonmutating`, async (t) => {
    const h = mediaNoticeHarness(),
      globals = globalThis as unknown as Record<string, unknown>;
    const oldWx = globals.wx,
      oldApp = globals.getApp;
    h.clock.advance(Date.now() - h.clock.now());
    globals.wx = {};
    globals.getApp = () => ({ community: h.runtime });
    const definition = registerNative<NativePage>(
      'Page',
      'pages/rating-discussion-media/rating-discussion-media.ts',
    );
    const commits: (() => void)[] = [];
    const page: NativePage = {
      ...definition,
      data: initialDiscussionMediaPage(),
      setData(patch, complete) {
        this.data = { ...this.data, ...patch };
        if (complete) commits.push(complete);
      },
    };
    t.after(() => {
      page.onHide();
      h.controller.dispose();
      globals.wx = oldWx;
      globals.getApp = oldApp;
    });
    page.onLoad(noticeRoute(kind));
    page.onShow();
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(page.data.rows.length, 2);
    for (const complete of commits) complete();
    assert.deepEqual(h.marks, []);
    const oldKey = page.data.noticeRead!.interactionKey;
    const f7 = registerNative<ButtonDefinition>(
      'Component',
      'components/f7-button/f7-button.ts',
    );
    const button: ButtonInstance = {
      data: { ...f7.data },
      properties: { interactionKey: oldKey, disabled: false, loading: false },
      triggerEvent(name, detail) {
        assert.equal(name, 'press');
        page.onReadNotice({ detail });
      },
    };
    const press = (key: string) =>
      f7.methods.onPress.call(button, {
        currentTarget: { dataset: { interactionKey: key } },
      });
    page.onReadNotice({});
    page.onReadNotice({ detail: { interactionKey: 42 } });
    button.properties.disabled = true;
    press(oldKey);
    button.properties.disabled = false;
    button.properties.loading = true;
    press(oldKey);
    button.properties.loading = false;
    f7.pageLifetimes.hide.call(button);
    press(oldKey);
    f7.pageLifetimes.show.call(button);
    assert.deepEqual(h.marks, []);
    page.onHide();
    page.onShow();
    for (let i = 0; i < 4; i++) await flush();
    const nextKey = page.data.noticeRead!.interactionKey;
    assert.notEqual(nextKey, oldKey);
    press(oldKey); // The old component cannot authorize the replacement page.
    button.properties.interactionKey = nextKey;
    press(oldKey); // F7 rejects an old inner-button tap relabelled by new properties.
    assert.deepEqual(h.marks, []);
    press(nextKey);
    for (let i = 0; i < 4; i++) await flush();
    assert.deepEqual(h.marks, [{ kind, id: otherId }]);
    assert.equal(page.data.noticeRead?.status, 'read');
    page.onHide();
    press(nextKey);
    assert.equal(h.marks.length, 1);
  });

test('media WXML exposes a separately guarded exact-notice F7 action outside content preview', () => {
  const source = readFileSync(
    join(
      __dirname,
      '../src/pages/rating-discussion-media/rating-discussion-media.wxml',
    ),
    'utf8',
  );
  assert.match(source, /<view wx:if="{{noticeRead}}"/);
  assert.match(
    source,
    /<wu-f7-button bind:press="onReadNotice" interaction-key="{{noticeRead.interactionKey}}" disabled="{{!noticeRead.canAcknowledge}}" loading="{{noticeRead.status === 'pending'}}"/,
  );
  const text = renderNativePageText('rating-discussion-media', {
    noticePreview: null,
    noticeRead: {
      interactionKey: 'original',
      status: 'unknown',
      canAcknowledge: true,
      readAt: null,
      unreadCount: null,
    },
  });
  assert.match(text, /结果尚未确认，可重试确认原通知/);
  assert.match(text, /重试确认原通知/);
  assert.doesNotMatch(text, /本条通知已确认已读/);
});
