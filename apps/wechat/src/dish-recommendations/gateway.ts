import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import { windowCursor, windowId } from '../window-ratings/contract';
import {
  decodeDishCommand,
  decodeDishOwn,
  decodeDishPage,
  decodeDishReceipt,
  dishName,
  dishOperation,
  invalidDish,
  matchDishReceipt,
  type DishCommand,
  type DishOperation,
  type DishOwn,
  type DishPage,
  type DishReceipt,
} from './contract';
export interface DishRecommendationsGateway {
  list(
    windowId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<DishPage>;
  own(
    windowId: string,
    dishName: string,
    cancel: Cancellation,
  ): Promise<DishOwn>;
  submit(
    windowId: string,
    operation: DishOperation,
    command: DishCommand,
    cancel: Cancellation,
  ): Promise<DishReceipt>;
  cancel(
    windowId: string,
    operation: DishOperation,
    command: DishCommand,
    cancel: Cancellation,
  ): Promise<DishReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<DishReceipt>;
}
export class HttpDishRecommendationsGateway implements DishRecommendationsGateway {
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
  async list(
    id: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<DishPage> {
    if (
      !windowId(id) ||
      (cursor !== null && !windowCursor(cursor)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidDish();
    const page = await this.read(
      `/v1/ratings/windows/${id}/dishes`,
      decodeDishPage,
      cancel,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      page.windowId !== id ||
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidDish();
    return page;
  }
  own(id: string, name: string, cancel: Cancellation): Promise<DishOwn> {
    if (!windowId(id) || !dishName(name)) invalidDish();
    return this.read(
      `/v1/ratings/windows/${id}/dishes/my-membership`,
      decodeDishOwn,
      cancel,
      { dishName: name },
    );
  }
  private async write(
    id: string,
    operation: DishOperation,
    raw: DishCommand,
    cancellation: Cancellation,
    cancelling: boolean,
  ): Promise<DishReceipt> {
    if (!windowId(id) || !dishOperation(operation)) invalidDish();
    const command = decodeDishCommand(raw);
    const receipt = await this.api.request(
      {
        path: cancelling
          ? `/v1/ratings/windows/dish-requests/${command.clientRequestId}/cancel`
          : `/v1/ratings/windows/${id}/dishes/${operation === 'window.dish.recommend.v1' ? 'recommend' : 'retract'}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDishReceipt,
      },
      {
        cancellation,
        body: JSON.parse(
          JSON.stringify(
            cancelling ? { windowId: id, operation, command } : command,
          ),
        ) as Json,
      },
    );
    matchDishReceipt(id, operation, command, receipt);
    return receipt;
  }
  submit(
    id: string,
    operation: DishOperation,
    command: DishCommand,
    cancel: Cancellation,
  ): Promise<DishReceipt> {
    return this.write(id, operation, command, cancel, false);
  }
  cancel(
    id: string,
    operation: DishOperation,
    command: DishCommand,
    cancel: Cancellation,
  ): Promise<DishReceipt> {
    return this.write(id, operation, command, cancel, true);
  }
  async receipt(id: string, cancel: Cancellation): Promise<DishReceipt> {
    if (!windowId(id)) invalidDish();
    const receipt = await this.read(
      `/v1/ratings/windows/dish-requests/${id}`,
      decodeDishReceipt,
      cancel,
    );
    if (receipt.requestId !== id) invalidDish();
    return receipt;
  }
}
