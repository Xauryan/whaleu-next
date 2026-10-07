import type { ApiClient, Endpoint } from '../api/client';
import { cursor, invalid } from '../community/contract';
import {
  isTradingSubtype,
  type TradingSubtype,
} from '../community/trading-contract';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from './contract';
import {
  decodeLikedList,
  decodeOwnProfileRef,
  decodeProfileList,
  decodePublicProfile,
  type LikedList,
  type OwnProfileRef,
  type ProfileList,
  type PublicProfile,
} from './discovery-contract';
export type ProfileListKind = 'posts' | 'trading';
export interface DiscoveryGateway {
  profile(profileId: string, cancel: Cancellation): Promise<PublicProfile>;
  list(
    profileId: string,
    kind: ProfileListKind,
    after: string | null,
    cancel: Cancellation,
    subtype?: TradingSubtype,
    limit?: number,
  ): Promise<ProfileList>;
  ownProfileRef(cancel: Cancellation): Promise<OwnProfileRef>;
  liked(
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<LikedList>;
}
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
  own = false,
): Endpoint<T> => ({
  path,
  decode,
  method: 'GET',
  authentication: own ? 'required' : 'optional',
  authReplay: 'once',
  successStatus: 200,
});
function paging(after: string | null, limit: number): void {
  if (!cursor(after) || !Number.isInteger(limit) || limit < 1 || limit > 50)
    invalid();
}
export class HttpDiscoveryGateway implements DiscoveryGateway {
  constructor(private readonly api: ApiClient) {}
  async profile(
    profileId: string,
    cancel: Cancellation,
  ): Promise<PublicProfile> {
    if (!isUuid(profileId)) invalid();
    const result = await this.api.request(
      endpoint(`/v1/profiles/${profileId}`, decodePublicProfile),
      { cancellation: cancel },
    );
    if (result.profileId !== profileId) invalid();
    return result;
  }
  async list(
    profileId: string,
    kind: ProfileListKind,
    after: string | null,
    cancel: Cancellation,
    subtype?: TradingSubtype,
    limit = 20,
  ): Promise<ProfileList> {
    paging(after, limit);
    if (
      !isUuid(profileId) ||
      !['posts', 'trading'].includes(kind) ||
      (subtype !== undefined &&
        (kind !== 'trading' || !isTradingSubtype(subtype)))
    )
      invalid();
    const result = await this.api.request(
      endpoint(`/v1/profiles/${profileId}/${kind}`, decodeProfileList),
      {
        query: {
          limit,
          ...(after ? { cursor: after } : {}),
          ...(subtype ? { tradingSubtype: subtype } : {}),
        },
        cancellation: cancel,
      },
    );
    if (result.profileId !== profileId) invalid();
    if (
      'items' in result &&
      (result.items.length > limit ||
        result.items.some((item) =>
          kind === 'posts'
            ? item.category === 'trading'
            : !item.trading ||
              item.trading.resolution !== 'open' ||
              (subtype !== undefined &&
                (item.trading.subtype.kind !== 'known' ||
                  item.trading.subtype.key !== subtype)),
        ))
    )
      invalid();
    return result;
  }
  ownProfileRef(cancel: Cancellation): Promise<OwnProfileRef> {
    return this.api.request(
      endpoint('/v1/me/public-profile-ref', decodeOwnProfileRef, true),
      { cancellation: cancel },
    );
  }
  async liked(
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<LikedList> {
    paging(after, limit);
    const result = await this.api.request(
      endpoint('/v1/me/community/liked', decodeLikedList, true),
      {
        query: { limit, ...(after ? { cursor: after } : {}) },
        cancellation: cancel,
      },
    );
    if (result.items.length > limit) invalid();
    return result;
  }
}
