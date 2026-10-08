import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { HttpSearchGateway } from '../src/community/search-gateway';
import {
  canonicalSearchTimestamp,
  decodeSearchHit,
  decodeSearchIntent,
  decodeSearchPage,
  searchTargetPath,
  type SearchHit,
  type SearchKind,
  type SearchPage,
} from '../src/community/search-contract';
import { decodeSearchRoute } from '../src/pages/community-search/controller';
import {
  ThreadController,
  initialThreadView,
} from '../src/pages/community-thread/controller';
import {
  comment,
  commentId,
  otherId,
  post,
  postId,
  reply,
  replyId,
  setup,
} from './community-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import {
  searchHarness,
  searchHit,
  searchPage,
  searchRoute,
  searchToken,
} from './search-helpers';

function childHit(
  kind: 'comment' | 'reply',
  id = kind === 'reply' ? replyId : commentId,
): SearchHit {
  return searchHit({
    kind,
    contentId: id,
    postId,
    rootCommentId: kind === 'comment' ? id : commentId,
    replyId: kind === 'reply' ? id : null,
    postSummary: '原帖并未出现关键词',
    snippet: {
      segments: [
        { text: '前文 ', matched: false },
        { text: '<script>校园İ😀', matched: true },
        { text: ' 后文', matched: false },
      ],
      truncatedBefore: true,
      truncatedAfter: true,
    },
    target:
      kind === 'comment'
        ? { kind, postId, rootCommentId: id }
        : { kind, postId, rootCommentId: commentId, replyId: id },
  });
}

test('strict lightweight mixed hits preserve original server segments and discriminate IDs shared across tables', () => {
  const items = [
    searchHit(),
    childHit('comment', postId),
    childHit('reply', postId),
  ];
  const result = decodeSearchPage(searchPage({ items }));
  assert.deepEqual(result.items, items);
  assert.ok(Object.isFrozen(result.items[1]!.snippet.segments[0]));
  assert.equal(result.items[1]!.snippet.segments[1]!.text, '<script>校园İ😀');
  for (const item of result.items) {
    for (const key of [
      'text',
      'images',
      'viewer',
      'commentCount',
      'likeCount',
      'component',
      'score',
    ])
      assert.equal(key in item, false);
  }
  assert.throws(() =>
    decodeSearchPage(searchPage({ items: [items[1]!, items[1]!] })),
  );
  const allSame = childHit('reply', postId);
  assert.equal(
    decodeSearchHit({
      ...allSame,
      rootCommentId: postId,
      target: { kind: 'reply', postId, rootCommentId: postId, replyId: postId },
    }).replyId,
    postId,
  );
});

test('hit decoder fails closed on private/full-card extras, invalid ancestry, media, false match and oversized snippets', () => {
  const hit = childHit('reply');
  for (const patch of [
    { images: [] },
    { viewer: { isSelf: true } },
    { privateAuthorId: otherId },
    { score: 1 },
    { rootCommentId: null },
    { contentId: otherId },
    { replyId: null },
    { target: { ...hit.target, postId: otherId } },
    { target: { ...hit.target, url: 'https://example.com' } },
    { createdAt: '2026-10-07T00:00:00.000Z' },
    { postSummary: '😀'.repeat(81) },
    { author: { ...hit.author, accountId: otherId } },
    {
      author: {
        ...hit.author,
        avatar: {
          assetId: otherId,
          width: 10,
          height: 10,
          displayUrl: 'https://media.example/avatar.png',
          thumbnailUrl: 'https://media.example/thumb.png',
          expiresAt: null,
        },
      },
    },
    { snippet: { ...hit.snippet, html: '<mark>x</mark>' } },
    { snippet: { ...hit.snippet, segments: [] } },
    { snippet: { ...hit.snippet, segments: [{ text: 'x', matched: false }] } },
    {
      snippet: {
        ...hit.snippet,
        segments: [{ text: '\ud800', matched: true }],
      },
    },
    {
      snippet: {
        ...hit.snippet,
        segments: [{ text: '😀'.repeat(241), matched: true }],
      },
    },
    {
      snippet: {
        ...hit.snippet,
        segments: [
          { text: 'x'.repeat(200), matched: true },
          { text: 'y'.repeat(41), matched: false },
        ],
      },
    },
  ])
    assert.throws(() => decodeSearchHit({ ...hit, ...patch }));
  assert.throws(() =>
    decodeSearchPage(searchPage({ items: [hit], effectiveTypes: ['post'] })),
  );
});

