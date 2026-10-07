import { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeVerificationSummary,
  type VerificationSummary,
} from './contract';

export interface VerificationGateway {
  summary(cancellation: Cancellation): Promise<VerificationSummary>;
}
/** No account selector, provider call, application mutation or private-value endpoint. */
export class HttpVerificationGateway implements VerificationGateway {
  constructor(private readonly api: ApiClient) {}
  summary(cancellation: Cancellation): Promise<VerificationSummary> {
    return this.api.request(
      {
        path: '/v1/me/verification',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeVerificationSummary,
      },
      { cancellation },
    );
  }
}
