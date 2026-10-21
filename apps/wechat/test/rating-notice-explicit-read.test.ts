import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { RatingNoticeRead } from '../src/ratings/updates-contract';
import { registerRatingScopedPage } from '../src/ratings/scoped-page';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, targetId, timestamp } from './ratings-helpers';
import { scopedContext, scopedHarness } from './rating-scoped-helpers';
import {
  FakeRatingUpdatesGateway,
  noticeId,
  replyId,
  route,
} from './ratings-r2a-helpers';
import {
  FakeRatingLikeUpdatesGateway,
  likeNoticeTarget,
  likeLocator,
} from './ratings-r2b-helpers';
import {
  FakeRatingSubscriptionUpdatesGateway,
  r2cHarness,
  subscriptionNoticeTarget,
  subscriptionLocator,
} from './ratings-r2c-helpers';

const kinds = ['updates', 'like-updates', 'subscription-updates'] as const;
const query = { mode: 'updates', scope: 'global' };
const receipt = (id = otherId): RatingNoticeRead => ({
  noticeId: id,
  readAt: timestamp,
  unreadCount: 7,
});
function setup() {
  const s = scopedHarness();
  const owners = {
    updates: new FakeRatingUpdatesGateway(),
    'like-updates': new FakeRatingLikeUpdatesGateway(),
    'subscription-updates': new FakeRatingSubscriptionUpdatesGateway(),
  };
  for (const owner of Object.values(owners))
    owner.markReadImpl = async () => receipt();
  Object.assign(s.runtime, {
    ratingUpdates: owners.updates,
    ratingLikeUpdates: owners['like-updates'],
    ratingSubscriptionUpdates: owners['subscription-updates'],
  });
  const calls = () =>
    Object.entries(owners).flatMap(([kind, owner]) =>
      owner.calls
        .filter((call) => call.method === 'markRead')
        .map((call) => ({ kind, ...call })),
    );
  const key = (id = otherId) => `${s.view().noticeReadKey}:${id}`;
  const acknowledge = (kind = s.view().noticeKind, id = otherId) =>
    s.controller.acknowledgeNotice(kind, id, key(id));
  return { ...s, owners, calls, key, acknowledge };
}
async function settle() {
  for (let i = 0; i < 8; i++) await flush();
}
for (const kind of kinds) {
  test(`scoped ${kind}: navigation resolution and image entry never read; explicit unavailable metadata uses exact owner receipt`, async () => {
    const s = setup();
    try {
      await s.controller.load(query);
      if (kind !== 'updates') await s.controller.selectNoticeKind(kind);
      assert.equal(s.view().notices[0]?.status, 'unavailable');
      assert.equal(s.view().canAcknowledgeNotices, true);
      const resolved = await s.controller.noticePath(otherId);
      assert.match(resolved!, new RegExp(`targetId=${targetId}`));
      assert.match(
        s.controller.discussionImageNoticePath(otherId)!,
        new RegExp(`noticeKind=${kind}`),
      );
      assert.deepEqual(s.calls(), []);
      await s.acknowledge(kind, noticeId);
      await s.controller.acknowledgeNotice(kind, otherId, 'old-render');
      await s.acknowledge(kinds.find((value) => value !== kind)!);
      assert.deepEqual(s.calls(), []);
      const targetReads = s.gateway.calls.length;
      await s.acknowledge();
      assert.equal(
        s.gateway.calls.length,
        targetReads,
        'bookkeeping must not request content permission',
      );
      assert.equal(s.calls().length, 1);
      assert.equal(s.calls()[0]?.kind, kind);
      assert.equal(s.calls()[0]?.args[0], otherId);
      assert.equal(s.view().notices[0]?.readAt, timestamp);
      assert.equal(
        s.view().unreadCount,
        7,
        'canonical receipt, never a local decrement',
      );
      await s.acknowledge();
      assert.equal(s.calls().length, 1, 'confirmed rows do not dispatch again');
    } finally {
      s.controller.dispose();
    }
  });
  test(`scoped ${kind}: lost or malformed receipt remains unknown and only explicit original-owner retry succeeds`, async () => {
    const s = setup();
    try {
      await s.controller.load(query);
      await s.controller.selectNoticeKind(kind);
      for (const outcome of ['lost', 'mismatch', 'malformed'] as const) {
        s.owners[kind].markReadImpl = async () => {
          if (outcome === 'lost')
            throw new ClientError('network', 'Response lost');
          return outcome === 'mismatch'
            ? receipt(noticeId)
            : { ...receipt(), unreadCount: -1 };
        };
        await s.acknowledge();
        assert.equal(s.view().notices[0]?.readAt, null);
        assert.equal(s.view().unreadCount, null);
        assert.equal(s.view().noticeReadUnknown[otherId], true);
        assert.match(s.view().status, /尚未确认/);
      }
      s.owners[kind].markReadImpl = async () => receipt();
      await s.acknowledge();
      assert.equal(s.view().notices[0]?.readAt, timestamp);
      assert.equal(s.view().unreadCount, 7);
      assert.equal(s.view().noticeReadUnknown[otherId], false);
      assert.deepEqual(
        s.calls().map((call) => [call.kind, call.args[0]]),
        Array.from({ length: 4 }, () => [kind, otherId]),
      );
    } finally {
      s.controller.dispose();
    }
  });
}

