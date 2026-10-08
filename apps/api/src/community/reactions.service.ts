import { Inject, Injectable } from '@nestjs/common';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { requireAction } from './community-policy.js';
import {
  postLikeIntentHash,
  postLikeRejectionCodes,
} from './post-like/contracts.js';
import type {
  PostLikeIntent,
  PostLikeReceipt,
  PostLikeRejectionCode,
} from './post-like/contracts.js';

@Injectable()
export class ReactionsService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  /** A receipt records this request's result, never frozen current membership or
   * count. Exact retries cannot create a new transition after an intervening unlike. */
  setLike(
    token: string,
    resource: string,
    input: PostLikeIntent,
  ): Promise<PostLikeReceipt> {
    const postId = resource.toLowerCase(),
      requestId = input.requestId.toLowerCase(),
      liked = input.liked;
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const hash = postLikeIntentHash(postId, liked);
      await tx.query(
        'INSERT INTO whaleu_community.post_like_requests(account_id,client_request_id,payload_hash,post_id,liked) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash, postId, liked],
      );
      const row = (
        await tx.query<{
          payload_hash: string;
          receipt: PostLikeReceipt | null;
        }>(
          'SELECT payload_hash,receipt FROM whaleu_community.post_like_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.access.actor(token, tx);
        return row.receipt;
      }
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT post_like_work');
      let receipt: PostLikeReceipt;
      const intent = {
        requestId,
        operation: 'set_post_like' as const,
        postId,
        liked,
      };
      try {
        const { post, space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
          true,
        );
        requireAction(await this.access.authority(actor, space, tx), 'like');
        const changed = liked
          ? await tx.query<{ like_id: string }>(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2) ON CONFLICT(post_id,account_id) DO NOTHING RETURNING like_id',
              [postId, actor],
            )
          : await tx.query<{ like_id: string }>(
              'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2 RETURNING like_id',
              [postId, actor],
            );
        if (changed.rows[0])
          await this.repository.event(
            `post:${liked ? 'like' : 'unlike'}:${changed.rows[0].like_id}`,
            liked ? 'post_liked' : 'post_unliked',
            postId,
            tx,
            {
              experienceSourceVersion: 1,
              actorAccountId: actor,
              actorAuthorMode: null,
              resourceAuthorMode: post.author_mode,
              postId,
              recipientAccountId: post.account_id,
              likeId: changed.rows[0].like_id,
              desired: liked,
            },
          );
        receipt = { ...intent, outcome: 'applied' };
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !postLikeRejectionCodes.some((code) => code === error.code)
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT post_like_work');
        restoreTransactionDeadlines(tx, checkpoint);
        receipt = {
          ...intent,
          outcome: 'rejected',
          code: error.code as PostLikeRejectionCode,
        };
      }
      await tx.query('RELEASE SAVEPOINT post_like_work');
      await tx.query(
        'UPDATE whaleu_community.post_like_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      await this.access.actor(token, tx);
      return receipt;
    });
  }
  receipt(token: string, request: string): Promise<PostLikeReceipt> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const row = (
        await tx.query<{ receipt: PostLikeReceipt }>(
          'SELECT receipt FROM whaleu_community.post_like_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, request.toLowerCase()],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.access.actor(token, tx);
      return row.receipt;
    });
  }
}
