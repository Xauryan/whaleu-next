import { z } from 'zod';
import { canonicalEqual } from './contracts.js';
import { canonicalRatingEnvelope } from './rating-contracts.js';
import type { RatingContentEnvelope } from './rating-contracts.js';

export type RatingTargetDefinitionEnvelope = Extract<
  RatingContentEnvelope,
  { purpose: 'publish_rating_target' | 'edit_rating_target' }
>;

/** Ratings owns current-head qualification. Review independently verifies the
 * immutable version against its binding; this descriptor is not an HTTP input. */
export interface RatingTargetDefinitionDescriptor {
  readonly targetId: string;
  readonly contentVersion: number;
  readonly definitionRevision: string;
  readonly appliedTargetRevision: string;
  readonly envelope: RatingTargetDefinitionEnvelope;
}

const id = z.uuid().refine((value) => value === value.toLowerCase());
const descriptorSchema = z.strictObject({
  targetId: id,
  contentVersion: z.number().int().min(1).max(2147483647),
  definitionRevision: id,
  appliedTargetRevision: id,
  envelope: z.unknown(),
});

export function canonicalRatingTargetDefinition(
  value: unknown,
): RatingTargetDefinitionDescriptor {
  const descriptor = descriptorSchema.parse(value);
  const envelope = canonicalRatingEnvelope(descriptor.envelope);
  if (
    !canonicalEqual(envelope, descriptor.envelope) ||
    envelope.targetId !== descriptor.targetId ||
    envelope.targetRevision !== descriptor.appliedTargetRevision ||
    (descriptor.contentVersion === 1
      ? envelope.purpose !== 'publish_rating_target' ||
        descriptor.definitionRevision !== descriptor.appliedTargetRevision
      : envelope.purpose !== 'edit_rating_target' ||
        envelope.contentVersion !== descriptor.contentVersion ||
        envelope.definitionRevision !== descriptor.definitionRevision)
  )
    throw new Error('Invalid rating target definition descriptor');
  // The purpose checks above independently exclude comment/reply envelopes.
  if (
    envelope.purpose !== 'publish_rating_target' &&
    envelope.purpose !== 'edit_rating_target'
  )
    throw new Error('Invalid rating target definition purpose');
  return Object.freeze({ ...descriptor, envelope });
}
