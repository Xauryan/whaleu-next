import { lockSafetyPolicy } from '../../safety/locks.js';
import { hashToken } from '../../identity/tokens.js';
import { beginPostPinProof, retainPostPinProof } from './proof.js';
import { IdentityService } from '../../identity/identity.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PostPinAuthorityFacade } from '../../authorization/post-pin-authority.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost } from '../community.repository.js';
import { CommunitySerializer } from '../community-serialization.js';
import { requireAction } from '../community-policy.js';
import { canonicalJson } from '../content-review/contracts.js';
import { requireFeedbackSpace } from '../feedback/topic.js';
import type { CommunitySpace } from '../contracts.js';
import type {
  PinCommand,
  PinReceipt,
  PinQuery,
  PinMetadata,
  PinPage,
  PinDetail,
  PinSlot,
} from './contracts.js';
interface Scope {
  id: string;
  space_id: string;
  kind: 'regional' | 'university_city' | 'feedback';
  operating_region_id: string | null;
  until: string;
  history_until: string;
}
interface Pin {
  id: string;
  post_id: string;
  scope_id: string;
  level: 1 | 2;
  pinned_at: Date;
  pinned_until: Date;
  until: string;
}
export const pinIntentHash = (actor: string, command: PinCommand) =>
  createHash('sha256')
    .update('whaleu:post-pin:v1\n' + canonicalJson({ actor, command }))
    .digest('hex');
