import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { prepareRatingGroupPermit } from '../../src/notifications/rating-group/permit.js';
import type { EffectIdentity } from '../../src/ratings/group-promotion/contracts.js';
/** Deterministic unit transport only; production stamps require the real wrapper. */
export async function committedUnitPermitCapsule(
  identity: EffectIdentity,
  authorityDigest: string,
) {
  const tx = {
    query: async () => ({ rows: [] }),
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return inTransaction(pool, async (client) =>
    prepareRatingGroupPermit(client, identity, authorityDigest),
  );
}
