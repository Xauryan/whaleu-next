import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';
import {
  decodeInstitutionalCapability,
  decodeInstitutionalCommand,
  decodeInstitutionalReceipt,
  institutionalHash,
  invalidInstitutional,
  type InstitutionalCapability,
  type InstitutionalCommand,
  type InstitutionalReceipt,
} from './institutional-contract';
export interface InstitutionalGateway {
  capability(
    campusId: string,
    cancellation: Cancellation,
  ): Promise<InstitutionalCapability>;
  prepare(
    command: InstitutionalCommand,
    cancellation: Cancellation,
  ): Promise<InstitutionalReceipt>;
  read(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<InstitutionalReceipt>;
  authorize(
    requestId: string,
    requestHash: string,
    response: string,
    cancellation: Cancellation,
  ): Promise<InstitutionalReceipt>;
  recover(
    requestId: string,
    requestHash: string,
    cancellation: Cancellation,
  ): Promise<InstitutionalReceipt>;
  close(
    requestId: string,
    requestHash: string,
    cancellation: Cancellation,
  ): Promise<InstitutionalReceipt>;
}
/** Bounded opaque bytes, no URLs/claims accepted as authority and no authorize retry. */
export class HttpInstitutionalGateway implements InstitutionalGateway {
  constructor(private readonly api: ApiClient) {}
  capability(campusId: string, cancellation: Cancellation) {
    if (!isUuid(campusId)) invalidInstitutional();
    return this.api.request(
      {
        path: '/v1/me/institutional-sso/capability',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeInstitutionalCapability,
      },
      { cancellation, query: { campusId } },
    );
  }
  private call(
    path: string,
    method: 'GET' | 'POST',
    cancellation: Cancellation,
    body?: Json,
    replay: 'once' | 'never' = 'once',
  ) {
    return this.api.request(
      {
        path: `/v1/me/institutional-sso/requests${path}`,
        method,
        authentication: 'required',
        authReplay: replay,
        successStatus: 200,
        decode: decodeInstitutionalReceipt,
      },
      { cancellation, ...(body === undefined ? {} : { body }) },
    );
  }
  prepare(input: InstitutionalCommand, cancellation: Cancellation) {
    return this.call('', 'POST', cancellation, {
      ...decodeInstitutionalCommand(input),
    });
  }
  private key(id: string, hash?: string) {
    if (!uuid4(id) || (hash !== undefined && !institutionalHash(hash)))
      invalidInstitutional();
    return `/${id}`;
  }
  read(id: string, cancellation: Cancellation) {
    return this.call(this.key(id), 'GET', cancellation);
  }
  authorize(
    id: string,
    requestHash: string,
    authorizationResponse: string,
    cancellation: Cancellation,
  ) {
    // Count UTF-8 bytes without relying on browser/Node encoders in the Mini Program.
    if (
      typeof authorizationResponse !== 'string' ||
      !authorizationResponse.length ||
      authorizationResponse.length > 4096 ||
      /[\p{Cc}\p{Cf}]/u.test(authorizationResponse) ||
      encodeURIComponent(authorizationResponse).replace(/%[A-F\d]{2}/g, '_')
        .length > 4096
    )
      invalidInstitutional();
    return this.call(
      `${this.key(id, requestHash)}/complete`,
      'POST',
      cancellation,
      { mode: 'authorize', requestHash, authorizationResponse },
      'never',
    );
  }
  recover(id: string, requestHash: string, cancellation: Cancellation) {
    return this.call(
      `${this.key(id, requestHash)}/complete`,
      'POST',
      cancellation,
      { mode: 'recover', requestHash },
    );
  }
  close(id: string, requestHash: string, cancellation: Cancellation) {
    return this.call(
      `${this.key(id, requestHash)}/close`,
      'POST',
      cancellation,
      { requestHash },
    );
  }
}
