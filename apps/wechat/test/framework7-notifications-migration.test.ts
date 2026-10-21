import { assertReviewedReadingSuccessor } from './reviewed-reading-successor';
import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import { assertReviewedNoticeReadSuccessor } from './reviewed-notice-read-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-reading-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import type { CommunityRuntime } from '../src/community/runtime';
import { ClientError } from '../src/api/errors';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { setup, requestId, otherId, createdAt } from './community-helpers';
import { update, unavailable, updates } from './updates-helpers';
import {
  FakeRatingUpdatesGateway,
  notice as ratingNotice,
  updates as ratingUpdates,
} from './ratings-r2a-helpers';
import { FakeRatingLikeUpdatesGateway } from './ratings-r2b-helpers';
import { FakeRatingSubscriptionUpdatesGateway } from './ratings-r2c-helpers';
import {
  discussionHarness as windowHarness,
  notice as windowNotice,
} from './window-discussion-helpers';
import {
  discussionHarness as majorHarness,
  notice as majorNotice,
} from './major-discussion-helpers';
import {
  systemNoticesSetup,
  systemNotice,
  systemNotices,
} from './system-notices-helpers';
import { deferred, flush } from './helpers';

const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-notifications-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-notifications-before-protected.json'),
) as Record<string, string>;
const pages = [
  'community-updates',
  'rating-updates',
  'window-discussion-notices',
  'major-discussion-notices',
  'social-notices',
  'system-notices',
  'notice-thread',
];
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
function chains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        child.tag,
      );
    chains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact actions, source datasets and all ancestor/disabled/loading guards survive`, () => {
    const tree = parse(read(file)),
      current = actions(tree);
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    chains(tree);
  });
test('native notification composition uses registered source components and no nested actionable slots or new overlays', () => {
  for (const page of pages) {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-block'));
    if (page !== 'notice-thread')
      assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    for (const node of nodes.filter((node) => node.tag.startsWith('wu-f7-'))) {
      const kind = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${kind}/${kind}`,
      );
      if (node.tag === 'wu-f7-button' || node.tag === 'wu-f7-list-item')
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (child) =>
                child.tag === 'navigator' ||
                /^(button|input|textarea|switch|wu-f7-button|wu-f7-list-item)$/.test(
                  child.tag,
                ) ||
                Object.keys(child.attrs).some((key) =>
                  /^(bind|catch)/.test(key),
                ),
            ),
          `${page}: no nested interaction`,
        );
    }
    assert.ok(
      !nodes.some((node) =>
        /^(button|wu-f7-sheet|wu-f7-dialog|wu-f7-actions|web-view)$/.test(
          node.tag,
        ),
      ),
    );
    assert.match(
      source(page, 'wxss'),
      /notifications\/framework7-details\.wxss/,
    );
  }
});
test('all 307 protected controller, reader, media, privacy, accepted-root and pinned native-component files stay byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 307);
  for (const [file, hash] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedReadingSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNoticeReadSuccessor(file, expected) &&
      !assertReviewedSocialSuccessor(file, expected),
  ))
    assert.equal(sha(read(file)), hash, file);
});
test('source fixtures are exact bounded clones, retain unavailable follow/activity and truthful partial/uncertain states', () => {
  interface Fixture {
    id: string;
    page: string;
    title: string;
    patch: Record<string, unknown>;
    expectedText: string[];
  }
  const { default: original } = requireNative(
    '../scripts/fixtures/notification-details-preview.mjs',
  ) as { default: Fixture[] };
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-notifications-preview.mjs',
  ) as { default: Fixture[] };
  assert.equal(fixtures.length, 19);
  assert.deepEqual(
    [...new Set(fixtures.map((f) => f.page))].sort(),
    pages.slice().sort(),
  );
  fixtures.forEach((fixture, index) => {
    assert.equal(fixture.id, `framework7-notifications-${original[index]!.id}`);
    assert.deepEqual(fixture.patch, original[index]!.patch);
    assert.deepEqual(fixture.expectedText, original[index]!.expectedText);
  });
  assert.match(source('social-notices'), /暂未接入关注通知服务/);
  assert.match(source('notice-thread'), /暂未接入活动通知服务/);
  assert.doesNotMatch(
    source('social-notices') + source('system-notices'),
    /unreadCount\s*\}\}/,
  );
});

interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let definition: T | undefined;
  globals[kind] = (value: T) => {
    definition = value;
  };
  try {
    const target = requireNative.resolve(path.join(root, 'src', file));
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition);
  return definition;
}
function invoke(owner: Owner, name: string, event?: unknown) {
  return (owner[name] as (event?: unknown) => unknown).call(owner, event);
}
function mount(page: string, runtime: CommunityRuntime, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp };
  const navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
  };
  globals.getApp = () => ({ community: runtime });
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, callback) {
      Object.assign(this.data, value);
      callback?.();
    },
  };
  if (target.onLoad) invoke(target, 'onLoad', query);
  if (target.onShow) invoke(target, 'onShow');
  return {
    target,
    navigation,
    close() {
      if (target.onUnload) invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function control(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  selector: Record<string, string> = {},
) {
  const node = flatten(parse(source(page))).find(
    (node) =>
      node.attrs['bind:press'] === handler &&
      Object.entries(selector).every(
        ([key, value]) => node.attrs[key] === value,
      ),
  );
  assert.ok(node, `${page}:${handler}`);
  const scope = { ...target.data, ...patch };
  const evaluate = (raw: string) =>
    raw.startsWith('{{')
      ? Function('scope', `with(scope){return (${raw.slice(2, -2)});}`)(scope)
      : raw;
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5), evaluate(value)]),
  );
  const kind = node.tag.slice(3),
    definition = registration<Definition>(
      'Component',
      `components/${kind}/${kind}.ts`,
    );
  let dispatched = 0;
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          structuredClone(value.value),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => ['disabled', 'loading', 'link'].includes(key))
          .map(([key, value]) => [key, evaluate(value)]),
      ),
    },
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(name, detail, options) {
      assert.equal(name, 'press');
      assert.deepEqual(options, { bubbles: false, composed: false });
      dispatched++;
      invoke(target, handler, { detail, currentTarget: { dataset } });
    },
  };
  definition.lifetimes?.attached?.call(instance);
  return {
    press: () => definition.methods.onPress!.call(instance),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
    dispatched: () => dispatched,
  };
}
function press(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  selector: Record<string, string> = {},
) {
  const c = control(page, handler, target, patch, selector);
  c.press();
  c.detach();
  return c.dispatched();
}

test('real Button→community Page→reader retains exact IDs, no eager reads, opaque pagination, busy/cancel and hidden/session fences', async () => {
  const h = setup();
  h.gateway.updatesImpl = async (cursor) =>
    cursor
      ? updates([update('reply', otherId)])
      : updates([update(), unavailable(otherId)], 'community-next', 9);
  h.gateway.updateTargetImpl = async (noticeId) => ({
    noticeId,
    status: 'available',
    target: update().target,
  });
  const f = mount('community-updates', h.runtime);
  try {
    await flush();
    assert.equal(f.target.data.unreadCount, 9);
    assert.equal(
      h.gateway.calls.some((call) => call.method === 'readUpdate'),
      false,
    );
    press('community-updates', 'onOpen', f.target, { item: update() });
    await flush();
    assert.equal(
      h.gateway.calls.find((call) => call.method === 'updateTarget')?.args[0],
      requestId,
    );
    assert.equal(f.navigation.length, 1);
    assert.equal(
      h.gateway.calls.some((call) => call.method === 'readUpdate'),
      false,
    );
    press('community-updates', 'onRead', f.target, { item: update() });
    await flush();
    assert.equal(
      h.gateway.calls.find((call) => call.method === 'readUpdate')?.args[0],
      requestId,
    );
    press('community-updates', 'onMore', f.target);
    await flush();
    assert.equal(
      h.gateway.calls.filter((call) => call.method === 'updates')[1]?.args[0],
      'community-next',
    );
    const pending = deferred<ReturnType<typeof updates>>();
    h.gateway.updatesImpl = () => pending.promise;
    press('community-updates', 'onReload', f.target);
    assert.equal(f.target.data.busy, true);
    assert.equal(press('community-updates', 'onReload', f.target), 0);
    press('community-updates', 'onCancel', f.target);
    pending.resolve(updates());
    await flush();
    assert.deepEqual(f.target.data.items, []);
    const stale = control('community-updates', 'onRead', f.target, {
      busy: false,
      item: update(),
    });
    stale.hide();
    stale.press();
    assert.equal(stale.dispatched(), 0);
    stale.detach();
    invoke(f.target, 'onHide');
    h.sessions.logout();
    assert.equal(f.target.controller, undefined);
    press('community-updates', 'onRead', f.target, {
      busy: false,
      item: update(),
    });
    assert.equal(
      h.gateway.calls.filter((call) => call.method === 'readUpdate').length,
      1,
    );
  } finally {
    f.close();
  }
});

