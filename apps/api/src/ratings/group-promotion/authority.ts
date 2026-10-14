import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { PoolClient } from 'pg';
import { RatingsAccessService } from '../access.js';
import { CampusRatingScopeFacade } from '../../campus/rating-scope.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import {
  digest,
  type Destination,
  type Program,
  type PromotionPrincipalPort,
} from './contracts.js';
import { retainPromotion } from './proof.js';
@Injectable()
export class RatingPromotionAuthority implements PromotionPrincipalPort {
  constructor(@Inject(ModuleRef) private readonly modules: ModuleRef) {}
  async grant(
    actor: string,
    p: Program,
    action: string,
    kind: 'operator' | 'service',
    tx: PoolClient,
  ) {
    const g = (
      await tx.query<{ id: string; revision: string; until: string }>(
        `SELECT id,revision,valid_until::text until FROM whaleu_ratings.promotion_grants WHERE program_id=$1 AND principal_lineage=$2 AND kind=$3 AND active AND valid_until>clock_timestamp() AND $4=ANY(actions) AND scope_ids @> $5::uuid[] AND (NOT $6::boolean OR allow_default) AND ($4<>'test' OR allow_test) FOR SHARE`,
        [p.id, actor, kind, action, p.scope_ids, p.include_default],
      )
    ).rows[0];
    if (!g) throw new ApplicationError('PROMOTION_FORBIDDEN');
    registerTransactionExactDeadline(tx, g.until, 'PROMOTION_UNAVAILABLE');
    retainPromotion(
      {
        programId: p.id,
        revision: p.revision,
        sourceHash: p.source_hash,
        grantEpoch: p.grant_epoch,
        grantId: g.id,
        grantRevision: g.revision,
      },
      tx,
    );
    return g;
  }
  async current(
    actor: string,
    p: Program,
    action: 'preview' | 'send' | 'test' | 'inspect',
    tx: PoolClient,
  ) {
    const access = await this.modules
      .get(RatingsAccessService, { strict: false })
      .resolveAccount(actor, null, tx, { phone: true });
    const g = await this.grant(actor, p, action, 'operator', tx);
    const scopes = await this.modules
      .get(CampusRatingScopeFacade, { strict: false })
      .requireManagedSet(p.scope_ids, tx);
    return digest([
      actor,
      g.id,
      g.revision,
      access.fingerprint,
      scopes,
      p.grant_epoch,
      p.scope_ids,
      p.include_default,
    ]);
  }
  async service(p: Program, grantId: string, tx: PoolClient) {
    const g = await this.grant(grantId, p, 'send', 'service', tx);
    const scopes = await this.modules
      .get(CampusRatingScopeFacade, { strict: false })
      .requireManagedSet(p.scope_ids, tx);
    return digest([g.id, g.revision, p.grant_epoch, scopes]);
  }
  async receiver(p: Program, d: Destination, tx: PoolClient) {
    if (
      d.account_lineage !== p.account_lineage ||
      (d.audience_kind === 'default_treehole' && !p.include_default) ||
      (d.audience_kind === 'school_treehole' &&
        (!d.school_scope_id || !p.scope_ids.includes(d.school_scope_id)))
    )
      throw new ApplicationError('PROMOTION_UNAVAILABLE');
    const until = (
      await tx.query<{ until: string }>(
        `SELECT valid_until::text until FROM whaleu_ratings.promotion_receivers WHERE id=$1 AND revision=$2`,
        [d.id, d.revision],
      )
    ).rows[0];
    if (!until) throw new ApplicationError('PROMOTION_UNAVAILABLE');
    registerTransactionExactDeadline(tx, until.until, 'PROMOTION_UNAVAILABLE');
    const campus = d.school_scope_id
      ? await this.modules
          .get(CampusRatingScopeFacade, { strict: false })
          .requireManaged(d.school_scope_id, tx)
      : d.audience_kind;
    retainPromotion(
      {
        programId: p.id,
        revision: p.revision,
        sourceHash: p.source_hash,
        grantEpoch: p.grant_epoch,
        destinationId: d.id,
        registryRevision: d.revision,
        enrollmentRevision: d.enrollment_revision,
      },
      tx,
    );
    return digest([d.id, d.revision, d.enrollment_revision, campus]);
  }
}
