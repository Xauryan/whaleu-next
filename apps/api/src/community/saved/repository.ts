import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UpdateChannel } from './contracts.js';
export interface StoredSave {
  account_id: string;
  post_id: string;
  epoch_id: string | null;
  saved_at: Date | null;
  revision: string;
}
export interface StoredPreferences {
  saved_updates_enabled: boolean;
  external_updates_enabled: boolean;
  saved_changed_at: Date | null;
  external_changed_at: Date | null;
  revision: string;
}
@Injectable()
export class SavedRepository {
  async own(
    actor: string,
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<StoredSave | null> {
    return (
      (
        await tx.query<StoredSave>(
          `SELECT * FROM whaleu_community.saved_posts WHERE account_id=$1 AND post_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [actor, postId],
        )
      ).rows[0] ?? null
    );
  }
  async preferences(
    actor: string,
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<StoredPreferences | null> {
    return (
      (
        await tx.query<StoredPreferences>(
          `SELECT saved_updates_enabled,external_updates_enabled,saved_changed_at,external_changed_at,revision FROM whaleu_community.post_update_preferences WHERE account_id=$1 AND post_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [actor, postId],
        )
      ).rows[0] ?? null
    );
  }
  /** Parent is already locked, so the aggregate and own state cannot race saves. */
  async projection(postId: string, viewer: string | null, tx: PoolClient) {
    const aggregate = (
      await tx.query<{ count: number; saved: boolean }>(
        'SELECT count(*)::integer AS count,coalesce(bool_or(account_id=$2::uuid),false) AS saved FROM whaleu_community.saved_posts WHERE post_id=$1 AND epoch_id IS NOT NULL',
        [postId, viewer],
      )
    ).rows[0]!;
    return { saveCount: aggregate.count, isSaved: aggregate.saved };
  }
  private async order(tx: PoolClient) {
    return (
      await tx.query<{ sequence: string; at: Date }>(
        "SELECT nextval('whaleu_community.discussion_sequence') AS sequence,date_trunc('milliseconds',clock_timestamp()) AS at",
      )
    ).rows[0]!;
  }
  async setSaved(
    actor: string,
    postId: string,
    desired: boolean,
    tx: PoolClient,
  ) {
    const current = await this.own(actor, postId, tx, true);
    if (!!current?.epoch_id === desired) return null;
    const order = await this.order(tx);
    if (desired) {
      if (!current) {
        await tx.query(
          'INSERT INTO whaleu_community.saved_posts(account_id,post_id) VALUES($1,$2)',
          [actor, postId],
        );
      }
      const epochId = randomUUID();
      await tx.query(
        'INSERT INTO whaleu_community.saved_epochs(id,account_id,post_id,started_at,started_sequence) VALUES($1,$2,$3,$4,$5)',
        [epochId, actor, postId, order.at, order.sequence],
      );
      await tx.query(
        'UPDATE whaleu_community.saved_posts SET epoch_id=$3,saved_at=$4,revision=$5 WHERE account_id=$1 AND post_id=$2',
        [actor, postId, epochId, order.at, order.sequence],
      );
      return { epochId, ...order };
    }
    const epochId = current!.epoch_id!;
    await tx.query(
      'UPDATE whaleu_community.saved_epochs SET ended_at=$2,ended_sequence=$3 WHERE id=$1',
      [epochId, order.at, order.sequence],
    );
    await tx.query(
      'UPDATE whaleu_community.saved_posts SET epoch_id=NULL,saved_at=NULL,revision=$3 WHERE account_id=$1 AND post_id=$2',
      [actor, postId, order.sequence],
    );
    return { epochId, ...order };
  }
  async setPreference(
    actor: string,
    postId: string,
    channel: UpdateChannel,
    enabled: boolean,
    tx: PoolClient,
  ) {
    const current = await this.preferences(actor, postId, tx, true);
    const saved = current?.saved_updates_enabled ?? true,
      external = current?.external_updates_enabled ?? true;
    if ((channel === 'saved' ? saved : external) === enabled) return;
    const order = await this.order(tx);
    const nextSaved = channel === 'saved' ? enabled : saved,
      nextExternal = channel === 'external' ? enabled : external;
    await tx.query(
      `INSERT INTO whaleu_community.post_update_preferences(account_id,post_id,saved_updates_enabled,external_updates_enabled,saved_changed_at,external_changed_at,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,post_id) DO UPDATE SET saved_updates_enabled=excluded.saved_updates_enabled,
      external_updates_enabled=excluded.external_updates_enabled,saved_changed_at=excluded.saved_changed_at,external_changed_at=excluded.external_changed_at,revision=excluded.revision`,
      [
        actor,
        postId,
        nextSaved,
        nextExternal,
        channel === 'saved' ? order.at : (current?.saved_changed_at ?? null),
        channel === 'external'
          ? order.at
          : (current?.external_changed_at ?? null),
        order.sequence,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_community.post_update_preference_history(account_id,post_id,revision,changed_at,channel,enabled,saved_updates_enabled,external_updates_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor,
        postId,
        order.sequence,
        order.at,
        channel,
        enabled,
        nextSaved,
        nextExternal,
      ],
    );
  }
  async obligations(
    epochId: string,
    actor: string,
    author: string,
    desired: boolean,
    tx: PoolClient,
  ) {
    const obligations: { action: string; recipient: string }[] = [
      { action: 'author_interactions', recipient: author },
      { action: 'save_ranking', recipient: author },
    ];
    if (desired) {
      obligations.push({ action: 'saver_reward', recipient: actor });
      if (actor !== author)
        obligations.push({ action: 'author_reward', recipient: author });
    }
    for (const obligation of obligations)
      await tx.query(
        'INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          epochId,
          desired ? 'saved' : 'unsaved',
          obligation.action,
          obligation.recipient,
          desired ? 1 : -1,
        ],
      );
  }
}
