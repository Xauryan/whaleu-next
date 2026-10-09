import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClientError } from '../src/api/errors';
import type {
  DetailRoute,
  DetailView,
} from '../src/messaging/detail-controller';
import {
  commentEntry,
  entryPath,
  postEntry,
  readDetailRoute,
  replyEntry,
  MessagingEntryNavigator,
} from '../src/messaging/entry';
import {
  anonymous,
  comment,
  post,
  postId,
  reply,
  commentId,
  otherId,
} from './community-helpers';
import { conversation, conversationId, harness } from './messaging-helpers';
import { namedAuthor } from './discovery-helpers';
test('native DM pages are real registered routes with lifecycle cleanup and matching action handlers', () => {
  const app = JSON.parse(
    readFileSync(path.resolve(__dirname, '../src/app.json'), 'utf8'),
  );
  for (const name of ['list', 'detail', 'recovery']) {
    const base = `private-message-${name}/private-message-${name}`;
    assert.ok(app.pages.includes(`pages/${base}`));
    const ts = readFileSync(
        path.resolve(__dirname, `../src/pages/${base}.ts`),
        'utf8',
      ),
      wxml = readFileSync(
        path.resolve(__dirname, `../src/pages/${base}.wxml`),
        'utf8',
      );
    assert.match(ts, /onHide/);
    assert.match(ts, /onUnload/);
    assert.match(ts, /dispose/);
    for (const match of wxml.matchAll(
      /bind(?:tap|input|longpress)="([A-Za-z]+)"/g,
    ))
      assert.ok(ts.includes(match[1]!), `${base} missing ${match[1]}`);
    assert.ok(
      readFileSync(
        path.resolve(__dirname, `../src/pages/${base}.json`),
        'utf8',
      ),
    );
    assert.ok(
      readFileSync(
        path.resolve(__dirname, `../src/pages/${base}.wxss`),
        'utf8',
      ),
    );
  }
  assert.match(
    readFileSync(
      path.resolve(
        __dirname,
        '../src/pages/private-message-detail/private-message-detail.ts',
      ),
      'utf8',
    ),
    /createIntersectionObserver/,
  );
});
test('source entry preserves exact post/comment/reply ancestry and never guesses hidden target account', () => {
  const p = post({
      author: namedAuthor(),
      viewer: { ...post().viewer, isSelf: false },
    }),
    c = comment({ viewer: { ...comment().viewer, isSelf: false } }),
    r = reply({ viewer: { ...reply().viewer, isSelf: false } });
  assert.deepEqual(postEntry(p)?.entry, { kind: 'post', postId: p.id });
  assert.equal(postEntry(p, true), null);
  assert.equal(
    postEntry({ ...p, allowAnonymousDm: true }, true)?.mode,
    'anonymous',
  );
  assert.equal(postEntry({ ...p, author: anonymous() })?.mode, 'anonymous');
  assert.equal(commentEntry(otherId, c), null);
  assert.equal(replyEntry(postId, otherId, r), null);
  const selected = replyEntry(postId, commentId, r)!;
  assert.ok(selected);
  const path = entryPath(selected.entry, selected.mode);
  assert.match(path, /rootCommentId=/);
  assert.ok(!path.includes('accountId'));
  const query = Object.fromEntries(
    new URL(`https://synthetic.invalid${path}`).searchParams,
  );
  assert.deepEqual(readDetailRoute(query), {
    entry: selected.entry,
    initiationMode: selected.mode,
  });
});
test('newer navigation/disposal ignores late native navigation callback and duplicate clicks', () => {
  const h = harness();
  let count = 0;
  let finish: (() => void) | undefined;
  const nav = new MessagingEntryNavigator(
    {
      navigateTo(options) {
        count++;
        finish = options.success;
      },
    },
    { sessions: h.sessions } as ConstructorParameters<
      typeof MessagingEntryNavigator
    >[1],
    () => assert.fail('late callback'),
  );
  const selected = {
    entry: { kind: 'post' as const, postId },
    mode: 'named' as const,
  };
  nav.open(selected);
  nav.open(selected);
  assert.equal(count, 1);
  nav.dispose();
  finish?.();
  nav.open(selected);
  assert.equal(count, 1);
});
test('compose exposes reviewed per-post optin and independent profile DM badge is not community update sum', () => {
  const compose = readFileSync(
    path.resolve(
      __dirname,
      '../src/pages/community-compose/community-compose.wxml',
    ),
    'utf8',
  );
  assert.match(compose, /onAllowAnonymousDm/);
  assert.match(compose, /authorMode === 'named'/);
  const profile = readFileSync(
    path.resolve(__dirname, '../src/pages/profile/profile.wxml'),
    'utf8',
  );
  assert.match(profile, /privateMessages.count/);
  for (const page of ['public-profile', 'community-detail', 'community-thread'])
    assert.match(
      readFileSync(
        path.resolve(__dirname, `../src/pages/${page}/${page}.wxml`),
        'utf8',
      ),
      /onPrivateMessage/,
    );
});
test('real DM native Page handlers and WXML render list/detail/recovery; repeated send and hide cleanup', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(__filename);
  const { smokeMessaging } = require('../scripts/smoke-messaging.mjs');
  const h = harness();
  await smokeMessaging({
    app: {
      identity: { sessions: h.sessions },
      community: { sessions: h.sessions, messaging: h.runtime },
    },
    dist: path.resolve(__dirname, '../src'),
    extension: 'ts',
    conversationId: '55555555-5555-4555-8555-555555555555',
    messageId: '66666666-6666-4666-8666-666666666666',
    flush: async () => {
      for (let i = 0; i < 100; i++) await Promise.resolve();
    },
  });
  assert.equal(h.applied.filter((i) => i.operation === 'send').length, 1);
  assert.equal(h.clock.timers, 0);
});

