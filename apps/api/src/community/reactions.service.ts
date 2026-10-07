import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { requireAction } from './community-policy.js';
@Injectable()
export class ReactionsService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  setLike(
    token: string,
    postId: string,
    desired: boolean,
  ): Promise<{ postId: string; isLiked: boolean; likeCount: number }> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { space } = await this.access.accessiblePost(
        postId,
        actor,
        tx,
        true,
      );
      requireAction(await this.access.authority(actor, space, tx), 'like');
      const changed = desired
        ? await tx.query(
            'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES ($1,$2) ON CONFLICT(post_id,account_id) DO NOTHING',
            [postId, actor],
          )
        : await tx.query(
            'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
            [postId, actor],
          );
      if (changed.rowCount)
        await this.repository.event(
          `like:${randomUUID()}`,
          desired ? 'post_liked' : 'post_unliked',
          postId,
          tx,
        );
      const count = await tx.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM whaleu_community.post_likes WHERE post_id=$1',
        [postId],
      );
      return { postId, isLiked: desired, likeCount: count.rows[0]!.count };
    });
  }
}
