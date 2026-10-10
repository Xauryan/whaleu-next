import { ApplicationError } from '../http/application-error.js';
import {
  canonicalAnyRatingTargetDefinition,
  type AnyRatingTargetDefinitionDescriptor,
} from '../community/content-review/rating-target-definition-contracts.js';
import { ratingPublicIdSchema, ratingTargetSchema } from './contracts.js';

/** Immutable creation identity and the current lifecycle, never definition text. */
export interface RatingTargetIdentityRow {
  id: string;
  revision: string;
  category_id: string;
  creator_id: string;
  region_id: string | null;
  active: boolean;
}

/** Raw v1 creation fields. These are not a current public target projection. */
export interface TargetCreationRow extends RatingTargetIdentityRow {
  name: string;
  description: string;
  envelope: unknown;
  ordinal?: string;
}

/** Nullable definition joins are intentional: unknown is never v1 fallback. */
export interface CurrentTargetRead extends RatingTargetIdentityRow {
  name: string | null;
  description: string | null;
  envelope: unknown;
  content_version: number | null;
  definition_revision: string | null;
  applied_target_revision: string | null;
  definition_target_id: string | null;
  lifecycle_target_revision: string | null;
  owner_deleted: boolean;
}

export interface CurrentTargetRow extends RatingTargetIdentityRow {
  name: string;
  description: string;
  envelope: AnyRatingTargetDefinitionDescriptor['envelope'];
  definition: AnyRatingTargetDefinitionDescriptor;
}

/** The aliases t/h/d/l are private Ratings-owner inputs in both bounded reads. */
export const ratingCurrentTargetColumns = `t.id,t.revision,t.category_id,t.creator_id,t.region_id,t.active,
  d.name,d.description,d.envelope,h.content_version,h.definition_revision,
  d.applied_target_revision,d.target_id definition_target_id,
  l.target_revision lifecycle_target_revision,
  EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones tombstone WHERE tombstone.target_id=t.id) owner_deleted`;

export const ratingCurrentTargetDefinitionJoins = `
  LEFT JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
  LEFT JOIN whaleu_ratings.target_definition_versions d ON d.target_id=h.target_id
    AND d.content_version=h.content_version AND d.definition_revision=h.definition_revision
  LEFT JOIN whaleu_ratings.target_definition_lifecycles l ON l.target_id=t.id
    AND l.target_revision=t.revision AND l.content_version=h.content_version
    AND l.definition_revision=h.definition_revision`;

/** Public/current readers must call this only after the lifecycle visibility gate. */
export function currentRatingTargetRow(
  row: CurrentTargetRead,
): CurrentTargetRow {
  if (
    row.active !== true ||
    row.owner_deleted !== false ||
    row.definition_target_id !== row.id ||
    row.lifecycle_target_revision !== row.revision ||
    !ratingPublicIdSchema.safeParse(row.creator_id).success ||
    (row.region_id !== null &&
      !ratingPublicIdSchema.safeParse(row.region_id).success) ||
    !ratingTargetSchema.safeParse({
      id: row.id,
      categoryId: row.category_id,
      name: row.name,
      description: row.description,
      revision: row.revision,
      allowedActions: {
        setScore: false,
        createComment: true,
        authorModes: ['named'],
      },
    }).success
  )
    throw new ApplicationError('RATING_UNAVAILABLE');
  let definition: AnyRatingTargetDefinitionDescriptor;
  try {
    definition = canonicalAnyRatingTargetDefinition({
      targetId: row.id,
      contentVersion: row.content_version,
      definitionRevision: row.definition_revision,
      appliedTargetRevision: row.applied_target_revision,
      envelope: row.envelope,
    });
  } catch {
    throw new ApplicationError('RATING_UNAVAILABLE');
  }
  if (
    definition.envelope.accountId !== row.creator_id ||
    definition.envelope.categoryId !== row.category_id ||
    (definition.envelope.version === 5 || definition.envelope.version === 6
      ? definition.envelope.targetOrigin.regionId
      : definition.envelope.scope.regionId) !== row.region_id ||
    definition.envelope.name !== row.name ||
    definition.envelope.description !== row.description
  )
    throw new ApplicationError('RATING_UNAVAILABLE');
  return {
    id: row.id,
    revision: row.revision,
    category_id: row.category_id,
    creator_id: row.creator_id,
    region_id: row.region_id,
    active: row.active,
    name: row.name!,
    description: row.description!,
    envelope: definition.envelope,
    definition,
  };
}

export function sameRatingTargetDefinition(
  left: AnyRatingTargetDefinitionDescriptor,
  right: AnyRatingTargetDefinitionDescriptor,
): boolean {
  return (
    left.targetId === right.targetId &&
    left.contentVersion === right.contentVersion &&
    left.definitionRevision === right.definitionRevision &&
    left.appliedTargetRevision === right.appliedTargetRevision
  );
}
