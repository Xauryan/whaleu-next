import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import { SocialUpdatesIngress } from '../../notifications/social/ingress.js';

@Injectable()
export class CommunitySocialSourceCapture {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(SocialUpdatesIngress)
    private readonly ingress: SocialUpdatesIngress,
  ) {}
  /** Only called after fresh source capture. DB provenance independently forbids backfill. */
  async interaction(eventId: string, tx: PoolClient): Promise<void> {
    const event = (
      await tx.query<{ event_type: string }>(
        'SELECT event_type FROM whaleu_community.outbox WHERE id=$1',
        [eventId],
      )
    ).rows[0];
    if (
      !event ||
      !['post_liked', 'comment_liked', 'reply_liked', 'post_saved'].includes(
        event.event_type,
      )
    )
      return;
    const facts = (
      await tx.query<{
        id: string;
        actor_account_id: string;
        resource_author_id: string;
      }>(
        'SELECT id,actor_account_id,resource_author_id FROM whaleu_community.reward_source_groups WHERE event_id=$1 AND creation_transaction=pg_current_xact_id()',
        [eventId],
      )
    ).rows[0];
    if (!facts) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (facts.actor_account_id === facts.resource_author_id) return;
    const id = randomUUID(),
      kind = event.event_type === 'post_saved' ? 'save' : 'like';
    await tx.query(
      `INSERT INTO whaleu_community.social_sources(id,kind,actor_account_id,recipient_account_id,resource_kind,resource_id,post_id,root_comment_id,reply_id,target_reply_id,source_epoch_id,reward_group_id,occurred_at)
      SELECT $1,$2,actor_account_id,resource_author_id,resource_kind,coalesce(reply_id,root_comment_id,post_id),post_id,root_comment_id,reply_id,target_reply_id,coalesce(like_id,save_epoch_id),id,occurred_at FROM whaleu_community.reward_source_groups WHERE id=$3`,
      [id, kind, facts.id],
    );
    await this.ingress.enqueue(
      id,
      facts.resource_author_id,
      kind,
      this.config.COMMUNITY_UPDATES_PROCESSING === 'automatic',
      tx,
    );
  }
  /** Positive new edge only, after its applied receipt has been written. */
  async follow(
    actor: string,
    recipient: string,
    profileId: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<void> {
    const id = randomUUID();
    const inserted = await tx.query(
      `INSERT INTO whaleu_community.social_sources(id,kind,actor_account_id,recipient_account_id,resource_kind,resource_id,source_epoch_id,occurred_at)
      SELECT $1,'follow',follower_id,followed_id,'profile',$2,$3,created_at FROM whaleu_community.user_follows WHERE follower_id=$4 AND followed_id=$5`,
      [id, profileId, requestId, actor, recipient],
    );
    if (inserted.rowCount !== 1)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await this.ingress.enqueue(
      id,
      recipient,
      'follow',
      this.config.COMMUNITY_UPDATES_PROCESSING === 'automatic',
      tx,
    );
  }
}
