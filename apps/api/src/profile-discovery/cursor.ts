import { createHash } from 'node:crypto';
import type { SessionView } from '../identity/contracts.js';
import type { PublicContentKind } from '../community/profile-discovery.facade.js';
import type { ProfileContentQuery } from './contracts.js';

export function profileCursorScope(
  profileId: string,
  kind: PublicContentKind,
  query: ProfileContentQuery,
  session: SessionView | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'public-profile-discovery-v2',
        profileId,
        kind,
        query.tradingSubtype ?? null,
        query.limit,
        session?.accountId ?? null,
        session?.sessionId ?? null,
      ]),
    )
    .digest('hex');
}
