import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ContentPublicationGate, Decision } from '../community-policy.js';
import { ApprovalRepository } from './approval.repository.js';
import { ContentDefinitionRepository } from './content-definition.repository.js';
import { canonicalEnvelope, canonicalJson } from './contracts.js';
import type { AcceptedApproval, ContentKind } from './contracts.js';
@Injectable()
export class LocalContentPublicationGate implements ContentPublicationGate {
  constructor(
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
    @Inject(ContentDefinitionRepository)
    private readonly definitions: ContentDefinitionRepository,
  ) {}
  async check(
    input: Parameters<ContentPublicationGate['check']>[0],
    tx: PoolClient,
  ): Promise<Decision<AcceptedApproval>> {
    if (!input.envelope) return { kind: 'unavailable' };
    try {
      const envelope = canonicalEnvelope(input.envelope);
      if (
        envelope.accountId !== input.accountId ||
        envelope.purpose !== input.purpose ||
        envelope.text !== input.text ||
        canonicalJson(envelope.images) !== canonicalJson(input.images)
      )
        return { kind: 'unavailable' };
      return await this.approvals.accepted(envelope, tx);
    } catch {
      return { kind: 'unavailable' };
    }
  }
  async bind(
    accepted: AcceptedApproval,
    kind: ContentKind,
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    const stored = await this.definitions.current(
      kind,
      id,
      accepted.envelope.scope,
      tx,
    );
    if (
      stored.kind !== 'allow' ||
      canonicalJson(stored.value.envelope) !== canonicalJson(accepted.envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    try {
      await this.approvals.bind(accepted, kind, id, tx);
    } catch (error) {
      if ((error as { code?: string })?.code === '23505')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      throw error;
    }
  }
}
