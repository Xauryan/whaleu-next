import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import { SavedRepository } from './repository.js';
import type { SavedIntent, SavedReceipt } from './contracts.js';
const terminal = new Set<ApplicationErrorCode>([
  'POST_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
]);
export function savedIntentHash(intent: SavedIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: intent.operation,
        postId: intent.postId.toLowerCase(),
        desired: intent.desired,
        channel: intent.channel,
      }),
    )
    .digest('hex');
}
@Injectable()
export class SavedMutationService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(SavedRepository) private readonly saved: SavedRepository,
  ) {}
  /** Cleanup is separately routed, reduction-only, active original account only.
   * It neither calls visibility/authority nor returns hidden parent information. */
  set(
    token: string,
    request: string,
    input: SavedIntent,
    cleanup = false,
  ): Promise<SavedReceipt> {
    const requestId = request.toLowerCase(),
      intent = { ...input, postId: input.postId.toLowerCase() };
    if (cleanup && intent.desired) throw new ApplicationError('POST_NOT_FOUND');
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx),
        hash = savedIntentHash(intent);
      await tx.query(
        'INSERT INTO whaleu_community.saved_requests(account_id,client_request_id,payload_hash,operation,post_id,desired,channel) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [
          actor,
          requestId,
          hash,
          intent.operation,
          intent.postId,
          intent.desired,
          intent.channel,
        ],
      );
      const row = (
        await tx.query<{ payload_hash: string; receipt: SavedReceipt | null }>(
          'SELECT payload_hash,receipt FROM whaleu_community.saved_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.access.actor(token, tx);
        return row.receipt;
      }
      await tx.query('SAVEPOINT saved_work');
      let receipt: SavedReceipt;
      try {
        // The parent lock is always first, even for hidden-state cleanup. Missing
        // cleanup saves are idempotent; they do not establish parent existence.
        let post;
        if (cleanup) {
          post = (
            await tx.query<{ id: string; account_id: string }>(
              'SELECT id,account_id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [intent.postId],
            )
          ).rows[0];
          if (
            intent.operation === 'set_post_update_preference' &&
            (!post ||
              !(await this.saved.preferences(actor, intent.postId, tx, true)))
          )
            throw new ApplicationError('POST_NOT_FOUND');
        } else {
          const target = await this.access.accessiblePost(
            intent.postId,
            actor,
            tx,
            true,
          );
          post = target.post;
          requireAction(
            await this.access.authority(actor, target.space, tx),
            intent.operation === 'set_post_saved'
              ? 'save_post'
              : 'set_post_update_preference',
          );
        }
        await this.access.actor(token, tx);
        if (post) {
          if (intent.operation === 'set_post_saved') {
            const changed = await this.saved.setSaved(
              actor,
              post.id,
              intent.desired,
              tx,
            );
            if (changed) {
              await this.saved.obligations(
                changed.epochId,
                actor,
                post.account_id,
                intent.desired,
                tx,
              );
              await this.community.event(
                `save:${changed.epochId}:${intent.desired ? 'started' : 'ended'}`,
                intent.desired ? 'post_saved' : 'post_unsaved',
                changed.epochId,
                tx,
                {
                  actorAccountId: actor,
                  postId: post.id,
                  saveEpochId: changed.epochId,
                  sequence: changed.sequence,
                  occurredAt: changed.at.toISOString(),
                  desired: intent.desired,
                  obligations: ['save_reward_and_ranking'],
                },
              );
            }
          } else
            await this.saved.setPreference(
              actor,
              post.id,
              intent.channel!,
              intent.desired,
              tx,
            );
        }
        receipt = { requestId, ...intent, outcome: 'applied' };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT saved_work');
        receipt = {
          requestId,
          ...intent,
          outcome: 'rejected',
          code: error.code,
        };
      }
      await tx.query('RELEASE SAVEPOINT saved_work');
      await tx.query(
        'UPDATE whaleu_community.saved_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      await this.access.actor(token, tx);
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<SavedReceipt> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const row = (
        await tx.query<{ receipt: SavedReceipt }>(
          'SELECT receipt FROM whaleu_community.saved_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.access.actor(token, tx);
      return row.receipt;
    });
  }
}
