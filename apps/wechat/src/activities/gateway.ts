import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import {
  activityCursor,
  activityUuid,
  decodeActivityContext,
  decodeActivityDetail,
  decodeActivityPage,
  decodeActivityVisitIntent,
  decodeActivityVisitReceipt,
  invalidActivity,
  matchActivityVisit,
  type ActivityContext,
  type ActivityDetail,
  type ActivityPage,
  type ActivityVisitIntent,
  type ActivityVisitReceipt,
  type ActivityWindow,
} from './contract';
export interface ActivitiesGateway {
  context(cancel: Cancellation): Promise<ActivityContext>;
  list(
    regionId: string,
    window: ActivityWindow,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ActivityPage>;
  detail(
    regionId: string,
    activityId: string,
    cancel: Cancellation,
  ): Promise<ActivityDetail>;
  visit(
    intent: ActivityVisitIntent,
    cancel: Cancellation,
  ): Promise<ActivityVisitReceipt>;
}
export class HttpActivitiesGateway implements ActivitiesGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  context(cancel: Cancellation): Promise<ActivityContext> {
    return this.read('/v1/activities/context', decodeActivityContext, cancel);
  }
  async list(
    regionId: string,
    window: ActivityWindow,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ActivityPage> {
    if (
      !activityUuid(regionId) ||
      !['entry', 'all'].includes(window) ||
      (cursor !== null && !activityCursor(cursor)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidActivity();
    const result = await this.read(
      `/v1/regions/${regionId}/activities`,
      decodeActivityPage,
      cancel,
      { window, limit, ...(cursor === null ? {} : { cursor }) },
    );
    if (
      result.context.regionId !== regionId ||
      result.nextCursor === result.pageCursor ||
      result.items.length > limit ||
      (result.continuation === 'more' && result.items.length !== limit) ||
      (cursor !== null &&
        (result.nextCursor === cursor || result.pageCursor !== cursor)) ||
      (window === 'all' && result.selection.kind !== 'all')
    )
      invalidActivity();
    return result;
  }
  async detail(
    regionId: string,
    activityId: string,
    cancel: Cancellation,
  ): Promise<ActivityDetail> {
    if (!activityUuid(regionId) || !activityUuid(activityId)) invalidActivity();
    const result = await this.read(
      `/v1/regions/${regionId}/activities/${activityId}`,
      decodeActivityDetail,
      cancel,
    );
    if (result.id !== activityId || result.regionId !== regionId)
      invalidActivity();
    return result;
  }
  async visit(
    raw: ActivityVisitIntent,
    cancel: Cancellation,
  ): Promise<ActivityVisitReceipt> {
    const intent = decodeActivityVisitIntent(raw);
    const receipt = await this.api.request(
      {
        path: `/v1/me/activity-visits/${intent.requestId}`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeActivityVisitReceipt,
      },
      {
        cancellation: cancel,
        body: {
          regionId: intent.regionId,
          expectedCatalogRevision: intent.expectedCatalogRevision,
        },
      },
    );
    matchActivityVisit(intent, receipt);
    return receipt;
  }
}
