import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { transactionReadEpoch } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';

export const COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE = 16;
const CANDIDATE_LIMIT = 8;
type ContentKind = 'post' | 'comment' | 'reply';
type Phase = 'self' | 'comments' | 'replies' | 'complete';
interface Job {
  id: string;
  resource_kind: ContentKind;
  resource_id: string;
  post_id: string;
  root_comment_id: string | null;
  source_deleted_at: string;
  phase: Phase;
  cursor_id: string | null;
}
interface ContentRow {
  id: string;
  post_id: string;
  root_comment_id?: string;
}
export interface CommunityMediaCleanupParent {
  readonly ownerKind: 'community';
  readonly resourceKind: ContentKind;
  readonly resourceId: string;
  readonly contentVersion: 1;
}
export interface CommunityMediaCleanupPage {
  readonly jobId: string;
  readonly parents: readonly CommunityMediaCleanupParent[];
}
interface PageFacts {
  readonly tx: PoolClient;
  readonly epoch: object;
  readonly job: Job;
  readonly nextPhase: Phase;
  readonly nextCursor: string | null;
}

/** Owner-local bounded enumeration. No Media implementation queries Community
 * business tables. Only tombstones authorize detachment; a held/hidden/revoked
 * target does not create cleanup work. Referenced replies are not ancestors.
 *
 * Routing hints never grant authority. Lock order is the existing Safety writer
 * gate -> post UPDATE -> root when applicable -> job UPDATE SKIP LOCKED ->
 * bounded canonical child rows -> Media's batch/intent/asset/binding locks.
 * Per-post exclusion also orders overlapping post/root/reply cleanup jobs.
 */
@Injectable()
export class CommunityMediaCleanupFacade {
  private readonly pages = new WeakMap<CommunityMediaCleanupPage, PageFacts>();

  async claimPage(
    tx: PoolClient,
    jobId?: string,
  ): Promise<CommunityMediaCleanupPage | null> {
    const epoch = this.managed(tx);
    const hints = (
      await tx.query<Job>(
        `SELECT id,resource_kind,resource_id,post_id,root_comment_id,
          source_deleted_at::text,phase,cursor_id
         FROM whaleu_community.media_cleanup_jobs
         WHERE enumeration_completed_at IS NULL AND ($1::uuid IS NULL OR id=$1)
         ORDER BY updated_at,id LIMIT $2`,
        [jobId ?? null, CANDIDATE_LIMIT],
      )
    ).rows;
    if (!hints.length) return null;
    // Media DML already takes this writer gate. Acquire it before all row locks;
    // taking shared first would create a shared-to-exclusive upgrade inversion.
    await lockSafetyPolicy(tx, true);
    for (const hint of hints) {
      await tx.query('SAVEPOINT community_media_cleanup_candidate');
      const job = await this.lockJob(hint, tx);
      if (!job) {
        await tx.query(
          'ROLLBACK TO SAVEPOINT community_media_cleanup_candidate',
        );
        await tx.query('RELEASE SAVEPOINT community_media_cleanup_candidate');
        continue;
      }
      const result = await this.enumerate(job, tx);
      await tx.query('RELEASE SAVEPOINT community_media_cleanup_candidate');
      const page: CommunityMediaCleanupPage = Object.freeze({
        jobId: job.id,
        parents: Object.freeze(result.parents),
      });
      this.pages.set(page, { tx, epoch, job, ...result });
      return page;
    }
    return null;
  }

