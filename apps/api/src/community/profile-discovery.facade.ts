import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import type { CommunitySpace, PostView } from './contracts.js';
import type { StoredPost } from './community.repository.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunitySerializer } from './community-serialization.js';
import { TradingRepository } from './trading/repository.js';
import type { TradingSubtype } from './trading/contracts.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from './discovery-cursors.js';

export type PublicContentKind = 'posts' | 'trading';
interface ProfileContentItem {
  post: StoredPost;
  space: CommunitySpace;
}
interface Candidate {
  id: string;
  scan_at: string;
}
const anchorSchema = z.strictObject({
  at: z.iso.datetime({ precision: 6 }),
  id: z.uuid(),
});
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('profile'),
  after: anchorSchema,
  visible: anchorSchema.nullable(),
});
type Anchor = z.infer<typeof anchorSchema>;
export const DISCOVERY_SCAN_BATCH = 128;
export const PROFILE_COUNT_BOUND = 1024;
export type CurrentProfileCount =
  | { status: 'known'; value: number; optionalUntil: number | null }
  | { status: 'unavailable'; value: null; optionalUntil: null };
export interface ProfileContentPage {
  items: PostView[];
  total: number | null;
  totalStatus: 'known' | 'unavailable';
  nextCursor: string | null;
  continuation: 'more' | 'scan_pending' | 'end';
}
const anchor = (item: Candidate): Anchor => ({
  id: item.id,
  at: item.scan_at,
});
function follows(a: Anchor, b: Anchor): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}

