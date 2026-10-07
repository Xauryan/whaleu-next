import { ApiClient, type Endpoint } from '../api/client';
import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import {
  decodeCampusPage,
  decodeOwnProfile,
  isUuid,
  validateCampusQuery,
  validatePreferencesPatch,
  validateProfilePatch,
  validateRevision,
  type CampusPage,
  type CampusPatch,
  type CampusQuery,
  type OwnProfile,
  type PreferencesPatch,
  type ProfilePatch,
} from './contract';
export interface ProfileGateway {
  campuses(query: CampusQuery, cancellation: Cancellation): Promise<CampusPage>;
  profile(cancellation: Cancellation): Promise<OwnProfile>;
  updateProfile(
    patch: ProfilePatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile>;
  updatePreferences(
    patch: PreferencesPatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile>;
  selectCampus(
    patch: CampusPatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile>;
}
const profileEndpoint = (
  path: string,
  method: Endpoint<OwnProfile>['method'],
): Endpoint<OwnProfile> => ({
  path,
  method,
  authentication: 'required',
  authReplay: method === 'GET' ? 'once' : 'never',
  successStatus: 200,
  decode: decodeOwnProfile,
});
export class HttpProfileGateway implements ProfileGateway {
  constructor(private readonly api: ApiClient) {}
  async campuses(
    query: CampusQuery,
    cancellation: Cancellation,
  ): Promise<CampusPage> {
    validateCampusQuery(query);
    const result = await this.api.request(
      {
        path: '/v1/campuses',
        method: 'GET',
        authentication: 'none',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeCampusPage,
      },
      {
        query: {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.q ? { q: query.q } : {}),
          ...(query.district ? { district: query.district } : {}),
        },
        cancellation,
      },
    );
    if (result.page !== query.page || result.pageSize !== query.pageSize)
      throw new ClientError('protocol', 'Campus pagination mismatch');
    return result;
  }
  profile(cancellation: Cancellation): Promise<OwnProfile> {
    return this.api.request(profileEndpoint('/v1/me/profile', 'GET'), {
      cancellation,
    });
  }
  updateProfile(
    patch: ProfilePatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile> {
    validateProfilePatch(patch);
    return this.api.request(profileEndpoint('/v1/me/profile', 'PATCH'), {
      body: { ...patch },
      cancellation,
    });
  }
  updatePreferences(
    patch: PreferencesPatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile> {
    validatePreferencesPatch(patch);
    return this.api.request(profileEndpoint('/v1/me/preferences', 'PATCH'), {
      body: {
        expectedRevision: patch.expectedRevision,
        preferences: { ...patch.preferences },
      },
      cancellation,
    });
  }
  selectCampus(
    patch: CampusPatch,
    cancellation: Cancellation,
  ): Promise<OwnProfile> {
    validateRevision(patch.expectedRevision);
    if (
      !isUuid(patch.campusId) ||
      Object.keys(patch).some(
        (key) => !['expectedRevision', 'campusId'].includes(key),
      )
    )
      throw new ClientError('business', 'Invalid campus selection');
    return this.api.request(profileEndpoint('/v1/me/campus', 'PUT'), {
      body: { ...patch },
      cancellation,
    });
  }
}
