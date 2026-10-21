import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { decodeOwnProfileStats, type OwnProfileStats } from './stats-contract';

export interface ProfileStatsGateway {
  own(cancel: Cancellation): Promise<OwnProfileStats>;
}
export class HttpProfileStatsGateway implements ProfileStatsGateway {
  constructor(private readonly api: ApiClient) {}
  own(cancellation: Cancellation): Promise<OwnProfileStats> {
    return this.api.request(
      {
        path: '/v1/me/profile-stats',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeOwnProfileStats,
      },
      { cancellation },
    );
  }
}
