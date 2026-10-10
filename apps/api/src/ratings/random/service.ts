import { Inject, Injectable } from '@nestjs/common';
import { ZodError } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { CampusRatingRandomScopeFacade } from '../../campus/rating-random-scope.facade.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import type { AnyRatingTargetDefinitionDescriptor } from '../../community/content-review/rating-target-definition-contracts.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository, type RatingCatalog } from '../repository.js';
import { sameRatingTargetDefinition } from '../target-definition.repository.js';
import { qualifyCurrentRatingTarget } from '../target-projection.facade.js';
import { ratingTargetSchema } from '../contracts.js';
import {
  ratingRandomResponseSchema,
  type RatingRandomQuery,
} from './contracts.js';
import { RatingCompletePoolRepository } from './complete-pool.repository.js';
import { RatingRandomDraw } from './draw.js';
import { matchesRatingMinimum } from './selection.js';

@Injectable()
export class RatingRandomService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingCompletePoolRepository)
    private readonly pool: RatingCompletePoolRepository,
    @Inject(CampusRatingRandomScopeFacade)
    private readonly campus: CampusRatingRandomScopeFacade,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(RatingRandomDraw) private readonly draw: RatingRandomDraw,
  ) {}
  async select(token: string, query: RatingRandomQuery) {
    try {
      return await this.database.transaction(
        async (tx) => {
          this.records.enable(tx);
          const global = await this.access.resolve(token, null, tx, {
            phone: true,
          });
          const pool = await this.pool.capture(tx);
          const review = await this.review.begin(tx);
          const regionIds = query.campusId
            ? (await this.campus.resolve(query.campusId, tx)).regionIds
            : [];
          // Every requested region is authorized. Missing scope cannot silently
          // narrow the user's institution-wide selection to a convenient subset.
          for (const regionId of regionIds)
            await this.access.resolveAccount(
              global.session.accountId,
              regionId,
              tx,
              { phone: true },
            );
          await this.safety.navigation(tx);
          await this.pool.prepare(
            pool,
            [null, ...regionIds],
            query.categoryId,
            tx,
          );
          const eligible = new Map<
            string,
            {
              id: string;
              revision: string;
              definition: AnyRatingTargetDefinitionDescriptor;
              catalog: RatingCatalog;
            }
          >();
          const observed = new Map<
            string,
            {
              revision: string;
              definition: AnyRatingTargetDefinitionDescriptor;
            }
          >();
          while (true) {
            const batch = await this.pool.next(pool, tx);
            const decisions = await this.review.validateBatch(
              batch,
              review,
              tx,
            );
            if (decisions.length !== batch.items.length)
              throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
            for (let i = 0; i < batch.items.length; i++) {
              const candidate = batch.items[i]!;
              const previous = observed.get(candidate.row.id);
              if (
                previous &&
                (previous.revision !== candidate.row.revision ||
                  !sameRatingTargetDefinition(
                    previous.definition,
                    candidate.definition,
                  ))
              )
                throw new ApplicationError('RATING_UNAVAILABLE');
              if (!previous)
                observed.set(candidate.row.id, {
                  revision: candidate.row.revision,
                  definition: candidate.definition,
                });
              if (decisions[i] === 'deny') continue;
              if (decisions[i] !== 'allow')
                throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
              if (
                !matchesRatingMinimum(candidate.summary, query.minimumAverage)
              )
                continue;
              const existing = eligible.get(candidate.row.id);
              if (!existing)
                eligible.set(candidate.row.id, {
                  id: candidate.row.id,
                  revision: candidate.row.revision,
                  definition: candidate.definition,
                  catalog: candidate.catalog,
                });
            }
            if (batch.done) break;
          }
          // Owner-authenticated EOF and unchanged complete epochs precede the
          // draw. The transaction's final NOWAIT proofs cover every candidate,
          // including rejected/unselected candidates, phantoms and threshold ABA.
          await this.pool.complete(pool, tx);
          await this.review.complete(review, tx);
          const candidates = [...eligible.values()].sort((a, b) =>
            a.id.localeCompare(b.id),
          );
          const index = candidates.length
            ? this.draw.index(candidates.length)
            : null;
          if (
            index !== null &&
            (!Number.isInteger(index) ||
              index < 0 ||
              index >= candidates.length)
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
          const chosen = index === null ? null : candidates[index]!;
          let item = null;
          if (chosen) {
            // Retain the mature per-item detail proof for the selected item only.
            const catalog = await this.records.catalog(
              chosen.catalog.regionId,
              tx,
            );
            if (catalog.id !== chosen.catalog.id)
              throw new ApplicationError('RATING_UNAVAILABLE');
            const { row } = await qualifyCurrentRatingTarget(
              this.records,
              this.review,
              catalog,
              chosen.id,
              tx,
            ).catch((error: unknown) => {
              // This item was in the complete admitted universe. Disappearance
              // is a changed selection, never a new empty/partial success.
              if (
                error instanceof ApplicationError &&
                error.code === 'RATING_NOT_FOUND'
              )
                throw new ApplicationError('RATING_UNAVAILABLE');
              throw error;
            });
            if (
              row.revision !== chosen.revision ||
              !sameRatingTargetDefinition(row.definition, chosen.definition)
            )
              throw new ApplicationError('RATING_UNAVAILABLE');
            const summary = await this.records.summary(row.id, tx);
            if (!matchesRatingMinimum(summary, query.minimumAverage))
              throw new ApplicationError('RATING_UNAVAILABLE');
            item = {
              regionId: catalog.regionId,
              summary,
              target: ratingTargetSchema.parse({
                id: row.id,
                categoryId: row.category_id,
                name: row.name,
                description: row.description,
                revision: row.revision,
                allowedActions: {
                  setScore: summary.status === 'known',
                  createComment: true,
                  authorModes: await this.access.authorModes(
                    global.session.accountId,
                    tx,
                  ),
                },
              }),
            };
          }
          await this.access.recheck(token, tx);
          return ratingRandomResponseSchema.parse({
            context: {
              campusId: query.campusId ?? null,
              categoryId: query.categoryId,
              minimumAverage: query.minimumAverage ?? null,
            },
            candidateCount: candidates.length,
            item,
          });
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof ZodError ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['57014', '55P03', '40P01', '40001', '53300'].includes(
            String(error.code),
          ))
      )
        throw new ApplicationError('RATING_UNAVAILABLE');
      throw error;
    }
  }
}
