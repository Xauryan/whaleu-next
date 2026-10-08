import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import type { CommunitySpace, PostView } from '../contracts.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../discovery-cursors.js';
import { CommunityPhoneContinuation } from '../phone-continuation.js';
import { HotScoreRepository } from '../hot-score/repository.js';
import { HotScoreStorage } from '../hot-score/storage.js';
import { currentHotScoreCertificate } from '../hot-score/certificate.js';
import { boundHotTransaction } from '../hot-score/transaction.js';
import { HOT_RANGES } from './contracts.js';
import type { HotQuery, HotPage } from './contracts.js';
import {
  hotAnchorFollows,
  hotCursorScope,
  hotPositionSchema,
} from './cursor.js';
import type { HotAnchor, HotVisible } from './cursor.js';
import {
  HotRepository,
  HOT_SCAN_BATCH,
  hotCandidateSchema,
} from './repository.js';
import type { HotCandidate } from './repository.js';
@Injectable()
export class HotFeedService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DiscoveryCursorRepository)
    private readonly cursors: DiscoveryCursorRepository,
    @Inject(CommunityPhoneContinuation)
    private readonly phones: CommunityPhoneContinuation,
    @Inject(HotRepository) private readonly hot: HotRepository,
    @Inject(HotScoreRepository) private readonly scores: HotScoreRepository,
    @Inject(HotScoreStorage) private readonly storage: HotScoreStorage,
  ) {}
  private async allowed(
    post: StoredPost,
    space: CommunitySpace,
    query: HotQuery,
    clock: string,
    actor: string | null,
    tx: PoolClient,
  ): Promise<boolean> {
    if (!(await this.hot.structurallyAllowed(post.id, space, query, clock, tx)))
      return false;
    if (
      post.category === 'trading' &&
      !(await this.hot.tradingAllowed(post.id, tx))
    )
      return false;
    return this.access.visible(actor, post, tx, 'list_projection');
  }
  private validate(
    candidates: HotCandidate[],
    after: HotAnchor | null,
    spaceId: string,
  ): void {
    if (candidates.length > HOT_SCAN_BATCH + 1)
      throw new ApplicationError('HOT_FEED_UNAVAILABLE');
    let previous = after;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (
        !hotCandidateSchema.safeParse(candidate).success ||
        candidate.spaceId !== spaceId ||
        seen.has(candidate.id) ||
        (previous !== null && !hotAnchorFollows(candidate, previous))
      )
        throw new ApplicationError('HOT_FEED_UNAVAILABLE');
      seen.add(candidate.id);
      previous = candidate;
    }
  }
  async read(token: string | null, query: HotQuery): Promise<HotPage> {
    if (this.config.HOT_FEED_PROCESSING === 'disabled')
      throw new ApplicationError('HOT_FEED_UNAVAILABLE');
    try {
      return await this.repository.database.transaction(
        async (tx) => {
          await boundHotTransaction(tx);
          enableSafetyRelationshipProof(tx);
          await lockSafetyPolicy(tx);
          const session =
              token === null ? null : await this.identity.session(token, tx),
            actor = session?.accountId ?? null;
          const space = await this.repository.space(query.spaceId, tx);
          if (query.cursor) {
            if (actor === null)
              throw new ApplicationError('AUTHENTICATION_REQUIRED');
            if (!(await this.phones.verified(actor, tx)))
              throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
          }
          const scope = hotCursorScope(query, session);
          const position = query.cursor
            ? await this.cursors.get(query.cursor, scope, tx, (value) =>
                hotPositionSchema.parse(value),
              )
            : null;
          const cap = HOT_RANGES[query.range].cap;
          if (position && position.emitted >= cap)
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          const limit = Math.min(query.limit, cap - (position?.emitted ?? 0));
          const clock = await this.hot.clock(tx),
            seek = position?.after ?? null,
            guard = position?.visible ?? null;
          const candidates = await this.hot.candidates(
            space,
            query,
            clock,
            seek,
            tx,
          );
          this.validate(candidates, seek, space.id);
          const held = new Map<string, HotVisible>();
          for (const id of [
            ...new Set([
              ...candidates.map((row) => row.id),
              ...(guard ? [guard.id] : []),
            ]),
          ].sort()) {
            const value = await this.hot.lockCandidate(id, tx);
            if (value) held.set(id, value);
            else if (id === guard?.id)
              throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          }
          // Guard intentionally has no score/vector check: accepted exposure and
          // live score movement cannot force a restart. Publication/scope is stable.
          if (guard) {
            const metadata = held.get(guard.id);
            if (
              !metadata ||
              metadata.spaceId !== guard.spaceId ||
              metadata.at !== guard.at ||
              !(await this.allowed(
                await this.repository.post(guard.id, tx),
                space,
                query,
                clock,
                actor,
                tx,
              ))
            )
              throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          }
          const items: PostView[] = [];
          let consumed = 0,
            lastVisible = guard;
          // Fixed original batch. A newly hot unheld row waits for a later live
          // read; moved/stale rows advance their original examined coordinate.
          for (const candidate of candidates.slice(0, HOT_SCAN_BATCH)) {
            consumed++;
            const metadata = held.get(candidate.id);
            if (
              !metadata ||
              metadata.spaceId !== candidate.spaceId ||
              metadata.at !== candidate.at
            )
              continue;
            await this.scores.lockStates(candidate.id, tx, 'share');
            const snapshot = await this.scores.snapshot(candidate.id, tx);
            const certificate = await this.storage.certificate(
              candidate.id,
              tx,
            );
            if (
              !snapshot ||
              !certificate ||
              certificate.score !== candidate.score ||
              !currentHotScoreCertificate(certificate, snapshot)
            )
              continue;
            const post = await this.repository.post(candidate.id, tx);
            if (!(await this.allowed(post, space, query, clock, actor, tx)))
              continue;
            items.push(
              await this.serializer.post(
                post,
                space,
                actor,
                await this.access.advisory(actor, space, tx),
                tx,
              ),
            );
            lastVisible = {
              id: candidate.id,
              spaceId: candidate.spaceId,
              at: candidate.at,
            };
            if (items.length === limit) break;
          }
          const emitted = (position?.emitted ?? 0) + items.length;
          const exhausted = consumed === candidates.length || emitted === cap;
          const next = exhausted ? null : candidates[consumed - 1];
          if (
            !exhausted &&
            (!next || (seek !== null && !hotAnchorFollows(next, seek)))
          )
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          let continuation: HotPage['continuation'] = exhausted
            ? 'end'
            : items.length === limit
              ? 'more'
              : 'scan_pending';
          if (!exhausted) {
            if (actor === null) continuation = 'login_required';
            else if (!(await this.phones.verified(actor, tx)))
              continuation = 'phone_verification_required';
          }
          if (token !== null) await this.identity.session(token, tx);
          // Last domain operation: cursor quota lock. DatabaseService rechecks all
          // mandatory relationship and phone/session/metadata deadlines at COMMIT.
          const nextCursor =
            next && (continuation === 'more' || continuation === 'scan_pending')
              ? await this.cursors.create(
                  scope,
                  discoveryCursorBucket(actor),
                  {
                    v: 1,
                    kind: 'hot',
                    after: { score: next.score, id: next.id },
                    visible: lastVisible,
                    emitted,
                  },
                  tx,
                )
              : null;
          return { items, nextCursor, continuation };
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['57014', '55P03', '25P04'].includes(String(error.code))
      )
        throw new ApplicationError('HOT_FEED_UNAVAILABLE');
      throw error;
    }
  }
}
