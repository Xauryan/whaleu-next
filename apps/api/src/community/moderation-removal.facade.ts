import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ReportTarget } from '../safety/reporting/contracts.js';
import { CommunityReportTargetFacade } from './report-target.facade.js';
import { CommunityRepository } from './community.repository.js';
@Injectable()
export class CommunityModerationRemovalFacade {
  constructor(
    @Inject(CommunityReportTargetFacade)
    private readonly targets: CommunityReportTargetFacade,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
  ) {}
  async remove(
    input: {
      target: ReportTarget;
      expectedVersion: string;
      cause: 'post_jury' | 'discussion_report_threshold';
      decisionId: string;
    },
    tx: PoolClient,
  ): Promise<'removed' | 'already_removed' | 'changed'> {
    const current = await this.targets.lockForSettlement(
      input.target,
      input.expectedVersion,
      tx,
    );
    if (current.status !== 'live')
      return current.status === 'removed' ? 'already_removed' : 'changed';
    if ((input.cause === 'post_jury') !== (input.target.kind === 'post'))
      throw new Error('Invalid moderation cause');
    const ref = current.value;
    if (input.target.kind === 'post')
      await tx.query(
        'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1',
        [ref.postId],
      );
    else if (input.target.kind === 'comment')
      await tx.query(
        'DELETE FROM whaleu_community.comment_pins WHERE comment_id=$1',
        [ref.rootId],
      );
    const table =
      input.target.kind === 'post'
        ? 'posts'
        : input.target.kind === 'comment'
          ? 'root_comments'
          : 'replies';
    await tx.query(
      `UPDATE whaleu_community.${table} SET deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1 AND deleted_at IS NULL`,
      [input.target.id],
    );
    await this.repository.event(
      `moderation:${input.decisionId}`,
      'moderation_removed',
      input.target.id,
      tx,
      {
        cause: input.cause,
        decisionId: input.decisionId,
        kind: input.target.kind,
        postId: ref.postId,
        rootCommentId: ref.rootId,
        obligations: ['content_invalidation', 'media_cleanup'],
      },
    );
    return 'removed';
  }
}
