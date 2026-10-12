import { isUuid } from '../profile/contract';
import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { uuid4 } from '../community/contract';
import {
  decodePinPage,
  decodePinSlot,
  decodePinDetail,
  decodePinCommand,
  decodePinReceipt,
  matchPinReceipt,
  checkPinQuery,
  invalidPin,
} from './contract';
import type {
  PinPage,
  PinSlot,
  PinQuery,
  PinDetail,
  PinCommand,
  PinReceipt,
} from './contract';
export interface PostPinsGateway {
  slot(spaceId: string, cancel: Cancellation): Promise<PinSlot>;
  list(query: PinQuery, cancel: Cancellation): Promise<PinPage>;
  detail(postId: string, cancel: Cancellation): Promise<PinDetail>;
  submit(
    command: PinCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<PinReceipt>;
  receipt(id: string, cancel: Cancellation): Promise<PinReceipt>;
}
export class HttpPostPinsGateway implements PostPinsGateway {
  constructor(private readonly api: ApiClient) {}
  async slot(spaceId: string, cancellation: Cancellation): Promise<PinSlot> {
    if (!isUuid(spaceId)) invalidPin();
    const result = await this.api.request(
      {
        path: '/v1/community/post-pin-slot',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePinSlot,
      },
      { query: { spaceId }, cancellation },
    );
    if (result.spaceId !== spaceId) invalidPin();
    return result;
  }
  async list(query: PinQuery, cancellation: Cancellation): Promise<PinPage> {
    checkPinQuery(query);
    const result = await this.api.request(
      {
        path: '/v1/community/post-pins',
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePinPage,
      },
      { query: { ...query }, cancellation },
    );
    if (
      result.spaceId !== query.spaceId ||
      result.items.some(
        (i) =>
          (query.category && i.post.category !== query.category) ||
          (query.tradingSubtype &&
            (i.post.trading?.subtype.kind !== 'known' ||
              i.post.trading.subtype.key !== query.tradingSubtype)),
      )
    )
      invalidPin();
    return result;
  }
  async detail(postId: string, cancellation: Cancellation): Promise<PinDetail> {
    if (!isUuid(postId)) invalidPin();
    const result = await this.api.request(
      {
        path: `/v1/community/posts/${postId}/pin`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePinDetail,
      },
      { cancellation },
    );
    if (result.postId !== postId) invalidPin();
    return result;
  }
  async submit(
    raw: PinCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<PinReceipt> {
    const command = decodePinCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? `/v1/me/community/post-pin-requests/${command.clientRequestId}/cancel`
          : '/v1/community/post-pin-commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePinReceipt,
      },
      { cancellation, body: JSON.parse(JSON.stringify(command)) as Json },
    );
    matchPinReceipt(command, result);
    return result;
  }
  async receipt(id: string, cancellation: Cancellation): Promise<PinReceipt> {
    if (!uuid4(id)) invalidPin();
    const result = await this.api.request(
      {
        path: `/v1/me/community/post-pin-requests/${id}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePinReceipt,
      },
      { cancellation },
    );
    if (result.requestId !== id) invalidPin();
    return result;
  }
}
