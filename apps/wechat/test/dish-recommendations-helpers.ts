import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  DishRecommendationController,
  type DishRecommendationView,
} from '../src/dish-recommendations/controller';
import {
  dishIdentity,
  type DishCommand,
  type DishOperation,
  type DishOwn,
  type DishPage,
  type DishReceipt,
} from '../src/dish-recommendations/contract';
import type { DishRecommendationsGateway } from '../src/dish-recommendations/gateway';
import {
  PendingDishRecommendationStore,
  type PendingDishRecommendation,
} from '../src/dish-recommendations/pending';
import { setup } from './community-helpers';
import {
  id,
  catalogRevision,
  revision,
  requestId,
  scoreRevision,
  otherId,
  recordedAt,
} from './window-ratings-helpers';
export {
  id,
  catalogRevision,
  revision,
  requestId,
  scoreRevision,
  otherId,
  recordedAt,
};
export const recommend: DishOperation = 'window.dish.recommend.v1';
export const retract: DishOperation = 'window.dish.retract.v1';
export const command = (patch: Partial<DishCommand> = {}): DishCommand => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedWindowRevision: revision,
  expectedMembershipRevision: null,
  dishName: '合成菜品',
  ...patch,
});
export const own = (active = true, ownRevision = scoreRevision): DishOwn => ({
  kind: 'recorded',
  active,
  revision: ownRevision,
  recordedAt,
  catalogRevision,
  windowRevision: revision,
});
export const page = (patch: Partial<DishPage> = {}): DishPage => ({
  windowId: id,
  catalogRevision,
  windowRevision: revision,
  membershipRevision: '1',
  items: [],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const receipt = (
  input = command(),
  operation: DishOperation = recommend,
  windowId = id,
): DishReceipt => ({
  requestId: input.clientRequestId,
  windowId,
  operation,
  dishIdentity: dishIdentity(input.dishName),
  outcome: 'applied',
  active: operation === recommend,
  membershipRevision:
    input.expectedMembershipRevision === scoreRevision
      ? otherId
      : scoreRevision,
  recordedAt,
});
export const cancelled = (
  input = command(),
  operation: DishOperation = recommend,
  windowId = id,
): DishReceipt => ({
  requestId: input.clientRequestId,
  windowId,
  operation,
  dishIdentity: dishIdentity(input.dishName),
  outcome: 'rejected',
  code: 'DISH_CANCELLED',
});
export const missing = () =>
  new ClientError('http', 'Missing', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export function dishHarness() {
  const s = setup(),
    pendingDishRecommendations = new PendingDishRecommendationStore(
      s.storage,
      'synthetic-dish-origin',
    );
  const calls: Array<{ method: string; args: unknown[] }> = [],
    commands: DishCommand[] = [],
    ids = { count: 0, next: async () => requestId };
  const impl: DishRecommendationsGateway = {
    list: async () => page(),
    own: async () => ({ kind: 'not_recommended' }),
    submit: async (windowId, operation, input) => {
      const result = receipt(input, operation, windowId);
      if (result.outcome !== 'applied') throw Error('Synthetic outcome');
      impl.own = async () => own(result.active, result.membershipRevision);
      return result;
    },
    receipt: async () => {
      throw missing();
    },
    cancel: async (windowId, operation, input) =>
      cancelled(input, operation, windowId),
  };
  const gateway: DishRecommendationsGateway = {
    list: (...args) => {
      calls.push({ method: 'list', args });
      return impl.list(...args);
    },
    own: (...args) => {
      calls.push({ method: 'own', args });
      return impl.own(...args);
    },
    submit: (...args) => {
      calls.push({ method: 'submit', args });
      commands.push(args[2]);
      return impl.submit(...args);
    },
    receipt: (...args) => {
      calls.push({ method: 'receipt', args });
      return impl.receipt(...args);
    },
    cancel: (...args) => {
      calls.push({ method: 'cancel', args });
      return impl.cancel(...args);
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    dishRecommendations: gateway,
    pendingDishRecommendations,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: DishRecommendationView[] = [],
    controller = new DishRecommendationController(runtime, (view) =>
      views.push(view),
    );
  const pending = (
    patch: Partial<PendingDishRecommendation> = {},
  ): PendingDishRecommendation => ({
    version: 1,
    accountId: s.accountId,
    origin: pendingDishRecommendations.origin,
    windowId: id,
    operation: recommend,
    command: command(),
    phase: 'submit',
    ...patch,
  });
  return {
    ...s,
    runtime,
    controller,
    impl,
    gateway,
    pendingDishRecommendations,
    calls,
    commands,
    ids,
    pending,
    views,
    view: () => views[views.length - 1]!,
  };
}
export async function choose(
  s: ReturnType<typeof dishHarness>,
  name = command().dishName,
  operation: 'recommend' | 'retract' = 'recommend',
): Promise<void> {
  s.controller.setName(name);
  await s.controller.lookup();
  s.controller.confirm(operation);
}
