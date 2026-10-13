import { requireContentDistributionGrant } from '../authorization/content-distribution-grant.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { campusCountProofOwner } from '../campus/count-epochs.js';
import { safetyCountProofOwner } from '../safety/count-epochs.js';
import { communityCountProofOwner } from './count-epochs.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { requireAction } from './community-policy.js';
import type { ModerationTarget } from '../profile/moderation/contracts.js';

const campusProof = requiredOwnerEpoch(
  campusCountProofOwner,
  'PROFILE_MODERATION_UNAVAILABLE',
);
const safetyProof = requiredOwnerEpoch(
  safetyCountProofOwner,
  'PROFILE_MODERATION_UNAVAILABLE',
);
const communityProof = requiredOwnerEpoch(
  communityCountProofOwner,
  'PROFILE_MODERATION_UNAVAILABLE',
);

export interface ProfileModerationTarget {
  readonly target: ModerationTarget;
  readonly subjectId: string;
  readonly postId: string;
  readonly rootId: string | null;
  readonly originalRegionId: string;
}
/** The ONLY content-to-subject resolver for this command. No public/private
 * account lookup is accepted. The existing visibility owners keep full control
 * over current Review, Media, Safety, category continuation and ancestry. */
@Injectable()
export class ProfileModerationTargetFacade {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  /** Safe unavailable capability: validates the visible named target and an
   * exact content-management grant, never resolves its subject Profile. */
  async relatedUnsupported(
    target: ModerationTarget,
    actor: string,
    tx: PoolClient,
  ): Promise<boolean> {
    const reference = (
      await tx.query<{ post_id: string; version: number }>(
        `SELECT n.post_id,p.publication_envelope_version version FROM whaleu_community.profile_moderation_nodes($1,$2) n JOIN whaleu_community.posts p ON p.id=n.post_id WHERE n.kind=$1 AND n.id=$2`,
        [target.kind, target.id],
      )
    ).rows[0];
    if (reference?.version !== 4) return false;
    await lockSafetyPolicy(tx);
    await campusProof(tx);
    await safetyProof(tx);
    await communityProof(tx);
    const resolved =
      target.kind === 'post'
        ? await this.access
            .accessiblePost(target.id, actor, tx, true)
            .then((v) => ({ ...v, content: v.post }))
        : target.kind === 'comment'
          ? await this.access
              .accessibleComment(target.id, actor, tx, true)
              .then((v) => ({ ...v, content: v.comment }))
          : await this.access
              .accessibleReply(target.id, actor, tx, true)
              .then((v) => ({ ...v, content: v.reply }));
    if (resolved.content.author_mode !== 'named')
      throw new ApplicationError('PROFILE_MODERATION_TARGET_NOT_ALLOWED');
    if (
      !(await this.access.visible(actor, resolved.post, tx, 'list_projection'))
    )
      throw new ApplicationError('POST_NOT_FOUND');
    await requireContentDistributionGrant(
      actor,
      resolved.post.id,
      null,
      tx,
      'profile_unavailable',
    );
    return true;
  }
  async resolve(
    target: ModerationTarget,
    actor: string,
    tx: PoolClient,
  ): Promise<ProfileModerationTarget> {
    await lockSafetyPolicy(tx);
    // This new management boundary promises one exact current target. Existing
    // public display reads do not acquire these extra mandatory owner proofs.
    await campusProof(tx);
    await safetyProof(tx);
    await communityProof(tx);
    const resolved =
      target.kind === 'post'
        ? await this.access
            .accessiblePost(target.id, actor, tx, true)
            .then((value) => ({ ...value, content: value.post }))
        : target.kind === 'comment'
          ? await this.access
              .accessibleComment(target.id, actor, tx, true)
              .then((value) => ({ ...value, content: value.comment }))
          : await this.access
              .accessibleReply(target.id, actor, tx, true)
              .then((value) => ({ ...value, content: value.reply }));
    const content = resolved.content;
    if (content.author_mode !== 'named')
      throw new ApplicationError('PROFILE_MODERATION_TARGET_NOT_ALLOWED');
    if (
      !(await this.access.visible(actor, resolved.post, tx, 'list_projection'))
    )
      throw new ApplicationError('POST_NOT_FOUND');
    if (resolved.space.kind !== 'regional' || !resolved.space.operatingRegionId)
      throw new ApplicationError('PROFILE_MODERATION_TARGET_NOT_ALLOWED');
    const row = (
      await tx.query<{
        region_id: string;
        subject_id: string;
        post_id: string;
        root_id: string | null;
      }>(
        'SELECT * FROM whaleu_community.profile_moderation_target($1,$2) WHERE whaleu_community.profile_moderation_supported($3,$1,$2)',
        [target.kind, target.id, actor],
      )
    ).rows[0];
    if (
      !row ||
      row.subject_id !== content.account_id ||
      row.post_id !== resolved.post.id ||
      row.region_id !== resolved.space.operatingRegionId
    )
      throw new ApplicationError('PROFILE_MODERATION_TARGET_NOT_ALLOWED');
    requireAction(
      await this.access.authority(actor, resolved.space, tx),
      'publish_post',
    );
    return Object.freeze({
      target,
      subjectId: row.subject_id,
      postId: row.post_id,
      rootId: row.root_id,
      originalRegionId: row.region_id,
    });
  }
}