test('scoped explicit action: busy latch and every owner boundary reject stale responses and stale render keys', async () => {
  const boundaries: Array<
    [string, (s: ReturnType<typeof setup>) => void | Promise<void>]
  > = [
    ['category', (s) => s.controller.selectNoticeKind('like-updates')],
    [
      'route',
      (s) =>
        s.controller.load({ ...query, scope: 'campus', campusId: otherId }),
    ],
    [
      'same-account login',
      (s) => {
        s.sessions.completeLogin(
          s.sessions.beginLogin(),
          wireCredentials('replacement'),
        );
      },
    ],
    [
      'different account',
      (s) => {
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('other'),
          accountId: otherId,
        });
      },
    ],
    [
      'logout',
      (s) => {
        s.sessions.logout();
      },
    ],
    ['directory scope', (s) => s.directoryScopeChanges.clear(s.accountId)],
    ['browse scope', (s) => s.browsingScopeChanges.clear(s.accountId)],
    ['app hide', (s) => s.runtime.privateViews!.clear()],
    ['page dispose', (s) => s.controller.dispose()],
  ];
  for (const [label, change] of boundaries) {
    const s = setup(),
      held = deferred<RatingNoticeRead>();
    try {
      await s.controller.load(query);
      const originalKey = s.key();
      s.owners.updates.markReadImpl = () => held.promise;
      const pending = s.acknowledge();
      await settle();
      await s.acknowledge();
      assert.equal(s.calls().length, 1, `${label}: busy duplicate`);
      await change(s);
      const current = s.view();
      held.resolve(receipt());
      await pending;
      assert.deepEqual(s.view(), current, `${label}: stale callback`);
      await s.controller.acknowledgeNotice('updates', otherId, originalKey);
      assert.equal(s.calls().length, 1, `${label}: stale control`);
    } finally {
      held.resolve(receipt());
      s.controller.dispose();
    }
  }
});

test('scoped pending locator invalidation, expired lease, unavailable target and missing read owner never acknowledge', async () => {
  const s = setup();
  try {
    await s.controller.load(query);
    const held = deferred<Awaited<ReturnType<typeof s.gateway.noticeTarget>>>();
    const original = s.gateway.noticeTarget.bind(s.gateway);
    s.gateway.noticeTarget = () => held.promise;
    const opening = s.controller.noticePath(otherId);
    await settle();
    s.browsingScopeChanges.clear(s.accountId);
    held.resolve(
      await original(
        'updates',
        otherId,
        scopedContext({
          purpose: 'read',
          selector: { kind: 'global' },
          mode: 'public',
        }),
      ),
    );
    assert.equal(await opening, null);
    assert.deepEqual(s.calls(), []);
    s.gateway.noticeTarget = original;
    await s.controller.load(query);
    await s.controller.noticePath(otherId);
    s.clock.advance(300_001);
    await s.acknowledge();
    assert.deepEqual(s.calls(), []);
    Object.assign(s.runtime, { ratingUpdates: undefined });
    await s.controller.load(query);
    assert.equal(s.view().canAcknowledgeNotices, false);
    await s.acknowledge();
    assert.match(s.view().error, /暂不可用/);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.controller.dispose();
  }
});