test('native confirmed-open route resumes by conversation after follow-up fetch fails and source disappears', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(__filename),
    h = harness();
  const globals = globalThis as typeof globalThis & {
    wx?: unknown;
    Page?: unknown;
    getApp?: unknown;
  };
  const old = { wx: globals.wx, Page: globals.Page, getApp: globals.getApp };
  interface DetailPage {
    data: DetailView;
    route: DetailRoute | null;
    onLoad(query: Record<string, string>): void;
    onShow(): void;
    onOpen(): void;
    onHide(): void;
    onUnload(): void;
    setData(patch: Record<string, unknown>, done?: () => void): void;
  }
  let page: DetailPage | undefined;
  const flush = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  Object.assign(globals, {
    wx: {},
    getApp: () => ({ community: { messaging: h.runtime } }),
    Page(definition: Omit<DetailPage, 'setData'>) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(patch, done) {
          Object.assign(this.data, patch);
          done?.();
        },
      };
    },
  });
  try {
    const filename = path.resolve(
      __dirname,
      '../src/pages/private-message-detail/private-message-detail.ts',
    );
    delete require.cache[require.resolve(filename)];
    require(filename);
    assert.ok(page);
    const currentView = (): DetailView => page!.data;
    page.onLoad({ kind: 'post', postId, initiationMode: 'named' });
    page.onShow();
    h.gateway.conversation = async () => {
      throw new ClientError('network', 'follow-up read failed');
    };
    page.onOpen();
    await flush();
    assert.equal(page.data.conversation, null);
    assert.deepEqual(page.route, { conversationId });
    assert.equal(
      h.applied.filter((intent) => intent.operation === 'open').length,
      1,
    );
    page.onHide();
    h.gateway.apply = async () =>
      assert.fail('must not reopen a disappeared source');
    h.gateway.conversation = async (id) => {
      assert.equal(id, conversationId);
      return conversation();
    };
    page.onShow();
    await flush();
    assert.equal(currentView().conversation?.id, conversationId);
    assert.equal(page.data.needsOpen, false);
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});
