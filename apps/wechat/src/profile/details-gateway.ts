import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from './contract';
import {
  decodeOwnProfileDetails,
  decodePublicProfileDetails,
  validateProfileDetailsPatch,
  type OwnProfileDetails,
  type ProfileDetailsPatch,
  type PublicProfileDetails,
} from './details-contract';
export interface ProfileDetailsGateway {
  own(cancel: Cancellation): Promise<OwnProfileDetails>;
  update(
    patch: ProfileDetailsPatch,
    cancel: Cancellation,
  ): Promise<OwnProfileDetails>;
  public(
    profileId: string,
    cancel: Cancellation,
  ): Promise<PublicProfileDetails>;
}
export class HttpProfileDetailsGateway implements ProfileDetailsGateway {
  constructor(private readonly api: ApiClient) {}
  own(cancellation: Cancellation): Promise<OwnProfileDetails> {
    return this.api.request(
      {
        path: '/v1/me/profile-details',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeOwnProfileDetails,
      },
      { cancellation },
    );
  }
  update(
    patch: ProfileDetailsPatch,
    cancellation: Cancellation,
  ): Promise<OwnProfileDetails> {
    validateProfileDetailsPatch(patch);
    return this.api.request(
      {
        path: '/v1/me/profile-details',
        method: 'PATCH',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeOwnProfileDetails,
      },
      { body: { ...patch }, cancellation },
    );
  }
  async public(
    profileId: string,
    cancellation: Cancellation,
  ): Promise<PublicProfileDetails> {
    if (!isUuid(profileId))
      throw new ClientError('business', 'Invalid public profile');
    const result = await this.api.request(
      {
        path: `/v1/profiles/${profileId}/details`,
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePublicProfileDetails,
      },
      { cancellation },
    );
    if (result.profileId !== profileId)
      throw new ClientError('protocol', 'Public profile details mismatch');
    return result;
  }
}