@Injectable()
export class PostPinsService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(PostPinAuthorityFacade)
    private readonly authority: PostPinAuthorityFacade,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.repository.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error && error.constraint === 'post_pin_causal'))
        )
          throw new ApplicationError('POST_PIN_UNAVAILABLE');
        throw error;
      });
  }
  private async scope(
    space: CommunitySpace,
    tx: PoolClient,
    write = false,
  ): Promise<Scope> {
    const row = (
      await tx.query<Scope>(
        `SELECT s.id,s.space_id,s.kind,s.operating_region_id,s.valid_until::text AS until,h.valid_until::text AS history_until FROM whaleu_community.post_pin_scopes s JOIN whaleu_community.post_pin_history h ON h.scope_id=s.id WHERE s.space_id=$1 AND s.provenance='accepted' AND s.accepted_at<=clock_timestamp() AND s.valid_until>clock_timestamp() AND h.coverage='accepted_empty' AND h.accepted_at<=clock_timestamp() AND h.valid_until>clock_timestamp() FOR SHARE OF s,h`,
        [space.id],
      )
    ).rows[0];
    if (
      !row ||
      (row.kind === 'regional'
        ? space.kind !== 'regional' ||
          row.operating_region_id !== space.operatingRegionId
        : space.kind !== 'global' || space.operatingRegionId !== null)
    )
      throw new ApplicationError('POST_PIN_UNAVAILABLE');
    if (row.kind === 'feedback') await requireFeedbackSpace(space, tx);
    await tx.query(
      `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:post-pin-slot:v1:'||$1,0))`,
      [row.id],
    );
    registerTransactionExactDeadline(tx, row.until, 'POST_PIN_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      row.history_until,
      'POST_PIN_UNAVAILABLE',
    );
    return row;
  }
  private supported(scope: Scope, post: StoredPost): boolean {
    return (
      post.space_id === scope.space_id &&
      (scope.kind === 'regional'
        ? post.category !== 'feedback'
        : post.category ===
          (scope.kind === 'feedback' ? 'feedback' : 'discussion'))
    );
  }
  private async current(scope: Scope, tx: PoolClient): Promise<Pin | null> {
    // The slot remains occupied while hidden or Review-denied. Only expiry,
    // explicit closure or canonical deletion release it.
    const row =
      (
        await tx.query<Pin>(
          `SELECT p.*,p.pinned_until::text AS until FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pins p ON p.id=h.pin_id JOIN whaleu_community.posts post ON post.id=p.post_id WHERE h.scope_id=$1 AND p.pinned_until>clock_timestamp() AND post.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_pin_closures c WHERE c.pin_id=p.id) FOR SHARE OF post`,
          [scope.id],
        )
      ).rows[0] ?? null;
    if (row) registerTransactionExactDeadline(tx, row.until, 'POST_PIN_STALE');
    return row;
  }
  private async metadata(
    pin: Pin,
    actor: string | null,
    tx: PoolClient,
  ): Promise<PinMetadata> {
    const read = actor
      ? (
          await tx.query<{ read_at: Date }>(
            'SELECT read_at FROM whaleu_community.post_pin_reads WHERE actor_id=$1 AND pin_id=$2',
            [actor, pin.id],
          )
        ).rows[0]
      : null;
    return {
      pinId: pin.id,
      postId: pin.post_id,
      level: pin.level,
      pinnedAt: pin.pinned_at.toISOString(),
      pinnedUntil: pin.pinned_until.toISOString(),
      readState: actor ? (read ? 'read' : 'unread') : 'guest',
      readAt: read?.read_at.toISOString() ?? null,
    };
  }
  async list(token: string | null, query: PinQuery): Promise<PinPage> {
    return this.run(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = token ? await this.access.actor(token, tx) : null;
      await lockSafetyPolicy(tx);
      await beginPostPinProof(tx);
      const sessionId = token
        ? (await this.identity.session(token, tx)).sessionId
        : null;
      await retainPostPinProof(
        {
          tokenHash: token ? hashToken(token) : null,
          actor,
          sessionId,
          scopeId: null,
          postId: null,
          grantId: null,
          visibility: false,
        },
        tx,
        'authority',
      );
      const space = await this.repository.space(query.spaceId, tx);
      const checkpoint = checkpointTransactionDeadlines(tx);
      let scope: Scope;
      try {
        scope = await this.scope(space, tx);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'POST_PIN_UNAVAILABLE'
        ) {
          restoreTransactionDeadlines(tx, checkpoint);
          await retainPostPinProof(
            {
              actor,
              sessionId,
              scopeId: null,
              postId: null,
              grantId: null,
              visibility: false,
            },
            tx,
          );
          return { spaceId: space.id, status: 'unavailable', items: [] };
        }
        throw error;
      }
      const pin = await this.current(scope, tx);
      if (!pin) {
        await retainPostPinProof(
          {
            actor,
            sessionId,
            scopeId: scope.id,
            postId: null,
            grantId: null,
            visibility: false,
          },
          tx,
        );
        return { spaceId: space.id, status: 'available', items: [] };
      }
      const post = await this.repository.post(pin.post_id, tx);
      if (
        !this.supported(scope, post) ||
        (query.category && query.category !== post.category) ||
        !(await this.access.visible(actor, post, tx, 'list_projection'))
      )
        return { spaceId: space.id, status: 'available', items: [] };
      const trade = (
        await tx.query<{ subtype: string; urgency: string }>(
          'SELECT subtype,urgency FROM whaleu_community.trading_listings WHERE post_id=$1 FOR SHARE',
          [post.id],
        )
      ).rows[0];
      if (
        (query.tradingSubtype && trade?.subtype !== query.tradingSubtype) ||
        (!query.category && trade?.urgency === 'urgent')
      )
        return { spaceId: space.id, status: 'available', items: [] };
      const result: PinPage = {
        spaceId: space.id,
        status: 'available',
        items: [
          {
            pin: await this.metadata(pin, actor, tx),
            post: await this.serializer.post(
              post,
              space,
              actor,
              await this.access.advisory(actor, space, tx),
              tx,
            ),
          },
        ],
      };
      await retainPostPinProof(
        {
          actor,
          sessionId,
          scopeId: scope.id,
          postId: post.id,
          grantId: null,
          visibility: true,
        },
        tx,
      );
      return result;
    });
  }
  async slot(token: string, spaceId: string): Promise<PinSlot> {
    return this.run(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = await this.access.actor(token, tx),
        sessionId = (await this.identity.session(token, tx)).sessionId;
      await lockSafetyPolicy(tx);
      await beginPostPinProof(tx);
      const space = await this.repository.space(spaceId, tx);
      requireAction(await this.access.authority(actor, space, tx), 'pin');
      const grantId = await this.authority.require(
        actor,
        space.operatingRegionId,
        tx,
      );
      await retainPostPinProof(
        {
          tokenHash: hashToken(token),
          actor,
          sessionId,
          scopeId: null,
          postId: null,
          grantId,
          visibility: false,
        },
        tx,
        'authority',
      );
      const checkpoint = checkpointTransactionDeadlines(tx);
      let scope: Scope;
      try {
        scope = await this.scope(space, tx);
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.code !== 'POST_PIN_UNAVAILABLE'
        )
          throw error;
        restoreTransactionDeadlines(tx, checkpoint);
        return { spaceId, status: 'unavailable', pin: null, canUnpin: false };
      }
      const pin = await this.current(scope, tx);
      await retainPostPinProof(
        {
          actor,
          sessionId,
          scopeId: scope.id,
          postId: pin?.post_id ?? null,
          grantId,
          visibility: false,
        },
        tx,
      );
      return {
        spaceId,
        status: 'available',
        canUnpin: !!pin,
        pin: pin
          ? {
              pinId: pin.id,
              postId: pin.post_id,
              level: pin.level,
              pinnedUntil: pin.pinned_until.toISOString(),
            }
          : null,
      };
    });
  }
  async detail(token: string, postId: string): Promise<PinDetail> {
    return this.run(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = await this.access.actor(token, tx);
      await lockSafetyPolicy(tx);
      await beginPostPinProof(tx);
      const currentSession = (await this.identity.session(token, tx)).sessionId;
      await retainPostPinProof(
        {
          tokenHash: hashToken(token),
          actor,
          sessionId: currentSession,
          scopeId: null,
          postId: null,
          grantId: null,
          visibility: false,
        },
        tx,
        'authority',
      );
      // Discover the immutable target without acquiring a post lock before slot.
      const reference = (
        await tx.query<{ space_id: string }>(
          'SELECT space_id FROM whaleu_community.posts WHERE id=$1',
          [postId],
        )
      ).rows[0];
      if (!reference) throw new ApplicationError('POST_NOT_FOUND');
      const space = await this.repository.space(reference.space_id, tx);
      let scope: Scope;
      const base: PinDetail = {
        postId,
        status: 'unavailable',
        pin: null,
        canPin: false,
        canUnpin: false,
      };
      const checkpoint = checkpointTransactionDeadlines(tx);
      try {
        scope = await this.scope(space, tx);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'POST_PIN_UNAVAILABLE'
        ) {
          restoreTransactionDeadlines(tx, checkpoint);
          await this.access.accessiblePost(postId, actor, tx);
          return base;
        }
        throw error;
      }
      const { post } = await this.access.accessiblePost(postId, actor, tx);
      if (!this.supported(scope, post)) return base;
      const pin = await this.current(scope, tx);
      const own = pin?.post_id === postId ? pin : null;
      let canManage = false;
      const hintCheckpoint = checkpointTransactionDeadlines(tx);
      try {
        requireAction(await this.access.authority(actor, space, tx), 'pin');
        await this.authority.require(actor, scope.operating_region_id, tx);
        canManage = true;
      } catch (error) {
        if (!(error instanceof ApplicationError)) throw error;
      } finally {
        restoreTransactionDeadlines(tx, hintCheckpoint);
      }
      const result: PinDetail = {
        postId,
        status: 'available',
        pin: own ? await this.metadata(own, actor, tx) : null,
        canPin: canManage,
        canUnpin: canManage && !!own,
      };
      const sessionId = (await this.identity.session(token, tx)).sessionId;
      await retainPostPinProof(
        {
          actor,
          sessionId,
          scopeId: scope.id,
          postId,
          grantId: null,
          visibility: true,
        },
        tx,
      );
      return result;
    });
  }
  async command(
    token: string,
    command: PinCommand,
    cancel = false,
  ): Promise<PinReceipt> {
    return this.run(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = await this.access.actor(token, tx),
        session = await this.identity.session(token, tx),
        hash = pinIntentHash(actor, command);
      let scopeId: string | null = null,
        grantId: string | null = null;
      await retainPostPinProof(
        {
          tokenHash: hashToken(token),
          actor,
          sessionId: session.sessionId,
          scopeId: null,
          postId: null,
          grantId: null,
          visibility: false,
        },
        tx,
        'authority',
      );
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:post-pin-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const old = (
        await tx.query<{ intent_hash: string; receipt: PinReceipt }>(
          'SELECT intent_hash,receipt FROM whaleu_community.post_pin_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (old) {
        if (old.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return old.receipt;
      }
      const base = {
        requestId: command.clientRequestId,
        operation: command.operation,
        postId: command.postId,
      };
      let receipt: PinReceipt;
      if (cancel)
        receipt = { ...base, outcome: 'rejected', code: 'POST_PIN_CANCELLED' };
      else {
        await lockSafetyPolicy(tx);
        await beginPostPinProof(tx);
        const reference =
          command.operation === 'unpin'
            ? (
                await tx.query<{ space_id: string }>(
                  `SELECT s.space_id FROM whaleu_community.post_pins p JOIN whaleu_community.post_pin_scopes s ON s.id=p.scope_id WHERE p.id=$1 AND p.post_id=$2`,
                  [command.pinId, command.postId],
                )
              ).rows[0]
            : (
                await tx.query<{ space_id: string }>(
                  'SELECT space_id FROM whaleu_community.posts WHERE id=$1',
                  [command.postId],
                )
              ).rows[0];
        if (!reference)
          throw new ApplicationError(
            command.operation === 'unpin' ? 'POST_PIN_STALE' : 'POST_NOT_FOUND',
          );
        const space = await this.repository.space(reference.space_id, tx),
          scope = await this.scope(space, tx, true);
        scopeId = scope.id;
        // Minimal exact-pin closure may survive hidden/withdrawn Review. It grants
        // no content projection, new-pin authority or read acknowledgement.
        const post =
          command.operation === 'unpin'
            ? await this.repository.post(command.postId, tx)
            : (await this.access.accessiblePost(command.postId, actor, tx))
                .post;
        if (command.operation !== 'unpin' && !this.supported(scope, post))
          throw new ApplicationError('POST_PIN_UNAVAILABLE');
        if (command.operation !== 'read') {
          requireAction(await this.access.authority(actor, space, tx), 'pin');
          grantId = await this.authority.require(
            actor,
            scope.operating_region_id,
            tx,
          );
        }
        await retainPostPinProof(
          {
            tokenHash: hashToken(token),
            actor,
            sessionId: session.sessionId,
            scopeId,
            postId: command.postId,
            grantId,
            visibility: command.operation !== 'unpin',
          },
          tx,
          'authority',
        );
        const current = await this.current(scope, tx);
        if (command.operation === 'pin') {
          if (current && current.post_id !== post.id)
            receipt = {
              ...base,
              outcome: 'rejected',
              code: 'POST_PIN_CONFLICT',
            };
          else {
            if (current)
              await tx.query(
                "INSERT INTO whaleu_community.post_pin_closures(pin_id,reason,actor_id,request_id) VALUES($1,'renewed',$2,$3)",
                [current.id, actor, command.clientRequestId],
              );
            const pin = (
              await tx.query<Pin>(
                `INSERT INTO whaleu_community.post_pins(id,scope_id,post_id,actor_id,request_id,level,duration_hours,pinned_at,pinned_until,provenance) SELECT $1,$2,$3,$4,$5,$6,$7::smallint,instant,instant+$7::smallint*interval '1 hour','native' FROM (SELECT clock_timestamp() instant) now RETURNING *,pinned_until::text AS until`,
                [
                  randomUUID(),
                  scope.id,
                  post.id,
                  actor,
                  command.clientRequestId,
                  command.level,
                  command.durationHours,
                ],
              )
            ).rows[0]!;
            await tx.query(
              'INSERT INTO whaleu_community.post_pin_heads(scope_id,pin_id) VALUES($1,$2) ON CONFLICT(scope_id) DO UPDATE SET pin_id=excluded.pin_id',
              [scope.id, pin.id],
            );
            registerTransactionExactDeadline(tx, pin.until, 'POST_PIN_STALE');
            receipt = {
              ...base,
              outcome: 'applied',
              pinId: pin.id,
              recordedAt: pin.pinned_at.toISOString(),
            };
          }
        } else if (
          !current ||
          current.id !== command.pinId ||
          current.post_id !== post.id
        )
          receipt = { ...base, outcome: 'rejected', code: 'POST_PIN_STALE' };
        else if (command.operation === 'unpin') {
          const row = (
            await tx.query<{ closed_at: Date }>(
              "INSERT INTO whaleu_community.post_pin_closures(pin_id,reason,actor_id,request_id) VALUES($1,'unpin',$2,$3) RETURNING closed_at",
              [current.id, actor, command.clientRequestId],
            )
          ).rows[0]!;
          receipt = {
            ...base,
            outcome: 'applied',
            pinId: current.id,
            recordedAt: row.closed_at.toISOString(),
          };
        } else {
          await tx.query(
            'INSERT INTO whaleu_community.post_pin_reads(actor_id,pin_id,request_id) VALUES($1,$2,$3) ON CONFLICT(actor_id,pin_id) DO NOTHING',
            [actor, current.id, command.clientRequestId],
          );
          const row = (
            await tx.query<{ read_at: Date }>(
              'SELECT read_at FROM whaleu_community.post_pin_reads WHERE actor_id=$1 AND pin_id=$2',
              [actor, current.id],
            )
          ).rows[0]!;
          receipt = {
            ...base,
            outcome: 'applied',
            pinId: current.id,
            recordedAt: row.read_at.toISOString(),
          };
        }
      }
      await tx.query(
        'INSERT INTO whaleu_community.post_pin_commands(actor_id,request_id,intent_hash,command,receipt,session_id,scope_id,grant_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)',
        [
          actor,
          command.clientRequestId,
          hash,
          JSON.stringify(command),
          JSON.stringify(receipt),
          session.sessionId,
          scopeId,
          grantId,
        ],
      );
      await retainPostPinProof(
        {
          actor,
          sessionId: session.sessionId,
          scopeId,
          postId: cancel ? null : command.postId,
          grantId,
          visibility: !cancel && command.operation !== 'unpin',
        },
        tx,
      );
      return receipt;
    });
  }
  async receipt(token: string, requestId: string): Promise<PinReceipt> {
    return this.run(async (tx) => {
      const actor = await this.access.actor(token, tx),
        sessionId = (await this.identity.session(token, tx)).sessionId;
      await retainPostPinProof(
        {
          tokenHash: token ? hashToken(token) : null,
          actor,
          sessionId,
          scopeId: null,
          postId: null,
          grantId: null,
          visibility: false,
        },
        tx,
        'authority',
      );
      const row = (
        await tx.query<{ receipt: PinReceipt }>(
          'SELECT receipt FROM whaleu_community.post_pin_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      return row.receipt;
    });
  }
}
