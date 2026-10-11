import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../community/content-review/contracts.js';
import { ApplicationError } from '../http/application-error.js';
import type { CategoryIconMediaDeliveryPlan } from './category-icon-delivery.js';
import type { CategoryIconMediaReadRequest } from './category-icon-owner-proof.js';
import type { MediaTransactionRunner } from './delivery.js';

/** Trusted Category-only bookkeeping, after the existing owner/Media proof.
 * Neither a hold nor its digest authorizes reading any bytes. */
export interface CategoryIconDeliveryHolds {
  enroll(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
    tx: PoolClient,
  ): Promise<void>;
  requireCurrent(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
    tx: PoolClient,
  ): Promise<void>;
  /** Called only by ExactMediaDeliveryService's physical-quiet notification.
   * Rejecting leaves the durable hold open; elapsed time is never closure. */
  closeQuiet(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
  ): Promise<void>;
}

function identity(
  request: CategoryIconMediaReadRequest,
  plan: CategoryIconMediaDeliveryPlan,
): unknown[] {
  const tokenDigest = createHash('sha256')
    .update(request.contextToken)
    .digest('hex');
  // Retain exact server-owned delivery facts without storing a bearer token.
  const { contextToken: _token, ...safePlan } = plan;
  void _token;
  const planDigest = createHash('sha256')
    .update('whaleu:category-icon-delivery-hold:v1\n')
    .update(canonicalJson({ ...safePlan, contextTokenDigest: tokenDigest }))
    .digest('hex');
  return [
    request.requestId,
    request.categoryId,
    request.appearanceId,
    plan.principal.accountId,
    plan.principal.sessionId,
    request.contextId,
    tokenDigest,
    request.purpose,
    JSON.stringify(plan.qualification),
    plan.bindingId,
    plan.manifestDigest,
    planDigest,
  ];
}

const exactIdentity = `id=$1 AND category_id=$2 AND appearance_id=$3
  AND actor_id=$4 AND session_id=$5 AND context_id=$6
  AND context_token_digest=$7 AND purpose=$8 AND qualification=$9::jsonb
  AND binding_id=$10 AND manifest_digest=$11 AND plan_digest=$12`;

/** Rows are retained permanently; only a confirmed quiet lifecycle may close
 * one. No cleanup timeout or context expiry can substitute for that fact. */
export class PostgresCategoryIconDeliveryHolds implements CategoryIconDeliveryHolds {
  constructor(private readonly database: MediaTransactionRunner) {}

  async enroll(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO whaleu_ratings.category_icon_delivery_holds
        (id,category_id,appearance_id,actor_id,session_id,context_id,
         context_token_digest,purpose,qualification,binding_id,manifest_digest,plan_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12) RETURNING id`,
      identity(request, plan),
    );
    if (result.rows.length !== 1 || result.rows[0]!.id !== request.requestId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }

  async requireCurrent(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM whaleu_ratings.category_icon_delivery_holds
       WHERE ${exactIdentity} AND closed_at IS NULL FOR SHARE`,
      identity(request, plan),
    );
    if (result.rows.length !== 1 || result.rows[0]!.id !== request.requestId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }

  async closeQuiet(
    request: CategoryIconMediaReadRequest,
    plan: CategoryIconMediaDeliveryPlan,
  ): Promise<void> {
    await this.database.transaction(
      async (tx) => {
        const result = await tx.query<{ id: string }>(
          `UPDATE whaleu_ratings.category_icon_delivery_holds
           SET closed_at=clock_timestamp()
           WHERE ${exactIdentity} AND closed_at IS NULL RETURNING id`,
          identity(request, plan),
        );
        if (
          result.rows.length !== 1 ||
          result.rows[0]!.id !== request.requestId
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
      },
      { isolationLevel: 'read committed' },
    );
  }
}