/** Community keeps private handles and skipped coordinates behind this facade. */
@Injectable()
export class CommunityProfileDiscoveryFacade {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(TradingRepository) private readonly trading: TradingRepository,
    @Inject(DiscoveryCursorRepository)
    private readonly cursors: DiscoveryCursorRepository,
  ) {}

  private async candidates(
    owner: string,
    kind: PublicContentKind,
    after: Anchor | null,
    tx: PoolClient,
    bound = DISCOVERY_SCAN_BATCH,
  ): Promise<Candidate[]> {
    return (
      await tx.query<Candidate>(
        `SELECT id,to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scan_at FROM whaleu_community.posts
       WHERE account_id=$1 AND author_mode='named' AND visibility='approved' AND deleted_at IS NULL
       AND (category='trading')=$2 ${after ? 'AND (published_at,id)<($3::timestamptz,$4::uuid)' : ''}
       ORDER BY published_at DESC,id DESC LIMIT ${bound + 1}`,
        after
          ? [owner, kind === 'trading', after.at, after.id]
          : [owner, kind === 'trading'],
      )
    ).rows;
  }

  private async lockCandidates(
    candidates: Candidate[],
    guard: Anchor | null,
    tx: PoolClient,
  ) {
    for (const id of [
      ...new Set([
        ...candidates.map((item) => item.id),
        ...(guard ? [guard.id] : []),
      ]),
    ].sort()) {
      try {
        await this.repository.post(id, tx);
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.code !== 'POST_NOT_FOUND'
        )
          throw error;
        if (id === guard?.id)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      }
    }
  }

  private async eligible(
    id: string,
    owner: string,
    viewer: string | null,
    kind: PublicContentKind,
    subtype: TradingSubtype | undefined,
    tx: PoolClient,
  ): Promise<ProfileContentItem | null> {
    try {
      const item = await this.access.accessiblePost(id, viewer, tx);
      if (
        item.post.account_id !== owner ||
        item.post.author_mode !== 'named' ||
        (kind === 'trading') !== (item.post.category === 'trading')
      )
        return null;
      if (kind === 'trading') {
        const listing = await this.trading.find(id, tx);
        if (!listing) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        if (
          listing.resolution !== 'open' ||
          (subtype !== undefined && listing.subtype !== subtype)
        )
          return null;
      }
      return item;
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'POST_NOT_FOUND')
        return null;
      throw error;
    }
  }

  /** Optional basics-only computation. Mandatory target policy was checked by
   * the application before this savepoint. No page/anchor uses this fallback. */
  async count(
    owner: string,
    viewer: string | null,
    kind: PublicContentKind,
    tx: PoolClient,
  ): Promise<CurrentProfileCount> {
    const baseline = checkpointTransactionDeadlines(tx);
    await tx.query('SAVEPOINT profile_optional_count');
    const unavailable = async (): Promise<CurrentProfileCount> => {
      await tx.query('ROLLBACK TO SAVEPOINT profile_optional_count');
      await tx.query('RELEASE SAVEPOINT profile_optional_count');
      restoreTransactionDeadlines(tx, baseline);
      return { status: 'unavailable', value: null, optionalUntil: null };
    };
    try {
      const candidates = await this.candidates(
        owner,
        kind,
        null,
        tx,
        PROFILE_COUNT_BOUND,
      );
      if (candidates.length > PROFILE_COUNT_BOUND) return unavailable();
      await this.lockCandidates(candidates, null, tx);
      const current = await this.candidates(
        owner,
        kind,
        null,
        tx,
        PROFILE_COUNT_BOUND,
      );
      const held = new Set(candidates.map((item) => item.id));
      if (
        current.length > PROFILE_COUNT_BOUND ||
        current.some((item) => !held.has(item.id))
      )
        return unavailable();
      let value = 0;
      for (const item of current)
        if (await this.eligible(item.id, owner, viewer, kind, undefined, tx))
          value++;
      const after = checkpointTransactionDeadlines(tx);
      const optional = [...after].flatMap(([code, until]) =>
        until < (baseline.get(code) ?? Infinity) ? [until] : [],
      );
      restoreTransactionDeadlines(tx, baseline);
      await tx.query('RELEASE SAVEPOINT profile_optional_count');
      return {
        status: 'known',
        value,
        optionalUntil: optional.length ? Math.min(...optional) : null,
      };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'COMMUNITY_UNAVAILABLE'
      )
        return unavailable();
      throw error;
    }
  }

  async validateCursor(
    cursor: string | undefined,
    scope: string,
    tx: PoolClient,
  ): Promise<void> {
    if (cursor)
      await this.cursors.get(cursor, scope, tx, (value) =>
        positionSchema.parse(value),
      );
  }

  async page(
    owner: string,
    viewer: string | null,
    kind: PublicContentKind,
    query: {
      limit: number;
      cursor?: string | undefined;
      tradingSubtype?: TradingSubtype | undefined;
    },
    scope: string,
    tx: PoolClient,
    verifySession: () => Promise<void>,
  ): Promise<ProfileContentPage> {
    const position = query.cursor
      ? await this.cursors.get(query.cursor, scope, tx, (value) =>
          positionSchema.parse(value),
        )
      : null;
    const seek = position?.after ?? null;
    const guard = position?.visible ?? null;
    if (
      guard &&
      seek &&
      !follows(seek, guard) &&
      (seek.at !== guard.at || seek.id !== guard.id)
    )
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    const candidates = await this.candidates(owner, kind, seek, tx);
    await this.lockCandidates(candidates, guard, tx);
    if (guard) {
      const item = await this.eligible(
        guard.id,
        owner,
        viewer,
        kind,
        query.tradingSubtype,
        tx,
      );
      const exactTime =
        item &&
        (
          await tx.query<{ matches: boolean }>(
            'SELECT published_at=$2::timestamptz AS matches FROM whaleu_community.posts WHERE id=$1',
            [guard.id, guard.at],
          )
        ).rows[0]?.matches;
      if (!item || !exactTime)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
    const current = await this.candidates(owner, kind, seek, tx);
    const held = new Set(candidates.map((item) => item.id));
    if (current.some((item) => !held.has(item.id)))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const items: PostView[] = [];
    let consumed = 0;
    let lastVisible = guard;
    for (const candidate of current.slice(0, DISCOVERY_SCAN_BATCH)) {
      consumed++;
      const item = await this.eligible(
        candidate.id,
        owner,
        viewer,
        kind,
        query.tradingSubtype,
        tx,
      );
      if (!item) continue;
      items.push(
        await this.serializer.post(
          item.post,
          item.space,
          viewer,
          await this.access.advisory(viewer, item.space, tx),
          tx,
        ),
      );
      lastVisible = anchor(candidate);
      if (items.length === query.limit) break;
    }
    const exhausted = consumed === current.length;
    const next = exhausted ? null : anchor(current[consumed - 1]!);
    if (next && seek && !follows(next, seek))
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    await verifySession();
    return {
      items,
      total: !position && exhausted ? items.length : null,
      totalStatus: !position && exhausted ? 'known' : 'unavailable',
      continuation: exhausted
        ? 'end'
        : items.length === query.limit
          ? 'more'
          : 'scan_pending',
      nextCursor: next
        ? await this.cursors.create(
            scope,
            discoveryCursorBucket(viewer),
            { v: 1, kind: 'profile', after: next, visible: lastVisible },
            tx,
          )
        : null,
    };
  }
}
