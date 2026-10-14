import type { ReviewedRatingTargetLink } from '../rating-target-link/contracts.js';
import { CurrentRatingLinkDependency } from '../rating-target-link/dependency.js';
import { resolvePostCategory } from '../category-reclassification/read-proof.js';
import { batchCategoryChildContextAllowed } from '../category-reclassification/child-context.js';
import type { CategoryChildTarget } from '../category-reclassification/child-context.js';
import { readOwnerPostVisibility } from '../owner-visibility/read-proof.js';
import {
  CONTENT_MEDIA_PROOF,
  UnavailableContentMediaProof,
} from './media-proof.js';
import type { ContentMediaProof } from './media-proof.js';
import type { SearchReadContext } from './search-read-context.js';
import type { ApprovalBinding } from './approval.repository.js';
const canonicalOwner = {};
type CanonicalProof = Pick<
  ApprovalBinding,
  'account_id' | 'content_version'
> & {
  authorMode: 'named' | 'anonymous';
  postOwner: string;
  ownerHidden: boolean;
  postId: string;
  categoryChildren: readonly CategoryChildTarget[];
  ratingLink: ReviewedRatingTargetLink | null;
};
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CommunityVisibilityPort,
  Decision,
  VisibilityPurpose,
  VisibilitySubject,
} from '../community-policy.js';
import { ApprovalRepository } from './approval.repository.js';
import { ContentDefinitionRepository } from './content-definition.repository.js';
import { definitionMatchesApproval } from './definition-validation.js';
import type { ContentKind } from './contracts.js';
@Injectable()
export class LocalApprovedContentVisibility implements CommunityVisibilityPort {
  constructor(
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(ContentDefinitionRepository)
    private readonly definitions: ContentDefinitionRepository,
    @Inject(CONTENT_MEDIA_PROOF)
    private readonly media: ContentMediaProof = new UnavailableContentMediaProof(),
    @Optional()
    @Inject(CurrentRatingLinkDependency)
    private readonly targetLinks: CurrentRatingLinkDependency = new CurrentRatingLinkDependency(),
  ) {}
  private async visible(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
    visited: Map<string, CanonicalProof | null>,
    viewer: string | null,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
    currentMediaAllowed = true,
  ): Promise<Decision<CanonicalProof>> {
    const result = read
      ? await read.read(
          canonicalOwner,
          `${kind}:${id}:1:${currentMediaAllowed ? 'media-current' : 'text-only'}`,
          tx,
          () =>
            this.prove(
              kind,
              id,
              tx,
              visited,
              viewer,
              purpose,
              read,
              currentMediaAllowed,
            ),
          (result) => result.kind === 'allow',
        )
      : await this.prove(
          kind,
          id,
          tx,
          visited,
          viewer,
          purpose,
          undefined,
          currentMediaAllowed,
        );
    // Canonical definitions can be shared, but an author-private allow is never
    // a public or another-viewer's visibility certificate, even in one epoch.
    if (
      result.kind === 'allow' &&
      result.value.ownerHidden &&
      !(
        (purpose === 'direct_post' || purpose === 'detail_projection') &&
        viewer === result.value.postOwner
      )
    )
      return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    if (result.kind === 'allow') visited.set(`${kind}:${id}`, result.value);
    return result;
  }
  private async prove(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
    visited: Map<string, CanonicalProof | null>,
    viewer: string | null,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
    currentMediaAllowed = true,
  ): Promise<Decision<CanonicalProof>> {
    const key = `${kind}:${id}`;
    if (visited.has(key)) return { kind: 'unavailable' };
    visited.set(key, null);
    const binding = await this.approvals.binding(kind, id, tx);
    if (!binding) return { kind: 'unavailable' };
    const accepted = await this.approvals.current(binding, tx, read);
    if (accepted.kind !== 'allow') return accepted;
    const stored = await this.definitions.current(
      kind,
      id,
      accepted.value.envelope.scope,
      tx,
      read,
    );
    if (stored.kind !== 'allow') return stored;
    let postOwner = binding.account_id;
    let ownerHidden = false;
    const postId =
      kind === 'post'
        ? id
        : stored.value.parents.find((parent) => parent.kind === 'post')?.id;
    if (!postId) return { kind: 'unavailable' };
    const categoryChildren = new Map<string, CategoryChildTarget>();
    if (kind !== 'post')
      categoryChildren.set(`${kind}:${id}`, { kind, id, postId });
    if (kind === 'post') {
      ownerHidden = (await readOwnerPostVisibility(id, tx)).ownerHidden;
      if (
        ownerHidden &&
        !(
          (purpose === 'direct_post' || purpose === 'detail_projection') &&
          viewer === postOwner
        )
      )
        return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    }
    const images = stored.value.envelope.images;
    if (images.length && !currentMediaAllowed) return { kind: 'unavailable' };
    if (images.length) {
      const decision = await this.media.current(kind, id, images, tx);
      if (decision.kind !== 'allow') return decision;
    }
    if (
      !definitionMatchesApproval(
        stored.value,
        accepted.value,
        images.length > 0,
      )
    )
      return { kind: 'unavailable' };
    // Retain only immutable source data in the shared canonical proof. Current
    // target qualification belongs to the viewer and is checked on every outer
    // call, including when a descendant reuses this canonical parent chain.
    let ratingLink =
      stored.value.envelope.version === 5
        ? stored.value.envelope.component
        : null;
    for (const parent of stored.value.parents) {
      // A post reached again via its root retains its exact owner overlay too.
      const prior = visited.get(`${parent.kind}:${parent.id}`);
      if (prior) {
        postOwner = prior.postOwner;
        ownerHidden = prior.ownerHidden;
        ratingLink = prior.ratingLink;
        for (const child of prior.categoryChildren)
          categoryChildren.set(`${child.kind}:${child.id}`, child);
        continue;
      }
      const decision = await this.visible(
        parent.kind,
        parent.id,
        tx,
        visited,
        viewer,
        purpose,
        read,
        currentMediaAllowed,
      );
      if (decision.kind !== 'allow') return decision;
      postOwner = decision.value.postOwner;
      ownerHidden = decision.value.ownerHidden;
      ratingLink = decision.value.ratingLink;
      for (const child of decision.value.categoryChildren)
        categoryChildren.set(`${child.kind}:${child.id}`, child);
    }
    return {
      kind: 'allow',
      value: Object.freeze({
        account_id: binding.account_id,
        content_version: binding.content_version,
        authorMode: binding.envelope.authorMode,
        postOwner,
        ownerHidden,
        postId,
        ratingLink,
        categoryChildren: Object.freeze(
          [...categoryChildren.values()].map((child) => Object.freeze(child)),
        ),
      }),
    };
  }
  async check(
    viewer: string | null,
    subject: VisibilitySubject,
    tx: PoolClient,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
    currentMediaAllowed = true,
  ): Promise<Decision> {
    const typed = subject as VisibilitySubject & {
      contentKind?: ContentKind;
      contentVersion?: number;
    };
    if (
      !typed.contentKind ||
      !['post', 'comment', 'reply'].includes(typed.contentKind) ||
      typed.contentVersion !== 1
    )
      return { kind: 'unavailable' };
    try {
      const result = await this.visible(
        typed.contentKind,
        subject.contentId,
        tx,
        new Map(),
        viewer,
        purpose,
        read,
        currentMediaAllowed,
      );
      if (result.kind !== 'allow') return result;
      if (result.value.ratingLink) {
        const target = await this.targetLinks.current(
          viewer,
          result.value.ratingLink,
          tx,
        );
        if (target.kind !== 'allow') return target;
      }
      const binding = read
        ? result.value
        : await this.approvals.binding(
            typed.contentKind,
            subject.contentId,
            tx,
          );
      if (
        !binding ||
        binding.content_version !== typed.contentVersion ||
        ('authorMode' in binding
          ? binding.authorMode
          : binding.envelope.authorMode) !== subject.authorMode ||
        (subject.authorMode === 'named' &&
          binding.account_id !== subject.namedAccountId)
      )
        return { kind: 'unavailable' };
      // Finish the entire original canonical ancestry before interpreting a
      // missing overlay as denial. Otherwise a revoked category policy could
      // hide unknown original Review or an invalid canonical definition.
      if ((await resolvePostCategory(result.value.postId, tx)) === null)
        return { kind: 'deny', reason: 'POST_NOT_FOUND' };
      const contexts = await batchCategoryChildContextAllowed(
        result.value.categoryChildren,
        tx,
      );
      if (
        result.value.categoryChildren.some(
          (child) => contexts.get(`${child.kind}:${child.id}`) !== true,
        )
      )
        return { kind: 'deny', reason: 'POST_NOT_FOUND' };
      return { kind: 'allow', value: undefined };
    } catch {
      return { kind: 'unavailable' };
    }
  }
}
