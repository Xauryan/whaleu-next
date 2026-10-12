import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  WindowRatingController,
  type WindowMode,
  type WindowRatingView,
} from '../src/window-ratings/controller';
import type {
  RatingWindow,
  WindowCatalog,
  WindowDetail,
  WindowPage,
  WindowReceipt,
  WindowSetScore,
} from '../src/window-ratings/contract';
import type { WindowRatingsGateway } from '../src/window-ratings/gateway';
import {
  PendingWindowRatingStore,
  type PendingWindowRating,
} from '../src/window-ratings/pending';
import { setup } from './community-helpers';
export const id = '11111111-1111-4111-8111-111111111111';
export const revision = '22222222-2222-4222-8222-222222222222';
export const catalogRevision = '33333333-3333-4333-8333-333333333333';
export const campusId = '44444444-4444-4444-8444-444444444444';
export const requestId = '55555555-5555-4555-8555-555555555555';
export const otherId = '66666666-6666-4666-8666-666666666666';
export const canteenId = '77777777-7777-4777-8777-777777777777';
export const floorId = '88888888-8888-4888-8888-888888888888';
export const scoreRevision = '99999999-9999-4999-8999-999999999999';
export const recordedAt = '2026-10-11T12:00:00.000Z';
export const floor = {
  id: floorId,
  sourceFloorKey: 'B1-mezzanine',
  label: '合成夹层',
};
export const catalog = (): WindowCatalog => ({
  catalogRevision,
  canteens: [
    {
      id: canteenId,
      revision,
      name: '合成食堂',
      sourceCanteenKey: 'synthetic-canteen',
      campusId,
      campusLabel: '合成校区',
      sourceCampusKey: 'synthetic-campus',
      floors: [floor],
    },
  ],
});
export const window = (patch: Partial<RatingWindow> = {}): RatingWindow => ({
  id,
  revision,
  name: '合成窗口',
  canteenId,
  canteenName: '合成食堂',
  floor,
  summary: { kind: 'known', ratingCount: 0, mean: null },
  ...patch,
});
export const detail = (patch: Partial<WindowDetail> = {}): WindowDetail => ({
  catalogRevision,
  window: window(),
  myScore: { kind: 'not_submitted' },
  ...patch,
});
export const page = (patch: Partial<WindowPage> = {}): WindowPage => ({
  catalogRevision,
  scoreRevision: '1',
  items: [window()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const command = (
  patch: Partial<WindowSetScore> = {},
): WindowSetScore => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedWindowRevision: revision,
  expectedOwnScoreRevision: null,
  score: -10,
  ...patch,
});
export const receipt = (input = command(), windowId = id): WindowReceipt => ({
  requestId: input.clientRequestId,
  operation: 'window.score.set.v1',
  outcome: 'applied',
  windowId,
  score: input.score,
  scoreRevision:
    input.expectedOwnScoreRevision === scoreRevision ? otherId : scoreRevision,
  recordedAt,
});
export const cancelled = (input = command(), windowId = id): WindowReceipt => ({
  requestId: input.clientRequestId,
  operation: 'window.score.set.v1',
  outcome: 'rejected',
  windowId,
  code: 'WINDOW_SCORE_CANCELLED',
});
export const missing = () =>
  new ClientError('http', 'Synthetic missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export function windowHarness(mode: WindowMode = 'detail') {
  const s = setup(),
    pendingWindowRatings = new PendingWindowRatingStore(
      s.storage,
      'synthetic-window-origin',
    );
  const calls: Array<{ method: string; args: unknown[] }> = [],
    commands: WindowSetScore[] = [],
    ids = { count: 0, next: async () => requestId };
  const impl: WindowRatingsGateway = {
    catalog: async () => catalog(),
    list: async () => page(),
    detail: async () => detail(),
    submit: async (windowId, input) => {
      const result = receipt(input, windowId);
      if (result.outcome === 'rejected')
        throw Error('Unexpected synthetic outcome');
      impl.detail = async () =>
        detail({
          myScore: {
            kind: 'recorded',
            score: input.score,
            revision: result.scoreRevision,
            recordedAt,
          },
          window: window({
            summary: { kind: 'known', ratingCount: 1, mean: input.score },
          }),
        });
      return result;
    },
    receipt: async () => {
      throw missing();
    },
    cancel: async (windowId, input) => cancelled(input, windowId),
  };
  const gateway: WindowRatingsGateway = {
    catalog: (...args) => {
      calls.push({ method: 'catalog', args });
      return impl.catalog(...args);
    },
    list: (...args) => {
      calls.push({ method: 'list', args });
      return impl.list(...args);
    },
    detail: (...args) => {
      calls.push({ method: 'detail', args });
      return impl.detail(...args);
    },
    submit: (...args) => {
      calls.push({ method: 'submit', args });
      commands.push(args[1]);
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
    windowRatings: gateway,
    pendingWindowRatings,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: WindowRatingView[] = [],
    controller = new WindowRatingController(runtime, mode, (view) =>
      views.push(view),
    );
  const pending = (
    patch: Partial<PendingWindowRating> = {},
  ): PendingWindowRating => ({
    version: 1,
    accountId: s.accountId,
    origin: pendingWindowRatings.origin,
    operation: 'window.score.set.v1',
    windowId: id,
    command: command(),
    phase: 'submit',
    ...patch,
  });
  return {
    ...s,
    runtime,
    controller,
    views,
    impl,
    gateway,
    pendingWindowRatings,
    calls,
    commands,
    ids,
    pending,
    view: () => views[views.length - 1]!,
  };
}
export function choose(s: ReturnType<typeof windowHarness>, score = -10): void {
  s.controller.chooseScore(score);
  s.controller.confirm();
}
