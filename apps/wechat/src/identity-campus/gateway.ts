import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeIdentityCampusIntent,
  decodeIdentityCampusReceipt,
  decodeIdentityCampusState,
  invalidIdentityCampus,
  matchIdentityCampusReceipt,
  type IdentityCampusIntent,
  type IdentityCampusReceipt,
  type IdentityCampusState,
} from './contract';
export interface IdentityCampusGateway {
  state(cancel: Cancellation): Promise<IdentityCampusState>;
  select(
    intent: IdentityCampusIntent,
    cancel: Cancellation,
  ): Promise<IdentityCampusReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<IdentityCampusReceipt>;
}
export class HttpIdentityCampusGateway implements IdentityCampusGateway {
  constructor(private readonly api: ApiClient) {}
  state(cancellation: Cancellation): Promise<IdentityCampusState> {
    return this.api.request(
      {
        path: '/v1/me/identity-campus',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeIdentityCampusState,
      },
      { cancellation },
    );
  }
  select(
    raw: IdentityCampusIntent,
    cancellation: Cancellation,
  ): Promise<IdentityCampusReceipt> {
    const intent = decodeIdentityCampusIntent(raw);
    return this.api.request(
      {
        path: '/v1/me/identity-campus',
        method: 'PUT',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode(value) {
          const receipt = decodeIdentityCampusReceipt(value);
          matchIdentityCampusReceipt(intent, receipt);
          return receipt;
        },
      },
      { cancellation, body: { ...intent } },
    );
  }
  receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<IdentityCampusReceipt> {
    // Validate before constructing a path, without accepting arbitrary account selectors.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      )
    )
      invalidIdentityCampus();
    return this.api.request(
      {
        path: `/v1/me/identity-campus/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode(value) {
          const receipt = decodeIdentityCampusReceipt(value);
          if (receipt.requestId !== requestId) invalidIdentityCampus();
          return receipt;
        },
      },
      { cancellation },
    );
  }
}
