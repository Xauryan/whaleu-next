/** Optional feature diagnostic transport. Shares the caller's existing ApiClient,
 * session refresh and cancellation, without a new session or background owner. */
import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import { isCategory, type Category } from './contract';
import { isUuid } from '../profile/contract';
import { decodeReadingCapability } from './reading-readiness-contract';
export class ReadingReadinessGateway {
  constructor(private readonly api: ApiClient) {}
  async readingCapabilities(
    spaceId: string,
    category: Category,
    authorMode: 'named' | 'anonymous',
    cancel: Cancellation,
  ) {
    if (
      !isUuid(spaceId) ||
      !isCategory(category) ||
      !['named', 'anonymous'].includes(authorMode)
    )
      throw new ClientError('protocol', 'Invalid reading capability scope');
    const value = await this.api.request(
      {
        path: '/v2/community/text-source-capabilities',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeReadingCapability,
      },
      { query: { spaceId, category, authorMode }, cancellation: cancel },
    );
    if (value.authorMode !== authorMode)
      throw new ClientError('protocol', 'Mismatched reading capability scope');
    return value;
  }
}
