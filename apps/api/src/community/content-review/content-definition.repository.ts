import type { SearchReadContext } from './search-read-context.js';
import {
  searchPost,
  searchRoot,
  searchReply,
  searchSpace,
  searchListing,
} from './search-source-reads.js';
const regionOwner = {};
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusService } from '../../campus/campus.service.js';
import type { Decision } from '../community-policy.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import {
  reconstructDefinition,
  definitionNodeDecision,
  definitionScopeDecision,
} from './definition-validation.js';
import type {
  CurrentContent,
  DefinitionPayload,
} from './definition-validation.js';
export type { CurrentContent } from './definition-validation.js';
import type { ContentKind, ContentScopeSnapshot } from './contracts.js';

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
    read?: SearchReadContext,
  ): Promise<Decision<CurrentContent>> {
    let postId = id;
    let rootId: string | null = null;
    if (kind !== 'post') {
      const table = kind === 'comment' ? 'root_comments' : 'replies';
      const reference = read
        ? await (kind === 'comment'
            ? searchRoot(id, tx, read)
            : searchReply(id, tx, read))
        : (
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
    const post = read
      ? await searchPost(postId, tx, read)
      : (
          await tx.query<StoredPost & { publication_state: string }>(
            'SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
            [postId],
          )
        ).rows[0];
    const postDecision = definitionNodeDecision(post, true);
    if (postDecision.kind !== 'allow') return postDecision;
    if (!post) return { kind: 'unavailable' };
    const space = read
      ? await searchSpace(post.space_id, tx, read)
      : (
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
        const regionId = space.operating_region_id;
        if (read)
          await read.read(
            regionOwner,
            regionId,
            tx,
            async () => {
              await this.campuses.requireActiveRegion(regionId, tx);
              return true;
            },
            (active) => active,
          );
        else await this.campuses.requireActiveRegion(regionId, tx);
      } catch {
        return { kind: 'unavailable' };
      }
    }
    const scopeDecision = definitionScopeDecision(space, scope, true);
    if (scopeDecision.kind !== 'allow') return scopeDecision;
    let content: StoredPost | StoredComment | StoredReply = post;
    const parents: CurrentContent['parents'] = [];
    if (kind !== 'post') {
      const root = read
        ? await searchRoot(rootId!, tx, read)
        : (
            await tx.query<StoredComment>(
              'SELECT * FROM whaleu_community.root_comments WHERE id=$1 AND post_id=$2 FOR SHARE',
              [rootId, post.id],
            )
          ).rows[0];
      const rootDecision = definitionNodeDecision(
        root?.post_id === post.id ? root : undefined,
      );
      if (rootDecision.kind !== 'allow') return rootDecision;
      if (!root) return { kind: 'unavailable' };
      parents.push({ kind: 'post', id: post.id });
      content = root;
      if (kind === 'reply') {
        const reply = read
          ? await searchReply(id, tx, read)
          : (
              await tx.query<StoredReply>(
                'SELECT * FROM whaleu_community.replies WHERE id=$1 AND post_id=$2 AND root_comment_id=$3 FOR SHARE',
                [id, post.id, root.id],
              )
            ).rows[0];
        if (
          !reply ||
          reply.post_id !== post.id ||
          reply.root_comment_id !== root.id ||
          reply.deleted_at ||
          reply.visibility === 'hidden'
        )
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
    const facts: DefinitionPayload = { images, options: [], creators: [] };
    if (images.some((image, position) => image.position !== position))
      return { kind: 'unavailable' };
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
      const listing = read
        ? await searchListing(id, tx, read)
        : (
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
      facts.poll = poll;
      facts.formation = formation;
      facts.listing = listing;
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
        facts.options = options;
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
        facts.creators = creators;
      }
    }

    return reconstructDefinition(
      kind,
      post,
      content,
      rootId,
      scope,
      parents,
      facts,
    );
  }
}
