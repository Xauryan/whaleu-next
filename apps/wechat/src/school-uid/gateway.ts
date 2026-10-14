import type { ApiClient } from '../api/client';
import {
  decodeAuthorization,
  type Authorization,
} from '../identity-privacy/overlay';
import type { Cancellation } from '../platform/contracts';
import {
  decodeSchoolUid,
  decodeSchoolUidLookup,
  invalidSchoolUid,
  isSchoolCode,
  parseSchoolUid,
  type SchoolUid,
  type SchoolUidLookup,
} from './contract';
export interface SchoolUidGateway {
  own(cancel: Cancellation): Promise<SchoolUid>;
  capabilities(cancel: Cancellation): Promise<Authorization>;
  lookup(
    schoolCode: string,
    uid: string,
    cancel: Cancellation,
  ): Promise<SchoolUidLookup>;
}
export class HttpSchoolUidGateway implements SchoolUidGateway {
  constructor(private readonly api: ApiClient) {}
  own(cancellation: Cancellation): Promise<SchoolUid> {
    return this.api.request(
      {
        path: '/v1/me/school-uid',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolUid,
      },
      { cancellation },
    );
  }
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
  lookup(
    schoolCode: string,
    uid: string,
    cancellation: Cancellation,
  ): Promise<SchoolUidLookup> {
    if (!isSchoolCode(schoolCode)) invalidSchoolUid();
    return this.api.request(
      {
        path: '/v1/admin/school-uids/lookup',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeSchoolUidLookup,
      },
      { cancellation, query: { schoolCode, uid: parseSchoolUid(uid) } },
    );
  }
}
