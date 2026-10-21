import { assertReviewedReadingSuccessor } from './reviewed-reading-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-reading-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import type { SavedList } from '../src/community/saved-contract';
import { PendingOwnerPostVisibilityStore } from '../src/owner-post-visibility/pending';
import type { OwnerVisibilityCommand } from '../src/owner-post-visibility/contract';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  createdAt,
  otherId,
  post,
  postId,
  setup,
  tradingPost,
} from './community-helpers';
import { discoverySetup, likedItem, likedList } from './discovery-helpers';
import { deferred, flush } from './helpers';
import { hotHarness, hotPage, hotRoute, hotToken } from './hot-helpers';
import { wireCredentials } from './identity-helpers';

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
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-collections-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-collections-before-protected.json'),
) as Record<string, string>;
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
function conditionalChains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        `${child.tag}: intact conditional chain`,
      );
    conditionalChains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact original actions, ancestor guards, datasets, loading and disabled constraints survive`, () => {
    const tree = parse(read(file));
    const current = actions(tree);
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
    conditionalChains(tree);
  });
const pages = [
  'community-hot',
  'community-saved',
  'community-liked',
  'community-mine',
];
for (const page of pages)
  test(`${page}: real native composition with no nested actions, new overlays or browser controls`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of ['button', 'block', 'list', 'list-item'])
      assert.ok(nodes.some((node) => node.tag === `wu-f7-${kind}`));
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        assert.equal(node.attrs.link, '{{true}}');
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (child) =>
                child.tag === 'navigator' ||
                Object.keys(child.attrs).some((key) =>
                  /^(bind|catch)/.test(key),
                ) ||
                /^(button|input|textarea|switch|wu-f7-button)$/.test(child.tag),
            ),
        );
      }
    }
    assert.ok(
      !nodes.some((node) =>
        /^(button|wu-f7-sheet|wu-f7-dialog|wu-f7-actions|web-view|input)$/.test(
          node.tag,
        ),
      ),
    );
    assert.match(source(page, 'wxss'), /framework7-collections\.wxss/);
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
  });
test('accepted roots, all collection Page/controller TS, shared domain and native media files stay byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 179);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedReadingSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('observer anchors, count uncertainty, private author boundaries, minimal publication records and consequential inline recovery stay intact', () => {
  assert.equal(
    flatten(parse(source('community-hot'))).find(
      (node) => node.attrs.id === 'view-{{item.id}}',
    )?.tag,
    'view',
  );
  for (const page of ['community-hot', 'community-mine'])
    assert.equal(
      flatten(parse(source(page))).find((node) => node.tag === 'scroll-view')!
        .attrs['scroll-x'],
      '{{true}}',
    );
  assert.equal(
    flatten(parse(source('community-hot'))).find(
      (node) => node.tag === 'scroll-view',
    )!.attrs.enhanced,
    '{{true}}',
  );
  assert.match(source('community-liked'), /visibleLikedCount !== null/);
  assert.match(
    source('community-liked'),
    /visibleLikedCount === 0 &amp;&amp; continuation === 'end'/,
  );
  assert.match(source('community-liked'), /暂未显示记录不代表历史为空/);
  assert.match(source('community-saved'), /identityOverlay\.developerEnabled/);
  assert.match(
    source('community-saved'),
    /is="saved-recovery" data="{{savedMutation}}"/,
  );
  assert.match(
    read('src/pages/community-saved/saved-recovery.wxml'),
    /停止等待（不撤销请求）/,
  );
  assert.match(
    read('src/pages/community-saved/saved-recovery.wxml'),
    /未确认的请求不会被相反意图覆盖/,
  );
  const publications = source('community-mine')
    .split('wx:for="{{publications}}"')[1]!
    .split('wx:for="{{tradingPosts}}"')[0]!;
  assert.doesNotMatch(publications, /item\.(text|images|author)/);
  for (const page of pages) assert.match(source(page), /分身/);
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
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
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
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
function mount(page: string, runtime: CommunityRuntime, query?: unknown) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { wx: globals.wx, getApp: globals.getApp };
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
  invoke(target, 'onShow');
  return {
    target,
    navigation,
    close() {
      invoke(target, 'onUnload');
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
  local = false,
) {
  const nodes = flatten(
    parse(
      local
        ? read('src/pages/community-saved/saved-recovery.wxml')
        : source(page),
    ),
  );
  const node = nodes.find(
    (item) =>
      item.attrs['bind:press'] === handler &&
      (!patch.item || item.attrs['data-key'] !== ''),
  )!;
  assert.ok(node, `${page}: actual migrated ${handler} binding`);
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
  const definition = registration<Definition>(
    'Component',
    `components/${node.tag.slice(3)}/${node.tag.slice(3)}.ts`,
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
  local = false,
) {
  const c = control(page, handler, target, patch, local);
  c.press();
  c.detach();
  return c.dispatched();
}

test('real Button→hot Page→controller keeps range, opaque forward/back cursor, busy and hide/session fences', async () => {
  const h = hotHarness();
  h.behavior.hot = async (_intent, cursor) =>
    cursor
      ? hotPage({ items: [] })
      : hotPage({ nextCursor: hotToken(), continuation: 'scan_pending' });
  const f = mount('community-hot', h.runtime, hotRoute);
  try {
    await flush();
    press('community-hot', 'onRange', f.target, { item: { key: 'week' } });
    await flush();
    assert.equal(f.target.data.range, 'week');
    press('community-hot', 'onNext', f.target);
    await flush();
    assert.equal(h.calls.slice(-1)[0]![1], hotToken());
    assert.deepEqual(f.target.data.posts, []);
    press('community-hot', 'onPrevious', f.target);
    await flush();
    assert.equal(h.calls.slice(-1)[0]![1], null);
    const count = h.calls.length;
    assert.equal(
      press('community-hot', 'onRange', f.target, {
        busy: true,
        item: { key: 'year' },
      }),
      0,
    );
    assert.equal(h.calls.length, count);
    const pending = deferred<ReturnType<typeof hotPage>>();
    h.behavior.hot = async () => pending.promise;
    press('community-hot', 'onRefresh', f.target);
    assert.equal(f.target.data.busy, true);
    assert.equal(press('community-hot', 'onRefresh', f.target), 0);
    press('community-hot', 'onCancel', f.target);
    pending.resolve(hotPage());
    await flush();
    assert.deepEqual(f.target.data.posts, []);
    const stale = control('community-hot', 'onNext', f.target, { busy: false });
    stale.hide();
    stale.press();
    assert.equal(stale.dispatched(), 0);
    stale.detach();
    invoke(f.target, 'onHide');
    h.sessions.completeLogin(
      h.sessions.beginLogin(),
      wireCredentials('replacement'),
    );
    assert.equal(f.target.resume, null);
    assert.deepEqual(f.target.data.posts, []);
  } finally {
    f.close();
    h.controller.dispose();
  }
});

test('real Button→saved Page preserves exact unsave identity, frozen retry/receipt and no opposite command after cancellation', async () => {
  const s = setup();
  const value = post();
  const saved = {
    ...value,
    viewer: { ...value.viewer, isSaved: true, canSave: true },
  };
  const entry = { post: saved, savedAt: createdAt, saveEpochId: otherId };
  s.gateway.savedImpl = async (after) => ({
    items: [entry],
    visibleSavedCount: 1,
    nextCursor: after ? null : 'saved-cursor',
  });
  const f = mount('community-saved', s.runtime);
  try {
    await flush();
    press('community-saved', 'onMore', f.target);
    await flush();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'saved').slice(-1)[0]!
        .args[0],
      'saved-cursor',
    );
    assert.equal((f.target.data.items as unknown[]).length, 1);
    s.gateway.applySavedImpl = async () => {
      throw new ClientError('network', 'Lost receipt');
    };
    press('community-saved', 'onUnsave', f.target, { item: entry });
    await flush();
    const pending = s.runtime.pendingSaved.load(s.accountId)!;
    assert.equal(pending.postId, postId);
    assert.equal(pending.desired, false);
    assert.equal(
      (f.target.data.savedMutation as { frozen: boolean }).frozen,
      true,
    );
    const commands = s.gateway.calls.filter(
      (call) => call.method === 'applySaved',
    ).length;
    assert.equal(
      press('community-saved', 'onUnsave', f.target, { item: entry }),
      0,
    );
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'applySaved').length,
      commands,
    );
    s.gateway.savedReceiptImpl = async () => {
      throw new ClientError('network', 'Still unknown');
    };
    press('community-saved', 'onSavedReceipt', f.target, {}, true);
    await flush();
    assert.equal(
      s.gateway.calls.find((call) => call.method === 'savedReceipt')!.args[0],
      pending.clientRequestId,
    );
    press('community-saved', 'onSavedCancel', f.target, {}, true);
    assert.deepEqual(s.runtime.pendingSaved.load(s.accountId), pending);
    s.gateway.applySavedImpl = async ({ clientRequestId, ...intent }) => ({
      requestId: clientRequestId,
      ...intent,
      outcome: 'applied',
    });
    press('community-saved', 'onSavedRetry', f.target, {}, true);
    await flush();
    const attempts = s.gateway.calls.filter(
      (call) => call.method === 'applySaved',
    );
    assert.deepEqual(attempts[0]!.args[0], attempts[1]!.args[0]);
    assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
    assert.equal(
      s.gateway.calls.some((call) => /upload|contact/i.test(call.method)),
      false,
    );
    invoke(f.target, 'onHide');
    assert.deepEqual(f.target.data.items, []);
  } finally {
    f.close();
  }
});

test('real saved controls suppress no-save/busy and a late paginated response cannot cross account ownership', async () => {
  const s = setup();
  const value = post();
  const entry = {
    post: { ...value, viewer: { ...value.viewer, isSaved: true } },
    savedAt: createdAt,
    saveEpochId: otherId,
  };
  s.gateway.savedImpl = async () => ({
    items: [entry],
    visibleSavedCount: 1,
    nextCursor: 'cursor',
  });
  const f = mount('community-saved', s.runtime);
  try {
    await flush();
    assert.equal(
      press('community-saved', 'onUnsave', f.target, {
        item: { ...entry, post: { ...entry.post, viewer: { canSave: false } } },
      }),
      0,
    );
    const late = deferred<SavedList>();
    s.gateway.savedImpl = async () => late.promise;
    press('community-saved', 'onMore', f.target);
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('other'),
      accountId: otherId,
    });
    late.resolve({ items: [entry], visibleSavedCount: 1, nextCursor: null });
    await flush();
    assert.deepEqual(f.target.data.items, []);
    assert.equal(f.target.data.visibleSavedCount, 0);
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'applySaved'),
      false,
    );
  } finally {
    f.close();
  }
});

test('real Button→liked Page preserves unavailable counts, sparse scans, fresh previous, cursor-loop failure and private hide', async () => {
  const s = discoverySetup();
  s.behavior.liked = async (after) =>
    after
      ? likedList({ items: [likedItem()] })
      : likedList({
          items: [],
          visibleLikedCount: null,
          visibleLikedCountStatus: 'unavailable',
          nextCursor: 'liked-cursor',
          continuation: 'scan_pending',
        });
  const f = mount('community-liked', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.visibleLikedCount, null);
    assert.equal(f.target.data.continuation, 'scan_pending');
    press('community-liked', 'onMore', f.target);
    await flush();
    assert.equal(s.calls.slice(-1)[0]!.args[0], 'liked-cursor');
    assert.equal(f.target.data.pageNumber, 2);
    press('community-liked', 'onPrevious', f.target);
    await flush();
    assert.equal(s.calls.slice(-1)[0]!.args[0], null);
    assert.deepEqual(f.target.data.items, []);
    s.behavior.liked = async () => likedList({ nextCursor: 'liked-cursor' });
    press('community-liked', 'onMore', f.target);
    await flush();
    assert.deepEqual(f.target.data.items, []);
    assert.equal(f.target.data.visibleLikedCount, null);
    assert.equal(f.target.data.canLoadMore, false);
    assert.ok(f.target.data.error);
    const count = s.calls.length;
    assert.equal(
      press('community-liked', 'onMore', f.target, { busy: true }),
      0,
    );
    assert.equal(s.calls.length, count);
    invoke(f.target, 'onHide');
    assert.equal(f.target.controller, undefined);
  } finally {
    f.close();
  }
});

test('real Button→mine Page separates minimal publications from trading, subtype data, visibility intent and frozen locks', async () => {
  const s = setup();
  const commands: OwnerVisibilityCommand[] = [];
  const runtime: CommunityRuntime = {
    ...s.runtime,
    pendingOwnerPostVisibility: new PendingOwnerPostVisibilityStore(
      s.storage,
      'synthetic',
    ),
    ownerPostVisibility: {
      management: async () => ({
        postId,
        ownerHidden: true,
        canChange: true,
        version: 0,
      }),
      submit: async (command) => {
        commands.push(command);
        return {
          requestId: command.clientRequestId,
          postId: command.postId,
          ownerHidden: command.ownerHidden,
          expectedVersion: command.expectedVersion,
          outcome: 'applied',
          version: 1,
          changed: true,
          recordedAt: createdAt,
        };
      },
      receipt: async () => {
        throw new ClientError('network', 'Unknown');
      },
    },
  };
  s.gateway.mineImpl = async () => ({
    items: [
      {
        id: postId,
        spaceId: post().space.id,
        category: 'discussion',
        status: 'hidden',
        publishedAt: createdAt,
        ownerVisibility: { ownerHidden: true, canChange: true, version: 0 },
      },
    ],
    nextCursor: null,
  });
  s.gateway.ownTradingImpl = async (after) => ({
    items: [tradingPost()],
    nextCursor: after ? null : 'trade-cursor',
  });
  const f = mount('community-mine', runtime);
  try {
    await flush();
    const record = (
      f.target.data.publications as Record<string, unknown>[]
    )[0]!;
    assert.equal(record.text, undefined);
    assert.equal(record.author, undefined);
    assert.equal(record.images, undefined);
    press('community-mine', 'onOwnerVisibilityUnhide', f.target, {
      item: record,
    });
    await flush();
    assert.equal(
      (f.target.data.ownerVisibility as { confirming: string }).confirming,
      'change',
    );
    assert.equal(
      commands.length,
      0,
      'requesting a change still requires the existing inline confirmation',
    );
    invoke(f.target, 'onOwnerVisibilityClose');
    assert.equal(commands.length, 0);
    assert.equal(
      press('community-mine', 'onOwnerVisibilityHide', f.target, {
        item: record,
        ownerVisibility: { busy: false, frozen: true },
      }),
      0,
    );
    press('community-mine', 'onOwnTrading', f.target);
    await flush();
    assert.deepEqual(f.target.data.publications, []);
    assert.equal((f.target.data.tradingPosts as unknown[]).length, 1);
    press('community-mine', 'onTradingSubtype', f.target, {
      item: { key: 'shuma' },
    });
    await flush();
    assert.equal(f.target.data.tradingSubtype, 'shuma');
    assert.equal(
      s.gateway.calls
        .filter((call) => call.method === 'ownTrading')
        .slice(-1)[0]!.args[2],
      'shuma',
    );
    press('community-mine', 'onMore', f.target);
    await flush();
    assert.equal(
      s.gateway.calls
        .filter((call) => call.method === 'ownTrading')
        .slice(-1)[0]!.args[0],
      'trade-cursor',
    );
    press('community-mine', 'onAllPublications', f.target);
    await flush();
    assert.deepEqual(f.target.data.tradingPosts, []);
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'tradingContacts'),
      false,
    );
    invoke(f.target, 'onHide');
    assert.deepEqual(f.target.data.publications, []);
  } finally {
    f.close();
  }
});

test('actual ListItem→Page disclosure toggles remain view-only, and privacy clearing cannot restore old bodies', async () => {
  for (const page of pages) {
    const hot = page === 'community-hot' ? hotHarness() : null;
    const h = hot ?? (page === 'community-liked' ? discoverySetup() : setup());
    const f = mount(page, h.runtime, hotRoute);
    try {
      await flush();
      const handler =
        page === 'community-mine' ? 'onToggleTools' : 'onToggleInfo';
      const field = page === 'community-mine' ? 'showTools' : 'showInfo';
      assert.equal(press(page, handler, f.target), 1);
      assert.equal(f.target.data[field], true);
      press(page, handler, f.target);
      assert.equal(f.target.data[field], false);
      h.runtime.privateViews?.clear();
      for (const key of ['posts', 'items', 'publications', 'tradingPosts'])
        if (key in f.target.data) assert.deepEqual(f.target.data[key], []);
    } finally {
      f.close();
      hot?.controller.dispose();
    }
  }
});

test('synthetic source fixtures cover every route and recovery/uncertainty states with no provider data', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-collections-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.ok(fixtures.length >= 30);
  assert.equal(new Set(fixtures.map((item) => item.id)).size, fixtures.length);
  assert.deepEqual(
    [...new Set(fixtures.map((item) => item.page))].sort(),
    [...pages].sort(),
  );
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-collections-/);
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|wxfile:\/\/|accessToken|refreshToken|accountId|privateAuthor|providerId/,
    );
  }
  for (const state of [
    'scan-pending',
    'count-unavailable',
    'cursor-error',
    'guest',
    'busy',
    'recovery',
    'hide-confirm',
    'coverage-unavailable',
  ])
    assert.ok(
      fixtures.some((item) => item.id.includes(state)),
      state,
    );
  assert.equal(
    fixtures.find((item) => item.id.endsWith('liked-count-unavailable'))!.patch
      .visibleLikedCount,
    null,
  );
});

// Source-only text projection: expand the actual local templates and real
// component slots/controlled properties, not screenshots or device evidence.
test('all synthetic fixture markers render through actual Component slots and template scopes', () => {
  const { evaluatePreviewExpression: evaluate } = requireNative(
    '../scripts/preview-wxml.mjs',
  ) as {
    evaluatePreviewExpression(
      value: string,
      scope: Record<string, unknown>,
    ): unknown;
  };
  const { nativeComponentPreviewState } = requireNative(
    '../scripts/preview-native-component.mjs',
  ) as {
    nativeComponentPreviewState(
      definition: object,
      attrs: Record<string, string>,
      evaluate: (value: string) => unknown,
    ): Record<string, unknown>;
  };
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-collections-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  type Templates = Record<string, (PresentationNode | string)[]>;
  type Slots = Record<string, () => string>;
  const interpolation = (value: string, scope: Record<string, unknown>) =>
    value.replace(/{{([\s\S]*?)}}/g, (_match, expr: string) =>
      String(evaluate(expr, scope) ?? ''),
    );
  function templateMap(file: string, seen = new Set<string>()): Templates {
    if (seen.has(file)) return {};
    seen.add(file);
    const tree = parse(read(file));
    let templates: Templates = {};
    for (const child of tree.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'import')
        templates = {
          ...templates,
          ...templateMap(path.join(path.dirname(file), child.attrs.src!), seen),
        };
      if (child.tag === 'template' && child.attrs.name)
        templates[child.attrs.name] = child.children;
    }
    return templates;
  }
  function render(
    nodes: (PresentationNode | string)[],
    scope: Record<string, unknown>,
    templates: Templates,
    slots: Slots = {},
  ): string {
    let result = '',
      matched = false;
    for (const node of nodes) {
      if (typeof node === 'string') {
        result += interpolation(node, scope);
        continue;
      }
      const attrs = node.attrs;
      if (node.tag === 'import' || (node.tag === 'template' && attrs.name))
        continue;
      if (attrs['wx:for']) {
        const values = evaluate(attrs['wx:for'].slice(2, -2), scope) as
          unknown[] | undefined;
        const remaining = { ...attrs };
        delete remaining['wx:for'];
        result += (values ?? [])
          .map((item, index) =>
            render(
              [{ ...node, attrs: remaining }],
              {
                ...scope,
                [attrs['wx:for-item'] ?? 'item']: item,
                [attrs['wx:for-index'] ?? 'index']: index,
              },
              templates,
              slots,
            ),
          )
          .join('');
        continue;
      }
      if ('wx:if' in attrs) matched = false;
      const condition = attrs['wx:if'] ?? attrs['wx:elif'];
      if ('wx:elif' in attrs && matched) continue;
      if (condition !== undefined) {
        if (!evaluate(condition.slice(2, -2), scope)) continue;
        matched = true;
      } else if ('wx:else' in attrs) {
        if (matched) continue;
        matched = true;
      } else matched = false;
      if (node.tag === 'template' && attrs.is) {
        result += render(
          templates[attrs.is] ?? [],
          (evaluate(`({${attrs.data!.slice(2, -2)}})`, scope) as Record<
            string,
            unknown
          >) ?? {},
          templates,
          slots,
        );
        continue;
      }
      if (node.tag === 'slot') {
        result += slots[attrs.name ?? 'default']?.() ?? '';
        continue;
      }
      if (node.tag.startsWith('wu-f7-')) {
        const name = node.tag.slice(3),
          file = `src/components/${name}/${name}.wxml`;
        const definition = registration<Definition>(
          'Component',
          `components/${name}/${name}.ts`,
        );
        const state = nativeComponentPreviewState(definition, attrs, (value) =>
          value.startsWith('{{') && value.endsWith('}}')
            ? evaluate(value.slice(2, -2), scope)
            : interpolation(value, scope),
        );
        const componentSlots: Slots = {};
        for (const child of node.children) {
          const slot =
            typeof child === 'string'
              ? 'default'
              : (child.attrs.slot ?? 'default');
          const previous = componentSlots[slot];
          componentSlots[slot] = () =>
            (previous?.() ?? '') + render([child], scope, templates, slots);
        }
        result += render(
          parse(read(file)).children,
          state,
          templateMap(file),
          componentSlots,
        );
        continue;
      }
      result += render(node.children, scope, templates, slots);
    }
    return result;
  }
  for (const fixture of fixtures) {
    const definition = registration<Owner>(
      'Page',
      `pages/${fixture.page}/${fixture.page}.ts`,
    );
    const file = `src/pages/${fixture.page}/${fixture.page}.wxml`;
    const text = render(
      parse(read(file)).children,
      { ...structuredClone(definition.data), ...fixture.patch },
      templateMap(file),
    );
    for (const marker of fixture.expectedText)
      assert.ok(text.includes(marker), `${fixture.id}: missing ${marker}`);
    if (
      fixture.id.endsWith('liked-count-unavailable') ||
      fixture.id.endsWith('hot-scan-pending')
    )
      assert.doesNotMatch(
        text,
        /暂无当前可查看的收藏|当前没有可查看的点赞|0 条可查看/,
      );
  }
});
