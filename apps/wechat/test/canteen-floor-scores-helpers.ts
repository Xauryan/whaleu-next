import { ClientError } from '../src/api/errors';
import {
  FloorRatingController,
  type FloorMode,
  type FloorRatingView,
} from '../src/canteen-floor-scores/controller';
import {
  PendingFloorRatingStore,
  type PendingFloorRating,
} from '../src/canteen-floor-scores/pending';
import type {
  FloorDetail,
  FloorReceipt,
  FloorSetScore,
} from '../src/canteen-floor-scores/contract';
import type { FloorRatingsGateway } from '../src/canteen-floor-scores/gateway';
import type { CommunityRuntime } from '../src/community/runtime';
import { setup } from './community-helpers';
import {
  catalog,
  floorId,
  revision,
  catalogRevision,
  canteenId,
  requestId,
  scoreRevision,
  recordedAt,
} from './window-ratings-helpers';
export {
  catalog,
  floorId,
  revision,
  catalogRevision,
  canteenId,
  requestId,
  scoreRevision,
  recordedAt,
};
export const command = (patch: Partial<FloorSetScore> = {}): FloorSetScore => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedCanteenRevision: revision,
  score: 4.75,
  ...patch,
});
export const detail = (patch: Partial<FloorDetail> = {}): FloorDetail => ({
  catalogRevision,
  floor: {
    id: floorId,
    canteenRevision: revision,
    canteenId,
    canteenName: '合成食堂',
    sourceFloorKey: 'B1-mezzanine',
    label: '合成夹层',
    summary: { kind: 'known', ratingCount: 0, mean: null },
  },
  myScore: { kind: 'not_submitted' },
  ...patch,
});
export const receipt = (c = command(), id = floorId): FloorReceipt => ({
  requestId: c.clientRequestId,
  operation: 'floor.score.first.v1',
  floorId: id,
  outcome: 'applied',
  score: c.score,
  scoreRevision,
  recordedAt,
});
export const cancelled = (c = command(), id = floorId): FloorReceipt => ({
  requestId: c.clientRequestId,
  operation: 'floor.score.first.v1',
  floorId: id,
  outcome: 'rejected',
  code: 'FLOOR_SCORE_CANCELLED',
});
export const missing = () =>
  new ClientError('http', 'Synthetic missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export function floorHarness(mode: FloorMode = 'detail') {
  const s = setup(),
    pendingFloorRatings = new PendingFloorRatingStore(
      s.storage,
      'synthetic-floor-origin',
    ),
    calls: string[] = [],
    commands: FloorSetScore[] = [],
    ids = { count: 0, next: async () => requestId };
  const impl: FloorRatingsGateway = {
    catalog: async () => catalog(),
    detail: async () => detail(),
    submit: async (id, c) => {
      impl.detail = async () =>
        detail({
          myScore: {
            kind: 'recorded',
            score: c.score,
            revision: scoreRevision,
            recordedAt,
          },
          floor: {
            ...detail().floor,
            summary: {
              kind: 'known',
              ratingCount: 1,
              mean: Math.round(c.score * 10) / 10,
            },
          },
        });
      return receipt(c, id);
    },
    receipt: async () => {
      throw missing();
    },
    cancel: async (id, c) => cancelled(c, id),
  };
  const gateway: FloorRatingsGateway = {
    catalog: (...args) => {
      calls.push('catalog');
      return impl.catalog(...args);
    },
    detail: (...args) => {
      calls.push('detail');
      return impl.detail(...args);
    },
    submit: (...args) => {
      calls.push('submit');
      commands.push(args[1]);
      return impl.submit(...args);
    },
    receipt: (...args) => {
      calls.push('receipt');
      return impl.receipt(...args);
    },
    cancel: (...args) => {
      calls.push('cancel');
      return impl.cancel(...args);
    },
  };
  const runtime: CommunityRuntime = {
      ...s.runtime,
      floorRatings: gateway,
      pendingFloorRatings,
      newRequestId: () => {
        ids.count++;
        return ids.next();
      },
    },
    views: FloorRatingView[] = [],
    controller = new FloorRatingController(runtime, mode, (v) => views.push(v));
  const pending = (
    patch: Partial<PendingFloorRating> = {},
  ): PendingFloorRating => ({
    version: 1,
    accountId: s.accountId,
    origin: pendingFloorRatings.origin,
    operation: 'floor.score.first.v1',
    floorId,
    command: command(),
    phase: 'submit',
    ...patch,
  });
  return {
    ...s,
    runtime,
    views,
    controller,
    impl,
    pendingFloorRatings,
    calls,
    commands,
    ids,
    pending,
    view: () => views[views.length - 1]!,
  };
}
export function choose(s: ReturnType<typeof floorHarness>, score = 4.75) {
  s.controller.chooseScore(score);
  s.controller.confirm();
}
