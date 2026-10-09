import { Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { canonicalJson } from '../community/content-review/contracts.js';
export interface Conversation {
  id: string;
  account0: string;
  account1: string;
  mode0: 'named' | 'anonymous';
  mode1: 'named' | 'anonymous';
  source_key: string;
  source_post_id: string | null;
  context: unknown;
  context_digest: string;
  next_message_seq: string;
  next_event_seq: string;
  created_at: Date;
  updated_at: Date;
}
export interface Participant {
  conversation_id: string;
  slot: 0 | 1;
  account_id: string;
  mode: 'named' | 'anonymous';
  display: {
    mode: 'named' | 'anonymous';
    displayName: string;
    profileId: string | null;
  };
  read_through_seq: string;
  hidden_through_seq: string;
  unread_count: string;
  hidden_at: Date | null;
  blocked_at: Date | null;
  lifetime_sent: string;
}
export interface Message {
  id: string;
  conversation_id: string;
  message_seq: string;
  sender_slot: 0 | 1;
  sender_id: string;
  request_id: string;
  body: string;
  envelope: unknown;
  created_at: Date;
  recalled_at: Date | null;
}
interface Coverage {
  account_id: string;
  coverage: 'local' | 'complete' | 'missing' | 'conflicting';
  provenance: string;
  issuer: string;
  source_reference: string;
  policy_reference: string;
  effective_at: Date;
  valid_until: Date;
  revision: string;
  exact: boolean;
}
async function coverageRow(actor: string, tx: PoolClient) {
  return (
    await tx.query<Coverage>(
      'SELECT c.*,effective_at<=clock_timestamp() AND valid_until>clock_timestamp() AS exact FROM whaleu_messaging.coverage_heads c WHERE account_id=$1',
      [actor],
    )
  ).rows[0];
}
const coverageProof: RequiredTransactionProof<{
  actor: string;
  fingerprint: string;
}> = {
  maximumFacts: 2,
  failureCode: 'DM_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DM_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_messaging.coverage_heads IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = await coverageRow(f.actor, read);
        if (ownerFingerprint(row ?? null) !== f.fingerprint)
          throw new ApplicationError('DM_UNAVAILABLE');
      }
    }),
};
@Injectable()
export class MessagingRepository {
  async coverage(actor: string, tx: PoolClient): Promise<'local' | 'complete'> {
    enableRequiredTransactionProof(tx, coverageProof);
    await tx.query(
      'SELECT account_id FROM whaleu_messaging.coverage_heads WHERE account_id=$1 FOR SHARE',
      [actor],
    );
    const row = await coverageRow(actor, tx);
    registerRequiredTransactionFact(tx, coverageProof, actor, {
      actor,
      fingerprint: ownerFingerprint(row ?? null),
    });
    if (
      !row ||
      !['local', 'complete'].includes(row.coverage) ||
      row.provenance !== 'accepted' ||
      !row.issuer.trim() ||
      !row.source_reference.trim() ||
      !row.policy_reference.trim() ||
      !row.exact
    )
      throw new ApplicationError('DM_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until.getTime(),
      'DM_UNAVAILABLE',
    );
    return row.coverage as 'local' | 'complete';
  }

  async member(id: string, actor: string, tx: PoolClient) {
    const c = (
      await tx.query<Conversation>(
        'SELECT * FROM whaleu_messaging.conversations WHERE id=$1 AND (account0=$2 OR account1=$2) FOR UPDATE',
        [id, actor],
      )
    ).rows[0];
    if (!c) throw new ApplicationError('DM_NOT_FOUND');
    const participants = (
      await tx.query<Participant>(
        'SELECT * FROM whaleu_messaging.participants WHERE conversation_id=$1 ORDER BY slot FOR UPDATE',
        [id],
      )
    ).rows;
    if (participants.length !== 2) throw new ApplicationError('DM_UNAVAILABLE');
    const self = participants.find((p) => p.account_id === actor),
      peer = participants.find((p) => p.account_id !== actor);
    if (!self || !peer) throw new ApplicationError('DM_NOT_FOUND');
    return { conversation: c, self, peer };
  }
  async epoch(actor: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ inbox_epoch: string }>(
          'SELECT inbox_epoch FROM whaleu_messaging.owner_states WHERE account_id=$1',
          [actor],
        )
      ).rows[0]?.inbox_epoch ?? '0'
    );
  }
  async bump(c: Conversation, tx: PoolClient) {
    await tx.query(
      'INSERT INTO whaleu_messaging.owner_states(account_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING',
      [[c.account0, c.account1]],
    );
    await tx.query(
      'SELECT account_id FROM whaleu_messaging.owner_states WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',
      [[c.account0, c.account1]],
    );
    await tx.query(
      'UPDATE whaleu_messaging.owner_states SET inbox_epoch=inbox_epoch+1 WHERE account_id=ANY($1::uuid[])',
      [[c.account0, c.account1]],
    );
  }
  async recount(id: string, tx: PoolClient) {
    await tx.query(
      `UPDATE whaleu_messaging.participants p SET unread_count=(SELECT count(*) FROM whaleu_messaging.messages m WHERE m.conversation_id=p.conversation_id AND m.sender_slot<>p.slot AND m.message_seq>greatest(p.read_through_seq,p.hidden_through_seq) AND m.recalled_at IS NULL) WHERE p.conversation_id=$1`,
      [id],
    );
  }
  async observation(
    actor: string,
    c: Conversation,
    tx: PoolClient,
    through = c.next_message_seq,
  ) {
    await tx.query(
      `DELETE FROM whaleu_messaging.observations WHERE account_id=$1 AND (valid_until<=clock_timestamp() OR id IN (SELECT id FROM whaleu_messaging.observations WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET 63))`,
      [actor],
    );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_messaging.observations(id,account_id,conversation_id,through_seq,valid_until) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes')`,
      [id, actor, c.id, through],
    );
    return id;
  }
  async quota(
    scope: string,
    kind: 'send_actor' | 'send_conversation' | 'open' | 'first_contact',
    limit: number,
    seconds: number,
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ used: number }>(
        `INSERT INTO whaleu_messaging.rate_budgets(scope,kind,window_start,used) VALUES($1,$2,to_timestamp(floor(extract(epoch FROM clock_timestamp())/$3)*$3),1) ON CONFLICT(scope,kind,window_start) DO UPDATE SET used=whaleu_messaging.rate_budgets.used+1 WHERE whaleu_messaging.rate_budgets.used<$4 RETURNING used`,
        [scope, kind, seconds, limit],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('DM_RATE_LIMITED');
    await tx.query(
      `DELETE FROM whaleu_messaging.rate_budgets WHERE scope=$1 AND window_start<clock_timestamp()-interval '2 hours'`,
      [scope],
    );
  }
}
export function dmDigest(value: unknown) {
  return createHash('sha256')
    .update('whaleu:dm:v1\n' + canonicalJson(value))
    .digest('hex');
}
export function safeCount(v: string) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ApplicationError('DM_UNAVAILABLE');
  return n;
}
