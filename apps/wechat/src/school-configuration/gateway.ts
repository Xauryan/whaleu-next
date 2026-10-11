import { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeSchoolPublic,
  decodeSchoolCapabilities,
  decodeSchoolManagement,
  decodeSchoolReceipt,
  decodeSchoolRecovery,
  schoolUuid,
  schoolKey,
  schoolCommand,
  invalidSchool,
} from './contract';
import type {
  SchoolPublicView,
  SchoolCapabilities,
  SchoolManagementView,
  SchoolReceipt,
  SchoolRecovery,
  SchoolEntryKey,
  SchoolCommand,
} from './contract';
export interface SchoolConfigurationGateway {
  public(campusId: string, cancel: Cancellation): Promise<SchoolPublicView>;
  capabilities(cancel: Cancellation): Promise<SchoolCapabilities>;
  management(
    regionId: string | null,
    cancel: Cancellation,
  ): Promise<SchoolManagementView>;
  save(
    regionId: string,
    key: SchoolEntryKey,
    command: SchoolCommand,
    cancel: Cancellation,
  ): Promise<SchoolReceipt>;
  recover(requestId: string, cancel: Cancellation): Promise<SchoolRecovery>;
  cancel(
    requestId: string,
    requestHash: string,
    cancel: Cancellation,
  ): Promise<SchoolRecovery>;
}
export class HttpSchoolConfigurationGateway implements SchoolConfigurationGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (value: unknown) => T,
    cancel: Cancellation,
    query: Record<string, string> = {},
    publicRead = false,
  ) {
    return this.api.request(
      {
        path,
        decode,
        method: 'GET',
        authentication: publicRead ? 'optional' : 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      { query, cancellation: cancel },
    );
  }
  async public(campusId: string, cancel: Cancellation) {
    schoolUuid(campusId);
    const result = await this.read(
      '/v1/school-services',
      decodeSchoolPublic,
      cancel,
      { campusId },
      true,
    );
    if (result.context.campusId !== campusId) invalidSchool();
    return result;
  }
  capabilities(cancel: Cancellation) {
    return this.read(
      '/v1/me/school-configuration/capabilities',
      decodeSchoolCapabilities,
      cancel,
    );
  }
  async management(regionId: string | null, cancel: Cancellation) {
    if (regionId !== null) schoolUuid(regionId);
    const result = await this.read(
      '/v1/me/school-configuration',
      decodeSchoolManagement,
      cancel,
      regionId === null ? {} : { regionId },
    );
    if (regionId !== null && result.context.regionId !== regionId)
      invalidSchool();
    return result;
  }
  async save(
    regionId: string,
    key: SchoolEntryKey,
    command: SchoolCommand,
    cancel: Cancellation,
  ) {
    schoolUuid(regionId);
    schoolKey(key);
    const checked = schoolCommand(command, key);
    const result = await this.api.request(
      {
        path: `/v1/me/school-configuration/${regionId}/entries/${key}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolReceipt,
      },
      {
        body: {
          ...checked,
          entry: { ...checked.entry },
          qrcode: { ...checked.qrcode },
        },
        cancellation: cancel,
      },
    );
    if (
      result.regionId !== regionId ||
      result.entryKey !== key ||
      result.requestId !== command.clientRequestId ||
      result.revision !== command.expectedRevision + 1
    )
      invalidSchool();
    return result;
  }
  async cancel(requestId: string, requestHash: string, cancel: Cancellation) {
    schoolUuid(requestId);
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidSchool();
    const result = await this.api.request(
      {
        path: `/v1/me/school-configuration/requests/${requestId}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolRecovery,
      },
      { body: { requestHash }, cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidSchool();
    return result;
  }
  async recover(requestId: string, cancel: Cancellation) {
    schoolUuid(requestId);
    const result = await this.read(
      `/v1/me/school-configuration/requests/${requestId}`,
      decodeSchoolRecovery,
      cancel,
    );
    if (result.requestId !== requestId) invalidSchool();
    return result;
  }
}