test('type/date/topic filters are strict, canonical microsecond UTC values without query text in routes', () => {
  assert.equal(
    canonicalSearchTimestamp('2026-10-07T00:00:00Z'),
    '2026-10-07T00:00:00.000000Z',
  );
  assert.equal(
    canonicalSearchTimestamp('2026-10-07T00:00:00.123456Z'),
    '2026-10-07T00:00:00.123456Z',
  );
  const filters = {
    type: 'reply',
    from: '2026-10-07T00:00:00.123455Z',
    to: '2026-10-07T00:00:00.123456Z',
    postId,
  } as const;
  assert.deepEqual(
    decodeSearchIntent({ scope: 'all', q: '校园', ...filters }),
    { scope: 'all', q: '校园', ...filters },
  );
  assert.deepEqual(decodeSearchRoute({ scope: 'all', ...filters }), {
    scope: 'all',
    ...filters,
  });
  for (const patch of [
    { type: 'semantic' },
    { type: ['reply'] },
    { type: undefined },
    { postId: 'bad' },
    { postId: undefined },
    { from: '2026-02-30T00:00:00Z' },
    { from: '0000-01-01T00:00:00Z' },
    { from: '2026-10-07' },
    { from: '2026-10-07T00:00:00+00:00' },
    { from: '2026-10-07T00:00:00.1234567Z' },
    { from: null },
    { to: undefined },
    { from: filters.to, to: filters.to },
    { from: filters.to, to: filters.from },
    { mode: 'hybrid' },
    { sort: 'relevance' },
  ])
    assert.throws(() => decodeSearchIntent({ scope: 'all', q: 'x', ...patch }));
  assert.throws(() =>
    decodeSearchRoute({ scope: 'all', q: 'private query', postId }),
  );
});

test('gateway checks requested kind, exact microsecond date bounds, post and canonical effective types without rematching text', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpSearchGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        throw new Error('not expected');
      },
    }),
  );
  const hit = childHit('reply'),
    cancel = new Cancellation();
  const intent = {
    scope: 'all',
    q: 'unrelated Unicode matcher query',
    type: 'reply',
    postId,
    from: hit.createdAt,
    to: '2026-10-07T00:00:00.000001Z',
  } as const;
  transport.reply(searchPage({ items: [hit], effectiveTypes: ['reply'] }));
  assert.deepEqual((await gateway.search(intent, null, cancel)).items, [hit]);
  const url = new URL(transport.requests[0]!.url);
  for (const [key, value] of Object.entries(intent))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(transport.requests[0]!.body, undefined);
  for (const page of [
    searchPage({ items: [childHit('comment')], effectiveTypes: ['comment'] }),
    searchPage({
      items: [
        { ...hit, postId: otherId, target: { ...hit.target, postId: otherId } },
      ],
      effectiveTypes: ['reply'],
    }),
    searchPage({
      items: [{ ...hit, createdAt: '2026-10-06T23:59:59.999999Z' }],
      effectiveTypes: ['reply'],
    }),
    searchPage({
      items: [{ ...hit, createdAt: intent.to }],
      effectiveTypes: ['reply'],
    }),
    searchPage({ items: [hit] }),
  ]) {
    transport.reply(page);
    await assert.rejects(gateway.search(intent, null, cancel), {
      kind: 'protocol',
    });
  }
  for (const effectiveTypes of [
    ['reply'],
    ['post', 'comment'],
    ['reply', 'comment', 'post'],
  ] as SearchKind[][]) {
    transport.reply(searchPage({ items: [], effectiveTypes }));
    await assert.rejects(
      gateway.search({ scope: 'all', q: 'x' }, null, cancel),
      { kind: 'protocol' },
    );
  }
  transport.reply(searchPage({ effectiveTypes: ['post'] }));
  assert.deepEqual(
    (await gateway.search({ scope: 'all', q: 'x' }, null, cancel))
      .effectiveTypes,
    ['post'],
  );
});

test('filters preserve submitted query across scope, fresh paging, hide resume and safety refresh with no body snapshots', async () => {
  const s = searchHarness();
  s.behavior.search = async (_intent, after) =>
    after
      ? searchPage({ items: [childHit('reply')] })
      : searchPage({
          items: [childHit('reply')],
          continuation: 'scan_pending',
          nextCursor: searchToken(),
        });
  await s.controller.load(searchRoute);
  s.controller.setInput('submitted');
  await s.controller.submit();
  s.controller.setInput('unsent');
  await s.controller.setType('reply');
  await s.controller.setDate('from', '2026-10-01');
  await s.controller.setDate('to', '2026-10-08');
  await s.controller.withinPost(postId);
  await s.controller.chooseScope('all');
  const expected = {
    scope: 'all',
    q: 'submitted',
    type: 'reply',
    from: '2026-10-01T00:00:00.000000Z',
    to: '2026-10-08T00:00:00.000000Z',
    postId,
  };
  assert.deepEqual(s.calls[s.calls.length - 1]![0], expected);
  assert.equal(s.view().inputDraft, 'unsent');
  const resume = s.controller.snapshot()!;
  assert.deepEqual(Object.keys(resume).sort(), [
    'inputDraft',
    'route',
    'submittedQuery',
  ]);
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [expected, null]);
  await s.controller.next();
  await s.controller.previous();
  assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [expected, null]);
  await s.controller.setDate('to', '2026-09-01');
  assert.deepEqual(s.view().hits, []);
  assert.equal(s.view().canNext, false);
  assert.match(s.view().error, /开始时间/);
  assert.equal(s.view().toDay, '2026-10-08');
  await s.controller.clearDates();
  await s.controller.clearPost();
  assert.deepEqual(s.calls[s.calls.length - 1]![0], {
    scope: 'all',
    type: 'reply',
    q: 'submitted',
  });
  assert.equal(s.storage.data.size, 0);
});