test('real Button→rating Page→controller retains reply/like/subscription ownership and invalid route guard', async () => {
  const h = setup(),
    rating = new FakeRatingUpdatesGateway(),
    likes = new FakeRatingLikeUpdatesGateway(),
    subscriptions = new FakeRatingSubscriptionUpdatesGateway();
  const runtime = {
    ...h.runtime,
    ratingUpdates: rating,
    ratingLikeUpdates: likes,
    ratingSubscriptionUpdates: subscriptions,
  };
  const f = mount('rating-updates', runtime);
  try {
    await flush();
    assert.equal(
      rating.calls.some((call) => call.method === 'markRead'),
      false,
    );
    const row = (f.target.data.items as { noticeId: string }[])[0]!;
    press('rating-updates', 'onRead', f.target, { item: row });
    await flush();
    assert.equal(
      rating.calls.find((call) => call.method === 'markRead')?.args[0],
      row.noticeId,
    );
    press(
      'rating-updates',
      'onCategory',
      f.target,
      {},
      { 'data-category': 'like' },
    );
    await flush();
    assert.equal(f.target.data.category, 'like');
    assert.equal(
      likes.calls.filter((call) => call.method === 'list').length,
      1,
    );
    const like = (f.target.data.items as { noticeId: string }[])[0]!;
    press('rating-updates', 'onRead', f.target, { item: like });
    await flush();
    assert.equal(
      likes.calls.find((call) => call.method === 'markRead')?.args[0],
      like.noticeId,
    );
    assert.equal(
      rating.calls.filter((call) => call.method === 'markRead').length,
      1,
    );
    press(
      'rating-updates',
      'onCategory',
      f.target,
      {},
      { 'data-category': 'subscription' },
    );
    await flush();
    assert.equal(f.target.data.category, 'subscription');
    assert.equal(
      subscriptions.calls.filter((call) => call.method === 'list').length,
      1,
    );
    h.sessions.logout();
    assert.deepEqual(f.target.data.items, []);
  } finally {
    f.close();
  }
  const invalid = mount('rating-updates', runtime, { unexpected: 'value' });
  try {
    assert.equal(invalid.target.controller, undefined);
    assert.match(String(invalid.target.data.error), /链接无效/);
  } finally {
    invalid.close();
  }
});

