import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { CommunitySpace, PostView } from './contracts.js';
import type { StoredPost } from './community.repository.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunitySerializer } from './community-serialization.js';
import { TradingRepository } from './trading/repository.js';
import type { TradingSubtype } from './trading/contracts.js';

export type PublicContentKind = 'posts' | 'trading';
export interface ProfileContentItem {
  post: StoredPost;
  space: CommunitySpace;
}
export const PROFILE_DISCOVERY_BOUND = 1024;

/** Community owns the exact public authored set and every content serializer.
 * The caller must first hold the target profile's privacy and current safety
 * decision. This facade never looks at profile, identity or safety tables. */
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
  ) {}

  async eligible(
    owner: string,
    viewer: string | null,
    kind: PublicContentKind,
    subtype: TradingSubtype | undefined,
    tx: PoolClient,
  ): Promise<ProfileContentItem[]> {
    // IDs only: no chosen contacts or raw record projections enter discovery.
    // Scan the complete bounded authored candidate set, without an age cutoff.
    const candidates = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_community.posts WHERE account_id=$1 AND author_mode='named'
       AND visibility='approved' AND deleted_at IS NULL
       AND (($2='trading' AND category='trading') OR ($2='posts' AND category<>'trading'))
       ORDER BY id LIMIT $3`,
        [owner, kind, PROFILE_DISCOVERY_BOUND + 1],
      )
    ).rows;
    if (candidates.length > PROFILE_DISCOVERY_BOUND)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const eligible: ProfileContentItem[] = [];
    for (const candidate of candidates) {
      try {
        const { post, space } = await this.access.accessiblePost(
          candidate.id,
          viewer,
          tx,
        );
        // Recheck candidate predicates after the parent lock wait.
        if (
          post.account_id !== owner ||
          post.author_mode !== 'named' ||
          (kind === 'trading') !== (post.category === 'trading')
        )
          continue;
        if (kind === 'trading') {
          const listing = await this.trading.find(post.id, tx);
          if (!listing) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (
            listing.resolution !== 'open' ||
            (subtype !== undefined && listing.subtype !== subtype)
          )
            continue;
        }
        eligible.push({ post, space });
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.code !== 'POST_NOT_FOUND'
        )
          throw error;
      }
    }
    eligible.sort(
      (a, b) =>
        b.post.published_at.getTime() - a.post.published_at.getTime() ||
        b.post.id.localeCompare(a.post.id),
    );
    return eligible;
  }

  async project(
    items: ProfileContentItem[],
    viewer: string | null,
    tx: PoolClient,
  ): Promise<PostView[]> {
    const result: PostView[] = [];
    for (const { post, space } of items)
      result.push(
        await this.serializer.post(
          post,
          space,
          viewer,
          await this.access.advisory(viewer, space, tx),
          tx,
        ),
      );
    return result;
  }
}
