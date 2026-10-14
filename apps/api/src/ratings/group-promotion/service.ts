import { currentPromotionProfile } from './profile.js';
import { requireRatingPromotionSession } from '../../identity/rating-promotion-session.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import type { SessionView } from '../../identity/contracts.js';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import {
  RATING_GROUP_PROMOTION_RUNTIME,
  campaignInput,
  commandHash,
  deterministicCopy,
  intentInput,
  limits,
  previewInput,
  sourceBindingSchema,
  type CampaignInput,
  type Command,
  type IntentInput,
  type PreviewInput,
  type Program,
  type RatingGroupPromotionRuntime,
} from './contracts.js';
import {
  promotionDatabaseError,
  promotionTransactionBudget,
  retainPromotion,
} from './proof.js';
interface IntentRow {
  request_id: string;
  program_id: string;
  actor: string;
  preview_id: string;
  command: Command;
  request_hash: string;
  ticket: string;
  expires_at: Date;
}
export interface CampaignRow {
  id: string;
  request_id: string;
  program_id: string;
  actor: string;
  request_hash: string;
  command: Command;
  program_revision: string;
  source_hash: string;
  audience_epoch: string;
  grant_revision: string;
  grant_epoch: string;
  created_at: Date;
  expires_at: Date;
  compose_by: Date;
  mode: 'normal' | 'test';
  recipient_count: number;
  cursor: string | null;
  payload: import('./contracts.js').FrozenPayload | null;
  payload_hash: string | null;
  qualification_hash: string | null;
  copy_provenance: string | null;
  cancelled_at: Date | null;
  payload_purged_at: Date | null;
  source_withdrawn: boolean;
  originating_session_id: string | null;
  principal_kind: 'operator' | 'service';
}
@Injectable()
export class RatingGroupPromotionService {
  private readonly sessions = new WeakMap<PoolClient, SessionView>();
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RATING_GROUP_PROMOTION_RUNTIME)
    readonly runtime: RatingGroupPromotionRuntime | null,
  ) {}
  run<T>(work: (tx: PoolClient) => Promise<T>, ms = 3000) {
    return this.db
      .transaction(
        async (tx) => {
          await promotionTransactionBudget(tx, ms);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      )
      .catch(promotionDatabaseError);
  }
  async verifyRuntime(tx: PoolClient): Promise<void> {
    const rt = this.enabled();
    const binding = (
      await tx.query<{
        domain_id: string;
        ledger_instance_id: string;
        restore_epoch: string;
        sender_store_id: string;
        generation_store_id: string | null;
        shortlink_store_id: string | null;
      }>(
        `SELECT * FROM whaleu_notifications.rating_group_restore_binding WHERE singleton FOR SHARE`,
      )
    ).rows[0];
    if (!binding || binding.domain_id !== rt.domainId)
      throw new ApplicationError('PROMOTION_UNAVAILABLE');
    for (const [port, id] of [
      [rt.sender, binding.sender_store_id],
      [rt.generation, binding.generation_store_id],
      [rt.shortlinks, binding.shortlink_store_id],
    ] as const) {
      if (!port) {
        if (id !== null) throw new ApplicationError('PROMOTION_UNAVAILABLE');
        continue;
      }
      const proof = await port.storageIdentity();
      if (
        proof.domainId !== binding.domain_id ||
        proof.storeId !== id ||
        proof.ledgerInstanceId !== binding.ledger_instance_id ||
        proof.restoreEpoch !== binding.restore_epoch
      )
        throw new ApplicationError('PROMOTION_UNAVAILABLE');
    }
  }
  enabled(): RatingGroupPromotionRuntime {
    if (
      !this.runtime ||
      this.runtime.mode !== 'synthetic-only' ||
      this.runtime.ticketSecret.length < 32
    )
      throw new ApplicationError('PROMOTION_UNAVAILABLE');
    return this.runtime;
  }
  async actor(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    this.sessions.set(tx, session);
    return session.accountId;
  }
  async program(id: string, tx: PoolClient, lock = false): Promise<Program> {
    const p = (
      await tx.query<Program & { until: string }>(
        `SELECT *,valid_until::text until,audience_epoch::text,grant_epoch::text FROM whaleu_ratings.promotion_programs WHERE id=$1 AND enabled AND coverage='complete' AND provenance='accepted' AND effective_at<=clock_timestamp() AND valid_until>clock_timestamp() ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!p) throw new ApplicationError('PROMOTION_NOT_FOUND');
    registerTransactionExactDeadline(tx, p.until, 'PROMOTION_UNAVAILABLE');
    p.source_binding = sourceBindingSchema.parse(p.source_binding);
    return p;
  }
  async counts(p: Program, tx: PoolClient) {
    const rows = (
      await tx.query<{ audience_kind: string; n: number }>(
        `SELECT audience_kind,count(*)::int n FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 GROUP BY audience_kind`,
        [p.id],
      )
    ).rows;
    const count = (kind: string) =>
      rows.find((r) => r.audience_kind === kind)?.n ?? 0;
    const school = count('school_treehole'),
      def = count('default_treehole'),
      test = count('test');
    return { school, default: def, test, total: school + def + test };
  }
  @AccountPolicy('privileged_read', 'entry')
  capabilities(token: string, id: string) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      if (!this.runtime)
        return {
          enabled: false,
          mode: 'disabled',
          actions: [],
          reason: 'runtime_disabled',
        };
      const p = await this.program(id, tx);
      await this.runtime.authority.current(actor, p, 'inspect', tx);
      return {
        enabled: true,
        mode: 'synthetic-only',
        actions: ['preview', 'send', 'test', 'inspect', 'cancel'],
        reason: null,
      };
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  inspectProgram(token: string, id: string) {
    return this.run(async (tx) => {
      const rt = this.enabled(),
        actor = await this.actor(token, tx),
        p = await this.program(id, tx);
      await rt.authority.current(actor, p, 'inspect', tx);
      await rt.source.current(p, tx);
      return {
        programId: p.id,
        revision: p.revision,
        type: p.type,
        audience: await this.counts(p, tx),
        copyModes: ['deterministic', ...(rt.generation ? ['assisted'] : [])],
        linkModes: [
          'native',
          ...(rt.shortlinks
            ? ['shortlink_optional', 'shortlink_required']
            : []),
        ],
        sourceBinding: p.source_binding,
        limits,
      };
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  destinations(
    token: string,
    id: string,
    kind: 'test' | 'normal',
    cursor?: string,
  ) {
    return this.run(async (tx) => {
      const rt = this.enabled(),
        actor = await this.actor(token, tx),
        p = await this.program(id, tx);
      await rt.authority.current(
        actor,
        p,
        kind === 'test' ? 'test' : 'inspect',
        tx,
      );
      const rows = (
        await tx.query<{ id: string; label: string }>(
          `SELECT r.id,r.label FROM whaleu_ratings.promotion_program_members_current m JOIN whaleu_ratings.promotion_receivers r ON r.id=m.stable_destination_id WHERE m.program_id=$1 AND ($2::uuid IS NULL OR m.stable_destination_id>$2) AND (($3='test' AND m.audience_kind='test') OR ($3='normal' AND m.audience_kind<>'test')) ORDER BY m.stable_destination_id LIMIT 101`,
          [id, cursor ?? null, kind],
        )
      ).rows;
      return {
        items: rows.slice(0, 100),
        nextCursor: rows.length > 100 ? rows[99]!.id : null,
      };
    });
  }
  @AccountPolicy('content_management', 'entry')
  preview(token: string, id: string, input: PreviewInput) {
    const body = previewInput.parse(input);
    return this.run(async (tx) => {
      const rt = this.enabled(),
        actor = await this.actor(token, tx),
        p = await this.program(id, tx, true);
      await enforceAccountPunishment(actor, 'content_management', tx);
      await rt.authority.current(
        actor,
        p,
        body.mode === 'test' ? 'test' : 'preview',
        tx,
      );
      const source = await rt.source.current(p, tx, body.mode);
      if (body.type !== p.type || body.expectedProgramRevision !== p.revision)
        throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
      const grant = (
        await tx.query<{ revision: string; epoch: string }>(
          `SELECT revision,epoch::text FROM whaleu_ratings.promotion_grants WHERE program_id=$1 AND principal_lineage=$2 AND kind='operator'`,
          [id, actor],
        )
      ).rows[0]!;
      const counts = await this.counts(p, tx);
      let testDestination: { id: string; label: string } | undefined;
      if (body.mode === 'test') {
        testDestination = (
          await tx.query<{ id: string; label: string }>(
            `SELECT r.id,r.label FROM whaleu_ratings.promotion_program_members_current m JOIN whaleu_ratings.promotion_receivers r ON r.id=m.stable_destination_id WHERE m.program_id=$1 AND m.stable_destination_id=$2 AND m.audience_kind='test' AND r.active AND r.valid_until>clock_timestamp()`,
            [id, body.testDestinationId],
          )
        ).rows[0];
        if (!testDestination) throw new ApplicationError('PROMOTION_NOT_FOUND');
      }
      const previewId = randomUUID();
      const row = (
        await tx.query<{ expires_at: Date }>(
          `INSERT INTO whaleu_ratings.promotion_previews(id,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch,originating_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING expires_at`,
          [
            previewId,
            id,
            actor,
            body,
            p.source_hash,
            p.audience_epoch,
            grant.revision,
            p.grant_epoch,
            this.sessions.get(tx)!.sessionId,
          ],
        )
      ).rows[0]!;
      retainPromotion(
        {
          programId: p.id,
          revision: p.revision,
          sourceHash: p.source_hash,
          grantEpoch: p.grant_epoch,
          audienceEpoch: p.audience_epoch,
        },
        tx,
      );
      return {
        ...body,
        previewId,
        programId: id,
        copy: deterministicCopy(p.type),
        locator: source.locator,
        expiresAt: row.expires_at.toISOString(),
        audience:
          body.mode === 'test'
            ? { school: 0, default: 0, test: 1, total: 1 }
            : { ...counts, test: 0, total: counts.school + counts.default },
        ...(testDestination ? { testDestination } : {}),
      };
    });
  }
  @AccountPolicy('content_management', 'entry')
  intent(token: string, id: string, input: IntentInput) {
    const body = intentInput.parse(input);
    return this.run(async (tx) => {
      const rt = this.enabled(),
        actor = await this.actor(token, tx),
        p = await this.program(id, tx, true);
      const preview = (
        await tx.query<{
          command: PreviewInput;
          source_hash: string;
          audience_epoch: string;
          grant_epoch: string;
        }>(
          `SELECT command,source_hash,audience_epoch::text,grant_epoch::text FROM whaleu_ratings.promotion_previews WHERE id=$1 AND program_id=$2 AND actor=$3 AND expires_at>clock_timestamp()`,
          [body.previewId, id, actor],
        )
      ).rows[0];
      if (!preview) throw new ApplicationError('PROMOTION_PREVIEW_STALE');
      await rt.authority.current(
        actor,
        p,
        preview.command.mode === 'test' ? 'test' : 'send',
        tx,
      );
      await rt.source.current(p, tx, preview.command.mode);
      if (
        preview.source_hash !== p.source_hash ||
        preview.audience_epoch !== p.audience_epoch ||
        preview.grant_epoch !== p.grant_epoch ||
        preview.command.expectedProgramRevision !== p.revision
      )
        throw new ApplicationError('PROMOTION_PREVIEW_STALE');
      if (
        (body.copyMode === 'assisted' && !rt.generation) ||
        (body.linkMode !== 'native' && !rt.shortlinks)
      )
        throw new ApplicationError('PROMOTION_UNAVAILABLE');
      if (body.copyMode === 'assisted')
        await currentPromotionProfile(p, 'generation', tx);
      if (body.linkMode !== 'native')
        await currentPromotionProfile(p, 'shortlink', tx);
      const requestId = randomUUID();
      const command: Command = {
        ...preview.command,
        ...body,
        programId: id,
        principalLineage: actor,
        requestId,
        sourceBindingHash: p.source_hash,
        audienceEpoch: p.audience_epoch,
      };
      const hash = commandHash(command);
      const time = (
        await tx.query<{ issued_at: Date; expires_at: Date }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT now issued_at,now+interval '15 minutes' expires_at FROM instant`,
        )
      ).rows[0]!;
      const ticket = createHmac('sha256', rt.ticketSecret)
        .update(
          JSON.stringify([
            'rating-intent-v1',
            id,
            actor,
            requestId,
            hash,
            time.expires_at.toISOString(),
          ]),
        )
        .digest('base64url');
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_intents(request_id,program_id,actor,preview_id,command,request_hash,ticket,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          requestId,
          id,
          actor,
          body.previewId,
          command,
          hash,
          ticket,
          time.issued_at,
          time.expires_at,
        ],
      );
      return {
        requestId,
        requestHash: hash,
        intentTicket: ticket,
        expiresAt: time.expires_at.toISOString(),
      };
    });
  }
  async original(
    program: string,
    request: string,
    actor: string,
    tx: PoolClient,
    lock = false,
  ) {
    const row = (
      await tx.query<IntentRow & { retained: boolean }>(
        `SELECT *,issued_at>clock_timestamp()-interval '180 days' retained FROM whaleu_ratings.promotion_intents WHERE request_id=$1 AND program_id=$2 AND actor=$3 ${lock ? 'FOR UPDATE' : ''}`,
        [request, program, actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('PROMOTION_NOT_FOUND');
    if (!row.retained) throw new ApplicationError('PROMOTION_RECORD_EXPIRED');
    return row;
  }
  async metadata(c: CampaignRow, tx: PoolClient) {
    if (
      !(
        await tx.query(
          `SELECT 1 WHERE $1::timestamptz+interval '180 days'>clock_timestamp()`,
          [c.expires_at],
        )
      ).rows[0]
    )
      throw new ApplicationError('PROMOTION_RECORD_EXPIRED');
    const age = (
      await tx.query<{ expired: boolean; payload_expired: boolean }>(
        `SELECT $1::timestamptz<=clock_timestamp() expired, $1::timestamptz+interval '24 hours'<=clock_timestamp() payload_expired`,
        [c.expires_at],
      )
    ).rows[0]!;
    const suppressPending = c.cancelled_at !== null || age.expired;
    const rows = (
      await tx.query<{ stage: string; state: string; n: number }>(
        `SELECT stage,state,count(*)::int n FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 GROUP BY stage,state`,
        [c.id],
      )
    ).rows;
    const count = (stage: string) => {
      const n = (states: string[]) =>
        rows
          .filter((r) => r.stage === stage && states.includes(r.state))
          .reduce((a, r) => a + r.n, 0);
      return {
        confirmed: n(['confirmed']),
        unknown: n(['dispatch_unknown', 'parked_unknown']),
        notSent:
          n(['suppressed_unsent']) +
          (suppressPending ? n(['pending', 'retry_wait', 'preparing']) : 0),
        pending: suppressPending
          ? 0
          : n(['pending', 'retry_wait', 'preparing']),
      };
    };
    const delivery = count('delivery'),
      generation = count('generation'),
      shortlink = count('shortlink');
    delivery[suppressPending ? 'notSent' : 'pending'] += Math.max(
      0,
      c.recipient_count - Object.values(delivery).reduce((a, b) => a + b, 0),
    );
    const unknown = generation.unknown + shortlink.unknown + delivery.unknown;
    return {
      requestId: c.request_id,
      requestHash: c.request_hash,
      campaignId: c.id,
      admission: c.recipient_count ? 'admitted' : 'empty',
      composition:
        c.recipient_count === 0
          ? 'not_required'
          : c.payload_hash
            ? 'frozen'
            : suppressPending
              ? 'not_sent'
              : 'pending',
      delivery: delivery.unknown
        ? 'unknown'
        : delivery.pending
          ? 'pending'
          : delivery.notSent
            ? 'partial'
            : 'complete',
      completed:
        unknown === 0 &&
        delivery.pending === 0 &&
        generation.pending === 0 &&
        shortlink.pending === 0 &&
        (c.payload_hash !== null || suppressPending || c.recipient_count === 0),
      cancelRequested: c.cancelled_at !== null,
      counts: delivery,
      stages: { generation, shortlink, delivery },
      payloadExpired: c.payload_purged_at !== null || age.payload_expired,
      remoteMessageMayRemain: delivery.confirmed + delivery.unknown > 0,
    };
  }
  async existing(request: string, hash: string, tx: PoolClient) {
    const c = (
      await tx.query<CampaignRow>(
        'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE request_id=$1',
        [request],
      )
    ).rows[0];
    if (c) {
      if (c.request_hash !== hash)
        throw new ApplicationError('PROMOTION_REQUEST_CONFLICT');
      return this.metadata(c, tx);
    }
    const seal = (
      await tx.query<{ request_hash: string }>(
        'SELECT request_hash FROM whaleu_ratings.promotion_cancel_requests WHERE request_id=$1',
        [request],
      )
    ).rows[0];
    if (seal) {
      if (seal.request_hash !== hash)
        throw new ApplicationError('PROMOTION_REQUEST_CONFLICT');
      return {
        requestId: request,
        requestHash: hash,
        admission: 'sealed',
        composition: 'not_started',
        delivery: 'not_started',
        cancelRequested: true,
        counts: { confirmed: 0, unknown: 0, notSent: 0, pending: 0 },
        payloadExpired: false,
      };
    }
    return null;
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recoverIntent(token: string, id: string, request: string) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const row = await this.original(id, request, actor, tx),
        recorded = await this.existing(request, row.request_hash, tx);
      if (recorded) return { recorded: true, status: recorded };
      const rt = this.enabled(),
        p = await this.program(id, tx);
      await rt.authority.current(
        actor,
        p,
        row.command.mode === 'test' ? 'test' : 'send',
        tx,
      );
      const valid = (
        await tx.query(
          'SELECT 1 FROM whaleu_ratings.promotion_intents WHERE request_id=$1 AND expires_at>clock_timestamp()',
          [request],
        )
      ).rows[0];
      if (!valid) throw new ApplicationError('PROMOTION_INTENT_EXPIRED');
      return {
        recorded: false,
        requestId: request,
        requestHash: row.request_hash,
        intentTicket: row.ticket,
        expiresAt: row.expires_at.toISOString(),
      };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  request(token: string, id: string, request: string) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const row = await this.original(id, request, actor, tx),
        status = await this.existing(request, row.request_hash, tx);
      return status ? { recorded: true, status } : { recorded: false };
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  campaign(token: string, id: string, input: CampaignInput) {
    const body = campaignInput.parse(input);
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const row = await this.original(id, body.requestId, actor, tx, true);
      if (row.request_hash !== body.requestHash)
        throw new ApplicationError('PROMOTION_REQUEST_CONFLICT');
      const recorded = await this.existing(
        row.request_id,
        row.request_hash,
        tx,
      );
      if (recorded) return recorded;
      const rt = this.enabled();
      await this.verifyRuntime(tx);
      if (
        Buffer.byteLength(body.intentTicket) !==
          Buffer.byteLength(row.ticket) ||
        !timingSafeEqual(
          Buffer.from(body.intentTicket),
          Buffer.from(row.ticket),
        )
      )
        throw new ApplicationError('PROMOTION_NOT_FOUND');
      if (
        !(
          await tx.query(
            'SELECT 1 FROM whaleu_ratings.promotion_intents WHERE request_id=$1 AND expires_at>clock_timestamp()',
            [row.request_id],
          )
        ).rows[0]
      )
        throw new ApplicationError('PROMOTION_INTENT_EXPIRED');
      const preview = (
        await tx.query<{
          grant_revision: string;
          grant_epoch: string;
          originating_session_id: string;
        }>(
          `SELECT grant_revision,grant_epoch::text,originating_session_id FROM whaleu_ratings.promotion_previews WHERE id=$1 AND expires_at>clock_timestamp()`,
          [row.preview_id],
        )
      ).rows[0];
      if (!preview) throw new ApplicationError('PROMOTION_PREVIEW_STALE');
      const p = await this.program(id, tx, true),
        c = row.command;
      if (
        commandHash(c) !== row.request_hash ||
        c.expectedProgramRevision !== p.revision ||
        c.sourceBindingHash !== p.source_hash ||
        c.audienceEpoch !== p.audience_epoch ||
        preview.grant_epoch !== p.grant_epoch
      )
        throw new ApplicationError('PROMOTION_PREVIEW_STALE');
      await enforceAccountPunishment(actor, 'content_management', tx);
      await rt.authority.current(
        actor,
        p,
        c.mode === 'test' ? 'test' : 'send',
        tx,
      );
      await rt.source.current(p, tx, c.mode);
      await requireRatingPromotionSession(
        actor,
        preview.originating_session_id,
        tx,
      );
      const currentGrant = (
        await tx.query(
          'SELECT 1 FROM whaleu_ratings.promotion_grants WHERE program_id=$1 AND principal_lineage=$2 AND revision=$3 AND active',
          [p.id, actor, preview.grant_revision],
        )
      ).rows[0];
      if (!currentGrant) throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
      await this.reserveAdmission(p.id, actor, c.mode === 'test', tx);
      const selected = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int n FROM (SELECT stable_destination_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND (($2='normal' AND audience_kind IN('school_treehole','default_treehole')) OR ($2='test' AND audience_kind='test' AND stable_destination_id=$3)) ORDER BY stable_destination_id LIMIT 10001) current_set`,
          [p.id, c.mode, c.testDestinationId ?? null],
        )
      ).rows[0]!.n;
      if (selected > 10000)
        throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
      if (c.mode === 'test' && selected !== 1)
        throw new ApplicationError('PROMOTION_NOT_FOUND');
      const campaignId = randomUUID();
      const campaign = (
        await tx.query<CampaignRow>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) INSERT INTO whaleu_ratings.promotion_campaigns(id,request_id,program_id,actor,request_hash,command,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,created_at,expires_at,compose_by,mode,recipient_count,originating_session_id) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now,now+$12::int*interval '1 minute',now+interval '2 minutes',$13,$14,$15 FROM instant RETURNING *`,
          [
            campaignId,
            c.requestId,
            p.id,
            actor,
            row.request_hash,
            c,
            p.revision,
            p.source_hash,
            p.audience_epoch,
            preview.grant_revision,
            p.grant_epoch,
            c.mode === 'test' ? 5 : 30,
            c.mode,
            selected,
            preview.originating_session_id,
          ],
        )
      ).rows[0]!;
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_campaign_recipients(campaign_id,stable_destination_id,enrollment_revision,registry_revision,audience_kind,school_scope_id) SELECT $1,stable_destination_id,enrollment_revision,registry_revision,audience_kind,school_scope_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$2 AND (($3='normal' AND audience_kind IN('school_treehole','default_treehole')) OR ($3='test' AND audience_kind='test' AND stable_destination_id=$4)) ORDER BY stable_destination_id`,
        [campaignId, p.id, c.mode, c.testDestinationId ?? null],
      );
      await tx.query(
        'UPDATE whaleu_ratings.promotion_campaigns SET snapshot_sealed=true WHERE id=$1',
        [campaignId],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_admissions(campaign_id,program_id,actor,is_test) VALUES($1,$2,$3,$4)`,
        [campaignId, p.id, actor, c.mode === 'test'],
      );
      retainPromotion(
        {
          programId: p.id,
          revision: p.revision,
          sourceHash: p.source_hash,
          grantEpoch: p.grant_epoch,
          audienceEpoch: p.audience_epoch,
        },
        tx,
      );
      return this.metadata(campaign, tx);
    });
  }
  async reserveAdmission(
    program: string,
    actor: string,
    test: boolean,
    tx: PoolClient,
  ) {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('rating-promotion-admission-v1',0))`,
    );
    const n = (
      await tx.query<{
        program: number;
        actor: number;
        all: number;
        tests: number;
        outstanding: number;
        program_outstanding: number;
      }>(
        `SELECT
   count(*) FILTER(WHERE program_id=$1)::int program,count(*) FILTER(WHERE actor=$2)::int actor,count(*)::int all,count(*) FILTER(WHERE actor=$2 AND is_test)::int tests,
   (SELECT count(*)::int FROM whaleu_ratings.promotion_campaigns WHERE expires_at>clock_timestamp() AND cancelled_at IS NULL) outstanding,
   (SELECT count(*)::int FROM whaleu_ratings.promotion_campaigns WHERE program_id=$1 AND expires_at>clock_timestamp() AND cancelled_at IS NULL) program_outstanding
   FROM whaleu_ratings.promotion_admissions WHERE utc_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
        [program, actor],
      )
    ).rows[0]!;
    if (
      n.program >= 20 ||
      n.actor >= 100 ||
      n.all >= 1000 ||
      (test && n.tests >= 5) ||
      n.outstanding >= 200 ||
      n.program_outstanding >= 20
    )
      throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  seal(
    token: string,
    id: string,
    request: string,
    body: { cancelRequestId: string; requestHash: string },
  ) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const original = await this.original(id, request, actor, tx, true);
      if (original.request_hash !== body.requestHash)
        throw new ApplicationError('PROMOTION_REQUEST_CONFLICT');
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_cancel_requests(request_id,cancel_request_id,actor,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING`,
        [request, body.cancelRequestId, actor, body.requestHash],
      );
      await tx.query(
        'UPDATE whaleu_ratings.promotion_campaigns SET cancelled_at=coalesce(cancelled_at,clock_timestamp()) WHERE request_id=$1',
        [request],
      );
      return {
        requestId: request,
        sealed: true,
        status: await this.existing(request, body.requestHash, tx),
      };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async status(token: string, id: string) {
    const metadata = await this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const c = (
        await tx.query<CampaignRow>(
          'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1 AND actor=$2',
          [id, actor],
        )
      ).rows[0];
      if (!c) throw new ApplicationError('PROMOTION_NOT_FOUND');
      return this.metadata(c, tx);
    });
    // Explicit inspection only. Historical request/replay never invokes this read.
    try {
      const payload = await this.run(async (tx) => {
        const rt = this.enabled(),
          actor = await this.actor(token, tx);
        await enforceAccountPunishment(actor, 'privileged_read', tx);
        const c = (
          await tx.query<CampaignRow & { payload_until: string }>(
            `SELECT *, (expires_at+interval '24 hours')::text payload_until FROM whaleu_ratings.promotion_campaigns WHERE id=$1 AND actor=$2 AND payload IS NOT NULL AND expires_at+interval '24 hours'>clock_timestamp() FOR SHARE`,
            [id, actor],
          )
        ).rows[0];
        if (!c) return null;
        registerTransactionExactDeadline(
          tx,
          c.payload_until,
          'PROMOTION_UNAVAILABLE',
        );
        const p = await this.program(c.program_id, tx);
        await rt.authority.current(actor, p, 'inspect', tx);
        await rt.source.current(p, tx, c.mode);
        if (
          c.source_hash !== p.source_hash ||
          c.program_revision !== p.revision
        )
          return null;
        await rt.qualification.current(p, c.payload!, tx);
        return c.payload;
      });
      return { ...metadata, ...(payload ? { payload } : {}) };
    } catch (error) {
      if (error instanceof ApplicationError) return metadata;
      throw error;
    }
  }
  @AccountPolicy('privileged_read', 'entry')
  recipients(token: string, id: string, cursor?: string) {
    return this.run(async (tx) => {
      const rt = this.enabled(),
        actor = await this.actor(token, tx),
        c = (
          await tx.query<CampaignRow>(
            'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1 AND actor=$2',
            [id, actor],
          )
        ).rows[0];
      if (!c) throw new ApplicationError('PROMOTION_NOT_FOUND');
      const p = await this.program(c.program_id, tx);
      await rt.authority.current(actor, p, 'inspect', tx);
      await rt.source.current(p, tx, c.mode);
      const rows = (
        await tx.query<{ id: string; state: string; audienceKind: string }>(
          `SELECT r.stable_destination_id id,coalesce(e.state,'pending') state,r.audience_kind "audienceKind" FROM whaleu_ratings.promotion_campaign_recipients r LEFT JOIN whaleu_notifications.rating_group_effects e ON e.campaign_id=r.campaign_id AND e.stable_destination_id=r.stable_destination_id WHERE r.campaign_id=$1 AND ($2::uuid IS NULL OR r.stable_destination_id>$2) ORDER BY r.stable_destination_id LIMIT 101`,
          [id, cursor ?? null],
        )
      ).rows;
      return {
        items: rows.slice(0, 100),
        nextCursor: rows.length > 100 ? rows[99]!.id : null,
      };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelCampaign(token: string, id: string, requestId: string) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const c = (
        await tx.query<CampaignRow>(
          'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1 AND actor=$2',
          [id, actor],
        )
      ).rows[0];
      if (!c) throw new ApplicationError('PROMOTION_NOT_FOUND');
      await this.original(c.program_id, c.request_id, actor, tx, true);
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_cancel_requests(request_id,cancel_request_id,actor,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT(request_id) DO NOTHING`,
        [c.request_id, requestId, actor, c.request_hash],
      );
      const updated = (
        await tx.query<CampaignRow>(
          'UPDATE whaleu_ratings.promotion_campaigns SET cancelled_at=coalesce(cancelled_at,clock_timestamp()) WHERE id=$1 RETURNING *',
          [id],
        )
      ).rows[0]!;
      return this.metadata(updated, tx);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  reconcile(token: string, id: string, effectId: string) {
    return this.run(async (tx) => {
      const actor = await this.actor(token, tx);
      await enforceAccountPunishment(actor, 'restricted_self_service', tx);
      const row = (
        await tx.query(
          `UPDATE whaleu_notifications.rating_group_effects e SET next_action_at=clock_timestamp(),state='dispatch_unknown',recovery_requested=true FROM whaleu_ratings.promotion_campaigns c WHERE e.id=$1 AND e.campaign_id=c.id AND c.id=$2 AND c.actor=$3 AND e.state IN('dispatch_unknown','parked_unknown') AND e.reconciliations<24 AND e.created_at>clock_timestamp()-interval '180 days' RETURNING e.id`,
          [effectId, id, actor],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('PROMOTION_NOT_FOUND');
      return { effectId, recoveryRequested: true };
    });
  }
}
