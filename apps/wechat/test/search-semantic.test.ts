import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeSearchHit,
  decodeSemanticSearchPage,
  searchTargetPath,
  type SemanticSearchPage,
} from '../src/community/search-contract';
import { HttpSearchGateway } from '../src/community/search-gateway';
import {
  SearchController,
  initialSearchView,
} from '../src/pages/community-search/controller';
import { deferred, flush, ScriptedTransport, response } from './helpers';
import {
  searchHarness,
  searchHit,
  searchPage,
  semanticPage,
} from './search-helpers';
import { otherId, requestId } from './community-helpers';
import { wireCredentials } from './identity-helpers';
const plainHit = () =>
  searchHit({
    snippet: {
      segments: [{ text: '相关原文 <script>😀', matched: false }],
      truncatedBefore: false,
      truncatedAfter: false,
    },
  });
function gatewaySetup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  const gateway = new HttpSearchGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
async function start(s: ReturnType<typeof searchHarness>) {
  await s.controller.load({ scope: 'all' });
  await s.controller.setMode('semantic');
  s.controller.setInput('找一处安静的学习地点');
  await s.controller.submit();
}
test('semantic DTO permits genuine unhighlighted text without relaxing keyword or strict private-field and envelope checks', () => {
  const hit = plainHit();
  assert.deepEqual(decodeSemanticSearchPage(semanticPage([hit])).items[0], hit);
  assert.throws(() => decodeSearchHit(hit));
  for (const value of [
    { ...semanticPage(), total: 1 },
    { ...semanticPage(), nextCursor: null },
    { ...semanticPage(), mode: 'keyword' },
    { ...semanticPage(), indexStatus: 'stale' },
    { ...semanticPage(), ranking: 'newest' },
    { ...semanticPage(), effectiveTypes: ['post'] },
    semanticPage([hit, hit]),
    semanticPage([{ ...hit, score: 0.9 } as never]),
    semanticPage([
      { ...hit, target: { ...hit.target, text: 'private' } } as never,
    ]),
    semanticPage([
      {
        ...hit,
        snippet: {
          ...hit.snippet,
          segments: [{ text: 'x'.repeat(241), matched: false }],
        },
      },
    ]),
  ])
    assert.throws(() => decodeSemanticSearchPage(value));
});
test('semantic gateway uses exact independent endpoint, filters and limit, rejects cursor and invalid scopes, with no fallback on disabled/unknown', async () => {
  const s = gatewaySetup(),
    cancel = new Cancellation();
  const intent = {
    scope: 'all',
    q: '  meaning\r\n😀  ',
    type: 'post',
    from: '2020-01-01T00:00:00Z',
    to: '2030-01-01T00:00:00Z',
    postId: plainHit().postId,
  } as const;
  s.transport.reply(semanticPage([plainHit()]));
  const result = await s.gateway.semantic(intent, cancel);
  assert.deepEqual(result.items, [plainHit()]);
  const url = new URL(s.transport.requests[0]!.url);
  assert.equal(url.pathname, '/v1/community/search/semantic');
  assert.equal(url.searchParams.get('q'), 'meaning\n😀');
  assert.equal(url.searchParams.get('from'), '2020-01-01T00:00:00.000000Z');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.has('cursor'), false);
  assert.equal(s.transport.requests[0]!.body, undefined);
  await assert.rejects(
    s.gateway.semantic({ ...intent, cursor: 'bad' } as never, cancel),
    { kind: 'protocol' },
  );
  for (const bad of [
    { scope: 'global', q: 'q' },
    { scope: 'all', q: 'q', type: 'reply' },
    { scope: 'all', q: 'q', postId: otherId },
  ] as const) {
    s.transport.reply(semanticPage([plainHit()]));
    await assert.rejects(s.gateway.semantic(bad, cancel), { kind: 'protocol' });
  }
  for (const code of ['SEMANTIC_SEARCH_DISABLED', 'COMMUNITY_UNAVAILABLE']) {
    const before = s.transport.requests.length;
    s.transport.reply({ error: { code } }, 503);
    await assert.rejects(
      s.gateway.semantic(intent, cancel),
      (error: ClientError) => error.details.serverCode === code,
    );
    assert.equal(s.transport.requests.length, before + 1);
  }
});
test('semantic transport rejects stale successes after cancel or account/login replacement', async () => {
  for (const reason of ['cancel', 'same-login', 'other-login']) {
    const s = gatewaySetup(),
      pending = deferred<ReturnType<typeof response>>(),
      cancel = new Cancellation();
    s.transport.steps.push(() => pending.promise);
    const work = s.gateway.semantic({ scope: 'all', q: 'q' }, cancel);
    await flush();
    if (reason === 'cancel') cancel.cancel();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(reason === 'other-login' ? { accountId: otherId } : {}),
      });
    pending.resolve(response(semanticPage()));
    await assert.rejects(work, {
      kind: reason === 'cancel' ? 'cancelled' : 'stale-session',
    });
  }
});
test('disabled and unknown remain visibly unavailable, keep draft and submitted query, retry semantic, and require explicit keyword switch', async () => {
  for (const code of ['SEMANTIC_SEARCH_DISABLED', 'COMMUNITY_UNAVAILABLE']) {
    const s = searchHarness();
    s.behavior.semantic = async () => {
      throw new ClientError('http', 'private provider detail', {
        serverCode: code,
        httpStatus: 503,
      });
    };
    await start(s);
    assert.equal(s.view().loaded, false);
    assert.equal(
      s.view().semanticDisabled,
      code === 'SEMANTIC_SEARCH_DISABLED',
    );
    assert.match(
      s.view().error,
      code === 'SEMANTIC_SEARCH_DISABLED' ? /尚未开启/ : /暂时无法确认/,
    );
    assert.doesNotMatch(s.view().error, /private/);
    assert.equal(s.calls.length, 0);
    s.controller.setInput('unsent draft');
    await s.controller.refresh();
    assert.equal(s.semanticCalls.length, 2);
    assert.equal(s.view().inputDraft, 'unsent draft');
    await s.controller.setMode('keyword');
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]![0].q, '找一处安静的学习地点');
    assert.equal(s.view().semanticDisabled, false);
    s.controller.dispose();
  }
});
test('semantic results are non-exhaustive and never pageable; mode changes fence late success/error/finally in both directions', async () => {
  for (const lateError of [false, true]) {
    const s = searchHarness(),
      old = deferred<SemanticSearchPage>();
    await start(s);
    assert.match(s.view().status, /并非全部匹配/);
    await s.controller.next();
    await s.controller.previous();
    assert.equal(s.semanticCalls.length, 1);
    assert.equal(s.view().pageNumber, 0);
    assert.equal(s.view().continuation, null);
    s.behavior.semantic = async () => old.promise;
    const pending = s.controller.refresh();
    await flush();
    await s.controller.setMode('keyword');
    if (lateError)
      old.reject(new ClientError('network', 'late private failure'));
    else old.resolve(semanticPage([]));
    await pending;
    assert.equal(s.view().mode, 'keyword');
    assert.equal(s.view().hits.length, 1);
    assert.equal(s.view().error, '');
    const keyword = deferred<ReturnType<typeof searchPage>>();
    s.behavior.search = async () => keyword.promise;
    const pendingKeyword = s.controller.refresh();
    await flush();
    s.behavior.semantic = async () => semanticPage([plainHit()]);
    await s.controller.setMode('semantic');
    keyword.resolve(searchPage({ items: [] }));
    await pendingKeyword;
    assert.equal(s.view().hits.length, 1);
    assert.equal(s.view().mode, 'semantic');
    assert.equal(s.view().hits[0]!.snippet.segments[0]!.matched, false);
    s.controller.dispose();
  }
});
test('scope, safety, cancel/retry, root hide, account changes and resume never retain or restore stale semantic hits', async () => {
  for (const action of [
    'scope',
    'cancel',
    'hide',
    'same-login',
    'other-login',
    'safety',
  ]) {
    const s = searchHarness(),
      pending = deferred<SemanticSearchPage>();
    await start(s);
    s.controller.setInput('unsent');
    s.behavior.semantic = async () => pending.promise;
    const old = s.controller.refresh();
    await flush();
    s.behavior.semantic = async () => semanticPage([]);
    if (action === 'scope') await s.controller.chooseScope('regional');
    if (action === 'cancel') {
      s.controller.cancel();
      await s.controller.refresh();
    }
    if (action === 'hide') s.runtime.privateViews?.clear();
    if (action === 'safety') {
      s.runtime.safetyChanges.invalidate(s.accountId);
      await flush();
    }
    if (action.endsWith('login'))
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(action === 'other-login' ? { accountId: otherId } : {}),
      });
    pending.resolve(semanticPage());
    await old;
    await flush();
    assert.deepEqual(s.view().hits, []);
    if (['scope', 'cancel', 'safety'].includes(action)) {
      assert.equal(s.view().mode, 'semantic');
      assert.equal(s.view().inputDraft, 'unsent');
      assert.match(s.view().status, /不代表没有/);
    } else {
      assert.equal(s.view().submittedQuery, '');
      assert.equal(s.view().loaded, false);
    }
    s.controller.dispose();
  }
  const s = searchHarness();
  await start(s);
  const resume = s.controller.snapshot()!;
  s.controller.dispose();
  let view = initialSearchView();
  const reopened = new SearchController(s.runtime, (v) => {
    view = v;
  });
  s.behavior.semantic = async () => semanticPage([]);
  await reopened.load(resume.route, resume);
  assert.equal(view.mode, 'semantic');
  assert.deepEqual(view.hits, []);
  assert.equal(s.semanticCalls.length, 2);
  reopened.dispose();
});
test('semantic post/root/reply navigation sends IDs only and clears results before current destination reads', async () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const s = searchHarness();
    const base = plainHit();
    const hit =
      kind === 'post'
        ? base
        : searchHit({
            ...base,
            kind,
            contentId: kind === 'reply' ? requestId : otherId,
            rootCommentId: otherId,
            replyId: kind === 'reply' ? requestId : null,
            target:
              kind === 'reply'
                ? {
                    kind,
                    postId: base.postId,
                    rootCommentId: otherId,
                    replyId: requestId,
                  }
                : { kind, postId: base.postId, rootCommentId: otherId },
          });
    s.behavior.semantic = async () => semanticPage([hit]);
    await start(s);
    const urls: string[] = [];
    await s.controller.openHit(kind, hit.contentId, async (url) => {
      assert.deepEqual(s.view().hits, []);
      urls.push(url);
    });
    assert.deepEqual(urls, [searchTargetPath(hit.target)]);
    assert.doesNotMatch(urls[0]!, /q=|snippet|text=/);
    s.controller.dispose();
  }
});
