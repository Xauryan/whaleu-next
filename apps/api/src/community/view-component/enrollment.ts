import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
@Injectable()
export class CommunityViewEnrollment {
  async enrollPublishedPost(
    input: { postId: string; ownerId: string; publicationRequestId: string },
    tx: PoolClient,
  ): Promise<void> {
    // Database guards require exact fresh creation, origin and successful receipt.
    await tx.query(
      'INSERT INTO whaleu_post_hotness.view_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
      [input.postId, input.ownerId, input.publicationRequestId],
    );
    await tx.query(
      'INSERT INTO whaleu_post_hotness.view_states(post_id) VALUES($1)',
      [input.postId],
    );
  }
}
