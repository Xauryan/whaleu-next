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
  ) {}
  private async visible(
    kind: ContentKind,
    id: string,
    tx: PoolClient,
    visited: Set<string>,
  ): Promise<Decision> {
    const key = `${kind}:${id}`;
    if (visited.has(key)) return { kind: 'unavailable' };
    visited.add(key);
    const binding = await this.approvals.binding(kind, id, tx);
    if (!binding) return { kind: 'unavailable' };
    const accepted = await this.approvals.current(binding, tx);
    if (accepted.kind !== 'allow') return accepted;
    const stored = await this.definitions.current(
      kind,
      id,
      accepted.value.envelope.scope,
      tx,
    );
    if (stored.kind !== 'allow') return stored;
    if (!definitionMatchesApproval(stored.value, accepted.value))
      return { kind: 'unavailable' };
    for (const parent of stored.value.parents) {
      // A post reached again via its root is already checked in this traversal.
      if (visited.has(`${parent.kind}:${parent.id}`)) continue;
      const decision = await this.visible(parent.kind, parent.id, tx, visited);
      if (decision.kind !== 'allow') return decision;
    }
    return { kind: 'allow', value: undefined };
  }
  async check(
    _viewer: string | null,
    subject: VisibilitySubject,
    tx: PoolClient,
    _purpose: VisibilityPurpose,
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
      );
      if (result.kind !== 'allow') return result;
      const binding = await this.approvals.binding(
        typed.contentKind,
        subject.contentId,
        tx,
      );
      if (
        !binding ||
        binding.envelope.authorMode !== subject.authorMode ||
        (subject.authorMode === 'named' &&
          binding.account_id !== subject.namedAccountId)
      )
        return { kind: 'unavailable' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    }
  }
}
