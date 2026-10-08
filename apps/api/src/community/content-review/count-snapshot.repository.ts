import { Injectable } from '@nestjs/common';
import { types } from 'pg';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { StoredComment, StoredReply } from '../community.repository.js';
import type { LikedCandidate } from '../liked/repository.js';
import { approvalProjection } from './approval.repository.js';
import type { ApprovalBinding, ApprovalRow } from './approval-validation.js';
import type { ContentKind } from './contracts.js';
import type {
  DefinitionCreator,
  DefinitionFormation,
  DefinitionImage,
  DefinitionListing,
  DefinitionOption,
  DefinitionPoll,
  DefinitionPost,
  DefinitionSpace,
} from './definition-validation.js';

export const COUNT_SNAPSHOT_BATCH = 256;
export const COUNT_SNAPSHOT_NODES = 3 * COUNT_SNAPSHOT_BATCH;
export const COUNT_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const unique = (ids: readonly string[]) => [...new Set(ids)];
const byId = <T extends { id: string }>(rows: T[]) =>
  new Map(rows.map((row) => [row.id, row]));
export const contentKey = (kind: ContentKind, id: string) => `${kind}:${id}`;
function grouped<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row),
      items = result.get(id) ?? [];
    items.push(row);
    result.set(id, items);
  }
  return result;
}
/** Only one bounded query's JSON rows are materialized at once. PostgreSQL checks
 * the uncompressed wire size BEFORE returning body/envelope/contact values. The
 * source LIMIT is safe because every caller is an indexed batch-local key lookup;
 * the sentinel rejects malformed excess children rather than truncating facts.
 * The composite-size precheck avoids JSON encoding obviously oversized rows.
 * This is a wire/JS bound, not a hard PostgreSQL backend-memory limit: TOAST
 * decompression/record construction can still allocate before that precheck. */
