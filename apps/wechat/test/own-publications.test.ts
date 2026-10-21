import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import { MeContentController } from '../src/pages/me/controller';
import {
  decodeOwnPublicationPage,
  HttpOwnPublicationsGateway,
  type OwnPublicationItem,
  type OwnPublicationPage,
  type OwnPublicationsGateway,
} from '../src/profile/own-publications';
import {
  anonymous,
  commentId,
  createdAt,
  otherId,
  postId,
  requestId,
} from './community-helpers';
import { discoverySetup, namedAuthor } from './discovery-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
const item = (
  kind: OwnPublicationItem['kind'] = 'post',
  identity: 'named' | 'anonymous' = 'named',
): OwnPublicationItem => ({
  kind,
  targetId:
    kind === 'post' ? postId : kind === 'comment' ? commentId : requestId,
  postId,
  rootCommentId: kind === 'post' ? null : commentId,
  createdAt,
  preview: {
    text: '合成自有内容',
    images: [],
    author: identity === 'named' ? namedAuthor() : anonymous(),
    createdAt,
    isSelf: true,
  },
});
const page = (
  items: readonly OwnPublicationItem[] = [],
  nextCursor: string | null = null,
  continuation: OwnPublicationPage['continuation'] = nextCursor
    ? 'more'
    : 'end',
): OwnPublicationPage => ({ items, nextCursor, continuation });
function setup() {
  const s = discoverySetup();
  const calls: {
    kind: string;
    identity: string;
    after: string | null;
    cancel: Cancellation;
  }[] = [];
  let result: Promise<OwnPublicationPage> = Promise.resolve(page([item()]));
  const gateway: OwnPublicationsGateway = {
    read: async (kind, identity, after, cancel) => {
      calls.push({ kind, identity, after, cancel });
      return result;
    },
  };
  const controller = new MeContentController(
    s.runtime,
    () => undefined,
    gateway,
  );
  return {
    ...s,
    discoveryCalls: s.calls,
    controller,
    calls,
    view: () => controller.snapshot(),
    set: (value: Promise<OwnPublicationPage> | OwnPublicationPage) => {
      result = Promise.resolve(value);
    },
  };
}
test('owner history is a strict distinct envelope without fabricated counts or likes', () => {
  assert.deepEqual(
    decodeOwnPublicationPage(page([item('reply', 'anonymous')])),
    page([item('reply', 'anonymous')]),
  );
  for (const raw of [
    { ...page(), total: 0 },
    { ...page(), continuation: 'more' },
    { ...page(), nextCursor: 'cursor' },
    page([{ ...item(), preview: { ...item().preview, isSelf: false } }]),
    page([{ ...item(), rootCommentId: commentId }]),
    page([{ ...item('reply'), rootCommentId: requestId }]),
    page([
      {
        ...item(),
        preview: { ...item().preview, profileId: otherId },
      } as unknown as OwnPublicationItem,
    ]),
    page([item(), item()]),
  ])
    assert.throws(() => decodeOwnPublicationPage(raw));
});
test('owner history gateway requires authentication and exact kind identity cursor query, never uses public profile or likes', async () => {
  const s = discoverySetup(false);
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  const gateway = new HttpOwnPublicationsGateway(api);
  await assert.rejects(
    gateway.read('reply', 'anonymous', null, new Cancellation()),
  );
  assert.equal(transport.requests.length, 0);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  transport.reply(page([item('reply', 'anonymous')]));
  await gateway.read('reply', 'anonymous', 'opaque-cursor', new Cancellation());
  const request = transport.requests[0]!;
  const url = new URL(request.url);
  assert.equal(url.pathname, '/v1/me/community/publications');
  assert.deepEqual([...url.searchParams.entries()].sort(), [
    ['cursor', 'opaque-cursor'],
    ['identity', 'anonymous'],
    ['kind', 'reply'],
    ['limit', '20'],
  ]);
  assert.ok(request.headers.Authorization);
  transport.reply(page([item('post', 'named')]));
  await assert.rejects(
    gateway.read('reply', 'anonymous', null, new Cancellation()),
  );
});
test('Me topics and replies use exact independent private identity lanes with real reply destinations', async () => {
  const s = setup();
  await s.controller.load();
  assert.equal(s.calls[0]?.kind, 'topic');
  assert.equal(s.calls[0]?.identity, 'named');
  assert.equal(s.view().total, null);
  s.set(page([item('post', 'anonymous')]));
  await s.controller.setMode('anonymous');
  assert.equal(s.view().mode, 'anonymous');
  assert.equal(s.view().items[0]?.author, anonymous().displayName);
  assert.equal(
    s.view().items[0]?.url,
    `/pages/community-detail/community-detail?postId=${postId}`,
  );
  s.set(page([item('comment'), item('reply')]));
  await s.controller.setTab('replies');
  assert.equal(s.view().mode, 'named');
  assert.equal(s.calls[s.calls.length - 1]?.kind, 'reply');
  assert.equal(
    s.view().items[0]?.url,
    `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${commentId}`,
  );
  assert.equal(
    s.view().items[1]?.url,
    `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${commentId}&replyId=${requestId}`,
  );
  assert.ok(s.view().items.every((row) => row.context === '回复'));
  assert.equal(s.view().total, null);
  assert.equal(
    s.calls.filter((call) => call.identity === 'anonymous').length,
    1,
  );
  assert.equal(s.discoveryCalls.length, 0);
  assert.equal(s.gateway.calls.length, 0);
  s.controller.dispose();
});
test('foreign identity or topic/reply classification fails closed and never falls back to likes or public discovery', async () => {
  const s = setup();
  s.set(page([item('post', 'anonymous')]));
  await s.controller.load();
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().loaded, false);
  assert.ok(s.view().error);
  s.set(page([item('post')]));
  await s.controller.setTab('replies');
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().loaded, false);
  s.controller.dispose();
});
test('owner history scans bounded pages without invented totals and revalidates previous pages', async () => {
  const s = setup();
  s.set(page([], 'next-page', 'scan_pending'));
  await s.controller.load();
  assert.equal(s.view().continuation, 'scan_pending');
  assert.equal(s.view().canLoadMore, true);
  assert.equal(s.view().total, null);
  s.set(page([item()]));
  await s.controller.more();
  assert.equal(s.calls[s.calls.length - 1]?.after, 'next-page');
  s.set(page([], 'next-page', 'scan_pending'));
  await s.controller.previous();
  assert.equal(s.calls[s.calls.length - 1]?.after, null);
  assert.equal(s.view().items.length, 0);
  s.controller.dispose();
});
for (const boundary of [
  'mode',
  'tab',
  'logout',
  'account',
  'epoch',
  'hide',
  'dispose',
] as const) {
  test(`owner history ignores late private results after ${boundary}`, async () => {
    const s = setup();
    const late = deferred<OwnPublicationPage>();
    s.set(late.promise);
    const reading = s.controller.load();
    await flush();
    s.set(page());
    if (boundary === 'mode') await s.controller.setMode('anonymous');
    else if (boundary === 'tab') await s.controller.setTab('replies');
    else if (boundary === 'logout') s.sessions.logout();
    else if (boundary === 'account' || boundary === 'epoch')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('replacement'),
        ...(boundary === 'account' ? { accountId: otherId } : {}),
      });
    else if (boundary === 'hide') s.runtime.privateViews?.clear();
    else s.controller.dispose();
    assert.equal(s.calls[0]?.cancel.isCancelled, true);
    late.resolve(page([item()]));
    await reading;
    assert.equal(s.view().items.length, 0);
    s.controller.dispose();
  });
}
test('Me taxonomy has four primary tabs and flat public/persona secondary controls without public linkage', () => {
  const root = join(__dirname, '../src/pages/me');
  const script = readFileSync(join(root, 'me.ts'), 'utf8');
  const markup = readFileSync(join(root, 'me.wxml'), 'utf8');
  for (const label of ['主题', '回复', '收藏', '赞过'])
    assert.ok(script.includes(`label: '${label}'`));
  assert.match(markup, /class="content-modes"/);
  assert.match(markup, /bindtap="onContentMode"/);
  assert.match(markup, />公开<\/button>/);
  assert.match(markup, />分身<\/button>/);
  assert.doesNotMatch(markup, /公开身份发布|全部发布|>匿名<|>笔记</);
});

test('owner publication safety invalidation clears immediately and rechecks only the current lane', async () => {
  const s = setup();
  s.set(page([item('post', 'anonymous')]));
  await s.controller.setMode('anonymous');
  assert.equal(s.view().items.length, 1);
  const late = deferred<OwnPublicationPage>();
  s.set(late.promise);
  const reading = s.controller.load();
  await flush();
  s.set(page());
  s.runtime.safetyChanges.invalidate(s.accountId);
  assert.equal(s.view().items.length, 0);
  await flush();
  assert.equal(s.calls[s.calls.length - 1]?.identity, 'anonymous');
  late.resolve(page([item('post', 'anonymous')]));
  await reading;
  assert.equal(s.view().items.length, 0);
  s.controller.dispose();
});
test('a repeated owner-publication cursor fails closed instead of looping or showing stale bodies', async () => {
  const s = setup();
  s.set(page([item()], 'same-cursor'));
  await s.controller.load();
  s.set(page([item()], 'same-cursor'));
  await s.controller.more();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().canLoadMore, false);
  assert.ok(s.view().error);
  s.controller.dispose();
});
