import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingsAccessService } from '../access.js';
import { RatingEffectsCapture } from '../effects/capture.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { RatingSubscriptionTargetFacade } from './target.facade.js';
import { RatingSubscriptionsRepository } from './repository.js';
import type { SubscriptionRow } from './repository.js';
import { RatingSubscriptionRequests } from './requests.js';
import {
  ratingSubscriptionStateSchema,
  ratingSubscriptionQueryResponseSchema,
} from './contracts.js';
import type {
  SetRatingSubscription,
  RatingSubscriptionQuery,
} from './contracts.js';
const view = (targetId: string, row: SubscriptionRow | null) =>
  ratingSubscriptionStateSchema.parse(
    row
      ? {
          status: 'known',
          targetId,
          subscribed: row.subscribed,
          count: row.count,
          revision: row.revision,
          allowedActions: { setSubscription: true },
        }
      : { status: 'unavailable' },
  );
@Injectable()
export class RatingSubscriptionsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingSubscriptionTargetFacade)
    private readonly targets: RatingSubscriptionTargetFacade,
    @Inject(RatingSubscriptionsRepository)
    private readonly records: RatingSubscriptionsRepository,
    @Inject(RatingSubscriptionRequests)
    private readonly requests: RatingSubscriptionRequests,
    @Inject(RatingEffectsCapture)
    private readonly effects: RatingEffectsCapture,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
  ) {}
  state(token: string, id: string, regionId: string | null) {
    return this.db.transaction(
      async (tx) => {
        const c = await this.targets.resolve(token, id, regionId, tx),
          state = await this.records.state(id, c.actor, tx);
        this.records.retain(id, state, c.actor, tx);
        await this.access.recheck(token, tx);
        return view(id, state);
      },
      { isolationLevel: 'read committed' },
    );
  }
  query(token: string, command: RatingSubscriptionQuery) {
    return this.db.transaction(
      async (tx) => {
        const c = await this.targets.scope(token, command.regionId, tx);
        const states = new Map<string, ReturnType<typeof view>>();
        // Deterministic parent order, one actor/scope transaction, at most twenty facts.
        for (const item of [...command.targets].sort((a, b) =>
          a.targetId.localeCompare(b.targetId),
        )) {
          try {
            const target = await this.targets.target(
              c.catalog,
              item.targetId,
              tx,
            );
            if (target.row.revision !== item.expectedTargetRevision) {
              states.set(item.targetId, { status: 'unavailable' });
              continue;
            }
            const state = await this.records.state(item.targetId, c.actor, tx);
            this.records.retain(item.targetId, state, c.actor, tx);
            states.set(item.targetId, view(item.targetId, state));
          } catch (error) {
            if (
              error instanceof ApplicationError &&
              error.code === 'RATING_NOT_FOUND'
            ) {
              states.set(item.targetId, { status: 'unavailable' });
              continue;
            }
            throw error;
          }
        }
        await this.access.recheck(token, tx);
        return ratingSubscriptionQueryResponseSchema.parse({
          items: command.targets.map((i) => ({
            targetId: i.targetId,
            state: states.get(i.targetId)!,
          })),
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  set(token: string, id: string, command: SetRatingSubscription) {
    return this.requests.execute(
      token,
      command.clientRequestId,
      'set_target_subscription',
      { targetId: id, ...command },
      async (actor, tx) => {
        const c = await this.targets.resolve(
          token,
          id,
          command.regionId,
          tx,
          true,
        );
        if (c.target.row.revision !== command.expectedTargetRevision)
          throw new ApplicationError('RATING_REVISION_CONFLICT');
        const { transitionId, ...result } = await this.records.set(
          id,
          actor,
          command.clientRequestId,
          command.expectedSubscriptionRevision,
          command.subscribed,
          tx,
        );
        if (transitionId) {
          if (result.subscribed) await this.authors.prepare(actor, tx);
          const transition = (
            await tx.query<{
              id: string;
              target_id: string;
              account_id: string;
              request_id: string;
              delta: 1 | -1;
              target_order: string;
              occurred_at: string;
            }>(
              `SELECT id,target_id,account_id,request_id,delta,target_order::text,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at FROM whaleu_ratings.subscription_transitions WHERE id=$1`,
              [transitionId],
            )
          ).rows[0]!;
          await this.effects.captureSubscription(tx, transition);
        }
        return { ...result, targetId: id };
      },
    );
  }
  receipt(token: string, id: string) {
    return this.requests.receipt(token, id);
  }
}
