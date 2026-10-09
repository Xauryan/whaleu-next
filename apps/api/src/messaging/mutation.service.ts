import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import { MessagingAccess } from './access.js';
import { MessagingRequests } from './requests.js';
import { MessagingRepository, dmDigest } from './repository.js';
import type { Conversation, Message } from './repository.js';
import type { dmOpenSchema, dmSendSchema } from './contracts.js';
import { CommunityDmEntryFacade } from '../community/dm-entry.facade.js';
import { DmContentReviewFacade } from '../community/content-review/dm-content-review.facade.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
const recallProof: RequiredTransactionProof<{ messageId: string }> = {
  maximumFacts: 1,
  failureCode: 'DM_RECALL_EXPIRED',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DM_RECALL_EXPIRED', async (read) => {
      for (const f of facts) {
        const row = (
          await read.query<{ allowed: boolean }>(
            `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT whaleu_messaging.recall_allowed(created_at,instant.now) AS allowed FROM whaleu_messaging.messages CROSS JOIN instant WHERE id=$1`,
            [f.messageId],
          )
        ).rows[0];
        if (row?.allowed !== true)
          throw new ApplicationError('DM_RECALL_EXPIRED');
      }
    }),
};
const result = (
  conversationId: string,
  messageId: string | null = null,
  outcome: 'applied' | 'noop' = 'applied',
  at = new Date(),
) => ({ conversationId, messageId, outcome, occurredAt: at.toISOString() });
@Injectable()
export class MessagingMutationService {
  constructor(
    @Inject(MessagingAccess) private readonly access: MessagingAccess,
    @Inject(MessagingRequests) private readonly requests: MessagingRequests,
    @Inject(MessagingRepository) private readonly records: MessagingRepository,
    @Inject(CommunityDmEntryFacade)
    private readonly sources: CommunityDmEntryFacade,
    @Inject(DmContentReviewFacade)
    private readonly review: DmContentReviewFacade,
  ) {}
  private async now(tx: PoolClient) {
    return (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))
      .rows[0]!.now;
  }
  open(token: string, body: z.infer<typeof dmOpenSchema>) {
    return this.requests.execute(
      token,
      body.clientRequestId,
      'open',
      body,
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        await this.records.quota(actor, 'open', 20, 60, tx);
        let entry = await this.sources.resolve(
          actor,
          body.entry,
          body.initiationMode,
          tx,
        );
        if (
          entry.peerAccountId === actor ||
          !(await this.access.identity.dmActiveAccount(entry.peerAccountId, tx))
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        if (
          entry.actorMode === 'named' &&
          entry.peerMode === 'named' &&
          !(await this.access.safety.namedAllowed(
            actor,
            entry.peerAccountId,
            tx,
          ))
        )
          throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
        const pair = [actor, entry.peerAccountId].sort(),
          actorSlot = pair[0] === actor ? 0 : 1;
        const modes =
          actorSlot === 0
            ? [entry.actorMode, entry.peerMode]
            : [entry.peerMode, entry.actorMode];
        const sourceKey = entry.sourcePostId ?? 'profile-direct';
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify(['whaleu:dm-context:v1', pair, sourceKey, modes]),
        ]);
        let c = (
          await tx.query<Conversation>(
            'SELECT * FROM whaleu_messaging.conversations WHERE account0=$1 AND account1=$2 AND source_key=$3 AND mode0=$4 AND mode1=$5 FOR UPDATE',
            [...pair, sourceKey, ...modes],
          )
        ).rows[0];
        if (c) {
          const state = await this.records.member(c.id, actor, tx);
          if (state.self.blocked_at || state.peer.blocked_at)
            throw new ApplicationError('DM_ENTRY_UNAVAILABLE');
          await tx.query(
            'UPDATE whaleu_messaging.participants SET hidden_at=NULL WHERE conversation_id=$1 AND account_id=$2',
            [c.id, actor],
          );
        } else {
          await this.records.quota(actor, 'first_contact', 5, 3600, tx);
          entry = await this.sources.materialize(entry, tx);
          const id = randomUUID();
          const context = {
            version: 1,
            sourcePostId: entry.sourcePostId,
            accounts: pair,
            modes,
            provenance: entry.provenance,
            displays:
              actorSlot === 0
                ? [entry.actorDisplay, entry.peerDisplay]
                : [entry.peerDisplay, entry.actorDisplay],
          };
          c = (
            await tx.query<Conversation>(
              'INSERT INTO whaleu_messaging.conversations(id,account0,account1,mode0,mode1,source_key,source_post_id,context,context_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *',
              [
                id,
                ...pair,
                ...modes,
                sourceKey,
                entry.sourcePostId,
                JSON.stringify(context),
                dmDigest(context),
              ],
            )
          ).rows[0]!;
          for (const slot of [0, 1] as const)
            await tx.query(
              'INSERT INTO whaleu_messaging.participants(conversation_id,slot,account_id,mode,display) VALUES($1,$2,$3,$4,$5::jsonb)',
              [
                id,
                slot,
                pair[slot],
                modes[slot],
                JSON.stringify(context.displays[slot]),
              ],
            );
        }
        await tx.query(
          'INSERT INTO whaleu_messaging.entry_provenance(account_id,request_id,conversation_id,provenance) VALUES($1,$2,$3,$4::jsonb)',
          [
            actor,
            body.clientRequestId,
            c.id,
            JSON.stringify({
              ...entry.provenance,
              conversationContextDigest: c.context_digest,
            }),
          ],
        );
        await this.records.bump(c, tx);
        return result(c.id, null, 'applied', await this.now(tx));
      },
    );
  }
  send(token: string, id: string, body: z.infer<typeof dmSendSchema>) {
    return this.requests.execute(
      token,
      body.clientRequestId,
      'send',
      { conversationId: id, ...body },
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        await this.records.quota(actor, 'send_actor', 20, 60, tx);
        const {
          conversation: c,
          self,
          peer,
        } = await this.records.member(id, actor, tx);
        if (
          !(await this.access.identity.dmActiveAccount(peer.account_id, tx)) ||
          self.blocked_at ||
          peer.blocked_at
        )
          throw new ApplicationError('DM_SEND_UNAVAILABLE');
        if (
          c.mode0 === 'named' &&
          c.mode1 === 'named' &&
          !(await this.access.safety.namedAllowed(actor, peer.account_id, tx))
        )
          throw new ApplicationError('DM_SEND_UNAVAILABLE');
        if (peer.lifetime_sent === '0' && self.lifetime_sent !== '0')
          throw new ApplicationError('DM_FIRST_CONTACT_LIMIT');
        await this.records.quota(id, 'send_conversation', 10, 60, tx);
        const envelope = {
          version: 1 as const,
          purpose: 'send_private_message' as const,
          accountId: actor,
          clientRequestId: body.clientRequestId,
          conversationId: id,
          contextDigest: c.context_digest,
          senderSlot: self.slot,
          participantModes: [c.mode0, c.mode1] as [
            'named' | 'anonymous',
            'named' | 'anonymous',
          ],
          text: body.text,
          assetIds: [] as [],
        };
        const accepted = await this.review.accepted(envelope, tx),
          messageId = randomUUID();
        const updated = (
          await tx.query<Conversation>(
            'UPDATE whaleu_messaging.conversations SET next_message_seq=next_message_seq+1,next_event_seq=next_event_seq+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [id],
          )
        ).rows[0]!;
        const message = (
          await tx.query<Message>(
            'INSERT INTO whaleu_messaging.messages(id,conversation_id,message_seq,sender_slot,sender_id,request_id,body,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *',
            [
              messageId,
              id,
              updated.next_message_seq,
              self.slot,
              actor,
              body.clientRequestId,
              body.text,
              JSON.stringify(envelope),
            ],
          )
        ).rows[0]!;
        await this.review.bind(
          accepted,
          {
            messageId,
            conversationId: id,
            senderSlot: self.slot,
            sequence: message.message_seq,
            envelope,
          },
          tx,
        );
        await tx.query(
          'UPDATE whaleu_messaging.participants SET lifetime_sent=lifetime_sent+1 WHERE conversation_id=$1 AND slot=$2',
          [id, self.slot],
        );
        await tx.query(
          'UPDATE whaleu_messaging.participants SET hidden_at=NULL WHERE conversation_id=$1 AND slot=$2',
          [id, peer.slot],
        );
        await this.records.recount(id, tx);
        await tx.query(
          "INSERT INTO whaleu_messaging.events(conversation_id,event_seq,kind,message_id) VALUES($1,$2,'sent',$3)",
          [id, updated.next_event_seq, messageId],
        );
        await tx.query(
          'INSERT INTO whaleu_messaging.outbox(id,message_id,recipient_id) VALUES($1,$2,$3)',
          [randomUUID(), messageId, peer.account_id],
        );
        await this.records.bump(c, tx);
        return result(id, messageId, 'applied', message.created_at);
      },
    );
  }
  read(token: string, id: string, requestId: string, observationId: string) {
    return this.requests.execute(
      token,
      requestId,
      'read',
      { conversationId: id, clientRequestId: requestId, observationId },
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        const { conversation: c, self } = await this.records.member(
          id,
          actor,
          tx,
        );
        const observation = (
          await tx.query<{ through_seq: string; valid_until: Date }>(
            `SELECT through_seq,valid_until FROM whaleu_messaging.observations WHERE id=$1 AND account_id=$2 AND conversation_id=$3 AND valid_until>clock_timestamp() FOR SHARE`,
            [observationId, actor, id],
          )
        ).rows[0];
        if (
          !observation ||
          BigInt(observation.through_seq) > BigInt(c.next_message_seq)
        )
          throw new ApplicationError('DM_OBSERVATION_UNAVAILABLE');
        registerTransactionDeadline(
          tx,
          observation.valid_until.getTime(),
          'DM_OBSERVATION_UNAVAILABLE',
        );
        const changed =
          BigInt(observation.through_seq) > BigInt(self.read_through_seq);
        await tx.query(
          'UPDATE whaleu_messaging.participants SET read_through_seq=greatest(read_through_seq,$3::bigint) WHERE conversation_id=$1 AND account_id=$2',
          [id, actor, observation.through_seq],
        );
        await this.records.recount(id, tx);
        await this.records.bump(c, tx);
        return result(
          id,
          null,
          changed ? 'applied' : 'noop',
          await this.now(tx),
        );
      },
    );
  }
  visibility(
    token: string,
    id: string,
    requestId: string,
    operation: 'hide' | 'reopen',
  ) {
    return this.requests.execute(
      token,
      requestId,
      operation,
      { conversationId: id, clientRequestId: requestId },
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        const { conversation: c, self } = await this.records.member(
          id,
          actor,
          tx,
        );
        if (operation === 'hide')
          await tx.query(
            'UPDATE whaleu_messaging.participants SET hidden_at=clock_timestamp(),hidden_through_seq=$3,unread_count=0 WHERE conversation_id=$1 AND account_id=$2',
            [id, actor, c.next_message_seq],
          );
        else
          await tx.query(
            'UPDATE whaleu_messaging.participants SET hidden_at=NULL WHERE conversation_id=$1 AND account_id=$2',
            [id, actor],
          );
        await this.records.bump(c, tx);
        return result(
          id,
          null,
          operation === 'hide'
            ? self.hidden_at
              ? 'noop'
              : 'applied'
            : self.hidden_at
              ? 'applied'
              : 'noop',
          await this.now(tx),
        );
      },
    );
  }
  recall(token: string, id: string, messageId: string, requestId: string) {
    return this.requests.execute(
      token,
      requestId,
      'recall',
      { conversationId: id, messageId, clientRequestId: requestId },
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        const { conversation: c, self } = await this.records.member(
          id,
          actor,
          tx,
        );
        const m = (
          await tx.query<Message & { in_window: boolean }>(
            `SELECT *,whaleu_messaging.recall_allowed(created_at,clock_timestamp()) AS in_window FROM whaleu_messaging.messages WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
            [messageId, id],
          )
        ).rows[0];
        if (!m || m.sender_slot !== self.slot)
          throw new ApplicationError('DM_NOT_FOUND');
        if (m.recalled_at) return result(id, messageId, 'noop', m.recalled_at);
        if (!m.in_window) throw new ApplicationError('DM_RECALL_EXPIRED');
        enableRequiredTransactionProof(tx, recallProof);
        registerRequiredTransactionFact(tx, recallProof, messageId, {
          messageId,
        });
        const updated = (
          await tx.query<Conversation>(
            'UPDATE whaleu_messaging.conversations SET next_event_seq=next_event_seq+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [id],
          )
        ).rows[0]!;
        const at = (
          await tx.query<{ recalled_at: Date }>(
            'UPDATE whaleu_messaging.messages SET recalled_at=clock_timestamp() WHERE id=$1 RETURNING recalled_at',
            [messageId],
          )
        ).rows[0]!.recalled_at;
        await tx.query(
          "INSERT INTO whaleu_messaging.events(conversation_id,event_seq,kind,message_id) VALUES($1,$2,'recalled',$3)",
          [id, updated.next_event_seq, messageId],
        );
        await tx.query(
          "UPDATE whaleu_messaging.outbox SET state='suppressed' WHERE message_id=$1",
          [messageId],
        );
        await this.records.recount(id, tx);
        await this.records.bump(c, tx);
        return result(id, messageId, 'applied', at);
      },
    );
  }
  block(token: string, id: string, requestId: string) {
    return this.requests.execute(
      token,
      requestId,
      'block',
      { conversationId: id, clientRequestId: requestId },
      async (actor, tx) => {
        await this.records.coverage(actor, tx);
        const {
          conversation: c,
          self,
          peer,
        } = await this.records.member(id, actor, tx);
        const namedChange =
          peer.mode === 'named'
            ? await this.access.safety.blockNamed(
                actor,
                peer.account_id,
                requestId,
                tx,
              )
            : null;
        if (c.mode0 === 'anonymous' || c.mode1 === 'anonymous')
          await tx.query(
            'UPDATE whaleu_messaging.participants SET blocked_at=coalesce(blocked_at,clock_timestamp()),blocked_request_id=coalesce(blocked_request_id,$3::uuid) WHERE conversation_id=$1 AND account_id=$2',
            [id, actor, requestId],
          );
        await tx.query(
          "UPDATE whaleu_messaging.outbox o SET state='suppressed' FROM whaleu_messaging.messages m WHERE m.id=o.message_id AND m.conversation_id=$1",
          [id],
        );
        await this.records.bump(c, tx);
        return result(
          id,
          null,
          namedChange?.changed ||
            ((c.mode0 === 'anonymous' || c.mode1 === 'anonymous') &&
              !self.blocked_at)
            ? 'applied'
            : 'noop',
          await this.now(tx),
        );
      },
    );
  }
}