for (const explicit of [false, true]) {
  for (const entry of [
    'reply',
    'root-like',
    'reply-like',
    'root-subscription',
    'reply-subscription',
  ] as const) {
    test(`legacy ${entry}, explicit marker ${explicit}: exact locator proof remains; load/reload/expand never acknowledge`, async () => {
      const s = r2cHarness();
      const anchored = entry === 'reply' || entry.startsWith('reply-');
      s.ratingLikeUpdates.targetImpl = async () =>
        likeNoticeTarget({
          target: likeLocator({ replyId: anchored ? replyId : null }),
        });
      s.ratingSubscriptionUpdates.targetImpl = async () =>
        subscriptionNoticeTarget({
          target: subscriptionLocator({ replyId: anchored ? replyId : null }),
        });
      const owner =
        entry === 'reply'
          ? s.ratingUpdates
          : entry.endsWith('like')
            ? s.ratingLikeUpdates
            : s.ratingSubscriptionUpdates;
      const noticeField =
        entry === 'reply'
          ? 'noticeId'
          : entry.endsWith('like')
            ? 'likeNoticeId'
            : 'subscriptionNoticeId';
      try {
        await s.controller.load({
          ...route,
          ...(anchored ? { replyId } : {}),
          [noticeField]: noticeId,
          ...(explicit ? { noticeRead: 'explicit' } : {}),
        });
        assert.equal(s.view().loaded, true);
        assert.equal(s.view().anchorReplyId, anchored ? replyId : '');
        assert.deepEqual(
          owner.calls.map((call) => call.method),
          ['target'],
        );
        await s.controller.reload();
        s.controller.collapse();
        await s.controller.expand();
        assert.equal(s.view().loaded, true);
        assert.deepEqual(
          owner.calls.map((call) => call.method),
          ['target', 'target', 'target'],
        );
        for (const gateway of [
          s.ratingUpdates,
          s.ratingLikeUpdates,
          s.ratingSubscriptionUpdates,
        ])
          assert.equal(
            gateway.calls.some((call) => call.method === 'markRead'),
            false,
          );
      } finally {
        s.controller.dispose();
        s.detailController.dispose();
        s.directoryController.dispose();
        s.updatesController.dispose();
      }
    });
  }
}

type PageOwner = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  [key: string]: unknown;
};
type ButtonInstance = {
  data: Record<string, unknown>;
  properties: Record<string, unknown>;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
};
type ButtonMethod = (this: ButtonInstance, event?: unknown) => void;
type ButtonDefinition = {
  data: Record<string, unknown>;
  properties: Record<string, { value: unknown }>;
  methods: Record<string, ButtonMethod>;
  pageLifetimes: Record<string, ButtonMethod>;
  lifetimes: Record<string, ButtonMethod>;
};
const requireNative = createRequire(__filename);
function invoke(page: PageOwner, method: string, event?: unknown) {
  return (page[method] as (event?: unknown) => unknown).call(page, event);
}

