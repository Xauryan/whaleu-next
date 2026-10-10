import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalEqual } from '../../community/content-review/contracts.js';
import { ratingScopedIntentSchema } from '../scoped/contracts.js';
import {
  ratingScopedCommandHash,
  ratingScopedOperations,
} from '../scoped/protocol-registry.js';
import { RatingScopedContextService } from '../scoped/context.service.js';
import { RatingScopedRepository } from '../scoped/repository.js';
import { RatingScopedProjection } from '../scoped/projection.js';

interface Target {
  regionId: string | null;
  targetId: string;
  rootId: string;
  replyId: string | null;
}
/** Captured effects remain the sole fanout identities. This only changes their
 * current recipient qualification, using immutable request provenance and the
 * recipient's own explicit current Campus identity. */
@Injectable()
export class RatingScopedNoticeRecipientFacade {
  constructor(
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
    @Inject(RatingScopedProjection)
    private readonly projection: RatingScopedProjection,
  ) {}
  async qualify(
    eventId: string,
    accountId: string,
    target: Target,
    tx: PoolClient,
  ): Promise<boolean> {
    const source = (
      await tx.query<{
        actor_account_id: string;
        request_id: string;
        target_id: string;
        root_id: string;
        reply_id: string | null;
        region_id: string | null;
        operation: string;
        intent_hash: string;
      }>(
        `SELECT e.actor_account_id,e.request_id,e.target_id,e.root_id,e.reply_id,e.region_id,r.operation,r.intent_hash,
      e.id
      FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.requests r ON (r.account_id,r.request_id)=(e.actor_account_id,e.request_id)
      WHERE e.id=$1`,
        [eventId],
      )
    ).rows[0];
    if (
      !source ||
      !canonicalEqual(
        {
          regionId: source.region_id,
          targetId: source.target_id,
          rootId: source.root_id,
          replyId: source.reply_id,
        },
        target,
      )
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    if (
      !ratingScopedOperations.some(
        (operation) => operation === source.operation,
      )
    )
      return false;
    const preparation = (
      await tx.query<{
        intent: unknown;
        context_id: string;
        operation: string;
        cause: boolean;
      }>(
        `SELECT p.intent,p.context_id,p.operation,EXISTS(SELECT 1 FROM whaleu_ratings.scoped_command_causes c WHERE c.account_id=p.account_id AND c.request_id=p.request_id AND c.cause_kind='execution' AND c.artifact_id=p.context_id AND c.artifact_revision=p.target_revision) cause
       FROM whaleu_ratings.scoped_command_preparations p WHERE p.account_id=$1 AND p.request_id=$2`,
        [source.actor_account_id, source.request_id],
      )
    ).rows[0];
    const parsed = ratingScopedIntentSchema.safeParse(preparation?.intent);
    if (
      !parsed.success ||
      !preparation?.cause ||
      source.operation !== preparation.operation ||
      parsed.data.operation !== source.operation ||
      ratingScopedCommandHash(parsed.data) !== source.intent_hash ||
      parsed.data.payload.clientRequestId !== source.request_id ||
      parsed.data.context.id !== preparation.context_id ||
      !('targetId' in parsed.data.payload) ||
      parsed.data.payload.targetId !== target.targetId
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    try {
      const scope = await this.contexts.resolveRecipient(
        accountId,
        parsed.data.context.selector,
        tx,
      );
      this.scoped.enable(tx);
      const current = await this.scoped.target(scope, target.targetId, tx);
      await this.projection.qualifyTarget(current.row, tx);
      if (current.row.region_id !== target.regionId)
        throw new ApplicationError('RATING_UNAVAILABLE');
      await this.scoped.retainAfter(scope, tx);
      return true;
    } catch (error) {
      // This code represents missing/changed scoped source or protocol, never an
      // authoritative recipient deny. Keep the captured work retryable.
      if (
        error instanceof ApplicationError &&
        error.code === 'RATING_SCOPE_UNAVAILABLE'
      )
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
}
