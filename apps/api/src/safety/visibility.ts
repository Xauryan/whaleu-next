import { enforceAccountPunishment } from './account-moderation/policy.js';
import type { SearchReadContext } from '../community/content-review/search-read-context.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CommunityVisibilityPort,
  Decision,
  VisibilityPurpose,
  VisibilitySubject,
} from '../community/community-policy.js';
import { COMMUNITY_BASE_VISIBILITY } from '../community/community-policy.js';
import { SafetyRepository } from './repository.js';
@Injectable()
export class NamedBlockVisibility implements CommunityVisibilityPort {
  constructor(
    @Inject(COMMUNITY_BASE_VISIBILITY)
    private readonly base: CommunityVisibilityPort,
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async check(
    viewer: string | null,
    subject: VisibilitySubject,
    tx: PoolClient,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
  ): Promise<Decision> {
    // Actor access is independent of anonymous/self relationship bypass.
    if (viewer) await enforceAccountPunishment(viewer, 'browse', tx);
    const base = await this.base.check(viewer, subject, tx, purpose, read);
    if (base.kind !== 'allow') return base;
    if (
      subject.authorMode === 'anonymous' ||
      !viewer ||
      viewer === subject.namedAccountId
    )
      return base;
    return this.checkNamedRelationship(
      viewer,
      subject.namedAccountId,
      tx,
      purpose,
      read,
    );
  }
  async checkNamedRelationship(
    viewer: string | null,
    namedAccountId: string,
    tx: PoolClient,
    purpose: VisibilityPurpose,
    read?: SearchReadContext,
  ): Promise<Decision> {
    if (viewer) await enforceAccountPunishment(viewer, 'browse', tx);
    // Private-detail children retain existing list relationship semantics.
    // Owner concealment remains an independent canonical parent gate.
    if (purpose === 'detail_projection') purpose = 'list_projection';
    const base: Decision = { kind: 'allow', value: undefined };
    if (!viewer || viewer === namedAccountId) return base;
    const directions = await this.records.directions(
      viewer,
      namedAccountId,
      purpose,
      tx,
      read,
    );
    if (!directions) return { kind: 'unavailable' };
    if (directions.outgoing)
      return {
        kind: 'deny',
        reason:
          purpose === 'direct_post' ? 'POST_BLOCKED_BY_YOU' : 'POST_NOT_FOUND',
      };
    if (purpose !== 'list_projection' && directions.incoming)
      return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    return base;
  }
}