test('real scoped Page/F7 control: failed and successful native navigation stays unread, overlay/hidden/stale taps cannot acknowledge', async () => {
  const s = setup();
  s.controller.dispose();
  s.gateway.contextWork = async (request) => scopedContext(request, Date.now());
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    Component: globals.Component,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let page: PageOwner | undefined, definition: ButtonDefinition | undefined;
  let failNavigation = true;
  const destinations: string[] = [];
  const commits: Array<() => void> = [];
  globals.Page = (value: PageOwner) => {
    page = value;
    value.setData = (patch, callback) => {
      Object.assign(value.data, patch);
      if (callback) commits.push(callback);
    };
  };
  globals.Component = (value: ButtonDefinition) => {
    definition = value;
  };
  globals.getApp = () => ({ community: s.runtime });
  globals.wx = {
    navigateTo: ({
      url,
      success,
      fail,
    }: {
      url: string;
      success: () => void;
      fail: () => void;
    }) => {
      destinations.push(url);
      if (failNavigation) fail();
      else success();
    },
  };
  try {
    registerRatingScopedPage();
    assert.ok(page);
    const native = page;
    invoke(native, 'onLoad', query);
    invoke(native, 'onShow');
    await settle();
    const buttonFile = requireNative.resolve(
      '../src/components/f7-button/f7-button.ts',
    );
    delete requireNative.cache[buttonFile];
    requireNative(buttonFile);
    assert.ok(definition);
    const button = definition;
    const wxml = readFileSync(
      path.join(__dirname, '../src/pages/rating-scoped/rating-scoped.wxml'),
      'utf8',
    );
    const tag = wxml.match(
      /<wu-f7-button\b[^>]*bind:press="onNoticeRead"[^>]*>/,
    )?.[0];
    assert.ok(tag);
    assert.match(
      tag,
      /interaction-key="\{\{noticeReadKey\}\}:\{\{item.noticeId\}\}"/,
    );
    assert.match(tag, /data-kind="\{\{noticeKind\}\}"/);
    const evaluate = (raw: string, item: unknown) => {
      const scope = { ...native.data, item };
      if (/^\{\{[^{}]*\}\}$/.test(raw))
        return Function(
          'scope',
          `with(scope) { return (${raw.slice(2, -2)}); }`,
        )(scope) as unknown;
      return raw.replace(/\{\{([^{}]*)\}\}/g, (_all, expression: string) =>
        String(
          Function('scope', `with(scope) { return (${expression}); }`)(scope),
        ),
      );
    };
    const mountControl = () => {
      const item = (native.data.notices as unknown[])[0];
      const attrs = Object.fromEntries(
        [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
          match[1]!,
          evaluate(match[2]!, item),
        ]),
      );
      const properties = Object.fromEntries(
        Object.entries(button.properties).map(([key, value]) => [
          key,
          value.value,
        ]),
      );
      for (const [key, value] of Object.entries(attrs)) {
        const camel = key.replace(/-([a-z])/g, (_all, letter: string) =>
          letter.toUpperCase(),
        );
        if (camel in properties) properties[camel] = value;
      }
      const key = properties.interactionKey;
      const instance: ButtonInstance = {
        data: structuredClone(button.data),
        properties,
        triggerEvent(name, detail, options) {
          assert.equal(name, 'press');
          assert.deepEqual(options, { bubbles: false, composed: false });
          invoke(native, 'onNoticeRead', {
            detail,
            currentTarget: {
              dataset: { kind: attrs['data-kind'], id: attrs['data-id'] },
            },
          });
        },
      };
      button.lifetimes.attached!.call(instance);
      return {
        press: () =>
          button.methods.onPress!.call(instance, {
            currentTarget: { dataset: { interactionKey: key } },
          }),
        hide: () => button.pageLifetimes.hide!.call(instance),
      };
    };
    assert.equal(native.data.loaded, true);
    assert.deepEqual(s.calls(), []);
    for (const callback of commits.splice(0)) callback();
    assert.deepEqual(
      s.calls(),
      [],
      'native setData completion alone is not a read',
    );
    for (const failure of [true, false]) {
      failNavigation = failure;
      await invoke(native, 'onNotice', {
        currentTarget: { dataset: { id: otherId } },
      });
      assert.deepEqual(s.calls(), []);
    }
    assert.equal(destinations.length, 2);
    invoke(native, 'onTogglePanel', {
      currentTarget: { dataset: { panel: 'scope' } },
    });
    mountControl().press();
    await settle();
    assert.deepEqual(s.calls(), [], 'overlay disables real F7 action');
    invoke(native, 'onClosePanel');
    const oldControl = mountControl(),
      hiddenControl = mountControl();
    hiddenControl.hide();
    hiddenControl.press();
    assert.deepEqual(s.calls(), []);
    invoke(native, 'onNoticeKind', {
      currentTarget: { dataset: { kind: 'like-updates' } },
    });
    await settle();
    oldControl.press();
    await settle();
    assert.deepEqual(
      s.calls(),
      [],
      'old category tap with colliding notice ID is rejected',
    );
    const current = mountControl();
    current.press();
    current.press();
    await settle();
    assert.equal(s.calls().length, 1);
    assert.equal(s.calls()[0]?.kind, 'like-updates');
    assert.equal(
      (native.data.notices as Array<{ readAt: string }>)[0]?.readAt,
      timestamp,
    );
    invoke(native, 'onHide');
    current.press();
    await settle();
    assert.equal(s.calls().length, 1, 'disposed Page cannot acknowledge');
  } finally {
    if (page) invoke(page, 'onUnload');
    Object.assign(globals, previous);
  }
});

test('all three rating loading/navigation functions remain mutation-free while exact locator fields stay present', () => {
  const read = (file: string) =>
    readFileSync(path.join(__dirname, '../src/ratings', file), 'utf8');
  const legacy = read('discussion-controller.ts');
  assert.doesNotMatch(
    legacy.slice(
      legacy.indexOf('private async refresh()'),
      legacy.indexOf('  collapse():'),
    ),
    /\.markRead\(/,
  );
  assert.match(legacy, /decodeRatingNoticeTarget/);
  assert.match(legacy, /decodeRatingLikeNoticeTarget/);
  assert.match(legacy, /decodeRatingSubscriptionNoticeTarget/);
  const scoped = read('scoped-controller.ts');
  const navigation = scoped.slice(
    scoped.indexOf('  async noticePath('),
    scoped.indexOf('  async ratingLinkComposePath('),
  );
  assert.doesNotMatch(navigation, /\.markRead\(/);
  assert.match(navigation, /noticeTarget\(/);
  assert.match(navigation, /assertRead\(cancel, context\)/);
  const media = read('discussion-media-page-controller.ts');
  const reload = media.slice(
    media.indexOf('  async reload()'),
    media.indexOf('  async selectSort('),
  );
  assert.doesNotMatch(reload, /\.markRead\(/);
  assert.match(reload, /gateway\.notice\(/);
  assert.match(reload, /gateway\.position\(/);
});
