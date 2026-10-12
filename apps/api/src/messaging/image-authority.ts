import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { MessagingAccess } from './access.js';
import { MessagingRepository, dmDigest } from './repository.js';
import type { Message } from './repository.js';
import { canonicalDmEnvelope } from '../community/content-review/dm-contracts.js';
import { DmContentReviewFacade } from '../community/content-review/dm-content-review.facade.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { PrivateMessageMediaAccessPort } from './media/access-port.js';
import type {
  PreparePrivateMessageMediaInput,
  PrivateMessageMediaBinding,
} from '../media/contracts-private-message.js';
export async function lockImageCommand(
  actor: string,
  requestId: string,
  tx: PoolClient,
) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify(['whaleu:dm-image-command:v1', actor, requestId]),
  ]);
}
async function currentSnapshot(conversationId: string, tx: PoolClient) {
  const c = (
    await tx.query(
      'SELECT id,account0,account1,mode0,mode1,context_digest FROM whaleu_messaging.conversations WHERE id=$1',
      [conversationId],
    )
  ).rows[0];
  const p = (
    await tx.query(
      'SELECT slot,account_id,mode,blocked_at FROM whaleu_messaging.participants WHERE conversation_id=$1 ORDER BY slot',
      [conversationId],
    )
  ).rows;
  return ownerFingerprint({ c, p });
}
const proof: RequiredTransactionProof<{
  conversationId: string;
  fingerprint: string;
}> = {
  maximumFacts: 1,
  failureCode: 'MEDIA_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MEDIA_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_messaging.conversations,whaleu_messaging.participants IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          (await currentSnapshot(fact.conversationId, read)) !==
          fact.fingerprint
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
    }),
};
/** Messaging alone grants prepare and retained-history authority. Neither filenames,
 * source-post availability, hidden flags nor administrative roles grant pixels. */
