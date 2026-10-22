import { ApplicationError } from '../../http/application-error.js';
import type { CommunitySpace, PublishPost } from '../contracts.js';
import { postIntent } from '../publication-intent.js';
import type { HomeAdmission } from './admission-contract.js';
import { resolveHomeMapping } from './admission.js';
import {
  evaluateLegacyHomePolicy,
  LEGACY_HOME_POLICY_COMMIT,
} from './policy.js';
import {
  homeReviewEvidenceSchema,
  homeRequestedIntentSchema,
  homeOriginalIntentHash,
} from './review-evidence.js';
import type { HomeReviewEvidence } from './review-evidence.js';

export type HomePublicationPlan =
  | {
      lane: 'existing';
      reason: 'excluded_category' | 'accessory' | 'unrestricted_related';
      suppressDistribution: false;
    }
  | {
      lane: 'home';
      evidence: HomeReviewEvidence;
      spaceId: string;
      regionId: string | null;
      category: PublishPost['category'] | 'water';
      suppressDistribution: boolean;
    };

/** Planning is not activation or authorization. Call only with the current
 * locked admission and canonical publication-time scope; the caller must still
 * authorize BOTH requested and effective destinations before obtaining Review.
 * No identity is returned, and the original request/source bytes remain intact.
 */
export function planHomePublication(
  body: PublishPost,
  space: CommunitySpace,
  authorOriginRegionId: string | null,
  admission: HomeAdmission,
  now: Date,
): HomePublicationPlan {
  const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(Date.parse(admission.ref.validUntil)) ||
    Date.parse(admission.ref.validUntil) <= now.getTime() ||
    !space.isActive ||
    space.id !== body.spaceId ||
    admission.ref.sourceCommit !== LEGACY_HOME_POLICY_COMMIT
  )
    throw unavailable();
  // These distinct existing owners are not relabelled as ordinary Home posts.
  if (body.category === 'feedback' || body.category === 'trading')
    return {
      lane: 'existing',
      reason: 'excluded_category',
      suppressDistribution: false,
    };
  if (admission.definition.exemptions.audit !== 'none') throw unavailable();
  const mapping = resolveHomeMapping(admission, {
    category: body.category,
    spaceId: space.id,
    spaceKind: space.kind,
    regionId: space.operatingRegionId,
    authorMode: body.authorMode,
    authorOriginRegionId,
  });
  const decision = evaluateLegacyHomePolicy({
    originalCategory: {
      sourceCommit: LEGACY_HOME_POLICY_COMMIT,
      choose: mapping.legacyChoose,
    },
    text: body.text,
    format: body.textSource?.format ?? 'plain',
    hasImages: body.imageAssetIds.length > 0,
    hasPoll: body.component?.kind === 'poll',
    hasGroup: body.component?.kind === 'formation',
    hasLink: body.component?.kind === 'rating_target_link',
    auditExempt: false,
  });
  if (decision.status !== 'resolved') throw unavailable();
  // Accessory owners retain their existing specialized Review envelopes.
  if (
    !decision.restriction &&
    (body.imageAssetIds.length > 0 ||
      (body.component && body.component.kind !== 'none'))
  )
    return {
      lane: 'existing',
      reason: 'accessory',
      suppressDistribution: false,
    };
  if (!decision.restriction && body.syncToRelatedCampuses === true)
    return {
      lane: 'existing',
      reason: 'unrestricted_related',
      suppressDistribution: false,
    };
  const requestedIntent = homeRequestedIntentSchema.parse(postIntent(body));
  const evidence = homeReviewEvidenceSchema.parse({
    version: 1,
    admission: mapping.admission,
    requestedIntent,
    requestedIntentHash: homeOriginalIntentHash(requestedIntent),
    requestedRegionId: space.operatingRegionId,
    legacyChoose: mapping.legacyChoose,
    targetWaterSpaceId: mapping.targetWaterSpaceId,
    targetWaterRegionId: mapping.targetWaterRegionId,
    auditExempt: false,
    result: decision.restriction?.reason ?? null,
  });
  return {
    lane: 'home',
    evidence,
    spaceId: decision.restriction ? mapping.targetWaterSpaceId : space.id,
    regionId: decision.restriction
      ? mapping.targetWaterRegionId
      : space.operatingRegionId,
    category: decision.restriction ? 'water' : body.category,
    suppressDistribution: decision.restriction !== null,
  };
}
