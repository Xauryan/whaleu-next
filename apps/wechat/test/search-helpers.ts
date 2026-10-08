import { SafetyChanges } from '../src/community/safety-changes';
import type { SearchPage } from '../src/community/search-contract';
import type { SearchGateway } from '../src/community/search-gateway';
import {
  SearchController,
  initialSearchView,
} from '../src/pages/community-search/controller';
import { post, setup, spaceId } from './community-helpers';
import { campusId } from './profile-helpers';
export const searchRoute = { campusId, spaceId };
export const searchToken = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export const searchPage = (patch: Partial<SearchPage> = {}): SearchPage => ({
  items: [post()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export function searchHarness(loggedIn = true) {
  const s = setup(loggedIn);
  const calls: Parameters<SearchGateway['search']>[] = [];
  const behavior: SearchGateway = { search: async () => searchPage() };
  const search: SearchGateway = {
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
  return { ...s, runtime, calls, behavior, controller, view: () => view };
}