@Injectable()
export class MessagingImageAuthority implements PrivateMessageMediaAccessPort {
  constructor(
    @Inject(MessagingAccess) private readonly access: MessagingAccess,
    @Inject(MessagingRepository) private readonly records: MessagingRepository,
    @Inject(DmContentReviewFacade)
    private readonly review: DmContentReviewFacade,
  ) {}
  async authorizePrepare(
    actor: string,
    input: PreparePrivateMessageMediaInput,
    tx: PoolClient,
  ) {
    await lockImageCommand(actor, input.messageRequestId, tx);
    await this.access.require(actor, tx);
    await this.records.coverage(actor, tx);
    const {
      conversation: c,
      self,
      peer,
    } = await this.records.member(input.conversationId, actor, tx);
    if (
      self.blocked_at ||
      peer.blocked_at ||
      !(await this.access.identity.dmActiveAccount(peer.account_id, tx)) ||
      (c.mode0 === 'named' &&
        c.mode1 === 'named' &&
        !(await this.access.safety.namedAllowed(actor, peer.account_id, tx)))
    )
      throw new ApplicationError('DM_SEND_UNAVAILABLE');
    if (peer.lifetime_sent === '0' && self.lifetime_sent !== '0')
      throw new ApplicationError('DM_FIRST_CONTACT_LIMIT');
    if (
      (
        await tx.query(
          'SELECT 1 FROM whaleu_messaging.image_command_fences WHERE account_id=$1 AND request_id=$2 UNION ALL SELECT 1 FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2',
          [actor, input.messageRequestId],
        )
      ).rowCount
    )
      throw new ApplicationError('DM_SEND_UNAVAILABLE');
    await tx.query(
      'INSERT INTO whaleu_messaging.image_command_reservations(account_id,request_id,conversation_id,context_digest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [actor, input.messageRequestId, c.id, c.context_digest],
    );
    const reservation = (
      await tx.query<{ conversation_id: string; context_digest: string }>(
        'SELECT conversation_id,context_digest FROM whaleu_messaging.image_command_reservations WHERE account_id=$1 AND request_id=$2',
        [actor, input.messageRequestId],
      )
    ).rows[0];
    if (
      reservation?.conversation_id !== c.id ||
      reservation.context_digest !== c.context_digest
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    await this.capture(c.id, tx);
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    return {
      actorAccountId: actor,
      conversationId: c.id,
      messageRequestId: input.messageRequestId,
      contextDigest: c.context_digest,
      expiresAt: now.getTime() + 30 * 60 * 1000,
    };
  }
  private async capture(conversationId: string, tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, conversationId, {
      conversationId,
      fingerprint: await currentSnapshot(conversationId, tx),
    });
  }
  async retainCurrent(_tx: PoolClient): Promise<void> {
    /* Methods enroll exact owner proof themselves. */
  }
  async assertSendFenced(
    actor: string,
    target: { conversationId: string; messageRequestId: string },
    tx: PoolClient,
  ) {
    await lockImageCommand(actor, target.messageRequestId, tx);
    const request = (
      await tx.query<{
        operation: string;
        receipt: { outcome: string } | null;
      }>(
        'SELECT operation,receipt FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, target.messageRequestId],
      )
    ).rows[0];
    if (
      request &&
      (request.operation !== 'send_image' ||
        request.receipt?.outcome !== 'rejected')
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const row =
      (
        await tx.query<{ conversation_id: string }>(
          'INSERT INTO whaleu_messaging.image_command_fences(account_id,request_id,conversation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING conversation_id',
          [actor, target.messageRequestId, target.conversationId],
        )
      ).rows[0] ??
      (
        await tx.query<{ conversation_id: string }>(
          'SELECT conversation_id FROM whaleu_messaging.image_command_fences WHERE account_id=$1 AND request_id=$2',
          [actor, target.messageRequestId],
        )
      ).rows[0];
    if (row?.conversation_id !== target.conversationId)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
  }
  async authorizeRead(
    token: string,
    target: { conversationId: string; messageId: string; bindingId?: string },
    tx: PoolClient,
  ) {
    const session = await this.access.authenticate(token, tx);
    const actor = session.accountId;
    await this.access.require(actor, tx);
    await this.records.coverage(actor, tx);
    const { conversation: c } = await this.records.member(
      target.conversationId,
      actor,
      tx,
    );
    const m = (
      await tx.query<Message>(
        'SELECT * FROM whaleu_messaging.messages WHERE id=$1 AND conversation_id=$2 FOR SHARE',
        [target.messageId, c.id],
      )
    ).rows[0];
    if (!m || m.recalled_at) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const envelope = canonicalDmEnvelope(m.envelope);
    if (envelope.version !== 2) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const decision = await this.review.current(
      {
        messageId: m.id,
        conversationId: c.id,
        senderSlot: m.sender_slot,
        sequence: m.message_seq,
        envelope,
      },
      tx,
    );
    if (decision.kind !== 'allow')
      throw new ApplicationError(
        decision.kind === 'deny'
          ? 'MEDIA_UNAVAILABLE'
          : 'CONTENT_REVIEW_UNAVAILABLE',
      );
    const image = await this.imageBinding(m, tx);
    if (target.bindingId && target.bindingId !== image.bindingId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.capture(c.id, tx);
    await this.access.final(token, tx);
    return {
      accountId: actor,
      sessionId: session.sessionId,
      actorAccountId: m.sender_id,
      conversationId: c.id,
      messageId: m.id,
      messageRequestId: m.request_id,
      contextDigest: c.context_digest,
      ownerRevision: dmDigest({
        message: m.id,
        request: m.request_id,
        envelope,
        decision: decision.value.digest,
      }),
      image,
    };
  }
  async imageBinding(
    m: Message,
    tx: PoolClient,
  ): Promise<PrivateMessageMediaBinding> {
    const envelope = canonicalDmEnvelope(m.envelope);
    if (envelope.version !== 2) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const row = (
      await tx.query<{ binding_id: string }>(
        'SELECT binding_id FROM whaleu_media.private_message_appearances WHERE message_id=$1 AND asset_id=$2 AND manifest_digest=$3',
        [m.id, envelope.image.assetId, envelope.image.manifestDigest],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { ...envelope.image, bindingId: row.binding_id };
  }
}
