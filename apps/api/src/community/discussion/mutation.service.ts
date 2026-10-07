import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import type { DiscussionOperation, DiscussionReceipt } from './contracts.js';
const terminal = new Set<ApplicationErrorCode>([
  'POST_NOT_FOUND',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
  'COMMENT_PIN_CONFLICT',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
]);
@Injectable()
export class DiscussionMutationService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  set(
    token: string,
    requestId: string,
    operation: DiscussionOperation,
    id: string,
    desired: boolean,
  ): Promise<DiscussionReceipt> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const hash = createHash('sha256')
        .update(JSON.stringify({ operation, id: id.toLowerCase(), desired }))
        .digest('hex');
      await tx.query(
        'INSERT INTO whaleu_community.discussion_requests(account_id,client_request_id,payload_hash,operation) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash, operation],
      );
      const row = (
        await tx.query<{
          payload_hash: string;
          receipt: DiscussionReceipt | null;
        }>(
          'SELECT payload_hash,receipt FROM whaleu_community.discussion_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) return row.receipt;
      await tx.query('SAVEPOINT discussion_work');
      let receipt: DiscussionReceipt;
      try {
        const target =
          operation === 'set_reply_like'
            ? await this.access.accessibleReply(id, actor, tx, true)
            : await this.access.accessibleComment(id, actor, tx, true);
        const { post, comment, authority } = target;
        requireAction(
          authority!,
          operation === 'set_comment_pin' ? 'pin' : 'like',
        );
        if (operation === 'set_comment_pin') {
          if (post.account_id !== actor)
            throw new ApplicationError('COMMENT_NOT_FOUND');
          const current = (
            await tx.query<{ comment_id: string }>(
              'SELECT comment_id FROM whaleu_community.comment_pins WHERE post_id=$1 FOR UPDATE',
              [post.id],
            )
          ).rows[0];
          if (desired && current && current.comment_id !== comment.id)
            throw new ApplicationError('COMMENT_PIN_CONFLICT');
          const changed = desired
            ? await tx.query(
                'INSERT INTO whaleu_community.comment_pins(post_id,comment_id) VALUES($1,$2) ON CONFLICT(post_id) DO NOTHING',
                [post.id, comment.id],
              )
            : await tx.query(
                'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1 AND comment_id=$2',
                [post.id, comment.id],
              );
          if (changed.rowCount)
            await this.repository.event(
              `discussion:${randomUUID()}`,
              desired ? 'comment_pinned' : 'comment_unpinned',
              id,
              tx,
              {
                actorAccountId: actor,
                postId: post.id,
                rootCommentId: comment.id,
                obligations: ['discussion_order_invalidation'],
              },
            );
        } else {
          const kind = operation === 'set_reply_like' ? 'reply' : 'comment';
          const changed = desired
            ? await tx.query(
                `INSERT INTO whaleu_community.${kind}_likes(${kind}_id,account_id) VALUES($1,$2) ON CONFLICT(${kind}_id,account_id) DO NOTHING`,
                [id, actor],
              )
            : await tx.query(
                `DELETE FROM whaleu_community.${kind}_likes WHERE ${kind}_id=$1 AND account_id=$2`,
                [id, actor],
              );
          if (changed.rowCount)
            await this.repository.event(
              `discussion:${randomUUID()}`,
              `${kind}_${desired ? 'liked' : 'unliked'}`,
              id,
              tx,
              {
                actorAccountId: actor,
                postId: post.id,
                rootCommentId: comment.id,
                recipientAccountId:
                  'reply' in target
                    ? (
                        target as Awaited<
                          ReturnType<CommunityAccessService['accessibleReply']>
                        >
                      ).reply.account_id
                    : comment.account_id,
                desired,
                obligations: desired
                  ? [
                      'lifetime_deduplicated_like_notification',
                      'capped_like_reward',
                      'discussion_ranking',
                    ]
                  : ['discussion_ranking'],
              },
            );
        }
        receipt = {
          requestId,
          operation,
          outcome: 'applied',
          resourceId: id.toLowerCase(),
          desired,
        };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT discussion_work');
        receipt = {
          requestId,
          operation,
          outcome: 'rejected',
          code: error.code,
        };
      }
      await tx.query('RELEASE SAVEPOINT discussion_work');
      await tx.query(
        'UPDATE whaleu_community.discussion_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<DiscussionReceipt> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const row = (
        await tx.query<{ receipt: DiscussionReceipt }>(
          'SELECT receipt FROM whaleu_community.discussion_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      return row.receipt;
    });
  }
  deleteReply(token: string, id: string): Promise<void> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const reference = await this.repository.reply(id, tx);
      if (reference.account_id !== actor)
        throw new ApplicationError('REPLY_NOT_FOUND');
      if (reference.deleted_at) return;
      const { post, comment, authority } = await this.access.accessibleComment(
        reference.root_comment_id,
        actor,
        tx,
        true,
      );
      const reply = await this.repository.reply(id, tx, true);
      if (reply.deleted_at) return;
      requireAction(authority!, 'delete');
      if (!(await this.access.visible(actor, reply, tx)))
        throw new ApplicationError('REPLY_NOT_FOUND');
      await tx.query(
        'UPDATE whaleu_community.replies SET deleted_at=clock_timestamp() WHERE id=$1',
        [id],
      );
      await this.repository.event(
        `reply:${id}:deleted`,
        'reply_deleted',
        id,
        tx,
        {
          actorAccountId: actor,
          postId: post.id,
          rootCommentId: comment.id,
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
