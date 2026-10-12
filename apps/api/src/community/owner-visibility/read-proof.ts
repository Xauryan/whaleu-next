import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { VisibilityPurpose } from '../community-policy.js';

interface VisibilityFact {
  postId: string;
  ownerHidden: boolean;
  version: number;
  requestId: string | null;
  xmin: string | null;
}
const projection = `p.id AS "postId",COALESCE(v.owner_hidden,false) AS "ownerHidden",
  COALESCE(v.version,0)::integer AS version,v.request_id AS "requestId",v.xmin::text AS xmin`;
const proof: RequiredTransactionProof<VisibilityFact> = {
  maximumFacts: 2048,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      // Includes absence: no first overlay insertion can pass the final fence.
      await read.query(
        'LOCK TABLE whaleu_community.post_owner_visibility IN SHARE MODE NOWAIT',
      );
      const rows = (
        await read.query<VisibilityFact>(
          `SELECT ${projection} FROM whaleu_community.posts p LEFT JOIN whaleu_community.post_owner_visibility v ON v.post_id=p.id WHERE p.id=ANY($1::uuid[])`,
          [facts.map((fact) => fact.postId)],
        )
      ).rows;
      const current = new Map(rows.map((row) => [row.postId, row]));
      for (const fact of facts) {
        const row = current.get(fact.postId);
        if (
          !row ||
          row.ownerHidden !== fact.ownerHidden ||
          row.version !== fact.version ||
          row.requestId !== fact.requestId ||
          row.xmin !== fact.xmin
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      }
    }),
};

/** Independent owner state; never changes immutable approved publication bytes.
 * Call only after the canonical post has been locked and its owner established.
 * Owner-private detail is deliberately unavailable to public projections. */
export async function readOwnerPostVisibility(
  postId: string,
  tx: PoolClient,
): Promise<Readonly<VisibilityFact>> {
  enableRequiredTransactionProof(tx, proof);
  const row = (
    await tx.query<VisibilityFact>(
      `SELECT ${projection} FROM whaleu_community.posts p LEFT JOIN whaleu_community.post_owner_visibility v ON v.post_id=p.id WHERE p.id=$1`,
      [postId],
    )
  ).rows[0];
  if (
    !row ||
    row.postId !== postId ||
    typeof row.ownerHidden !== 'boolean' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    row.version > 2147483647 ||
    (row.version === 0
      ? row.ownerHidden || row.requestId !== null || row.xmin !== null
      : typeof row.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          row.requestId,
        ) ||
        typeof row.xmin !== 'string' ||
        !/^\d+$/.test(row.xmin))
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  registerRequiredTransactionFact(
    tx,
    proof,
    JSON.stringify(row),
    Object.freeze(row),
  );
  return row;
}

export async function ownerPostVisibilityAllowed(
  postId: string,
  owner: string,
  viewer: string | null,
  purpose: VisibilityPurpose,
  tx: PoolClient,
): Promise<boolean> {
  const row = await readOwnerPostVisibility(postId, tx);
  return (
    !row.ownerHidden ||
    ((purpose === 'direct_post' || purpose === 'detail_projection') &&
      viewer === owner)
  );
}