test('new type/date intent cancels stale mixed hits and navigation callback cannot repopulate cleared search', async () => {
  const s = searchHarness(),
    pending = deferred<SearchPage>();
  await s.controller.load({ scope: 'all' });
  s.controller.setInput('q');
  await s.controller.submit();
  s.behavior.search = async (intent) =>
    intent.type === 'comment'
      ? pending.promise
      : searchPage({ items: [childHit('reply')] });
  const old = s.controller.setType('comment');
  await flush();
  await s.controller.setType('reply');
  pending.resolve(searchPage({ items: [childHit('comment')] }));
  await old;
  assert.equal(s.view().hits[0]!.kind, 'reply');
  const route = deferred<void>(),
    urls: string[] = [];
  const opening = s.controller.openHit('reply', replyId, async (url) => {
    urls.push(url);
    return route.promise;
  });
  assert.deepEqual(s.view().hits, []);
  await flush();
  assert.deepEqual(urls, [searchTargetPath(childHit('reply').target)]);
  await s.controller.refresh();
  route.reject(new Error('late navigation failure'));
  await opening;
  assert.equal(s.view().hits[0]!.kind, 'reply');
  assert.equal(s.view().error, '');
  s.controller.dispose();
});

test('post/comment/reply navigation uses only current loaded structured targets, then clears hits before opening', async () => {
  for (const hit of [searchHit(), childHit('comment'), childHit('reply')]) {
    const s = searchHarness(),
      urls: string[] = [];
    s.behavior.search = async () => searchPage({ items: [hit] });
    await s.controller.load({ scope: 'all' });
    s.controller.setInput('secret query');
    await s.controller.submit();
    await s.controller.openHit(hit.kind, otherId, async (url) => {
      urls.push(url);
    });
    assert.equal(urls.length, 0);
    const open = s.controller.openHit(hit.kind, hit.contentId, async (url) => {
      assert.deepEqual(s.view().hits, []);
      urls.push(url);
    });
    await s.controller.openHit(hit.kind, hit.contentId, async (url) => {
      urls.push(url);
    });
    await open;
    assert.deepEqual(urls, [searchTargetPath(hit.target)]);
    assert.doesNotMatch(urls[0]!, /secret|snippet|text=|q=/);
    assert.deepEqual(s.gateway.calls, []); // destination, not search, owns fresh reads
    s.controller.dispose();
  }
});

test('existing thread destination freshly reloads exact reply context and never falls back to old search text after deletion', async () => {
  const s = setup();
  let view = initialThreadView();
  s.gateway.postImpl = async () =>
    post({ text: 'Parent never contained the query' });
  s.gateway.repliesImpl = async () => ({ items: [], nextCursor: null });
  s.gateway.discussionContextImpl = async () => ({
    comment: comment(),
    reply: reply({ text: 'Current reply text' }),
    replies: { items: [], nextCursor: null },
  });
  const controller = new ThreadController(
    s.runtime,
    postId,
    commentId,
    replyId,
    (next) => {
      view = next;
    },
  );
  await controller.load();
  assert.equal(view.locatedReply?.text, 'Current reply text');
  const context = s.gateway.calls.find(
    (call) => call.method === 'discussionContext',
  )!;
  assert.equal(context.args[0], postId);
  assert.deepEqual(context.args[1], { replyId });
  s.gateway.discussionContextImpl = async () => {
    throw new ClientError('http', 'private deleted text', {
      serverCode: 'REPLY_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await controller.load();
  assert.equal(view.loaded, false);
  assert.equal(view.post, null);
  assert.equal(view.root, null);
  assert.equal(view.locatedReply, null);
  assert.deepEqual(view.contextReplies, []);
  assert.doesNotMatch(view.error, /private deleted text/);
  controller.dispose();
});

test('guest explicit child search does not silently become an empty or post search after login requirement', async () => {
  const s = searchHarness(false);
  s.behavior.search = async () => {
    throw new ClientError('auth-required', 'login required', {
      serverCode: 'AUTHENTICATION_REQUIRED',
      httpStatus: 401,
    });
  };
  await s.controller.load({ scope: 'all', type: 'comment' });
  s.controller.setInput('q');
  await s.controller.submit();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]![0].type, 'comment');
  assert.deepEqual(s.view().hits, []);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().hasSession, false);
  assert.doesNotMatch(s.view().status, /没有.*匹配|末尾/);
  assert.equal(s.view().canNext, false);
});

test('approved historical snippet text stays raw rather than applying the new-write text normalizer', () => {
  const text = '校园\r\n\u0001原文';
  const hit = childHit('comment');
  const result = decodeSearchHit({
    ...hit,
    snippet: { ...hit.snippet, segments: [{ text, matched: true }] },
  });
  assert.equal(result.snippet.segments[0]!.text, text);
});
