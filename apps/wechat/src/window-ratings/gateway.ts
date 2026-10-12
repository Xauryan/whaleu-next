import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeWindowCatalog,
  decodeWindowDetail,
  decodeWindowPage,
  decodeWindowQuery,
  decodeWindowReceipt,
  decodeWindowSetScore,
  invalidWindow,
  matchWindowReceipt,
  windowCursor,
  windowId,
  type WindowCatalog,
  type WindowDetail,
  type WindowPage,
  type WindowQuery,
  type WindowReceipt,
  type WindowSetScore,
} from './contract';
export interface WindowRatingsGateway {
  catalog(cancel: Cancellation): Promise<WindowCatalog>;
  list(
    query: WindowQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<WindowPage>;
  detail(windowId: string, cancel: Cancellation): Promise<WindowDetail>;
  submit(
    windowId: string,
    command: WindowSetScore,
    cancel: Cancellation,
  ): Promise<WindowReceipt>;
  cancel(
    windowId: string,
    command: WindowSetScore,
    cancel: Cancellation,
  ): Promise<WindowReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<WindowReceipt>;
}
export class HttpWindowRatingsGateway implements WindowRatingsGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancellation: Cancellation,
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
      { cancellation, ...(query ? { query } : {}) },
    );
  }
  catalog(cancel: Cancellation): Promise<WindowCatalog> {
    return this.read(
      '/v1/ratings/windows/catalog',
      decodeWindowCatalog,
      cancel,
    );
  }
  async list(
    raw: WindowQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<WindowPage> {
    const query = decodeWindowQuery(raw);
    if (
      (cursor !== null && !windowCursor(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidWindow();
    const page = await this.read(
      '/v1/ratings/windows',
      decodeWindowPage,
      cancel,
      {
        limit,
        ...(query.canteenIds ? { canteenIds: query.canteenIds.join(',') } : {}),
        ...(query.floorId ? { floorId: query.floorId } : {}),
        ...(query.minRating === undefined
          ? {}
          : { minRating: query.minRating }),
        ...(cursor ? { cursor } : {}),
      },
    );
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor) ||
      page.items.some(
        (item) =>
          (query.canteenIds && !query.canteenIds.includes(item.canteenId)) ||
          (query.floorId && query.floorId !== item.floor.id) ||
          (query.minRating !== undefined &&
            query.minRating > 0 &&
            (item.summary.kind !== 'known' ||
              item.summary.mean === null ||
              item.summary.mean < query.minRating)),
      )
    )
      invalidWindow();
    return page;
  }
  async detail(id: string, cancel: Cancellation): Promise<WindowDetail> {
    if (!windowId(id)) invalidWindow();
    const detail = await this.read(
      `/v1/ratings/windows/${id}`,
      decodeWindowDetail,
      cancel,
    );
    if (detail.window.id !== id) invalidWindow();
    return detail;
  }
  private async write(
    id: string,
    raw: WindowSetScore,
    cancellation: Cancellation,
    cancelling: boolean,
  ): Promise<WindowReceipt> {
    if (!windowId(id)) invalidWindow();
    const command = decodeWindowSetScore(raw);
    const receipt = await this.api.request(
      {
        path: cancelling
          ? `/v1/ratings/windows/requests/${command.clientRequestId}/cancel`
          : `/v1/ratings/windows/${id}/score`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeWindowReceipt,
      },
      {
        cancellation,
        body: JSON.parse(
          JSON.stringify(cancelling ? { windowId: id, command } : command),
        ) as Json,
      },
    );
    matchWindowReceipt(id, command, receipt);
    return receipt;
  }
  submit(
    id: string,
    command: WindowSetScore,
    cancel: Cancellation,
  ): Promise<WindowReceipt> {
    return this.write(id, command, cancel, false);
  }
  cancel(
    id: string,
    command: WindowSetScore,
    cancel: Cancellation,
  ): Promise<WindowReceipt> {
    return this.write(id, command, cancel, true);
  }
  async receipt(id: string, cancel: Cancellation): Promise<WindowReceipt> {
    if (!windowId(id)) invalidWindow();
    const receipt = await this.read(
      `/v1/ratings/windows/requests/${id}`,
      decodeWindowReceipt,
      cancel,
    );
    if (receipt.requestId !== id) invalidWindow();
    return receipt;
  }
}
