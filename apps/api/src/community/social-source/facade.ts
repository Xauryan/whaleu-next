import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { SocialSource } from './contracts.js';

export type SocialSourceLocator = Pick<
  SocialSource,
  'actorAccountId' | 'recipientAccountId'
>;

/** A locator grants no authority. Recheck both lifecycles while locking in a
 * stable order, before any follow/source/notification-owner gate. A reader may
 * already own its recipient session lock, so additional locks never wait. */
export async function lockSocialSourceAccounts(
  source: SocialSourceLocator,
  tx: PoolClient,
): Promise<boolean> {
  const accounts = [
    ...new Set([source.actorAccountId, source.recipientAccountId]),
  ].sort();
  const rows = (
    await tx.query<{ id: string; lifecycle: string }>(
      'SELECT id,lifecycle FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
      [accounts],
    )
  ).rows;
  return (
    rows.length === accounts.length &&
    rows.every((row) => row.lifecycle === 'active')
  );
}

export async function lockSocialSource(
  id: string,
  tx: PoolClient,
  write = false,
) {
  const locked = (
    await tx.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended($1,0)) AS locked`,
      [`social-in-app:${id}`],
    )
  ).rows[0]?.locked;
  if (!locked) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
}

/** SQL validates the exact immutable source fingerprint and deletion scope.
 * Merely finding a row with the same source UUID is not retirement authority. */
export async function socialSourceDeletionState(id: string, tx: PoolClient) {
  const state = (
    await tx.query<{ retired: boolean; erasing: boolean }>(
      'SELECT whaleu_account_deletion.follow_source_retired($1) AS retired,whaleu_account_deletion.follow_source_erasing($1) AS erasing',
      [id],
    )
  ).rows[0];
  if (!state) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return state;
}

@Injectable()
export class CommunitySocialSourceFacade {
  async locate(
    id: string,
    tx: PoolClient,
  ): Promise<SocialSourceLocator | null> {
    return (
      (
        await tx.query<SocialSourceLocator>(
          'SELECT actor_account_id AS "actorAccountId",recipient_account_id AS "recipientAccountId" FROM whaleu_community.social_sources WHERE id=$1',
          [id],
        )
      ).rows[0] ?? null
    );
  }

  async source(id: string, tx: PoolClient): Promise<SocialSource | null> {
    return (
      (
        await tx.query<SocialSource>(
          `SELECT id,kind,actor_account_id AS "actorAccountId",recipient_account_id AS "recipientAccountId",resource_kind AS "resourceKind",resource_id AS "resourceId",post_id AS "postId",root_comment_id AS "rootCommentId",reply_id AS "replyId",target_reply_id AS "targetReplyId",source_epoch_id AS "sourceEpochId",to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt" FROM whaleu_community.social_sources WHERE id=$1`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
}
