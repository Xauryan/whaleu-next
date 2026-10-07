import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PollComponent, OwnBallot } from './contracts.js';
export interface StoredPoll {
  id: string;
  post_id: string;
  question: string;
  selection_mode: 'single' | 'multiple';
  deadline: Date | null;
}
@Injectable()
export class PollRepository {
  async create(
    postId: string,
    input: PollComponent,
    tx: PoolClient,
  ): Promise<void> {
    const id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode) VALUES ($1,$2,$3,$4)',
      [id, postId, input.question, input.selectionMode],
    );
    for (const [position, label] of input.options.entries())
      await tx.query(
        'INSERT INTO whaleu_community.poll_options(id,poll_id,position,label) VALUES ($1,$2,$3,$4)',
        [randomUUID(), id, position, label],
      );
  }
  async find(
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<StoredPoll | null> {
    const result = await tx.query<StoredPoll>(
      `SELECT id,post_id,question,selection_mode,deadline FROM whaleu_community.polls WHERE post_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [postId],
    );
    return result.rows[0] ?? null;
  }
  async expired(poll: StoredPoll, tx: PoolClient): Promise<boolean> {
    // Deliberately separate from the locking SELECT: clock_timestamp must execute
    // after every parent, scope, authority and poll lock has been acquired.
    const result = await tx.query<{ expired: boolean }>(
      'SELECT coalesce(deadline<=clock_timestamp(),false) AS expired FROM whaleu_community.polls WHERE id=$1',
      [poll.id],
    );
    return result.rows[0]!.expired;
  }
  async options(pollId: string, tx: PoolClient) {
    return (
      await tx.query<{
        id: string;
        label: string;
        position: number;
        count: number;
      }>(
        `SELECT o.id,o.label,o.position,count(s.ballot_id)::integer AS count
       FROM whaleu_community.poll_options o LEFT JOIN whaleu_community.poll_selections s
       ON s.poll_id=o.poll_id AND s.option_id=o.id WHERE o.poll_id=$1
       GROUP BY o.id ORDER BY o.position`,
        [pollId],
      )
    ).rows;
  }
  async own(
    actor: string,
    postId: string,
    tx: PoolClient,
  ): Promise<OwnBallot | null> {
    const rows = await tx.query<{
      id: string;
      post_id: string;
      created_at: Date;
      option_ids: string[];
    }>(
      `SELECT b.id,p.post_id,b.created_at,array_agg(s.option_id ORDER BY s.option_id) AS option_ids
       FROM whaleu_community.poll_ballots b JOIN whaleu_community.polls p ON p.id=b.poll_id
       JOIN whaleu_community.poll_selections s ON s.ballot_id=b.id
       WHERE b.account_id=$1 AND p.post_id=$2 GROUP BY b.id,p.post_id`,
      [actor, postId],
    );
    const row = rows.rows[0];
    return row
      ? {
          postId: row.post_id,
          ballotId: row.id,
          createdAt: row.created_at.toISOString(),
          selectedOptionIds: row.option_ids,
        }
      : null;
  }
}
