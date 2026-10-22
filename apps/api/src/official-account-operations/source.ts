import type { PoolClient } from 'pg';
import { checkpointTransactionDeadlines } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { currentHotScoreCertificate } from '../community/hot-score/certificate.js';
import { HotScoreRepository } from '../community/hot-score/repository.js';
import { HotScoreStorage } from '../community/hot-score/storage.js';
import { CommunityRepository } from '../community/community.repository.js';
import { CommunityAccessService } from '../community/community-access.service.js';
import { ownerPostVisibilityAllowed } from '../community/owner-visibility/read-proof.js';
import { homeDistributionAllowed } from '../community/home-distribution/read-proof.js';
import { officialDigest } from './profile.js';

export interface OfficialSourceFact {
  postId: string;
  spaceId: string;
  publishedAt: string;
  revision: string;
  eligibilityRevision: string;
  decision: 'allow' | 'deny' | 'unknown';
  score: string | null;
  certificateHash: string | null;
  digest: string;
  validUntil: string | null;
}
export interface OfficialPublicProjection {
  text: string;
  publicCounts: { likes: string; comments: string; subscriptions: string };
  locator: string;
  mediaAppearanceRefs: string[];
}
/** A purpose-specific Community/Media projection, never a raw counter or public serializer. */
export interface OfficialPublicProjectionPort {
  read(postId: string, tx: PoolClient): Promise<OfficialPublicProjection>;
}
export interface OfficialSourcePort {
  inspect(
    postId: string,
    scoreRequired: boolean,
    tx: PoolClient,
  ): Promise<OfficialSourceFact | null>;
  project(postId: string, tx: PoolClient): Promise<OfficialPublicProjection>;
}
/** Reuses actual current Community Review/Safety/owner visibility and exact score owner.
 * Separate explicit eligibility is mandatory even when the public post is readable. */
export class CommunityOfficialSource implements OfficialSourcePort {
  constructor(
    private readonly posts: CommunityRepository,
    private readonly access: CommunityAccessService,
    private readonly scores: HotScoreRepository,
    private readonly storage: HotScoreStorage,
    private readonly projection: OfficialPublicProjectionPort,
  ) {}
  async inspect(
    postId: string,
    scoreRequired: boolean,
    tx: PoolClient,
  ): Promise<OfficialSourceFact | null> {
    const row = (
      await tx.query<{
        id: string;
        space_id: string;
        published_at: Date;
        local_creation_transaction: string;
      }>(
        'SELECT id,space_id,published_at,local_creation_transaction::text FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
        [postId],
      )
    ).rows[0];
    if (!row) return null;
    const eligibility = (
      await tx.query<{
        revision: string;
        decision: 'allow' | 'deny' | 'unknown';
        current: boolean;
      }>(
        `SELECT revision,decision,(revoked_at IS NULL AND publication_xid=$2::xid8 AND profile='synthetic-official-v1') current
       FROM whaleu_official.export_eligibility WHERE post_id=$1 FOR SHARE`,
        [postId, row.local_creation_transaction],
      )
    ).rows[0];
    let decision: OfficialSourceFact['decision'] = 'unknown';
    let score: string | null = null,
      certificateHash: string | null = null;
    // Unknown Review/visibility is never suppressed by a later known-denial overlay.
    const post = await this.posts.post(postId, tx);
    const visible = await this.access.visible(
      null,
      post,
      tx,
      'list_projection',
    );
    const ownerVisible = await ownerPostVisibilityAllowed(
      postId,
      post.account_id,
      null,
      'list_projection',
      tx,
    );
    const distributionAllowed = await homeDistributionAllowed(
      postId,
      null,
      'official',
      tx,
    );
    if (eligibility?.current) {
      decision =
        !visible ||
        !ownerVisible ||
        !distributionAllowed ||
        eligibility.decision === 'deny'
          ? 'deny'
          : eligibility.decision;
    }
    if (decision === 'allow' && scoreRequired) {
      await this.scores.lockStates(postId, tx, 'share');
      const snapshot = await this.scores.snapshot(postId, tx);
      const certificate = await this.storage.certificate(postId, tx);
      if (
        !snapshot ||
        !certificate ||
        !currentHotScoreCertificate(certificate, snapshot)
      )
        decision = 'unknown';
      else {
        score = certificate.score;
        certificateHash = certificate.certificate_hash;
      }
    }
    const fact = {
      postId,
      spaceId: row.space_id,
      publishedAt: row.published_at.toISOString(),
      revision: row.local_creation_transaction,
      eligibilityRevision: eligibility?.revision ?? '',
      decision,
      score,
      certificateHash,
    };
    const deadlines = [...checkpointTransactionDeadlines(tx).values()];
    return {
      ...fact,
      digest: officialDigest(fact),
      validUntil: deadlines.length
        ? new Date(Math.min(...deadlines)).toISOString()
        : null,
    };
  }
  async project(postId: string, tx: PoolClient) {
    if (!(await homeDistributionAllowed(postId, null, 'official', tx)))
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    return this.projection.read(postId, tx);
  }
}
export function requireOfficialSource(
  fact: OfficialSourceFact | null,
): OfficialSourceFact {
  if (!fact || fact.decision === 'unknown')
    throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
  return fact;
}

/** Reuses Community's public read projection, then discards every identity field.
 * The external manifest never receives the original PostView or source heat vector. */
export class CommunityOfficialPublicProjection implements OfficialPublicProjectionPort {
  constructor(
    private readonly repository: CommunityRepository,
    private readonly access: CommunityAccessService,
    private readonly serializer: import('../community/community-serialization.js').CommunitySerializer,
  ) {}
  async read(
    postId: string,
    tx: PoolClient,
  ): Promise<OfficialPublicProjection> {
    if (!(await homeDistributionAllowed(postId, null, 'official', tx)))
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    await this.access.projectionPost(postId, null, tx);
    const view = await this.serializer.publicExport(postId, tx);
    const count = (n: number) => {
      if (!Number.isSafeInteger(n) || n < 0)
        throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      return String(n);
    };
    const images = await this.repository.images('post', postId, tx);
    const bindings = (
      await tx.query<{ id: string; asset_id: string; ordinal: number }>(
        `SELECT id,asset_id,ordinal FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_kind='post' AND resource_id=$1 AND content_version=1 AND detached_at IS NULL ORDER BY ordinal LIMIT 33`,
        [postId],
      )
    ).rows;
    if (
      bindings.length !== images.length ||
      bindings.length > 32 ||
      bindings.some((b, i) => b.asset_id !== images[i]?.assetId)
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
    return {
      text: view.text,
      publicCounts: {
        likes: count(view.likeCount),
        comments: count(view.discussionCount),
        subscriptions: count(view.saveCount),
      },
      locator: `pages/community-detail/community-detail?postId=${postId}`,
      mediaAppearanceRefs: bindings.map((b) => b.id),
    };
  }
}
