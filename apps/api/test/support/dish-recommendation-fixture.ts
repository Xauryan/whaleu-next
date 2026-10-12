/** Synthetic provenance only. No runtime issuer, seed, import or provider. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { windowRatingFixture } from './window-rating-fixture.js';
import type { DishCommand } from '../../src/ratings/windows/dishes/contracts.js';
import {
  dishReviewDigest,
  dishIdentity,
} from '../../src/community/content-review/dish-review.facade.js';
export async function dishHistory(
  pool: Pool,
  windowId: string,
  kind: 'population' | 'membership',
  coverage: 'accepted_empty' | 'unknown' = 'accepted_empty',
  until = new Date(Date.now() + 3600000),
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_ratings.dish_history_assertions(id,window_id,kind,coverage,source_reference,policy_reference,valid_until) VALUES($1,$2,$3,$4,'synthetic:independent-dish-reconciliation','synthetic:accepted-empty-only',$5)",
      [id, windowId, kind, coverage, until],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.dish_history_heads(window_id,kind,assertion_id) VALUES($1,$2,$3) ON CONFLICT(window_id,kind) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
      [windowId, kind, id],
    );
    return id;
  });
}
export async function reviewDish(
  pool: Pool,
  actorId: string,
  windowId: string,
  command: DishCommand,
  verdict: 'allow' | 'reject' = 'allow',
  options: {
    consumeUntil?: Date;
    visibilityUntil?: Date;
    issuedAt?: Date;
  } = {},
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID(),
      policy = randomUUID(),
      envelope = {
        version: 1 as const,
        purpose: 'window.dish.recommend.v1' as const,
        actorId,
        requestId: command.clientRequestId,
        windowId,
        catalogRevision: command.expectedCatalogRevision,
        windowRevision: command.expectedWindowRevision,
        dishName: command.dishName,
        dishIdentity: dishIdentity(command.dishName),
      };
    await tx.query(
      "INSERT INTO whaleu_community.dish_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:local-window-dish-review','synthetic:no-live-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours')",
      [policy],
    );
    await tx.query(
      'INSERT INTO whaleu_community.dish_review_decisions(id,actor_id,request_id,window_id,catalog_id,window_revision,dish_name,policy_id,verdict,digest,issued_at,consume_until,visibility_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,clock_timestamp()),$12,$13)',
      [
        id,
        actorId,
        command.clientRequestId,
        windowId,
        command.expectedCatalogRevision,
        command.expectedWindowRevision,
        command.dishName,
        policy,
        verdict,
        dishReviewDigest(envelope),
        options.issuedAt ?? null,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        options.visibilityUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.dish_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'active') ON CONFLICT(actor_id,request_id) DO UPDATE SET decision_id=EXCLUDED.decision_id,state='active'",
      [actorId, command.clientRequestId, id],
    );
    return id;
  });
}
export async function revokeDishReview(pool: Pool, decisionId: string) {
  await pool.query(
    "UPDATE whaleu_community.dish_review_heads SET state='revoked' WHERE decision_id=$1",
    [decisionId],
  );
}
export async function dishRecommendationFixture() {
  const f = await windowRatingFixture();
  const acceptDishes = async (ids: string[]) => {
    for (const id of ids) {
      await dishHistory(f.pool, id, 'population');
      await dishHistory(f.pool, id, 'membership');
    }
  };
  const recommend = (
    catalog: string,
    window: { revision: string },
    dishName = 'Synthetic',
    expectedMembershipRevision: string | null = null,
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedWindowRevision: window.revision,
    expectedMembershipRevision,
    dishName,
  });
  return { ...f, acceptDishes, recommend };
}
