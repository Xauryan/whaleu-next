import { sourceOriginalIntentHash } from '../text-source/protocol.js';
import { reconstructTextSource } from '../text-source/repository.js';
import type { StoredTextSource } from '../text-source/repository.js';
import type { ReviewedRatingTargetLink } from '../rating-target-link/contracts.js';
import type { Decision } from '../community-policy.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalEqual,
  operationForKind,
} from './contracts.js';
import type {
  ContentKind,
  ContentScopeSnapshot,
  EffectiveContentEnvelope,
} from './contracts.js';

export interface CurrentContent {
  envelope: EffectiveContentEnvelope;
  textSource?: StoredTextSource;
  authorAccountId: string;
  authorMode: 'named' | 'anonymous';
  parents: { kind: ContentKind; id: string }[];
}
export type DefinitionPost = StoredPost & { publication_state: string };
export interface DefinitionSpace {
  id: string;
  is_active: boolean;
  kind: string;
  operating_region_id: string | null;
}
export interface DefinitionImage {
  assetId: string;
  digest: string;
  position: number;
}
export interface DefinitionPoll {
  id: string;
  question: string;
  selection_mode: 'single' | 'multiple';
  deadline: Date | null;
}
export interface DefinitionOption {
  label: string;
  position: number;
}
export interface DefinitionFormation {
  id: string;
  capacity: number;
  theme: string;
  reconciliation: string;
}
export interface DefinitionCreator {
  account_id: string;
  wechat: string;
  qq: string;
  phone: string;
  contact_sharing: string;
}
export interface DefinitionListing {
  subtype: string;
  price: string;
  urgency: string;
  location: string;
  wechat: string;
  qq: string;
  phone: string;
  legacy_raw_price: string | null;
  legacy_raw_subtype: string | null;
  resolution?: string;
}
export interface DefinitionPayload {
  textSource?: StoredTextSource;
  ratingTargetLink?: ReviewedRatingTargetLink | undefined;
  images: DefinitionImage[];
  poll?: DefinitionPoll | undefined;
  options: DefinitionOption[];
  formation?: DefinitionFormation | undefined;
  creators: DefinitionCreator[];
  listing?: DefinitionListing | undefined;
}
export function definitionNodeDecision(
  content: StoredPost | StoredComment | undefined,
  publication = false,
): Decision {
  if (!content || content.deleted_at || content.visibility === 'hidden')
    return { kind: 'deny', reason: 'POST_NOT_FOUND' };
  if (
    content.visibility !== 'approved' ||
    (publication &&
      (content as DefinitionPost).publication_state !== 'published')
  )
    return { kind: 'unavailable' };
  return { kind: 'allow', value: undefined };
}
export function definitionScopeDecision(
  space: DefinitionSpace | undefined,
  scope: ContentScopeSnapshot,
  activeRegion: boolean,
): Decision {
  if (!space) return { kind: 'unavailable' };
  if (!space.is_active) return { kind: 'deny', reason: 'POST_NOT_FOUND' };
  if (space.operating_region_id && !activeRegion)
    return { kind: 'unavailable' };
  if (
    space.id !== scope.originalSpaceId ||
    space.operating_region_id !== scope.originalRegionId ||
    !['regional', 'global'].includes(space.kind) ||
    (scope.sync !== 'none' &&
      (space.kind !== 'regional' || !scope.originalRegionId))
  )
    return { kind: 'unavailable' };
  return { kind: 'allow', value: undefined };
}
/** Exact canonical payload reconstruction shared by locked and snapshot readers. */
export function reconstructDefinition(
  kind: ContentKind,
  post: DefinitionPost,
  content: StoredPost | StoredComment | StoredReply,
  rootId: string | null,
  scope: ContentScopeSnapshot,
  parents: CurrentContent['parents'],
  facts: DefinitionPayload,
): Decision<CurrentContent> {
  const {
    images,
    poll,
    options,
    formation,
    creators,
    listing,
    ratingTargetLink,
  } = facts;
  if (images.some((image, position) => image.position !== position))
    return { kind: 'unavailable' };
  let component: EffectiveContentEnvelope['component'] = { kind: 'none' };
  let trading: EffectiveContentEnvelope['trading'] = null;
  if (kind === 'post') {
    if ([poll, formation, listing, ratingTargetLink].filter(Boolean).length > 1)
      return { kind: 'unavailable' };
    if (ratingTargetLink) component = ratingTargetLink;
    if (poll) {
      if (
        poll.deadline !== null ||
        options.some((option, position) => option.position !== position)
      )
        return { kind: 'unavailable' };
      component = {
        kind: 'poll',
        question: poll.question,
        selectionMode: poll.selection_mode,
        options: options.map((option) => option.label),
      };
    }
    if (formation) {
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
  const version =
    kind === 'post'
      ? (post.publication_envelope_version ?? 1)
      : facts.textSource
        ? 6
        : scope.sync === 'inherited_related'
          ? 4
          : 1;
  if (
    kind === 'post' &&
    ((version === 5) !== !!ratingTargetLink ||
      (version === 5 &&
        (images.length !== 0 ||
          scope.sync !== 'none' ||
          post.allow_anonymous_dm != null)))
  )
    return { kind: 'unavailable' };
  if (
    (post.publication_envelope_version === 4) !== (version === 4) ||
    (version === 4 &&
      (kind === 'post'
        ? scope.sync !== 'related'
        : scope.sync !== 'inherited_related'))
  )
    return { kind: 'unavailable' };
  if (
    kind === 'post' &&
    ((version === 3 &&
      (post.category !== 'feedback' ||
        !post.feedback ||
        post.allow_anonymous_dm != null)) ||
      (version !== 3 && post.feedback != null) ||
      (version === 1 && post.allow_anonymous_dm != null) ||
      (version === 2 &&
        (post.author_mode !== 'named' ||
          typeof post.allow_anonymous_dm !== 'boolean')))
  )
    return { kind: 'unavailable' };
  const textSource = facts.textSource
    ? reconstructTextSource(
        facts.textSource,
        kind,
        content.id,
        content.account_id,
        content.text,
      )
    : null;
  if ((version === 6) !== !!textSource || (facts.textSource && !textSource))
    return { kind: 'unavailable' };
  if (
    version === 6 &&
    post.publication_envelope_version !== 1 &&
    post.publication_envelope_version !== 2 &&
    post.publication_envelope_version !== 6
  )
    return { kind: 'unavailable' };
  try {
    const envelope = canonicalEnvelope({
      version,
      ...(version === 6
        ? {
            textSource,
            allowAnonymousDm:
              kind === 'post' ? (post.allow_anonymous_dm ?? null) : null,
          }
        : {}),
      ...(version === 2 ? { allowAnonymousDm: post.allow_anonymous_dm } : {}),
      ...(version === 4
        ? {
            allowAnonymousDm:
              kind === 'post' ? (post.allow_anonymous_dm ?? null) : null,
          }
        : {}),
      ...(version === 3 ? { feedback: post.feedback } : {}),
      accountId: content.account_id,
      purpose: operationForKind(kind),
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
    if (
      envelope.version === 6 &&
      (!facts.textSource ||
        facts.textSource.original_intent_hash !==
          sourceOriginalIntentHash(
            envelope,
            facts.textSource.requested_author_mode,
          ) ||
        content.author_mode !==
          (kind !== 'post' &&
          post.author_mode === 'anonymous' &&
          post.account_id === content.account_id
            ? 'anonymous'
            : facts.textSource.requested_author_mode))
    )
      return { kind: 'unavailable' };
    return {
      kind: 'allow',
      value: {
        envelope,
        ...(facts.textSource ? { textSource: facts.textSource } : {}),
        authorAccountId: content.account_id,
        authorMode: content.author_mode,
        parents,
      },
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function definitionMatchesApproval(
  stored: CurrentContent,
  accepted: {
    decisionId?: string;
    digest: string;
    envelope: EffectiveContentEnvelope;
  },
  currentMediaProved = false,
): boolean {
  return (
    canonicalEqual(stored.envelope, accepted.envelope) &&
    (stored.envelope.version !== 6 ||
      (!!stored.textSource &&
        stored.textSource.decision_id === accepted.decisionId &&
        stored.textSource.approval_digest === accepted.digest &&
        stored.textSource.account_id === accepted.envelope.accountId)) &&
    // Equal canonical JSON has the same versioned digest. Reuse the accepted
    // parser-owned envelope's digest rather than encoding its equal reconstructed
    // copy again; this retains both independent equality and digest checks.
    approvalDigest(accepted.envelope) === accepted.digest &&
    (!stored.envelope.images.length || currentMediaProved)
  );
}
