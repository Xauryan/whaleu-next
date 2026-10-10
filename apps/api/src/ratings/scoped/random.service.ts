import { ratingTargetCoverContextSchema } from './target-cover-contracts.js';
import { currentRatingTargetCoverDescriptor } from '../target-cover-current.js';
import { ratingsMediaDescriptorSchema } from '../../media/contracts-ratings.js';
import { requireTargetCoverRead } from './target-cover-capability.js';
import { Inject, Injectable } from '@nestjs/common';
import { z, ZodError } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalEqual } from '../../community/content-review/contracts.js';
import { canonicalAnyRatingTargetDefinition } from '../../community/content-review/rating-target-definition-contracts.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository } from '../repository.js';
import { ratingSummarySchema, ratingTargetSchema } from '../contracts.js';
import { RatingRandomDraw } from '../random/draw.js';
import { matchesRatingMinimum } from '../random/selection.js';
import {
  ratingMinimumAverageSchema,
  ratingRandomQuerySchema,
} from '../random/contracts.js';
import { RatingScopedContextService } from './context.service.js';
import { RatingScopedRepository } from './repository.js';
import { RatingScopedProjection } from './projection.js';
import {
  ratingRandomCandidateSelectorSchema,
  ratingScopedLocatorSchema,
  ratingScopedReadQuerySchema,
  scopedId,
  ratingScopedScopeKey,
  type RatingNavigationSelector,
} from './contracts.js';
import {
  RATING_SCOPED_POOL_TARGET_LIMIT,
  RATING_SCOPED_POOL_PATH_LIMIT,
} from './constants.js';

export const ratingScopedRandomQuerySchema = ratingScopedReadQuerySchema.extend(
  {
    categoryId: scopedId,
    minimumAverage: ratingRandomQuerySchema.shape.minimumAverage,
  },
);
export type RatingScopedRandomQuery = z.infer<
  typeof ratingScopedRandomQuerySchema
>;
export const ratingScopedRandomResponseSchema = z
  .strictObject({
    context: z.strictObject({
      contextId: scopedId,
      selector: ratingRandomCandidateSelectorSchema,
      protocolGeneration: scopedId,
      categoryId: scopedId,
      minimumAverage: ratingMinimumAverageSchema.nullable(),
    }),
    candidateCount: z
      .number()
      .int()
      .nonnegative()
      .max(RATING_SCOPED_POOL_TARGET_LIMIT),
    item: z
      .strictObject({
        locator: ratingScopedLocatorSchema,
        target: ratingTargetSchema,
        summary: ratingSummarySchema,
      })
      .nullable(),
  })
  .superRefine((value, context) => {
    const item = value.item;
    if (
      (value.candidateCount === 0) !== (item === null) ||
      (item &&
        (item.locator.targetId !== item.target.id ||
          item.locator.rootId !== null ||
          item.locator.replyId !== null ||
          (value.context.selector.kind === 'global' &&
            item.locator.selector.kind !== 'global') ||
          item.target.allowedActions.setScore !==
            (item.summary.status === 'known')))
    )
      context.addIssue({
        code: 'custom',
        message: 'Exact scoped random selection required',
      });
    if (
      item &&
      value.context.minimumAverage !== null &&
      (item.summary.status !== 'known' ||
        !matchesRatingMinimum(item.summary, value.context.minimumAverage))
    )
      context.addIssue({
        code: 'custom',
        message: 'Selected target must meet the exact threshold',
      });
  });
/** Display path tie-breaking does not affect uniform sampling of distinct target IDs. */
export function compareRatingScopedRandomLocators(
  a: RatingNavigationSelector,
  b: RatingNavigationSelector,
  anchorCampusId: string | null,
): number {
  const rank = (selector: RatingNavigationSelector) =>
    selector.kind === 'global'
      ? 2
      : selector.campusId === anchorCampusId
        ? 0
        : 1;
  return (
    rank(a) - rank(b) ||
    ratingScopedScopeKey(a).localeCompare(ratingScopedScopeKey(b))
  );
}
type PoolPath = Awaited<
  ReturnType<RatingScopedRepository['nextPool']>
