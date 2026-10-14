import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import {
  decodeAuthorization,
  type Authorization,
} from '../identity-privacy/overlay';
import { isUuid } from '../profile/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeSchoolIdentityManagement,
  decodeSchoolIdentityCommand,
  decodeSchoolIdentityReceipt,
  decodeSchoolIdentityRecovery,
  invalidSchoolIdentity,
  matchSchoolIdentityReceipt,
  type SchoolIdentityManagement,
  type SchoolIdentityCommand,
  type SchoolIdentityReceipt,
  type SchoolIdentityRecovery,
} from './contract';
export interface SchoolIdentityGateway {
  capabilities(cancel: Cancellation): Promise<Authorization>;
  management(
    targetProfileId: string,
    cancel: Cancellation,
    destinationCampusId?: string,
  ): Promise<SchoolIdentityManagement>;
  submit(
    command: SchoolIdentityCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<SchoolIdentityReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<SchoolIdentityRecovery>;
}
const base = '/v1/admin/school-identities';
export class HttpSchoolIdentityGateway implements SchoolIdentityGateway {
  constructor(private readonly api: ApiClient) {}
  capabilities(cancellation: Cancellation): Promise<Authorization> {
    return this.api.request(
      {
        path: '/v1/me/authorization',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAuthorization,
      },
      { cancellation },
    );
  }
  async management(
    targetProfileId: string,
    cancellation: Cancellation,
    destinationCampusId?: string,
  ): Promise<SchoolIdentityManagement> {
    if (
      !isUuid(targetProfileId) ||
      (destinationCampusId !== undefined && !isUuid(destinationCampusId))
    )
      invalidSchoolIdentity();
    const result = await this.api.request(
      {
        path: `${base}/management`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolIdentityManagement,
      },
      {
        cancellation,
        query: {
          targetProfileId,
          ...(destinationCampusId ? { destinationCampusId } : {}),
        },
      },
    );
    if (
      result.target.profileId !== targetProfileId ||
      (result.destination?.campusId ?? null) !== (destinationCampusId ?? null)
    )
      invalidSchoolIdentity();
    return result;
  }
  async submit(
    raw: SchoolIdentityCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<SchoolIdentityReceipt> {
    const command = decodeSchoolIdentityCommand(raw);
    const result = await this.api.request(
      {
        path: `${base}/commands${cancelling ? '/cancel' : ''}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolIdentityReceipt,
      },
      { cancellation, body: { ...command } },
    );
    matchSchoolIdentityReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<SchoolIdentityRecovery> {
    if (!uuid4(requestId)) invalidSchoolIdentity();
    const result = await this.api.request(
      {
        path: `${base}/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolIdentityRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidSchoolIdentity();
    return result;
  }
}
