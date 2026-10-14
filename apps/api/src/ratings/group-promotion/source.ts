import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { PoolClient } from 'pg';
import { RatingsRepository } from '../repository.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import {
  digest,
  nativeLocator,
  sourceBindingSchema,
  type Program,
  type PromotionSourcePort,
} from './contracts.js';
import { retainPromotion } from './proof.js';
/** A category read is necessary but insufficient: exact export/mapping policy is
 * separately accepted for this purpose and all audience scopes. */
@Injectable()
export class RatingPromotionSource implements PromotionSourcePort {
  constructor(@Inject(ModuleRef) private readonly modules: ModuleRef) {}
  async current(
    program: Program,
    tx: PoolClient,
    mode: 'normal' | 'test' = 'normal',
  ) {
    const b = sourceBindingSchema.parse(program.source_binding);
    if (
      digest(b) !== program.source_hash ||
      b.systemKey !== program.type ||
      (b.catalogContext.regionId !== null &&
        (program.include_default ||
          program.scope_ids.some((s) => s !== b.catalogContext.regionId)))
    )
      throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
    const accepted = (
      await tx.query<{ public_label: string; until: string }>(
        `SELECT b.public_label,least(b.valid_until,p.valid_until)::text until FROM whaleu_ratings.promotion_source_bindings b JOIN whaleu_ratings.promotion_policy_revisions p ON (p.id,p.revision)=(b.policy_id,b.policy_revision)
   WHERE b.program_id=$1 AND b.binding_hash=$2 AND b.binding=$3::jsonb AND b.enabled AND b.effective_at<=clock_timestamp() AND b.valid_until>clock_timestamp()
   AND b.id=(b.binding->>'locatorMappingId')::uuid AND b.locator_mapping_revision=(b.binding->>'locatorMappingRevision')::uuid AND ($8='normal' OR p.allow_test) AND p.id=$4 AND p.revision=$5 AND p.program_id=b.program_id AND p.enabled AND p.purpose='rating_group_promotion' AND p.source_hash=b.binding_hash AND p.scope_ids @> $6::uuid[] AND (NOT $7::boolean OR p.include_default) AND p.effective_at<=clock_timestamp() AND p.valid_until>clock_timestamp() FOR SHARE OF b,p`,
        [
          program.id,
          program.source_hash,
          b,
          b.exportPolicyId,
          b.exportPolicyRevision,
          program.scope_ids,
          program.include_default,
          mode,
        ],
      )
    ).rows[0];
    if (!accepted) throw new ApplicationError('PROMOTION_UNAVAILABLE');
    const ratings = this.modules.get(RatingsRepository, { strict: false });
    ratings.enable(tx);
    const catalog = await ratings.catalog(b.catalogContext.regionId, tx);
    const category = await ratings.operationalCategory(
      catalog,
      b.categoryId,
      tx,
    );
    if (
      category.revision !== b.categoryRevision ||
      category.system_key !== b.systemKey ||
      category.level !== 1 ||
      category.name !== accepted.public_label ||
      [...category.name].length > 80 ||
      Buffer.byteLength(category.name) > 320
    )
      throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
    registerTransactionExactDeadline(
      tx,
      accepted.until,
      'PROMOTION_UNAVAILABLE',
    );
    retainPromotion(
      {
        programId: program.id,
        revision: program.revision,
        sourceHash: program.source_hash,
        grantEpoch: program.grant_epoch,
      },
      tx,
    );
    return {
      label: category.name,
      locator: nativeLocator(b),
      fingerprint: digest([catalog.id, category, program.source_hash]),
    };
  }
}
