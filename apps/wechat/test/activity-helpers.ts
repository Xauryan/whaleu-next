import {
  ActivityController,
  initialActivityView,
} from '../src/activities/controller';
import {
  ActivityVisitController,
  initialActivityVisitView,
} from '../src/activities/visit-controller';
import { PendingActivityVisitStore } from '../src/activities/pending';
import type {
  ActivityDetail,
  ActivityPage,
  ActivitySummary,
  ActivityVisitReceipt,
} from '../src/activities/contract';
import type { ActivitiesGateway } from '../src/activities/gateway';
import { SafetyChanges } from '../src/community/safety-changes';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { createdAt, requestId, setup } from './community-helpers';
export const regionId = '11111111-1111-4111-8111-111111111111';
export const activityId = '22222222-2222-4222-8222-222222222222';
export const revision = '33333333-3333-4333-8333-333333333333';
export const otherRegion = '44444444-4444-4444-8444-444444444444';
export const token = (n = 1): string =>
  Buffer.alloc(32, n).toString('base64url');
export const summary = (
  patch: Partial<ActivitySummary> = {},
): ActivitySummary => ({
  id: activityId,
  revision,
  title: '  活动\r\n标题  ',
  organizerLabel: '主办方快照',
  reward: { status: 'unavailable', value: null },
  online: { status: 'known', value: 'offline' },
  createdAt: { status: 'known', value: createdAt },
  cover: { status: 'unavailable' },
  organizerAvatar: { status: 'absent' },
  ...patch,
});
export const detail = (
  patch: Partial<ActivityDetail> = {},
): ActivityDetail => ({
  ...summary(),
  regionId,
  bodyText: '  原文\r\n\t<b>不解析</b>  ',
  activityTime: '每逢周末 下午\n时间待定',
  activityLocation: '  学生活动中心  ',
  gallery: { status: 'unavailable', items: null },
  organizerQr: { status: 'unavailable' },
  ...patch,
});
export const page = (patch: Partial<ActivityPage> = {}): ActivityPage => ({
  context: { regionId, catalogRevision: revision },
  items: [summary()],
  selection: { kind: 'historical', maximum: 10 },
  continuation: 'end',
  nextCursor: null,
  pageCursor: token(),
  ...patch,
});
export const visitIntent = () => ({
  requestId,
  regionId,
  expectedCatalogRevision: revision,
});
export const receipt = (
  patch: Partial<ActivityVisitReceipt> = {},
): ActivityVisitReceipt => ({
  requestId,
  regionId,
  catalogRevision: revision,
  visitedAt: createdAt,
  ...patch,
});
export function activityHarness(
  mode: 'list' | 'detail' = 'list',
  signedIn = true,
) {
  const s = setup(signedIn);
  const calls: { method: keyof ActivitiesGateway; args: unknown[] }[] = [];
  const behavior: ActivitiesGateway = {
    context: async () => ({ regionId, visitHistory: 'never_visited' }),
    list: async () => page(),
    detail: async () => detail(),
    visit: async (intent) =>
      receipt({
        requestId: intent.requestId,
        regionId: intent.regionId,
        catalogRevision: intent.expectedCatalogRevision,
      }),
  };
  const activities: ActivitiesGateway = {
    context: (...args) => {
      calls.push({ method: 'context', args });
      return behavior.context(...args);
    },
    list: (...args) => {
      calls.push({ method: 'list', args });
      return behavior.list(...args);
    },
    detail: (...args) => {
      calls.push({ method: 'detail', args });
      return behavior.detail(...args);
    },
    visit: (...args) => {
      calls.push({ method: 'visit', args });
      return behavior.visit(...args);
    },
  };
  const runtime = {
    ...s.runtime,
    activities,
    pendingActivityVisits: new PendingActivityVisitStore(
      s.storage,
      'synthetic',
    ),
    directoryScopeChanges: new PrivateViewLifecycle(),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  let view = initialActivityView(),
    visit = initialActivityVisitView();
  const visits = new ActivityVisitController(runtime, (next) => {
    visit = next;
  });
  const controller = new ActivityController(
    runtime,
    mode,
    (next) => {
      view = next;
    },
    (context) => {
      void visits.acknowledge(context);
    },
    () => visits.cancel(),
  );
  return {
    ...s,
    runtime,
    calls,
    behavior,
    visits,
    controller,
    view: () => view,
    visit: () => visit,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
}
export const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
