import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating } from './contract';
import {
  assistanceId,
  assistanceIntentHash,
  decodeAssistanceMetadata,
  decodeAssistanceRequest,
  decodeAssistanceResult,
  matchAssistanceMetadata,
  type AssistanceMetadata,
  type AssistanceRequest,
  type AssistanceResult,
} from './assistance-contract';
export interface AssistanceGateway {
  create(
    request: AssistanceRequest,
    cancel: Cancellation,
  ): Promise<AssistanceMetadata>;
  status(requestId: string, cancel: Cancellation): Promise<AssistanceMetadata>;
  result(requestId: string, cancel: Cancellation): Promise<AssistanceResult>;
  cancel(
    request: Pick<AssistanceMetadata, 'requestId' | 'purpose' | 'intentHash'>,
    cancel: Cancellation,
  ): Promise<AssistanceMetadata>;
}
const prefix = '/v2/ratings/assistance/requests';
export class HttpAssistanceGateway implements AssistanceGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  private async read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    body?: unknown,
  ): Promise<T> {
    const owner = this.sessions.snapshot();
    const result = await this.api.request(
      {
        path,
        method: body === undefined ? 'GET' : 'POST',
        decode,
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      {
        cancellation: cancel,
        ...(body === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(body)) as Json }),
      },
    );
    this.sessions.assertCurrent(owner);
    return result;
  }
  private path(id: string): string {
    if (!assistanceId(id)) invalidRating();
    return `${prefix}/${id}`;
  }
  async create(
    raw: AssistanceRequest,
    cancel: Cancellation,
  ): Promise<AssistanceMetadata> {
    const request = decodeAssistanceRequest(raw),
      result = await this.read(
        prefix,
        decodeAssistanceMetadata,
        cancel,
        request,
      );
    matchAssistanceMetadata(
      { ...request, intentHash: assistanceIntentHash(request) },
      result,
    );
    return result;
  }
  async status(id: string, cancel: Cancellation): Promise<AssistanceMetadata> {
    const result = await this.read(
      this.path(id),
      decodeAssistanceMetadata,
      cancel,
    );
    if (result.requestId !== id) invalidRating();
    return result;
  }
  result(id: string, cancel: Cancellation): Promise<AssistanceResult> {
    return this.read(`${this.path(id)}/result`, decodeAssistanceResult, cancel);
  }
  async cancel(
    request: Pick<AssistanceMetadata, 'requestId' | 'purpose' | 'intentHash'>,
    cancel: Cancellation,
  ): Promise<AssistanceMetadata> {
    const result = await this.read(
      `${this.path(request.requestId)}/cancel`,
      decodeAssistanceMetadata,
      cancel,
      { purpose: request.purpose, intentHash: request.intentHash },
    );
    matchAssistanceMetadata(request, result);
    return result;
  }
}
