import { ApplicationError } from '../../../src/http/application-error.js';
import { requirePublication } from '../../../src/community/community-policy.js';
import type { Authority } from '../../../src/community/community-policy.js';
import type {
  AuthorMode,
  Category,
  CommunitySpace,
  PublicationOperation,
} from '../../../src/community/contracts.js';
import type { TextSourceDescriptor } from '../../../src/community/text-source/contracts.js';
import { reviewedTextSource, sourceTextAvailable } from '../../../src/community/text-source/protocol.js';
import type {
  EffectiveContentEnvelopeDraft,
  EffectiveContentEnvelopeV6,
} from '../../../src/community/content-review/contracts.js';

/** Explicit source is a new ordinary Review lane, never a legacy downgrade. */
export function withReviewedTextSource(
  envelope: EffectiveContentEnvelopeDraft,
  source: TextSourceDescriptor | undefined,
): EffectiveContentEnvelopeDraft {
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
): Promise<void> {
  const row = (
    await tx.query(
      `SELECT p.id FROM whaleu_community.posts p WHERE p.id=$1 AND p.publication_envelope_version IN (1,2,6) AND p.category NOT IN ('feedback','trading') AND p.comments_policy='open' AND p.allow_anonymous_dm IS DISTINCT FROM true AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_owner_visibility WHERE post_id=p.id AND owner_hidden) AND NOT EXISTS(SELECT 1 FROM whaleu_community.polls WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.formations WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_rating_target_links WHERE post_id=p.id) AND NOT EXISTS(SELECT 1 FROM whaleu_community.post_distribution_bindings WHERE post_id=p.id) FOR SHARE OF p`,
      [postId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
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
