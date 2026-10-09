import { SafetyChanges } from '../src/community/safety-changes';
import type {
  SearchHit,
  SearchPage,
  SemanticSearchPage,
} from '../src/community/search-contract';
import type { SearchGateway } from '../src/community/search-gateway';
import {
  SearchController,
  initialSearchView,
} from '../src/pages/community-search/controller';
import { post, tradingPost, setup, spaceId } from './community-helpers';
import type { Post } from '../src/community/contract';
import { campusId } from './profile-helpers';
export const searchRoute = { campusId, spaceId };
export const searchToken = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export function hitFromPost(source: Post): SearchHit {
  return {
    kind: 'post',
    contentId: source.id,
    postId: source.id,
    rootCommentId: null,
    replyId: null,
    space: source.space,
    category: source.category,
    tradingSubtype:
      source.trading?.subtype.kind === 'known'
        ? source.trading.subtype.key
        : null,
    tradingUrgency: source.trading?.urgency ?? null,
    createdAt:
      typeof source.publishedAt === 'string'
        ? `${source.publishedAt.slice(0, 19)}.${source.publishedAt.slice(19, -1).replace('.', '').padEnd(6, '0')}Z`
        : source.publishedAt,
    author: source.author,
    postSummary: [...source.text].slice(0, 80).join(''),
    snippet: {
      segments: [
        { text: [...source.text].slice(0, 240).join(''), matched: true },
      ],
      truncatedBefore: false,
      truncatedAfter: [...source.text].length > 240,
    },
    target: { kind: 'post', postId: source.id },
  };
}
export const searchPost = (patch: Partial<Post> = {}): SearchHit =>
  hitFromPost(post(patch));
export const searchTradingPost = (patch: Partial<Post> = {}): SearchHit =>
  hitFromPost(tradingPost(patch));
export const searchHit = (patch: Partial<SearchHit> = {}): SearchHit => ({
  ...searchPost(),
  ...patch,
});
export const searchPage = (patch: Partial<SearchPage> = {}): SearchPage => ({
  items: [searchPost()],
  effectiveTypes: ['post', 'comment', 'reply'],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const semanticPage = (
  items: readonly SearchHit[] = [searchPost()],
): SemanticSearchPage => ({
  mode: 'semantic',
  indexStatus: 'current',
  ranking: 'embedding-top32-reranked',
  items,
});
export function searchHarness(loggedIn = true) {
  const s = setup(loggedIn);
  const calls: Parameters<SearchGateway['search']>[] = [];
  const semanticCalls: Parameters<SearchGateway['semantic']>[] = [];
  const behavior: SearchGateway = {
    search: async () => searchPage(),
    semantic: async () => semanticPage(),
  };
  const search: SearchGateway = {
    semantic: (...args) => {
      semanticCalls.push(args);
      return behavior.semantic(...args);
    },
    search: (...args) => {
      calls.push(args);
      return behavior.search(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    search,
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  let view = initialSearchView();
  const controller = new SearchController(runtime, (next) => {
    view = next;
  });
  return {
    ...s,
    runtime,
    calls,
    semanticCalls,
    behavior,
    controller,
    view: () => view,
  };
}
