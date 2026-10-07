import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../http/application-error.js';
import { CommunityRepository } from './community.repository.js';
import type { StoredComment } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { requireAction } from './community-policy.js';
@Injectable()
export class DeletionService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  post(token: string, id: string): Promise<void> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const post = await this.repository.post(id, tx, true);
      if (post.account_id !== actor)
        throw new ApplicationError('POST_NOT_FOUND');
      if (post.deleted_at) return;
      const space = await this.repository.space(post.space_id, tx);
      requireAction(await this.access.authority(actor, space, tx), 'delete');
      await tx.query(
        'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
        [id],
      );
      await this.repository.event(`post:${id}:deleted`, 'post_deleted', id, tx);
    });
  }
  comment(token: string, id: string): Promise<void> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const reference = await this.repository.comment(id, tx);
      if (reference.account_id !== actor)
        throw new ApplicationError('COMMENT_NOT_FOUND');
      // All child transitions lock parent first, including deletion; no inverse lock order.
      if (reference.deleted_at) return;
      const { post, space } = await this.access.accessiblePost(
        reference.post_id,
        actor,
        tx,
        true,
      );
      requireAction(await this.access.authority(actor, space, tx), 'delete');
      const result = await tx.query<StoredComment>(
        'SELECT * FROM whaleu_community.root_comments WHERE id=$1 FOR UPDATE',
        [id],
      );
      const comment = result.rows[0]!;
      if (comment.deleted_at) return;
      if (!(await this.access.visible(actor, comment, tx, 'list_projection')))
        throw new ApplicationError('COMMENT_NOT_FOUND');
      await tx.query(
        'DELETE FROM whaleu_community.comment_pins WHERE comment_id=$1',
        [id],
      );
      await tx.query(
        'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
        [id],
      );
      await this.repository.event(
        `comment:${id}:deleted`,
        'comment_deleted',
        id,
        tx,
        {
          actorAccountId: actor,
          postId: post.id,
          rootCommentId: id,
          obligations: [
            'own_delete_deduction',
            'bounded_daily_refund',
            'discussion_ranking',
            'media_cleanup',
          ],
        },
      );
    });
  }
}
