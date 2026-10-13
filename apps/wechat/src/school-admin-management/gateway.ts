import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import {
  decodeAuthorization,
  type Authorization,
} from '../identity-privacy/overlay';
import { isUuid } from '../profile/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeSchoolAdminManagement,
  decodeSchoolAdminManagementCommand,
  decodeSchoolAdminManagementReceipt,
  decodeSchoolAdminManagementRecovery,
  invalidSchoolAdminManagement,
  matchSchoolAdminManagementReceipt,
  type SchoolAdminManagement,
  type SchoolAdminManagementCommand,
  type SchoolAdminManagementReceipt,
  type SchoolAdminManagementRecovery,
} from './contract';
export interface SchoolAdminManagementGateway {
  capabilities(cancel: Cancellation): Promise<Authorization>;
  management(
    targetProfileId: string,
    cancel: Cancellation,
  ): Promise<SchoolAdminManagement>;
  submit(
    command: SchoolAdminManagementCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<SchoolAdminManagementReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<SchoolAdminManagementRecovery>;
}
const base = '/v1/admin/school-administrators';
export class HttpSchoolAdminManagementGateway implements SchoolAdminManagementGateway {
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
  ): Promise<SchoolAdminManagement> {
    if (!isUuid(targetProfileId)) invalidSchoolAdminManagement();
    const result = await this.api.request(
      {
        path: `${base}/management`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolAdminManagement,
      },
      { cancellation, query: { targetProfileId } },
    );
    if (result.target.profileId !== targetProfileId)
      invalidSchoolAdminManagement();
    return result;
  }
  async submit(
    raw: SchoolAdminManagementCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<SchoolAdminManagementReceipt> {
    const command = decodeSchoolAdminManagementCommand(raw);
    const result = await this.api.request(
      {
        path: `${base}/commands${cancelling ? '/cancel' : ''}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolAdminManagementReceipt,
      },
      { cancellation, body: { ...command } },
    );
    matchSchoolAdminManagementReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<SchoolAdminManagementRecovery> {
    if (!uuid4(requestId)) invalidSchoolAdminManagement();
    const result = await this.api.request(
      {
        path: `${base}/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolAdminManagementRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidSchoolAdminManagement();
    return result;
  }
}
