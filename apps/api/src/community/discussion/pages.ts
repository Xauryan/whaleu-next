import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { transactionLifetime } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from '../discovery-cursors.js';
import { batchCategoryChildContextAllowed } from '../category-reclassification/child-context.js';
import { currentCategoryCursorScope } from '../current-category-cursor.js';
import type { CommentsQuery } from './contracts.js';
import type { CommentMetadata } from '../community-serialization.js';

export const DISCUSSION_SCAN_BATCH = 128;
const rootAnchorSchema = z.strictObject({
  id: z.uuid(),
  at: z.iso.datetime({ precision: 6 }),
  pinned: z.boolean(),
  likes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const replyAnchorSchema = z.strictObject({
  id: z.uuid(),
  sequence: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
});
type RootAnchor = z.infer<typeof rootAnchorSchema>;
type ReplyAnchor = z.infer<typeof replyAnchorSchema>;
interface RootCandidate extends StoredComment {
  scan_at: string;
  like_count: number;
  is_liked: boolean;
  is_pinned: boolean;
}
function rootAnchor(row: RootCandidate): RootAnchor {
  const parsed = rootAnchorSchema.safeParse({
    id: row.id,
    at: row.scan_at,
    pinned: row.is_pinned,
    likes: row.like_count,
  });
  if (!parsed.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return parsed.data;
}
function replyAnchor(row: StoredReply): ReplyAnchor {
  const parsed = replyAnchorSchema.safeParse({
    id: row.id,
    sequence: row.sequence,
  });
  if (!parsed.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return parsed.data;
}
function follows(
  next: RootAnchor,
  previous: RootAnchor,
  query: CommentsQuery,
): boolean {
  if (next.pinned !== previous.pinned) return !next.pinned;
  if (query.sort === 'likes' && next.likes !== previous.likes)
    return query.order === 'asc'
      ? next.likes > previous.likes
      : next.likes < previous.likes;
  const greater =
    next.at > previous.at || (next.at === previous.at && next.id > previous.id);
  const less =
    next.at < previous.at || (next.at === previous.at && next.id < previous.id);
  return query.sort === 'time' && query.order === 'asc' ? greater : less;
}
function restart(): never {
  throw new ApplicationError('DISCUSSION_RESTART_REQUIRED');
}
const position = <T extends z.ZodType>(anchor: T, kind: string) =>
  z.strictObject({
    v: z.literal(4),
    kind: z.literal(kind),
    after: anchor,
    visible: anchor.nullable(),
  });

/** Bounded live keysets. Opaque continuation may advance over invisible rows;
 * no hidden ID/sequence or reason is returned to the caller. Every selected row
 * re-enters canonical current authority. The cursor never grants authorization. */
@Injectable()
export class DiscussionPages {
  private readonly pending = new WeakMap<object, (() => Promise<void>)[]>();
  private readonly mirrors = new WeakMap<
    object,
    { nextCursor: string | null }[]
  >();
  private cursorPage<T>(
    rows: T[],
    scope: string,
    viewer: string,
    coordinate: Parameters<DiscoveryCursorRepository['create']>[2] | null,
    tx: PoolClient,
  ) {
    const page = { rows, nextCursor: null as string | null };
    if (!coordinate) return page;
    const lifetime = transactionLifetime(tx);
    if (!lifetime) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const targets = [page];
    this.mirrors.set(page, targets);
    const writes = this.pending.get(lifetime) ?? [];
    writes.push(async () => {
      const cursor = await this.cursors.create(
        scope,
        discoveryCursorBucket(viewer),
        coordinate,
        tx,
      );
      for (const target of targets) target.nextCursor = cursor;
    });
    this.pending.set(lifetime, writes);
    return page;
  }
  copyCursor(
    source: { nextCursor: string | null },
    target: { nextCursor: string | null },
  ): void {
    target.nextCursor = source.nextCursor;
    this.mirrors.get(source)?.push(target);
  }
  /** Last domain operation, after ALL selected roots and previews serialize. */
  async flush(tx: PoolClient): Promise<void> {
    const lifetime = transactionLifetime(tx);
    if (!lifetime) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const writes = this.pending.get(lifetime) ?? [];
    this.pending.delete(lifetime);
    for (const write of writes) await write();
  }

  constructor(
    @Inject(CommunityRepository) private readonly records: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(DiscoveryCursorRepository)
    private readonly cursors: DiscoveryCursorRepository,
  ) {}
  private async scope(parts: readonly unknown[], tx: PoolClient) {
    return currentCategoryCursorScope(discoveryScopeHash(parts), tx);
  }
  private async readPosition<T>(
    cursor: string | undefined,
    scope: string,
    schema: z.ZodType<T>,
    tx: PoolClient,
  ): Promise<T | null> {
    if (!cursor) return null;
    // v1 reply/v2-v3 root JSON tokens explicitly restart; never reinterpret.
    if (!/^[A-Za-z0-9_-]{43}$/.test(cursor)) restart();
    try {
      return await this.cursors.get(cursor, scope, tx, (value) =>
        schema.parse(value),
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        (error instanceof ApplicationError &&
          error.code === 'DISCOVERY_RESTART_REQUIRED')
      )
        restart();
      throw error;
    }
  }
  private async pin(postId: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ comment_id: string }>(
          'SELECT comment_id FROM whaleu_community.comment_pins WHERE post_id=$1',
          [postId],
        )
      ).rows[0]?.comment_id ?? null
    );
  }
  private async rootCandidates(
    postId: string,
    viewer: string,
    query: CommentsQuery,
    after: RootAnchor | null,
    tx: PoolClient,
    exactId?: string,
    visibleAnchor?: RootAnchor | null,
  ): Promise<RootCandidate[]> {
    type Coordinate = { id: string; at: string; likes: number | null };
    const pin = await this.pin(postId, tx);
    if (visibleAnchor && (visibleAnchor.id === pin) !== visibleAnchor.pinned)
      restart();
    const coordinates: Coordinate[] = [];
    const timestamp = `to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const exact = async (id: string) =>
      (
        await tx.query<Coordinate>(
          `/* discussion:root-exact */ SELECT root.id,to_char(root.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,ord.like_count AS likes
       FROM whaleu_community.root_comments root JOIN whaleu_community.discussion_root_order ord ON ord.root_id=root.id
       WHERE root.post_id=$1 AND root.id=$2 AND root.visibility='approved' AND root.deleted_at IS NULL AND ord.live LIMIT 1`,
          [postId, id],
        )
      ).rows;
    if (exactId) coordinates.push(...(await exact(exactId)));
    else {
      if (!after && pin) coordinates.push(...(await exact(pin)));
      const seek = after && !after.pinned ? after : null;
      const remaining = () => DISCUSSION_SCAN_BATCH + 1 - coordinates.length;
      if (query.sort === 'time') {
        const direction = query.order === 'asc' ? 'ASC' : 'DESC';
        coordinates.push(
          ...(
            await tx.query<Coordinate>(
              `/* discussion:root-time */ SELECT root_id AS id,${timestamp} AS at,NULL::integer AS likes
           FROM whaleu_community.discussion_live_root_order WHERE ($2::uuid IS NULL OR root_id<>$2::uuid)
           AND (post_id,created_at,root_id) ${seek && direction === 'ASC' ? '> ($1::uuid,$3::timestamptz,$4::uuid)' : ">= ($1::uuid,'-infinity'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid)"}
           AND (post_id,created_at,root_id) ${seek && direction === 'DESC' ? '< ($1::uuid,$3::timestamptz,$4::uuid)' : "<= ($1::uuid,'infinity'::timestamptz,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)"}
           ORDER BY post_id ${direction},created_at ${direction},root_id ${direction} LIMIT ${remaining()}`,
              seek ? [postId, pin, seek.at, seek.id] : [postId, pin],
            )
          ).rows,
        );
      } else if (query.order === 'desc') {
        coordinates.push(
          ...(
            await tx.query<Coordinate>(
              `/* discussion:root-likes-desc */ SELECT root_id AS id,${timestamp} AS at,like_count AS likes
           FROM whaleu_community.discussion_live_root_order WHERE ($2::uuid IS NULL OR root_id<>$2::uuid)
           AND (post_id,like_count,created_at,root_id) >= ($1::uuid,0,'-infinity'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid)
           AND (post_id,like_count,created_at,root_id) ${seek ? '< ($1::uuid,$3::integer,$4::timestamptz,$5::uuid)' : "<= ($1::uuid,2147483647,'infinity'::timestamptz,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)"}
           ORDER BY post_id DESC,like_count DESC,created_at DESC,root_id DESC LIMIT ${remaining()}`,
              seek
                ? [postId, pin, seek.likes, seek.at, seek.id]
                : [postId, pin],
            )
          ).rows,
        );
      } else {
        // Normalize nonnegative integer counts so ASC count / DESC time+UUID
        // is one complete descending key range over an all-ASC expression index.
        // This preserves ties without a broad OR or prefix-only mixed-key seek.
        coordinates.push(
          ...(
            await tx.query<Coordinate>(
              `/* discussion:root-likes-asc */ SELECT root_id AS id,${timestamp} AS at,like_count AS likes
           FROM whaleu_community.discussion_live_root_order WHERE ($2::uuid IS NULL OR root_id<>$2::uuid)
           AND (post_id,(-like_count),created_at,root_id) >= ($1::uuid,-2147483647,'-infinity'::timestamptz,'00000000-0000-0000-0000-000000000000'::uuid)
           AND (post_id,(-like_count),created_at,root_id) ${seek ? '< ($1::uuid,(-$3::integer),$4::timestamptz,$5::uuid)' : "<= ($1::uuid,0,'infinity'::timestamptz,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)"}
           ORDER BY post_id DESC,(-like_count) DESC,created_at DESC,root_id DESC LIMIT ${remaining()}`,
              seek
                ? [postId, pin, seek.likes, seek.at, seek.id]
                : [postId, pin],
            )
          ).rows,
        );
      }
    }
    if (
      coordinates.length > DISCUSSION_SCAN_BATCH + 1 ||
      new Set(coordinates.map((c) => c.id)).size !== coordinates.length
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const ids = coordinates.map((c) => c.id).sort();
    if (!ids.length) {
      if ((await this.pin(postId, tx)) !== pin) restart();
      return [];
    }
    // All source writers take root before projection. Never lock projection
    // during index enumeration, then wait on its canonical root in reverse.
    const roots = (
      await tx.query<StoredComment & { scan_at: string }>(
        `/* discussion:root-lock */ SELECT root.*,to_char(root.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scan_at
       FROM whaleu_community.root_comments root WHERE post_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,
        [postId, ids],
      )
    ).rows;
    const ordered = (
      await tx.query<{
        root_id: string;
        post_id: string;
        scan_at: string;
        live: boolean;
        like_count: number;
      }>(
        `/* discussion:order-lock */ SELECT root_id,post_id,${timestamp} AS scan_at,live,like_count
       FROM whaleu_community.discussion_root_order WHERE root_id=ANY($1::uuid[]) ORDER BY root_id FOR SHARE`,
        [ids],
      )
    ).rows;
    const liked = (
      await tx.query<{ id: string; liked: boolean }>(
        `/* discussion:viewer-likes */ SELECT id,EXISTS(SELECT 1 FROM whaleu_community.comment_likes WHERE comment_id=id AND account_id=$2::uuid) AS liked FROM unnest($1::uuid[]) AS selected(id)`,
        [ids, viewer],
      )
    ).rows;
    if (
      roots.length !== ids.length ||
      ordered.length !== ids.length ||
      liked.length !== ids.length
    )
      restart();
    const rootMap = new Map(roots.map((r) => [r.id, r]));
    const orderMap = new Map(ordered.map((r) => [r.root_id, r]));
    const likedMap = new Map(liked.map((r) => [r.id, r.liked]));
    if (
      rootMap.size !== ids.length ||
      orderMap.size !== ids.length ||
      likedMap.size !== ids.length
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const result = coordinates.map((coordinate) => {
      const root = rootMap.get(coordinate.id)!,
        order = orderMap.get(coordinate.id)!;
      if (
        !root ||
        !order ||
        root.visibility !== 'approved' ||
        root.deleted_at !== null ||
        !order.live ||
        root.post_id !== postId ||
        order.post_id !== postId ||
        root.scan_at !== coordinate.at ||
        order.scan_at !== coordinate.at ||
        (query.sort === 'likes' && order.like_count !== coordinate.likes)
      )
        restart();
      return {
        ...root,
        like_count: order.like_count,
        is_liked: likedMap.get(root.id)!,
        is_pinned: root.id === pin,
      };
    });
    // Split pin/ordinary reads must describe one observed live ordering. A
    // later change may stale the cursor, but never mix two pin observations.
    if ((await this.pin(postId, tx)) !== pin) restart();
    return result;
  }
  async roots(
    post: StoredPost,
    viewer: string,
    sessionId: string,
    query: CommentsQuery,
    tx: PoolClient,
  ) {
    const scope = await this.scope(
      [
        'discussion-roots-v4',
        post.id,
        viewer,
        sessionId,
        query.sort,
        query.order,
        query.limit,
        query.previewLimit,
      ],
      tx,
    );
    const prior = await this.readPosition(
      query.cursor,
      scope,
      position(rootAnchorSchema, 'root'),
      tx,
    );
    if (prior?.visible) {
      if (
        prior.after.id !== prior.visible.id &&
        !follows(prior.after, prior.visible, query)
      )
        restart();
      const guard = (
        await this.rootCandidates(
          post.id,
          viewer,
          query,
          null,
          tx,
          prior.visible.id,
        )
      )[0];
      if (
        !guard ||
        !(await this.access.visible(viewer, guard, tx, 'detail_projection'))
      )
        restart();
      const anchor = rootAnchor(guard);
      if (
        anchor.at !== prior.visible.at ||
        anchor.pinned !== prior.visible.pinned ||
        (query.sort === 'likes' && anchor.likes !== prior.visible.likes)
      )
        restart();
    }
    const candidates = await this.rootCandidates(
      post.id,
      viewer,
      query,
      prior?.after ?? null,
      tx,
      undefined,
      prior?.visible,
    );
    if (candidates.length > DISCUSSION_SCAN_BATCH + 1)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    let previous = prior?.after ?? null;
    for (const row of candidates) {
      const anchor = rootAnchor(row);
      if (
        row.post_id !== post.id ||
        typeof row.is_liked !== 'boolean' ||
        (previous && !follows(anchor, previous, query))
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      previous = anchor;
    }
    const current = candidates.slice(0, DISCUSSION_SCAN_BATCH);
    await batchCategoryChildContextAllowed(
      current.map((row) => ({
        kind: 'comment',
        id: row.id,
        postId: row.post_id,
      })),
      tx,
    );
    const rows: { row: StoredComment; metadata: CommentMetadata }[] = [];
    let consumed = 0,
      last: RootAnchor | null = null,
      visible = prior?.visible ?? null;
    for (const row of current) {
      if (row.post_id !== post.id || typeof row.is_liked !== 'boolean')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      last = rootAnchor(row);
      consumed++;
      if (await this.access.visible(viewer, row, tx, 'detail_projection')) {
        rows.push({
          row,
          metadata: {
            likeCount: row.like_count,
            isLiked: row.is_liked,
            isPinned: row.is_pinned,
          },
        });
        visible = last;
      }
      if (rows.length === query.limit) break;
    }
    return this.cursorPage(
      rows,
      scope,
      viewer,
      last && consumed < candidates.length
        ? { v: 4, kind: 'root', after: last, visible }
        : null,
      tx,
    );
  }

  private async replyCandidates(
    post: StoredPost,
    root: StoredComment,
    tx: PoolClient,
    after: string | null,
    direction: 'ASC' | 'DESC' = 'ASC',
  ): Promise<StoredReply[]> {
    // Keep the complete scope in both range bounds and ordering. Scalar prefix
    // equalities let PostgreSQL discard the leading pathkeys and choose the
    // globally unique sequence index, filtering unrelated threads before LIMIT.
    // Identical UUID prefixes bound exactly this root; positive bigint sequences
    // make zero exclusive and bigint max inclusive safe first-page endpoints.
    const lower =
      direction === 'ASC' && after !== null ? '$3::bigint' : '0::bigint';
    const upper =
      direction === 'DESC' && after !== null
        ? '< ($1::uuid,$2::uuid,$3::bigint)'
        : '<= ($1::uuid,$2::uuid,9223372036854775807::bigint)';
    const rows = (
      await tx.query<StoredReply>(
        `SELECT * FROM whaleu_community.replies WHERE visibility='approved' AND deleted_at IS NULL
       AND (post_id,root_comment_id,sequence) > ($1::uuid,$2::uuid,${lower})
       AND (post_id,root_comment_id,sequence) ${upper}
       ORDER BY post_id ${direction},root_comment_id ${direction},sequence ${direction}
       LIMIT ${DISCUSSION_SCAN_BATCH + 1} FOR SHARE`,
        after === null ? [post.id, root.id] : [post.id, root.id, after],
      )
    ).rows;
    let previous = after === null ? null : BigInt(after);
    for (const row of rows) {
      const next = BigInt(replyAnchor(row).sequence);
      if (
        previous !== null &&
        !(direction === 'ASC' ? next > previous : next < previous)
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      previous = next;
    }
    return rows;
  }
  private async allowedReplies(
    post: StoredPost,
    root: StoredComment,
    candidates: StoredReply[],
    viewer: string,
    tx: PoolClient,
    limit: number,
  ) {
    if (candidates.length > DISCUSSION_SCAN_BATCH + 1)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const current = candidates.slice(0, DISCUSSION_SCAN_BATCH);
    await batchCategoryChildContextAllowed(
      current.map((row) => ({
        kind: 'reply',
        id: row.id,
        postId: row.post_id,
      })),
      tx,
    );
    const rows: StoredReply[] = [];
    let consumed = 0,
      last: ReplyAnchor | null = null;
    for (const row of current) {
      if (row.post_id !== post.id || row.root_comment_id !== root.id)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      last = replyAnchor(row);
      consumed++;
      if (await this.access.visible(viewer, row, tx, 'detail_projection'))
        rows.push(row);
      if (rows.length === limit) break;
    }
    return { rows, consumed, last };
  }
  async replies(
    post: StoredPost,
    root: StoredComment,
    viewer: string,
    sessionId: string,
    tx: PoolClient,
    limit: number,
    cursor?: string,
    continuationLimit = limit,
  ) {
    const scope = await this.scope(
      [
        'discussion-replies-v4',
        post.id,
        root.id,
        viewer,
        sessionId,
        continuationLimit,
      ],
      tx,
    );
    const prior = await this.readPosition(
      cursor,
      scope,
      position(replyAnchorSchema, 'reply'),
      tx,
    );
    if (prior?.visible) {
      if (BigInt(prior.after.sequence) < BigInt(prior.visible.sequence))
        restart();
      let guard: StoredReply;
      try {
        guard = await this.records.reply(prior.visible.id, tx, true);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'REPLY_NOT_FOUND'
        )
          restart();
        throw error;
      }
      if (
        guard.post_id !== post.id ||
        guard.root_comment_id !== root.id ||
        guard.sequence !== prior.visible.sequence ||
        !(await this.access.visible(viewer, guard, tx, 'detail_projection'))
      )
        restart();
    }
    const candidates = await this.replyCandidates(
      post,
      root,
      tx,
      prior?.after.sequence ?? null,
    );
    const selected = await this.allowedReplies(
      post,
      root,
      candidates,
      viewer,
      tx,
      limit,
    );
    const visible = selected.rows.at(-1);
    return this.cursorPage(
      selected.rows,
      scope,
      viewer,
      selected.last && selected.consumed < candidates.length
        ? {
            v: 4,
            kind: 'reply',
            after: selected.last,
            visible: visible ? replyAnchor(visible) : (prior?.visible ?? null),
          }
        : null,
      tx,
    );
  }

  async context(
    post: StoredPost,
    root: StoredComment,
    viewer: string,
    tx: PoolClient,
    target?: StoredReply,
  ): Promise<StoredReply[]> {
    if (
      target &&
      (target.post_id !== post.id ||
        target.root_comment_id !== root.id ||
        !(await this.access.visible(viewer, target, tx, 'detail_projection')))
    )
      throw new ApplicationError('REPLY_NOT_FOUND');
    if (!target)
      return (
        await this.allowedReplies(
          post,
          root,
          await this.replyCandidates(post, root, tx, null),
          viewer,
          tx,
          2,
        )
      ).rows;
    // The explicitly authorized target is never searched for via an unbounded
    // prefix scan. A hidden-heavy neighborhood may contain fewer than 2 each side.
    const before = await this.allowedReplies(
      post,
      root,
      await this.replyCandidates(post, root, tx, target.sequence, 'DESC'),
      viewer,
      tx,
      2,
    );
    const after = await this.allowedReplies(
      post,
      root,
      await this.replyCandidates(post, root, tx, target.sequence),
      viewer,
      tx,
      2,
    );
    return [...before.rows.reverse(), target, ...after.rows];
  }
}