function discussionNoticeHarness(kind: 'window' | 'major') {
  const ids: string[] = [],
    cursors: unknown[] = [];
  if (kind === 'window') {
    const h = windowHarness(),
      row = windowNotice();
    h.controller.dispose();
    h.impl.notices = async (cursor) => {
      cursors.push(cursor);
      return {
        items: [row],
        nextCursor: cursor ? null : 'window-next',
        unreadCount: 7,
      };
    };
    h.impl.read = async (noticeId) => {
      ids.push(noticeId);
      return { noticeId, readAt: createdAt };
    };
    return { runtime: h.runtime, sessions: h.sessions, row, ids, cursors };
  }
  const h = majorHarness(),
    row = majorNotice();
  h.controller.dispose();
  h.impl.notices = async (cursor) => {
    cursors.push(cursor);
    return {
      items: [row],
      nextCursor: cursor ? null : 'major-next',
      unreadCount: 7,
    };
  };
  h.impl.read = async (noticeId) => {
    ids.push(noticeId);
    return { noticeId, readAt: createdAt };
  };
  return { runtime: h.runtime, sessions: h.sessions, row, ids, cursors };
}
for (const kind of ['window', 'major'] as const)
  test(`real Button→${kind} notices Page→controller retains exact read/target identity, independent cursor and stale owner fences`, async () => {
    const h = discussionNoticeHarness(kind),
      { row, ids, cursors } = h;
    const page = `${kind}-discussion-notices`,
      f = mount(page, h.runtime);
    try {
      await flush();
      assert.equal(f.target.data.unreadCount, 7);
      assert.deepEqual(ids, []);
      press(page, 'onOpen', f.target, { item: row });
      await flush();
      assert.equal(f.navigation.length, 1);
      assert.deepEqual(ids, []);
      press(page, 'onNext', f.target);
      await flush();
      assert.equal(cursors[1], `${kind}-next`);
      assert.equal(f.target.data.pageNumber, 2);
      assert.equal(
        press(page, 'onRead', f.target, { item: row, busy: true }),
        0,
      );
      press(page, 'onRead', f.target, { item: row });
      await flush();
      assert.deepEqual(ids, [row.noticeId]);
      h.sessions.logout();
      assert.deepEqual(f.target.data.items, []);
      press(page, 'onRead', f.target, { item: row, busy: false });
      await flush();
      assert.equal(ids.length, 1);
      invoke(f.target, 'onHide');
      assert.equal(f.target.controller, undefined);
      assert.equal(f.target.gallery, undefined);
      assert.equal(f.target.navigator, undefined);
    } finally {
      f.close();
    }
  });

test('real Button/List-item→social Page→aggregator preserves duplicate-ID namespaces, partial availability and independent pagination', async () => {
  const h = setup(),
    rating = new FakeRatingUpdatesGateway(),
    cursors: unknown[] = [];
  h.gateway.updatesImpl = async (cursor) => {
    cursors.push(cursor);
    return updates([update()], cursor ? null : 'only-community-next', 11);
  };
  rating.listImpl = async () =>
    ratingUpdates({ items: [ratingNotice({ noticeId: requestId })] });
  h.gateway.updateTargetImpl = async (noticeId) => ({
    noticeId,
    status: 'available',
    target: update().target,
  });
  const runtime = { ...h.runtime, ratingUpdates: rating };
  const f = mount('social-notices', runtime, { kind: 'comments' });
  try {
    await flush();
    const rows = f.target.data.rows as {
      id: string;
      available: boolean;
      busy: boolean;
    }[];
    const community = rows.find((row) => row.id === `community:${requestId}`)!,
      reply = rows.find((row) => row.id === `rating-reply:${requestId}`)!;
    assert.ok(community);
    assert.ok(reply);
    assert.equal(f.target.data.partial, true);
    assert.equal(
      h.gateway.calls.some((call) => call.method === 'readUpdate'),
      false,
    );
    assert.equal(
      press('social-notices', 'onOpen', f.target, {
        item: { ...community, available: false },
      }),
      0,
    );
    press('social-notices', 'onOpen', f.target, { item: community });
    await flush();
    assert.equal(f.navigation.length, 1);
    assert.equal(
      h.gateway.calls.some((call) => call.method === 'readUpdate'),
      false,
    );
    press('social-notices', 'onRead', f.target, { item: community });
    await flush();
    assert.equal(
      h.gateway.calls.find((call) => call.method === 'readUpdate')?.args[0],
      requestId,
    );
    assert.equal(
      rating.calls.some((call) => call.method === 'markRead'),
      false,
    );
    const beforeRating = rating.calls.filter(
      (call) => call.method === 'list',
    ).length;
    press('social-notices', 'onMore', f.target, {
      item: { key: 'community', busy: false },
    });
    await flush();
    assert.equal(cursors[1], 'only-community-next');
    assert.equal(
      rating.calls.filter((call) => call.method === 'list').length,
      beforeRating,
    );
    press('social-notices', 'onCoverage', f.target);
    assert.equal(f.target.data.showCoverage, true);
    h.sessions.logout();
    assert.deepEqual(f.target.data.rows, []);
    invoke(f.target, 'onHide');
    assert.equal(f.target.data.showCoverage, false);
  } finally {
    f.close();
  }
});

