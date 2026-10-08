import { SafetyChanges } from '../src/community/safety-changes';
import type { HotPage } from '../src/community/hot-contract';
import type { HotGateway } from '../src/community/hot-gateway';
import {
  HotController,
  initialHotView,
} from '../src/pages/community-hot/controller';
import { post, setup, spaceId } from './community-helpers';
export const hotRoute = { spaceId };
export const hotToken = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export const hotPage = (patch: Partial<HotPage> = {}): HotPage => ({
  items: [post()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export function hotHarness(loggedIn = true) {
  const s = setup(loggedIn);
  const calls: Parameters<HotGateway['hot']>[] = [];
  const behavior: HotGateway = { hot: async () => hotPage() };
  const hot: HotGateway = {
    hot: (...args) => {
      calls.push(args);
      return behavior.hot(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    hot,
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  let view = initialHotView();
  const controller = new HotController(runtime, (next) => {
    view = next;
  });
  return { ...s, runtime, calls, behavior, controller, view: () => view };
}
