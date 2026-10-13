import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireFeedbackSpace } from './topic.js';
import { feedbackInputSchema } from './contracts.js';
@Injectable()
export class FeedbackService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  @AccountPolicy('browse', 'entry')
  topic() {
    return this.repository.database.transaction(async (tx) => {
      const row = (
        await tx.query<{ space_id: string }>(
          `SELECT space_id FROM whaleu_community.feedback_topic WHERE topic='feedback' FOR SHARE`,
        )
      ).rows[0];
      if (!row) throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
      const space = await this.repository.space(row.space_id, tx);
      await requireFeedbackSpace(space, tx);
      return { topic: 'feedback' as const, space };
    });
  }
  @AccountPolicy('browse', 'entry')
  contacts(token: string, postId: string) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
        );
        if (post.category !== 'feedback')
          throw new ApplicationError('POST_NOT_FOUND');
        await requireFeedbackSpace(space, tx);
        const parsed = feedbackInputSchema.safeParse(post.feedback);
        if (!parsed.success)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        return { postId, contacts: parsed.data.contacts };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
