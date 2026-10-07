import type { ApiClient, Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { cursor, invalid, uuid4 } from './contract';
import {
  decodeBlockIntent,
  decodeBlockResult,
  decodeBlocksList,
  decodeBlockState,
  matchBlockResult,
  type BlockIntent,
  type BlockResult,
  type BlocksList,
  type BlockState,
} from './block-contract';
export interface BlockGateway {
  apply(intent: BlockIntent, cancel: Cancellation): Promise<BlockResult>;
  receipt(requestId: string, cancel: Cancellation): Promise<BlockResult>;
  list(
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<BlocksList>;
  state(relationshipId: string, cancel: Cancellation): Promise<BlockState>;
}
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
  method: Endpoint<T>['method'] = 'GET',
): Endpoint<T> => ({
  path,
  decode,
  method,
  authentication: 'required',
  successStatus: 200,
  authReplay: 'once',
});
export class HttpBlockGateway implements BlockGateway {
  constructor(private readonly api: ApiClient) {}
  async apply(raw: BlockIntent, cancel: Cancellation): Promise<BlockResult> {
    const intent = decodeBlockIntent(raw);
    const result = await this.api.request(
      endpoint(
        intent.operation === 'block_named'
          ? '/v1/me/safety/blocks'
          : `/v1/me/safety/blocks/${intent.relationshipId}`,
        decodeBlockResult,
        'PUT',
      ),
      {
        body:
          intent.operation === 'block_named'
            ? {
                clientRequestId: intent.clientRequestId,
                source: { kind: intent.source.kind, id: intent.source.id },
                blocked: true,
              }
            : {
                clientRequestId: intent.clientRequestId,
                blocked: false,
                expectedRevision: intent.expectedRevision,
              },
        cancellation: cancel,
      },
    );
    matchBlockResult(intent, result);
    return result;
  }
  async receipt(requestId: string, cancel: Cancellation): Promise<BlockResult> {
    if (!uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(`/v1/me/safety/block-requests/${requestId}`, decodeBlockResult),
      { cancellation: cancel },
    );
    if (result.receipt.requestId !== requestId) invalid();
    return result;
  }
  async list(
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<BlocksList> {
    if (!cursor(after) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      invalid();
    const result = await this.api.request(
      endpoint('/v1/me/safety/blocks', decodeBlocksList),
      {
        query: { limit, ...(after ? { cursor: after } : {}) },
        cancellation: cancel,
      },
    );
    if (result.items.length > limit) invalid();
    return result;
  }
  async state(
    relationshipId: string,
    cancel: Cancellation,
  ): Promise<BlockState> {
    if (!isUuid(relationshipId)) invalid();
    const result = await this.api.request(
      endpoint(`/v1/me/safety/blocks/${relationshipId}`, decodeBlockState),
      { cancellation: cancel },
    );
    if (result.relationshipId !== relationshipId) invalid();
    return result;
  }
}
