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
> & { authorMode: 'named' | 'anonymous' };
import { Inject, Injectable } from '@nestjs/common';
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
  ) {}
  private async visible(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
    visited: Set<string>,
    read?: SearchReadContext,
    currentMediaAllowed = true,
  ): Promise<Decision<CanonicalProof>> {
    if (read)
      return read.read(
        canonicalOwner,
        `${kind}:${id}:1:${currentMediaAllowed ? 'media-current' : 'text-only'}`,
        tx,
        () => this.prove(kind, id, tx, visited, read, currentMediaAllowed),
        (result) => result.kind === 'allow',
      );
    return this.prove(kind, id, tx, visited, undefined, currentMediaAllowed);
  }
  private async prove(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
    visited: Set<string>,
    read?: SearchReadContext,
    currentMediaAllowed = true,
  ): Promise<Decision<CanonicalProof>> {
    const key = `${kind}:${id}`;
    if (visited.has(key)) return { kind: 'unavailable' };
    visited.add(key);
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
    for (const parent of stored.value.parents) {
      // A post reached again via its root is already checked in this traversal.
      if (visited.has(`${parent.kind}:${parent.id}`)) continue;
      const decision = await this.visible(
        parent.kind,
        parent.id,
        tx,
        visited,
        read,
        currentMediaAllowed,
      );
      if (decision.kind !== 'allow') return decision;
    }
    return {
      kind: 'allow',
      value: Object.freeze({
        account_id: binding.account_id,
        content_version: binding.content_version,
        authorMode: binding.envelope.authorMode,
      }),
    };
  }
  async check(
    _viewer: string | null,
    subject: VisibilitySubject,
    tx: PoolClient,
    _purpose: VisibilityPurpose,
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
        new Set(),
        read,
        currentMediaAllowed,
      );
      if (result.kind !== 'allow') return result;
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
      return { kind: 'allow', value: undefined };
    } catch {
      return { kind: 'unavailable' };
    }
  }
}