  /** Called only after every detach in this page succeeds in the SAME managed
   * transaction. A thrown detach, failed final proof, rollback or process death
   * retains the prior cursor and all obligations for a retry. There is no
   * persisted lease to expire: PostgreSQL owns this short transaction claim. */
  async completePage(
    page: CommunityMediaCleanupPage,
    tx: PoolClient,
  ): Promise<'progress' | 'enumeration-complete'> {
    const facts = this.pages.get(page);
    if (!facts || facts.tx !== tx || facts.epoch !== this.managed(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.pages.delete(page);
    const result = await tx.query(
      `UPDATE whaleu_community.media_cleanup_jobs SET phase=$2,cursor_id=$3,
       detached_targets=detached_targets+$4,updated_at=clock_timestamp(),
       enumeration_completed_at=CASE WHEN $2='complete' THEN clock_timestamp() ELSE NULL END
       WHERE id=$1 AND phase=$5 AND cursor_id IS NOT DISTINCT FROM $6::uuid
       AND enumeration_completed_at IS NULL`,
      [
        facts.job.id,
        facts.nextPhase,
        facts.nextCursor,
        page.parents.length,
        facts.job.phase,
        facts.job.cursor_id,
      ],
    );
    if (result.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return facts.nextPhase === 'complete' ? 'enumeration-complete' : 'progress';
  }

  private async lockJob(hint: Job, tx: PoolClient): Promise<Job | null> {
    const post = await tx.query(
      'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE SKIP LOCKED',
      [hint.post_id],
    );
    if (post.rowCount !== 1) return null;
    if (hint.root_comment_id) {
      const root = await tx.query(
        `SELECT id FROM whaleu_community.root_comments WHERE id=$1 AND post_id=$2
         FOR UPDATE SKIP LOCKED`,
        [hint.root_comment_id, hint.post_id],
      );
      if (root.rowCount !== 1) return null;
    }
    const job = (
      await tx.query<Job>(
        `SELECT id,resource_kind,resource_id,post_id,root_comment_id,
          source_deleted_at::text,phase,cursor_id
         FROM whaleu_community.media_cleanup_jobs WHERE id=$1
         AND enumeration_completed_at IS NULL FOR UPDATE SKIP LOCKED`,
        [hint.id],
      )
    ).rows[0];
    if (!job) return null;
    if (
      job.resource_kind !== hint.resource_kind ||
      job.resource_id !== hint.resource_id ||
      job.post_id !== hint.post_id ||
      job.root_comment_id !== hint.root_comment_id ||
      job.source_deleted_at !== hint.source_deleted_at
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const table =
      job.resource_kind === 'post'
        ? 'posts'
        : job.resource_kind === 'comment'
          ? 'root_comments'
          : 'replies';
    // Exact current tombstone, under the canonical parent/child locks. This
    // refuses fabricated queue routing and never detaches a restored object.
    const source = await tx.query<ContentRow>(
      `SELECT id,${job.resource_kind === 'post' ? 'id AS post_id' : 'post_id'}
        ${job.resource_kind === 'reply' ? ',root_comment_id' : ''}
       FROM whaleu_community.${table} WHERE id=$1 AND deleted_at=$2::timestamptz
       FOR UPDATE NOWAIT`,
      [job.resource_id, job.source_deleted_at],
    );
    const current = source.rows[0];
    if (
      !current ||
      current.post_id !== job.post_id ||
      (job.resource_kind === 'comment' && current.id !== job.root_comment_id) ||
      (job.resource_kind === 'reply' &&
        current.root_comment_id !== job.root_comment_id)
    )
      return null;
    return job;
  }

  private async enumerate(
    job: Job,
    tx: PoolClient,
  ): Promise<{
    parents: CommunityMediaCleanupParent[];
    nextPhase: Phase;
    nextCursor: string | null;
  }> {
    const parent = (
      kind: ContentKind,
      id: string,
    ): CommunityMediaCleanupParent =>
      Object.freeze({
        ownerKind: 'community',
        resourceKind: kind,
        resourceId: id,
        contentVersion: 1,
      });
    if (job.phase === 'self')
      return {
        parents: [parent(job.resource_kind, job.resource_id)],
        nextPhase:
          job.resource_kind === 'post'
            ? 'comments'
            : job.resource_kind === 'comment'
              ? 'replies'
              : 'complete',
        nextCursor: null,
      };
    let rows: ContentRow[];
    if (job.phase === 'comments' && job.resource_kind === 'post') {
      rows = (
        await tx.query<ContentRow>(
          `SELECT id,post_id FROM whaleu_community.root_comments
           WHERE post_id=$1 AND ($2::uuid IS NULL OR id>$2)
           ORDER BY id LIMIT $3 FOR UPDATE NOWAIT`,
          [job.post_id, job.cursor_id, COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE],
        )
      ).rows;
    } else if (job.phase === 'replies' && job.resource_kind !== 'reply') {
      // First route at most 16 replies, then lock their roots before their rows.
      // The post is already held UPDATE, so no legitimate child writer can add
      // an item behind this cursor or change the hinted ancestry.
      const column =
        job.resource_kind === 'post' ? 'post_id' : 'root_comment_id';
      const id =
        job.resource_kind === 'post' ? job.post_id : job.root_comment_id;
      const hints = (
        await tx.query<ContentRow>(
          `SELECT id,post_id,root_comment_id FROM whaleu_community.replies
           WHERE ${column}=$1 AND ($2::uuid IS NULL OR id>$2)
           ORDER BY id LIMIT $3`,
          [id, job.cursor_id, COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE],
        )
      ).rows;
      if (!hints.length) rows = [];
      else {
        const roots = [
          ...new Set(hints.map((row) => row.root_comment_id!)),
        ].sort();
        const lockedRoots = await tx.query(
          `SELECT id FROM whaleu_community.root_comments WHERE post_id=$1 AND id=ANY($2::uuid[])
           ORDER BY id FOR UPDATE NOWAIT`,
          [job.post_id, roots],
        );
        if (lockedRoots.rowCount !== roots.length)
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        rows = (
          await tx.query<ContentRow>(
            `SELECT id,post_id,root_comment_id FROM whaleu_community.replies
             WHERE post_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,
            [job.post_id, hints.map((row) => row.id)],
          )
        ).rows;
        if (
          rows.length !== hints.length ||
          rows.some(
            (row, index) =>
              row.id !== hints[index]!.id ||
              row.root_comment_id !== hints[index]!.root_comment_id,
          )
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
      }
    } else throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (
      rows.length > COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE ||
      rows.some((row) => row.post_id !== job.post_id)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const exhausted = rows.length < COMMUNITY_MEDIA_CLEANUP_PAGE_SIZE;
    return {
      parents: rows.map((row) =>
        parent(job.phase === 'comments' ? 'comment' : 'reply', row.id),
      ),
      nextPhase: exhausted
        ? job.phase === 'comments'
          ? 'replies'
          : 'complete'
        : job.phase,
      nextCursor: exhausted ? null : rows.at(-1)!.id,
    };
  }

  private managed(tx: PoolClient): object {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return epoch;
  }
}
