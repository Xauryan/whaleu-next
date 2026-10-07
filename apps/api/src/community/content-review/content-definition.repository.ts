import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusService } from '../../campus/campus.service.js';
import type { Decision } from '../community-policy.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import { canonicalEnvelope } from './contracts.js';
import type {
  ContentKind,
  ContentScopeSnapshot,
  EffectiveContentEnvelope,
} from './contracts.js';

export interface CurrentContent {
  envelope: EffectiveContentEnvelope;
  authorAccountId: string;
  authorMode: 'named' | 'anonymous';
  parents: { kind: ContentKind; id: string }[];
}
@Injectable()
export class ContentDefinitionRepository {
  constructor(
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  /** Content ancestry is locked post -> root -> reply. No access/safety facade is
   * invoked here; this is the leaf owner of the effective stored definition. */
  async current(
    kind: ContentKind,
    id: string,
    scope: ContentScopeSnapshot,
    tx: PoolClient,
  ): Promise<Decision<CurrentContent>> {
    let postId = id;
    let rootId: string | null = null;
    if (kind !== 'post') {
      const table = kind === 'comment' ? 'root_comments' : 'replies';
      const reference = (
        await tx.query<StoredComment | StoredReply>(
          `SELECT * FROM whaleu_community.${table} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!reference) return { kind: 'deny', reason: 'POST_NOT_FOUND' };
      postId = reference.post_id;
      rootId =
        kind === 'comment' ? id : (reference as StoredReply).root_comment_id;
    }
    const post = (
      await tx.query<StoredPost & { publication_state: string }>(
        'SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
        [postId],
      )
    ).rows[0];
    if (!post || post.deleted_at || post.visibility === 'hidden')
      return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    if (
      post.visibility !== 'approved' ||
      post.publication_state !== 'published'
    )
      return { kind: 'unavailable' };
    const space = (
      await tx.query<{
        id: string;
        is_active: boolean;
        kind: string;
        operating_region_id: string | null;
      }>(
        'SELECT id,is_active,kind,operating_region_id FROM whaleu_community.spaces WHERE id=$1 FOR SHARE',
        [post.space_id],
      )
    ).rows[0];
    if (!space) return { kind: 'unavailable' };
    if (!space.is_active) return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    if (space.operating_region_id) {
      try {
        await this.campuses.requireActiveRegion(space.operating_region_id, tx);
      } catch {
        return { kind: 'unavailable' };
      }
    }
    if (
      space.id !== scope.originalSpaceId ||
      space.operating_region_id !== scope.originalRegionId ||
      !['regional', 'global'].includes(space.kind) ||
      scope.sync !== 'none'
    )
      return { kind: 'unavailable' };
    let content: StoredPost | StoredComment | StoredReply = post;
    const parents: CurrentContent['parents'] = [];
    if (kind !== 'post') {
      const root = (
        await tx.query<StoredComment>(
          'SELECT * FROM whaleu_community.root_comments WHERE id=$1 AND post_id=$2 FOR SHARE',
          [rootId, post.id],
        )
      ).rows[0];
      if (!root || root.deleted_at || root.visibility === 'hidden')
        return { kind: 'deny', reason: 'POST_NOT_FOUND' };
      if (root.visibility !== 'approved') return { kind: 'unavailable' };
      parents.push({ kind: 'post', id: post.id });
      content = root;
      if (kind === 'reply') {
        const reply = (
          await tx.query<StoredReply>(
            'SELECT * FROM whaleu_community.replies WHERE id=$1 AND post_id=$2 AND root_comment_id=$3 FOR SHARE',
            [id, post.id, root.id],
          )
        ).rows[0];
        if (!reply || reply.deleted_at || reply.visibility === 'hidden')
          return { kind: 'deny', reason: 'POST_NOT_FOUND' };
        if (reply.visibility !== 'approved') return { kind: 'unavailable' };
        content = reply;
        parents.push({ kind: 'comment', id: root.id });
      }
    }
    const images = (
      await tx.query<{ assetId: string; digest: string; position: number }>(
        `SELECT asset_id AS "assetId",digest,position FROM whaleu_community.${kind}_images WHERE ${kind}_id=$1 ORDER BY position FOR SHARE`,
        [id],
      )
    ).rows;
    if (images.some((image, position) => image.position !== position))
      return { kind: 'unavailable' };
    let component: EffectiveContentEnvelope['component'] = { kind: 'none' };
    let trading: EffectiveContentEnvelope['trading'] = null;
    if (kind === 'post') {
      const poll = (
        await tx.query<{
          id: string;
          question: string;
          selection_mode: 'single' | 'multiple';
          deadline: Date | null;
        }>(
          'SELECT id,question,selection_mode,deadline FROM whaleu_community.polls WHERE post_id=$1 FOR SHARE',
          [id],
        )
      ).rows[0];
      const formation = (
        await tx.query<{
          id: string;
          capacity: number;
          theme: string;
          reconciliation: string;
        }>(
          'SELECT id,capacity,theme,reconciliation FROM whaleu_community.formations WHERE post_id=$1 FOR SHARE',
          [id],
        )
      ).rows[0];
      const listing = (
        await tx.query<{
          subtype: string;
          price: string;
          urgency: string;
          location: string;
          wechat: string;
          qq: string;
          phone: string;
          legacy_raw_price: string | null;
          legacy_raw_subtype: string | null;
        }>(
          'SELECT subtype,price::text,urgency,location,wechat,qq,phone,legacy_raw_price,legacy_raw_subtype FROM whaleu_community.trading_listings WHERE post_id=$1 FOR SHARE',
          [id],
        )
      ).rows[0];
      if ([poll, formation, listing].filter(Boolean).length > 1)
        return { kind: 'unavailable' };
      if (poll) {
        if (poll.deadline !== null) return { kind: 'unavailable' };
        const options = (
          await tx.query<{ label: string; position: number }>(
            'SELECT label,position FROM whaleu_community.poll_options WHERE poll_id=$1 ORDER BY position FOR SHARE',
            [poll.id],
          )
        ).rows;
        if (options.some((option, position) => option.position !== position))
          return { kind: 'unavailable' };
        component = {
          kind: 'poll',
          question: poll.question,
          selectionMode: poll.selection_mode,
          options: options.map((option) => option.label),
        };
      }
      if (formation) {
        const creators = (
          await tx.query<{
            account_id: string;
            wechat: string;
            qq: string;
            phone: string;
            contact_sharing: string;
          }>(
            'SELECT account_id,wechat,qq,phone,contact_sharing FROM whaleu_community.formation_members WHERE formation_id=$1 AND is_creator FOR SHARE',
            [formation.id],
          )
        ).rows;
        const creator = creators[0];
        if (
          formation.reconciliation !== 'current' ||
          creators.length !== 1 ||
          !creator ||
          creator.account_id !== post.account_id ||
          creator.contact_sharing !== 'members_v1'
        )
          return { kind: 'unavailable' };
        component = {
          kind: 'formation',
          capacity: formation.capacity,
          theme: formation.theme,
          contacts: {
            wechat: creator.wechat,
            qq: creator.qq,
            phone: creator.phone,
          },
          contactSharing: 'members_v1',
        };
      }
      if (listing) {
        if (
          listing.legacy_raw_price !== null ||
          listing.legacy_raw_subtype !== null
        )
          return { kind: 'unavailable' };
        // The strict envelope parser validates the immutable known subtype,
        // decimal normalization, contact fields and effective urgency below.
        trading = {
          subtype: listing.subtype,
          price: listing.price,
          urgency: listing.urgency,
          location: listing.location,
          contacts: {
            wechat: listing.wechat,
            qq: listing.qq,
            phone: listing.phone,
          },
        } as EffectiveContentEnvelope['trading'];
      }
    }
    try {
      const envelope = canonicalEnvelope({
        version: 1,
        accountId: content.account_id,
        purpose:
          kind === 'post'
            ? 'publish_post'
            : kind === 'comment'
              ? 'publish_comment'
              : 'publish_reply',
        spaceId: post.space_id,
        category: post.category,
        authorMode: content.author_mode,
        commentsPolicy: post.comments_policy,
        postId: kind === 'post' ? null : post.id,
        rootCommentId: kind === 'reply' ? rootId : null,
        targetReplyId:
          kind === 'reply' ? (content as StoredReply).target_reply_id : null,
        text: content.text,
        images: images.map(({ assetId, digest }) => ({ assetId, digest })),
        component,
        trading,
        scope,
      });
      return {
        kind: 'allow',
        value: {
          envelope,
          authorAccountId: content.account_id,
          authorMode: content.author_mode,
          parents,
        },
      };
    } catch {
      return { kind: 'unavailable' };
    }
  }
}
