import { requireCurrentHomeParent } from '../home-feed-policy/parent-proof.js';
import type { ApprovalRepository } from '../content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../content-review/content-definition.repository.js';
import { ApplicationError } from '../../http/application-error.js';
import { requirePublication } from '../community-policy.js';
import type { Authority } from '../community-policy.js';
import type {
  AuthorMode,
  Category,
  CommunitySpace,
  PublicationOperation,
} from '../contracts.js';
import type { TextSourceDescriptor } from './contracts.js';
import { reviewedTextSource, sourceTextAvailable } from './protocol.js';
import {
  canonicalEnvelope,
  canonicalEqual,
} from '../content-review/contracts.js';
import type {
  EffectiveContentEnvelopeDraft,
  EffectiveContentEnvelopeV6,
} from '../content-review/contracts.js';

/** Explicit source is a new ordinary Review lane, never a legacy downgrade. */
export function withReviewedTextSource(
  envelope: EffectiveContentEnvelopeDraft,
  source: TextSourceDescriptor | undefined,
): EffectiveContentEnvelopeDraft {
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(envelope.version))
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  if (envelope.version === 7 || envelope.version === 8) {
    // Composition is already selected by the Home owner. Never downgrade it to v6
    // or silently erase an explicit descriptor at this boundary.
    if (source === undefined) {
      if (envelope.textSource !== null)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return envelope;
    }
    const kind =
      envelope.purpose === 'publish_post'
        ? 'post'
        : envelope.purpose === 'publish_comment'
          ? 'comment'
          : 'reply';
    try {
      const textSource = reviewedTextSource(envelope.text, source, kind);
      if (
        envelope.textSource !== null &&
        !canonicalEqual(envelope.textSource, textSource)
      )
        throw new Error('Source descriptor mismatch');
      const composed = { ...envelope, textSource };
      // Asset ownership remains with the normal publication owner. This checks
      // the text-only source contract before that owner supplies actual images.
      canonicalEnvelope({ ...composed, images: [] });
      return composed;
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
  }
  if (source === undefined) return envelope;
  if (
    !sourceTextAvailable(envelope.text, source) ||
    (envelope.version !== 1 && envelope.version !== 2) ||
    envelope.scope.sync !== 'none' ||
    envelope.category === 'trading' ||
    envelope.category === 'feedback' ||
    envelope.component.kind !== 'none' ||
    envelope.trading !== null ||
    envelope.commentsPolicy !== 'open' ||
    (envelope.version === 2 && envelope.allowAnonymousDm !== false)
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  const kind =
    envelope.purpose === 'publish_post'
      ? 'post'
      : envelope.purpose === 'publish_comment'
        ? 'comment'
        : 'reply';
  return {
    ...envelope,
    version: 6,
    component: { kind: 'none' },
    trading: null,
    commentsPolicy: 'open',
    allowAnonymousDm: envelope.version === 2 ? false : null,
    textSource: reviewedTextSource(envelope.text, source, kind),
  } satisfies Omit<EffectiveContentEnvelopeV6, 'images'>;
}

/** Current ordinary parent proof is first established by the canonical access
 * owner. This adds only a narrowing restriction; it is never authorization. */
export async function requireOrdinarySourceParent(
  postId: string,
  tx: import('pg').PoolClient,
  owners?: {
    approvals: Pick<ApprovalRepository, 'binding' | 'current'>;
    definitions: Pick<ContentDefinitionRepository, 'current'>;
  },
): Promise<void> {
  const row = (
    await tx.query(
      `SELECT p.id,p.publication_envelope_version FROM whaleu_community.posts p WHERE p.id=$1 AND p.publication_envelope_version IN (1,2,6,7) AND p.category NOT IN ('feedback','trading') AND p.comments_policy='open' AND p.allow_anonymous_dm IS DISTINCT FROM true AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden) AND NOT EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id) FOR SHARE OF p`,
      [postId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  if (row.publication_envelope_version === 7) {
    if (!owners) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await requireCurrentHomeParent(
      postId,
      tx,
      owners.approvals,
      owners.definitions,
    );
  }
}

/** Identity-specific scope advisory; never a proof for a particular child target. */
export function sourcePublicationOperations(
  authority: Authority,
  space: CommunitySpace,
  category: Category,
  authorMode: AuthorMode,
): PublicationOperation[] {
  const operations: PublicationOperation[] = [];
  for (const operation of [
    'publish_post',
    'publish_comment',
    'publish_reply',
  ] as const) {
    // Water is a server placement, never a client-authored post category.
    if (operation === 'publish_post' && category === 'water') continue;
    try {
      // Replies share the existing publish_comment action. A named parent is the
      // least restrictive possible ordinary target; real admission rechecks it.
      requirePublication(
        authority,
        space,
        category,
        authorMode,
        operation === 'publish_post' ? 'publish_post' : 'publish_comment',
        'named',
      );
      operations.push(operation);
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
    }
  }
  return operations;
}
