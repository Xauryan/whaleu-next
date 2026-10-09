import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { MessagingAccess } from './access.js';
import { MessagingRepository, safeCount } from './repository.js';
import type { Conversation, Participant, Message } from './repository.js';
import {
  dmConversationSchema,
  dmMessageSchema,
  dmListSchema,
  dmHistorySchema,
  dmEventsSchema,
  dmUnreadSchema,
} from './contracts.js';
import { encodeDmCursor, decodeDmCursor } from './cursor.js';
import { DmContentReviewFacade } from '../community/content-review/dm-content-review.facade.js';
import { canonicalDmEnvelope } from '../community/content-review/dm-contracts.js';
import { CommunityDmEntryFacade } from '../community/dm-entry.facade.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
const inboxProof: RequiredTransactionProof<{ actor: string; epoch: string }> = {
  maximumFacts: 1,
  failureCode: 'DM_CURSOR_STALE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DM_CURSOR_STALE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_messaging.owner_states IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const current =
          (
            await read.query<{ inbox_epoch: string }>(
              'SELECT inbox_epoch FROM whaleu_messaging.owner_states WHERE account_id=$1',
              [f.actor],
            )
          ).rows[0]?.inbox_epoch ?? '0';
        if (current !== f.epoch) throw new ApplicationError('DM_CURSOR_STALE');
      }
    }),
};
@Injectable()
export class MessagingReadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MessagingAccess) private readonly access: MessagingAccess,
    @Inject(MessagingRepository) private readonly records: MessagingRepository,
    @Inject(DmContentReviewFacade)
    private readonly review: DmContentReviewFacade,
    @Inject(CommunityDmEntryFacade)
    private readonly sources: CommunityDmEntryFacade,
    @Inject(AuthorDisplayService)
    private readonly display: AuthorDisplayService,
  ) {}
  private read<T>(
    token: string,
    work: (actor: string, tx: PoolClient) => Promise<T>,
    phone = true,
  ) {
    return this.database.transaction(
      async (tx) => {
        const { accountId: actor } = await this.access.authenticate(token, tx);
        await this.access.require(actor, tx, phone);
        const value = await work(actor, tx);
        await this.access.final(token, tx);
        return value;
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async view(
    actor: string,
    c: Conversation,
    self: Participant,
    peer: Participant,
    tx: PoolClient,
  ) {
    const named = c.mode0 === 'named' && c.mode1 === 'named';
    const state = named
      ? await this.access.safety.namedState(actor, peer.account_id, tx)
      : { allowed: true, blockedByYou: false };
    const peerActive = await this.access.identity.dmActiveAccount(
      peer.account_id,
      tx,
    );
    const project = async (p: Participant) => {
      if (p.mode === 'anonymous')
        return {
          mode: 'anonymous' as const,
          displayName: p.display.displayName,
          profileId: null,
        };
      if (
        !named ||
        !state.allowed ||
        self.blocked_at ||
        peer.blocked_at ||
        (p.slot === peer.slot && !peerActive)
      )
        // A mixed-context named profile ID is only the already-known, frozen
        // navigation locator. Never consult a hidden pair or refresh its profile
        // here; explicit public-profile navigation independently reauthorizes.
        return {
          mode: 'named' as const,
          displayName: p.display.displayName,
          profileId:
            !named &&
            !self.blocked_at &&
            !peer.blocked_at &&
            (p.slot !== peer.slot || peerActive)
              ? p.display.profileId
              : null,
        };
      const d = await this.display.findPublic(p.account_id, tx);
      return {
        mode: 'named' as const,
        displayName: d?.displayName ?? p.display.displayName,
        profileId: d?.profileId ?? null,
      };
    };
    const own = !!self.blocked_at || state.blockedByYou;
    const unavailable = !!peer.blocked_at || !state.allowed || !peerActive;
    return dmConversationSchema.parse({
      id: c.id,
      self: await project(self),
      peer: await project(peer),
      source: c.source_post_id
        ? {
            kind: 'post',
            postId: c.source_post_id,
            available: await this.sources.sourceAvailable(
              actor,
              c.source_post_id,
              tx,
            ),
          }
        : null,
      unreadCount: safeCount(self.unread_count),
      hidden: !!self.hidden_at,
      sendAvailability: own
        ? 'blocked_by_you'
        : unavailable
          ? 'unavailable'
          : peer.lifetime_sent === '0' && self.lifetime_sent !== '0'
            ? 'awaiting_reply'
            : 'available',
      blockScope: named
        ? 'named'
        : peer.mode === 'named'
          ? 'named_and_conversation'
          : 'conversation',
      blockedByYou: own,
    });
  }
  private async message(m: Message, self: Participant, tx: PoolClient) {
    let state: 'text' | 'recalled' | 'unavailable' = m.recalled_at
      ? 'recalled'
      : 'text';
    if (state === 'text') {
      const decision = await this.review.current(
        {
          messageId: m.id,
          conversationId: m.conversation_id,
          senderSlot: m.sender_slot,
          sequence: m.message_seq,
          envelope: canonicalDmEnvelope(m.envelope),
        },
        tx,
      );
      if (decision.kind === 'unavailable')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      if (decision.kind === 'deny') state = 'unavailable';
    }
    const row = (
      await tx.query<{ allowed: boolean }>(
        'SELECT whaleu_messaging.recall_allowed(created_at,clock_timestamp()) AS allowed FROM whaleu_messaging.messages WHERE id=$1',
        [m.id],
      )
    ).rows[0];
    return dmMessageSchema.parse({
      id: m.id,
      sequence: m.message_seq,
      sender: m.sender_slot === self.slot ? 'self' : 'peer',
      state,
      text: state === 'text' ? m.body : null,
      createdAt: m.created_at.toISOString(),
      canRecall:
        m.sender_slot === self.slot && !m.recalled_at && row?.allowed === true,
    });
  }
  conversation(token: string, id: string) {
    return this.read(token, async (actor, tx) => {
      await this.records.coverage(actor, tx);
      const { conversation, self, peer } = await this.records.member(
        id,
        actor,
        tx,
      );
      return this.view(actor, conversation, self, peer, tx);
    });
  }
  list(token: string, query: { cursor?: string; limit: number }) {
    return this.read(token, async (actor, tx) => {
      const coverage = await this.records.coverage(actor, tx),
        epoch = await this.records.epoch(actor, tx);
      enableRequiredTransactionProof(tx, inboxProof);
      registerRequiredTransactionFact(tx, inboxProof, actor, { actor, epoch });
      const cursor = query.cursor
        ? decodeDmCursor(query.cursor, actor, 'list', null, query.limit)
        : null;
      if (cursor && cursor.epoch !== epoch)
        throw new ApplicationError('DM_CURSOR_STALE');
      const rows = (
        await tx.query<{ id: string; updated_at: Date; order_at: string }>(
          `SELECT c.id,c.updated_at,to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') order_at FROM whaleu_messaging.conversations c JOIN whaleu_messaging.participants p ON p.conversation_id=c.id WHERE p.account_id=$1 AND p.hidden_at IS NULL AND c.next_message_seq>0 AND ($2::timestamptz IS NULL OR (c.updated_at,c.id)<($2,$3::uuid)) ORDER BY c.updated_at DESC,c.id DESC LIMIT $4`,
          [actor, cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
        )
      ).rows;
      const selected = rows.slice(0, query.limit);
      const states = new Map<
        string,
        Awaited<ReturnType<MessagingRepository['member']>>
      >();
      for (const row of [...selected].sort((a, b) => a.id.localeCompare(b.id)))
        states.set(row.id, await this.records.member(row.id, actor, tx));
      const items = [];
      for (const row of selected) {
        const { conversation: c, self, peer } = states.get(row.id)!;
        const m = (
          await tx.query<Message>(
            'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1 ORDER BY message_seq DESC LIMIT 1',
            [c.id],
          )
        ).rows[0];
        items.push({
          conversation: await this.view(actor, c, self, peer, tx),
          latest: m ? await this.message(m, self, tx) : null,
          updatedAt: c.updated_at.toISOString(),
        });
      }
      const last = rows[Math.min(rows.length, query.limit) - 1];
      return dmListSchema.parse({
        items,
        coverage,
        nextCursor:
          rows.length > query.limit && last
            ? encodeDmCursor(actor, {
                purpose: 'list',
                conversation: null,
                sequence: '0',
                epoch,
                at: last.order_at,
                id: last.id,
                limit: query.limit,
              })
            : null,
      });
    });
  }
  unread(token: string) {
    return this.read(
      token,
      async (actor, tx) => {
        const coverage = await this.records.coverage(actor, tx);
        const row = (
          await tx.query<{ count: string }>(
            'SELECT coalesce(sum(unread_count),0)::text count FROM whaleu_messaging.participants WHERE account_id=$1 AND hidden_at IS NULL',
            [actor],
          )
        ).rows[0]!;
        return dmUnreadSchema.parse({ count: safeCount(row.count), coverage });
      },
      false,
    );
  }
  history(
    token: string,
    id: string,
    query: { cursor?: string; limit: number },
  ) {
    return this.read(token, async (actor, tx) => {
      const coverage = await this.records.coverage(actor, tx),
        { conversation: c, self } = await this.records.member(id, actor, tx);
      const cursor = query.cursor
        ? decodeDmCursor(query.cursor, actor, 'history', id, query.limit)
        : null;
      const rows = (
        await tx.query<Message>(
          'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR message_seq<$2) ORDER BY message_seq DESC LIMIT $3',
          [id, cursor?.sequence ?? null, query.limit + 1],
        )
      ).rows;
      const selected = rows.slice(0, query.limit).reverse(),
        items = [];
      for (const m of selected) items.push(await this.message(m, self, tx));
      const through = selected.at(-1)?.message_seq ?? '0';
      const observationId = await this.records.observation(
        actor,
        c,
        tx,
        through,
      );
      return dmHistorySchema.parse({
        items,
        coverage,
        observationId,
        throughSequence: through,
        eventCursor: encodeDmCursor(actor, {
          purpose: 'events',
          conversation: id,
          sequence: c.next_event_seq,
          epoch: '0',
          at: null,
          id: null,
          limit: query.limit,
        }),
        nextCursor:
          rows.length > query.limit && selected[0]
            ? encodeDmCursor(actor, {
                purpose: 'history',
                conversation: id,
                sequence: selected[0].message_seq,
                epoch: '0',
                at: null,
                id: null,
                limit: query.limit,
              })
            : null,
      });
    });
  }
  events(token: string, id: string, query: { cursor?: string; limit: number }) {
    return this.read(token, async (actor, tx) => {
      await this.records.coverage(actor, tx);
      const { conversation: c, self } = await this.records.member(
        id,
        actor,
        tx,
      );
      if (!query.cursor) throw new ApplicationError('DM_CURSOR_STALE');
      const cursor = decodeDmCursor(
        query.cursor,
        actor,
        'events',
        id,
        query.limit,
      );
      if (BigInt(cursor.sequence) > BigInt(c.next_event_seq))
        throw new ApplicationError('DM_CURSOR_STALE');
      const rows = (
        await tx.query<
          Message & { event_seq: string; event_kind: 'sent' | 'recalled' }
        >(
          'SELECT m.*,e.event_seq,e.kind event_kind FROM whaleu_messaging.events e JOIN whaleu_messaging.messages m ON m.id=e.message_id WHERE e.conversation_id=$1 AND e.event_seq>$2 ORDER BY e.event_seq ASC LIMIT $3',
          [id, cursor.sequence, query.limit + 1],
        )
      ).rows;
      const selected = rows.slice(0, query.limit),
        items = [];
      let through = 0n;
      for (const m of selected) {
        items.push({
          sequence: m.event_seq,
          kind: m.event_kind,
          message: await this.message(m, self, tx),
        });
        if (m.event_kind === 'sent' && BigInt(m.message_seq) > through)
          through = BigInt(m.message_seq);
      }
      const observationId = await this.records.observation(
        actor,
        c,
        tx,
        through.toString(),
      );
      return dmEventsSchema.parse({
        items,
        hasMore: rows.length > query.limit,
        observationId,
        throughSequence: through.toString(),
        nextCursor: encodeDmCursor(actor, {
          purpose: 'events',
          conversation: id,
          sequence: selected.at(-1)?.event_seq ?? cursor.sequence,
          epoch: '0',
          at: null,
          id: null,
          limit: query.limit,
        }),
      });
    });
  }
}
