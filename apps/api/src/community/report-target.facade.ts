import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ReportTarget } from '../safety/reporting/contracts.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunityRepository } from './community.repository.js';
import type {
  StoredPost,
  StoredComment,
  StoredReply,
} from './community.repository.js';
import type { CommunitySpace } from './contracts.js';
export interface ReportScope {
  kind: 'regional' | 'global';
  operatingRegionId: string | null;
}
export interface ResolvedReportTarget {
  target: ReportTarget;
  postId: string;
  rootId: string | null;
  replyId: string | null;
  ownerAccountId: string;
  version: string;
  scope: ReportScope;
  native: boolean;
}
export type SettlementTarget =
  | { status: 'live'; value: ResolvedReportTarget }
  | { status: 'removed' }
  | { status: 'changed' };
@Injectable()
export class CommunityReportTargetFacade {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  private async lock(target: ReportTarget, tx: PoolClient, write: boolean) {
    const reference =
      target.kind === 'post'
        ? null
        : target.kind === 'comment'
          ? await this.repository.comment(target.id, tx)
          : await this.repository.reply(target.id, tx);
    const post = await this.repository.post(
      reference?.post_id ?? target.id,
      tx,
      write,
    );
    let root: StoredComment | null = null,
      reply: StoredReply | null = null;
    if (reference) {
      const rootId =
        target.kind === 'reply'
          ? (reference as StoredReply).root_comment_id
          : reference.id;
      root =
        (
          await tx.query<StoredComment>(
            `SELECT * FROM whaleu_community.root_comments WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
            [rootId],
          )
        ).rows[0] ?? null;
      if (!root || root.post_id !== post.id)
        throw new ApplicationError('REPORT_TARGET_UNAVAILABLE');
    }
    if (target.kind === 'reply') {
      reply =
        (
          await tx.query<StoredReply>(
            `SELECT * FROM whaleu_community.replies WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
            [target.id],
          )
        ).rows[0] ?? null;
      if (
        !reply ||
        reply.post_id !== post.id ||
        reply.root_comment_id !== root?.id
      )
        throw new ApplicationError('REPORT_TARGET_UNAVAILABLE');
    }
    return { post, root, reply, content: reply ?? root ?? post };
  }
  private async resolved(
    target: ReportTarget,
    locked: {
      post: StoredPost;
      root: StoredComment | null;
      reply: StoredReply | null;
      content: StoredPost | StoredComment;
    },
    scope: ReportScope,
    tx: PoolClient,
  ): Promise<ResolvedReportTarget> {
    const { post, root, reply, content } = locked;
    const images = await this.repository.images(target.kind, target.id, tx);
    // Canonical component definitions only: never mutable ballots, membership or counts.
    const component =
      target.kind === 'post'
        ? (
            await tx.query<{ definition: unknown }>(
              `SELECT jsonb_build_object('poll',(SELECT to_jsonb(p)-'creation_transaction' FROM whaleu_community.polls p WHERE p.post_id=$1),'options',(SELECT jsonb_agg(jsonb_build_object('position',o.position,'label',o.label) ORDER BY o.position) FROM whaleu_community.poll_options o JOIN whaleu_community.polls p ON p.id=o.poll_id WHERE p.post_id=$1),'trading',(SELECT to_jsonb(t)-'resolution' FROM whaleu_community.trading_listings t WHERE t.post_id=$1),'formation',(SELECT jsonb_build_object('capacity',f.capacity,'theme',f.theme) FROM whaleu_community.formations f WHERE f.post_id=$1)) AS definition`,
              [post.id],
            )
          ).rows[0]!.definition
        : null;
    const version = createHash('sha256')
      .update(
        JSON.stringify({
          target,
          postId: post.id,
          rootId: root?.id ?? null,
          text: content.text,
          authorMode: content.author_mode,
          images: images.map((x) => x.digest),
          component,
        }),
      )
      .digest('hex');
    const native = !!(
      await tx.query(
        'SELECT 1 FROM whaleu_community.report_origins WHERE kind=$1 AND target_id=$2 AND owner_account_id=$3 AND provenance=$4',
        [target.kind, target.id, content.account_id, 'native_publication'],
      )
    ).rowCount;
    return {
      target,
      postId: post.id,
      rootId: root?.id ?? null,
      replyId: reply?.id ?? null,
      ownerAccountId: content.account_id,
      version,
      scope,
      native,
    };
  }
  async resolveVisible(
    target: ReportTarget,
    actor: string,
    tx: PoolClient,
    mutation: boolean,
  ): Promise<ResolvedReportTarget> {
    try {
      const locked = await this.lock(target, tx, mutation);
      const { post, root, reply } = locked;
      const space: CommunitySpace = await this.repository.space(
        post.space_id,
        tx,
      );
      if (
        !(await this.access.visible(actor, post, tx, 'direct_post')) ||
        (root &&
          !(await this.access.visible(actor, root, tx, 'list_projection'))) ||
        (reply &&
          !(await this.access.visible(actor, reply, tx, 'list_projection')))
      )
        throw new ApplicationError('REPORT_TARGET_UNAVAILABLE');
      return this.resolved(
        target,
        locked,
        { kind: space.kind, operatingRegionId: space.operatingRegionId },
        tx,
      );
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'POST_NOT_FOUND',
          'POST_BLOCKED_BY_YOU',
          'COMMENT_NOT_FOUND',
          'REPLY_NOT_FOUND',
          'COMMUNITY_SCOPE_UNAVAILABLE',
        ].includes(error.code)
      )
        throw new ApplicationError('REPORT_TARGET_UNAVAILABLE');
      throw error;
    }
  }
  async lockForSettlement(
    target: ReportTarget,
    expectedVersion: string,
    tx: PoolClient,
  ): Promise<SettlementTarget> {
    try {
      const locked = await this.lock(target, tx, true);
      if ([locked.post, locked.root, locked.reply].some((x) => x?.deleted_at))
        return { status: 'removed' };
      if (
        [locked.post, locked.root, locked.reply].some(
          (x) => x && x.visibility !== 'approved',
        )
      )
        return { status: 'changed' };
      const scope = (
        await tx.query<{
          kind: 'regional' | 'global';
          operatingRegionId: string | null;
        }>(
          'SELECT kind,operating_region_id AS "operatingRegionId" FROM whaleu_community.spaces WHERE id=$1',
          [locked.post.space_id],
        )
      ).rows[0];
      if (!scope) return { status: 'changed' };
      const value = await this.resolved(target, locked, scope, tx);
      return value.version === expectedVersion && value.native
        ? { status: 'live', value }
        : { status: 'changed' };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        [
          'POST_NOT_FOUND',
          'COMMENT_NOT_FOUND',
          'REPLY_NOT_FOUND',
          'REPORT_TARGET_UNAVAILABLE',
        ].includes(error.code)
      )
        return { status: 'changed' };
      throw error;
    }
  }
}
