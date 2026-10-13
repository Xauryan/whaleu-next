import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeExperienceRanking,
  type ExperienceRanking,
} from './ranking-contract';
export interface ExperienceRankingGateway {
  ranking(cancel: Cancellation): Promise<ExperienceRanking>;
}
export class HttpExperienceRankingGateway implements ExperienceRankingGateway {
  constructor(private readonly api: ApiClient) {}
  ranking(cancel: Cancellation): Promise<ExperienceRanking> {
    return this.api.request(
      {
        path: '/v1/experience/ranking',
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeExperienceRanking,
      },
      { query: { limit: 50 }, cancellation: cancel },
    );
  }
}