test('real Button→system Page→source owner preserves colliding IDs, unread-dot truth and uncertain read recovery', async () => {
  const h = systemNoticesSetup(),
    reads: string[] = [];
  h.notices.listImpl = async () =>
    systemNotices([systemNotice({ noticeId: requestId })]);
  const runtime = {
    ...h.runtime,
    errandNotices: {
      async list() {
        return {
          items: [
            {
              noticeId: requestId,
              kind: 'completed' as const,
              orderId: requestId,
              createdAt,
              readAt: null,
            },
          ],
          nextCursor: null,
          unreadCount: 1,
        };
      },
      async read(noticeId: string) {
        reads.push(noticeId);
        return { noticeId, readAt: createdAt, unreadCount: 0 };
      },
      async unread() {
        return { unreadCount: 1 };
      },
    },
  };
  const f = mount('system-notices', runtime);
  try {
    await flush();
    const items = f.target.data.items as {
      key: string;
      readAt: string | null;
    }[];
    assert.ok(items.some((item) => item.key === `errand:${requestId}`));
    assert.ok(items.some((item) => item.key === `system:${requestId}`));
    assert.equal(f.target.data.unreadCount, null);
    assert.equal(f.target.data.hasUnread, true);
    assert.deepEqual(reads, []);
    press('system-notices', 'onRead', f.target, {
      item: { key: `errand:${requestId}` },
    });
    await flush();
    assert.deepEqual(reads, [requestId]);
    assert.equal(
      h.notices.calls.some((call) => call.method === 'read'),
      false,
    );
    h.notices.readImpl = async () => {
      throw new ClientError('network', 'uncertain');
    };
    press('system-notices', 'onRead', f.target, {
      item: { key: `system:${requestId}` },
    });
    await flush();
    assert.equal(
      h.notices.calls.find((call) => call.method === 'read')?.args[0],
      requestId,
    );
    assert.ok(f.target.data.error);
    assert.equal(
      (f.target.data.items as { key: string; readAt: string | null }[]).find(
        (item) => item.key === `system:${requestId}`,
      )?.readAt,
      null,
    );
    press('system-notices', 'onSources', f.target);
    assert.equal(f.target.data.showSources, true);
    h.sessions.logout();
    assert.deepEqual(f.target.data.items, []);
    invoke(f.target, 'onHide');
    assert.equal(f.target.data.showSources, false);
  } finally {
    f.close();
  }
});

test('real unavailable follow/activity pages never activate a provider, acknowledge a read or fabricate a count', async () => {
  const h = setup();
  const follower = mount('social-notices', h.runtime, { kind: 'followers' });
  try {
    await flush();
    assert.equal(follower.target.data.unavailable, true);
    assert.deepEqual(follower.target.data.rows, []);
    assert.deepEqual(h.gateway.calls, []);
  } finally {
    follower.close();
  }
  for (const query of [
    { kind: 'activity' },
    { kind: 'activity', unexpected: true },
    { kind: 'followers' },
  ]) {
    const f = mount('notice-thread', h.runtime, query);
    try {
      assert.equal(
        f.target.data.valid,
        Object.keys(query).length === 1 && query.kind === 'activity',
      );
      assert.equal(f.target.data.unreadCount, undefined);
      assert.deepEqual(h.gateway.calls, []);
    } finally {
      f.close();
    }
  }
});