export class SnapshotReadBudget {
  private remaining = COUNT_SNAPSHOT_BYTES;
  async rows<T>(
    tx: PoolClient,
    sql: string,
    values: unknown[],
    cap: number,
    dates: readonly string[] = [],
  ): Promise<T[]> {
    // Owner callers derive cap from the exact indexed input-key set. Zero keys
    // cannot match a row, even if a source writer concurrently inserts elsewhere.
    // Avoid four empty child queries for a plain post and two for a liked chain.
    if (cap === 0) return [];
    const result = await tx.query<{
      data: Record<string, unknown> | null;
      bytes: string;
    }>(
      `WITH count_snapshot_source AS MATERIALIZED (${sql} LIMIT ${cap + 1}),
       count_snapshot_measured AS (
         SELECT s, count(*) OVER () AS n,
         sum(CASE WHEN pg_column_size(s)>${this.remaining}
           THEN ${this.remaining + 1}
           ELSE octet_length(row_to_json(s)::text) END) OVER () AS bytes
         FROM count_snapshot_source s
       ) SELECT CASE WHEN n<=${cap} AND bytes<=${this.remaining}
           THEN row_to_json(s) ELSE NULL END AS data,bytes::text
         FROM count_snapshot_measured`,
      values,
    );
    if (result.rows.some((row) => row.data === null))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const bytes = Number(result.rows[0]?.bytes ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    this.remaining -= bytes;
    return result.rows.map(({ data }) => {
      for (const key of dates) {
        if (data![key] === null || data![key] === undefined) continue;
        const text = data![key] as string;
        const standard = new Date(text);
        // Native ISO parsing matches scalar pg milliseconds for ordinary JSON
        // timestamps. Historical second-resolution timezone offsets are not
        // ECMAScript ISO; fall back to pg's exact scalar TIMESTAMPTZ parser.
        data![key] = Number.isFinite(standard.getTime())
          ? standard
          : types.getTypeParser(
              types.builtins.TIMESTAMPTZ,
              'text',
            )(text.replace('T', ' '));
      }
      return data as T;
    });
  }
}
export interface SnapshotReferences {
  posts: string[];
  roots: string[];
  replies: string[];
}
@Injectable()
export class ContentReviewCountRepository {
  async read(references: SnapshotReferences, tx: PoolClient) {
    const postIds = unique(references.posts),
      rootIds = unique(references.roots),
      replyIds = unique(references.replies);
    if (
      postIds.length > COUNT_SNAPSHOT_BATCH ||
      rootIds.length > COUNT_SNAPSHOT_BATCH ||
      replyIds.length > COUNT_SNAPSHOT_BATCH
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const budget = new SnapshotReadBudget();
    const posts = byId(
      await budget.rows<DefinitionPost>(
        tx,
        `SELECT id,space_id,account_id,category,text,author_mode,comments_policy,visibility,deleted_at,published_at,publication_state FROM whaleu_community.posts WHERE id=ANY($1::uuid[])`,
        [postIds],
        postIds.length,
        ['deleted_at', 'published_at'],
      ),
    );
    const roots = byId(
      await budget.rows<StoredComment>(
        tx,
        `SELECT id,post_id,account_id,text,author_mode,visibility,deleted_at,created_at FROM whaleu_community.root_comments WHERE id=ANY($1::uuid[])`,
        [rootIds],
        rootIds.length,
        ['deleted_at', 'created_at'],
      ),
    );
    const replies = byId(
      await budget.rows<StoredReply>(
        tx,
        `SELECT id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode,visibility,deleted_at,created_at,sequence::text FROM whaleu_community.replies WHERE id=ANY($1::uuid[])`,
        [replyIds],
        replyIds.length,
        ['deleted_at', 'created_at'],
      ),
    );
    const spaceIds = unique([...posts.values()].map((post) => post.space_id));
    const spaces = byId(
      await budget.rows<DefinitionSpace>(
        tx,
        'SELECT id,is_active,kind,operating_region_id FROM whaleu_community.spaces WHERE id=ANY($1::uuid[])',
        [spaceIds],
        spaceIds.length,
      ),
    );
    const kinds: ContentKind[] = [
      ...postIds.map(() => 'post' as const),
      ...rootIds.map(() => 'comment' as const),
      ...replyIds.map(() => 'reply' as const),
    ];
    const nodeIds = [...postIds, ...rootIds, ...replyIds];
    // Account existence is the same binding anchor as ApprovalRepository.current;
    // no lifecycle, verification or publication-eligibility query is introduced.
    const bindingRows = await budget.rows<ApprovalBinding>(
      tx,
      `SELECT b.* FROM unnest($1::text[],$2::uuid[]) AS wanted(kind,id)
       JOIN whaleu_community.content_approval_bindings b ON b.content_kind=wanted.kind AND b.content_id=wanted.id AND b.content_version=1
       JOIN whaleu_identity.accounts a ON a.id=b.account_id`,
      [kinds, nodeIds],
      nodeIds.length,
    );
    const bindings = new Map(
      bindingRows.map((binding) => [
        contentKey(binding.content_kind, binding.content_id),
        binding,
      ]),
    );
    const decisionIds = unique(
      bindingRows.map((binding) => binding.decision_id),
    );
    const approvals = byId(
      await budget.rows<ApprovalRow>(
        tx,
        `SELECT ${approvalProjection} FROM whaleu_community.content_approval_decisions d
       JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
       JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
       JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
       WHERE d.id=ANY($1::uuid[])`,
        [decisionIds],
        decisionIds.length,
        [
          'evaluated_at',
          'consume_until',
          'visibility_until',
          'policy_valid_from',
          'policy_valid_until',
          'event_at',
        ],
      ),
    );
    const images = grouped(
      await budget.rows<
        DefinitionImage & { kind: ContentKind; content_id: string }
      >(
        tx,
        `SELECT * FROM (
         SELECT 'post'::text kind,post_id content_id,asset_id AS "assetId",digest,position FROM whaleu_community.post_images WHERE post_id=ANY($1::uuid[])
         UNION ALL SELECT 'comment',comment_id,asset_id,digest,position FROM whaleu_community.comment_images WHERE comment_id=ANY($2::uuid[])
         UNION ALL SELECT 'reply',reply_id,asset_id,digest,position FROM whaleu_community.reply_images WHERE reply_id=ANY($3::uuid[])
       ) image_rows ORDER BY kind,content_id,position`,
        [postIds, rootIds, replyIds],
        9 * postIds.length + 3 * rootIds.length + 3 * replyIds.length,
      ),
      (row) => contentKey(row.kind, row.content_id),
    );
    const pollRows = await budget.rows<DefinitionPoll & { post_id: string }>(
      tx,
      'SELECT id,post_id,question,selection_mode,deadline FROM whaleu_community.polls WHERE post_id=ANY($1::uuid[])',
      [postIds],
      postIds.length,
      ['deadline'],
    );
    const formationRows = await budget.rows<
      DefinitionFormation & { post_id: string }
    >(
      tx,
      'SELECT id,post_id,capacity,theme,reconciliation FROM whaleu_community.formations WHERE post_id=ANY($1::uuid[])',
      [postIds],
      postIds.length,
    );
    const listings = new Map(
      (
        await budget.rows<DefinitionListing & { post_id: string }>(
          tx,
          'SELECT post_id,subtype,price::text,urgency,location,wechat,qq,phone,legacy_raw_price,legacy_raw_subtype,resolution FROM whaleu_community.trading_listings WHERE post_id=ANY($1::uuid[])',
          [postIds],
          postIds.length,
        )
      ).map((row) => [row.post_id, row]),
    );
    const options = grouped(
      await budget.rows<DefinitionOption & { poll_id: string }>(
        tx,
        'SELECT poll_id,label,position FROM whaleu_community.poll_options WHERE poll_id=ANY($1::uuid[]) ORDER BY poll_id,position',
        [pollRows.map((row) => row.id)],
        5 * pollRows.length,
      ),
      (row) => row.poll_id,
    );
    const creators = grouped(
      await budget.rows<DefinitionCreator & { formation_id: string }>(
        tx,
        'SELECT formation_id,account_id,wechat,qq,phone,contact_sharing FROM whaleu_community.formation_members WHERE formation_id=ANY($1::uuid[]) AND is_creator',
        [formationRows.map((row) => row.id)],
        formationRows.length,
      ),
      (row) => row.formation_id,
    );
    const now =
      (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]?.now.getTime() ?? NaN;
    return {
      posts,
      roots,
      replies,
      spaces,
      bindings,
      approvals,
      images,
      polls: new Map(pollRows.map((row) => [row.post_id, row])),
      formations: new Map(formationRows.map((row) => [row.post_id, row])),
      listings,
      options,
      creators,
      now,
      budget,
      dependencies: {
        contentIds: unique(nodeIds),
        spaceIds,
        namedAccountIds: [] as string[],
      },
    };
  }
  async memberships(
    candidates: readonly LikedCandidate[],
    owner: string,
    tx: PoolClient,
    budget: SnapshotReadBudget,
  ) {
    const rows = await budget.rows<{
      kind: ContentKind;
      target_id: string;
      like_id: string;
      liked_at: Date | null;
    }>(
      tx,
      `SELECT 'post'::text kind,post_id target_id,like_id,liked_at FROM whaleu_community.post_likes WHERE account_id=$1 AND post_id=ANY($2::uuid[])
       UNION ALL SELECT 'comment',comment_id,like_id,liked_at FROM whaleu_community.comment_likes WHERE account_id=$1 AND comment_id=ANY($3::uuid[])
       UNION ALL SELECT 'reply',reply_id,like_id,liked_at FROM whaleu_community.reply_likes WHERE account_id=$1 AND reply_id=ANY($4::uuid[])`,
      [
        owner,
        ...(['post', 'comment', 'reply'] as const).map((kind) =>
          candidates
            .filter((item) => item.kind === kind)
            .map((item) => item.target_id),
        ),
      ],
      candidates.length,
      ['liked_at'],
    );
    return new Map(
      rows.map((row) => [contentKey(row.kind, row.target_id), row]),
    );
  }
}
export type CountReviewSnapshot = Awaited<
  ReturnType<ContentReviewCountRepository['read']>
>;