>['items'][number];
function unavailable(): never {
  throw new ApplicationError('RATING_UNAVAILABLE');
}
export const ratingTargetCoverRandomResponseSchema = z
  .strictObject({
    ...ratingScopedRandomResponseSchema.shape,
    item: z
      .strictObject({
        ...ratingScopedRandomResponseSchema.shape.item.unwrap().shape,
        cover: ratingsMediaDescriptorSchema.nullable(),
        coverContext: ratingTargetCoverContextSchema,
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    const { item, ...rest } = value;
    const old = ratingScopedRandomResponseSchema.safeParse({
      ...rest,
      item: item
        ? { locator: item.locator, target: item.target, summary: item.summary }
        : null,
    });
    if (
      !old.success ||
      (item &&
        (!canonicalEqual(item.coverContext.selector, item.locator.selector) ||
          item.coverContext.protocolGeneration !==
            item.locator.protocolGeneration ||
          item.coverContext.purpose !== 'read' ||
          item.coverContext.mode !== 'public' ||
          (item.cover && item.cover.targetId !== item.target.id) ||
          (item.cover &&
            (item.cover.contextId !== item.coverContext.id ||
              item.cover.contextToken !== item.coverContext.token))))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid exact covered random result',
      });
  });
function observation(path: PoolPath) {
  const definition = canonicalAnyRatingTargetDefinition(path.definition),
    row = path.row,
    envelope = definition.envelope;
  if (
    path.id !== row.id ||
    row.id !== definition.targetId ||
    row.category_id !== envelope.categoryId ||
    row.creator_id !== envelope.accountId ||
    row.name !== envelope.name ||
    row.description !== envelope.description ||
    row.region_id !==
      (envelope.version === 5 || envelope.version === 6
        ? envelope.targetOrigin.regionId
        : envelope.scope.regionId) ||
    !canonicalEqual(row.definition, definition)
  )
    unavailable();
  return {
    revision: row.revision,
    definition,
    categoryId: row.category_id,
    creatorId: row.creator_id,
    regionId: row.region_id,
    name: row.name,
    description: row.description,
    summary: ratingSummarySchema.parse(path.summary),
  };
}
/** One complete Ratings-owned scan; target identity, Review, summary and entropy retain their existing owners. */
@Injectable()
export class RatingScopedRandomService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(RatingScopedProjection)
    private readonly projection: RatingScopedProjection,
    @Inject(RatingRandomDraw) private readonly draw: RatingRandomDraw,
  ) {}
  async select(
    token: string,
    input: RatingScopedRandomQuery,
    protocolVersion: 2 | 3 = 2,
  ) {
    const query = ratingScopedRandomQuerySchema.parse(input);
    try {
      return await this.database.transaction(
        async (tx) => {
          this.records.enable(tx);
          this.scoped.enable(tx);
          const random = await this.contexts.resolveRandom(
            token,
            query,
            tx,
            protocolVersion,
          );
          if (
            random.context.purpose !== 'random' ||
            random.context.mode !== 'public'
          )
            unavailable();
          const selector = ratingRandomCandidateSelectorSchema.parse(
              random.context.selector,
            ),
            anchor =
              selector.kind === 'institution_with_global'
                ? selector.anchorCampusId
                : null;
          const declared = new Set(random.scopes),
            expectedKeys = random.scopes.map((scope) =>
              ratingScopedScopeKey(scope.selector),
            );
          if (
            declared.size !== random.scopes.length ||
            new Set(expectedKeys).size !== expectedKeys.length ||
            !expectedKeys.includes('global') ||
            (anchor === null
              ? expectedKeys.length !== 1
              : !expectedKeys.includes(`campus:${anchor}`))
          )
            unavailable();
          const pool = await this.scoped.beginPool(
            random,
            query.categoryId,
            tx,
          );
          await this.safety.navigation(tx);
          const seenPaths = new Set<string>(),
            observed = new Map<string, ReturnType<typeof observation>>(),
            eligible = new Map<string, PoolPath>();
          let done = false;
          while (!done) {
            const batch = await this.scoped.nextPool(pool, tx);
            if (batch.items.length > 128) unavailable();
            const decisions = await this.review.currentDefinitionBatch(
              batch.items.map((candidate) => candidate.definition),
              tx,
            );
            if (decisions.length !== batch.items.length)
              throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
            for (const candidate of batch.items)
              requireTargetCoverRead(candidate.scope, candidate.definition);
            for (let index = 0; index < batch.items.length; index++) {
              const candidate = batch.items[index]!,
                scopeKey = ratingScopedScopeKey(candidate.scope.selector),
                key = `${scopeKey}:${candidate.id}`;
              if (
                !declared.has(candidate.scope) ||
                seenPaths.has(key) ||
                (candidate.authorized && !candidate.scope.authorized)
              )
                unavailable();
              seenPaths.add(key);
              if (seenPaths.size > RATING_SCOPED_POOL_PATH_LIMIT) unavailable();
              const current = observation(candidate),
                previous = observed.get(candidate.id);
              if (previous && !canonicalEqual(previous, current)) unavailable();
              if (!previous) observed.set(candidate.id, current);
              if (observed.size > RATING_SCOPED_POOL_TARGET_LIMIT)
                unavailable();
              const decision = decisions[index]!;
              // A denied path cannot hide unknown Review or inconsistent target identity on another path.
              if (decision.kind !== 'allow' && decision.kind !== 'deny')
                throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
              if (
                !candidate.authorized ||
                decision.kind === 'deny' ||
                !matchesRatingMinimum(candidate.summary, query.minimumAverage)
              )
                continue;
              const existing = eligible.get(candidate.id);
              if (
                !existing ||
                compareRatingScopedRandomLocators(
                  candidate.scope.selector,
                  existing.scope.selector,
                  anchor,
                ) < 0
              )
                eligible.set(candidate.id, candidate);
            }
            done = batch.done;
          }
          const completion = await this.scoped.completePool(pool, tx);
          if (
            completion.pathCount !== seenPaths.size ||
            completion.targetCount !== observed.size
          )
            unavailable();
          if (!completion.categoryFound)
            throw new ApplicationError('RATING_NOT_FOUND');
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
            unavailable();
          const selected = index === null ? null : candidates[index]!;
          let item = null;
          let cover: ReturnType<typeof currentRatingTargetCoverDescriptor> =
            null;
          let coverContext: z.infer<
            typeof ratingTargetCoverContextSchema
          > | null = null;
          if (selected) {
            const current = await this.scoped
              .target(selected.scope, selected.id, tx)
              .catch((error: unknown) => {
                if (
                  error instanceof ApplicationError &&
                  error.code === 'RATING_NOT_FOUND'
                )
                  unavailable();
                throw error;
              });
            const after = observation({
              ...selected,
              row: current.row,
              definition: current.row.definition,
            });
            if (!canonicalEqual(observed.get(selected.id), after))
              unavailable();
            await this.projection
              .qualifyTarget(current.row, tx)
              .catch((error: unknown) => {
                if (
                  error instanceof ApplicationError &&
                  error.code === 'RATING_NOT_FOUND'
                )
                  unavailable();
                throw error;
              });
            const summary = await this.records.summary(selected.id, tx);
            if (
              !matchesRatingMinimum(summary, query.minimumAverage) ||
              !canonicalEqual(summary, selected.summary)
            )
              unavailable();
            item = {
              locator: {
                selector: selected.scope.selector,
                targetId: selected.id,
                rootId: null,
                replyId: null,
                protocolGeneration: selected.scope.protocolGeneration,
              },
              summary,
              target: ratingTargetSchema.parse({
                id: current.row.id,
                categoryId: current.row.category_id,
                name: current.row.name,
                description: current.row.description,
                revision: current.row.revision,
                allowedActions: {
                  setScore: summary.status === 'known',
                  createComment: true,
                  authorModes: await this.access.authorModes(random.actor, tx),
                },
              }),
            };
            if (protocolVersion === 3) {
              coverContext = await this.contexts.createCover(
                token,
                {
                  purpose: 'read',
                  mode: 'public',
                  selector: selected.scope.selector,
                },
                tx,
              );
              cover = currentRatingTargetCoverDescriptor(
                current.row.definition,
                {
                  contextId: coverContext.id,
                  contextToken: coverContext.token,
                },
                tx,
              );
            }
            await this.scoped.retainAfter(selected.scope, tx);
          }
          await this.access.recheck(token, tx);
          return (
            protocolVersion === 3
              ? ratingTargetCoverRandomResponseSchema
              : ratingScopedRandomResponseSchema
          ).parse({
            context: {
              contextId: random.context.id,
              selector,
              protocolGeneration: random.context.protocolGeneration,
              categoryId: query.categoryId,
              minimumAverage: query.minimumAverage ?? null,
            },
            candidateCount: candidates.length,
            item:
              protocolVersion === 3 && item
                ? { ...item, cover, coverContext }
                : item,
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
