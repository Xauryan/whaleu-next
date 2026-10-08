import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { validateBlockCoverage } from './block-coverage.js';
import type { BlockCoverageHead } from './block-coverage.js';

export const CONTENT_VISIBILITY_BATCH_LIMIT = 768;

export interface ContentVisibilityFact {
  decision: 'allow' | 'deny' | 'unknown';
  optionalUntil: number | null;
}

export interface ContentVisibilityBatch {
  facts: Map<string, ContentVisibilityFact>;
  /** Only non-self named authors whose relationship facts were consulted. */
  namedAccountIds: string[];
}

/** Internal direct_post count snapshots, after canonical base visibility.
 * Anonymous subjects must never supply their underlying account IDs here.
 * The caller's collector must capture the owner epoch vector before these reads
 * and complete the final all-owner epoch/fence proof plus horizon check before
 * returning a known count. The common-policy gate alone does not freeze raw
 * safety head/relationship writes; they are covered by the safety owner epochs.
 * No locks or required transaction deadlines are added by this optional read. */
@Injectable()
export class SafetyContentVisibilityFacade {
  async checkBatch(
    viewer: string | null,
    namedAuthorIds: readonly string[],
    tx: PoolClient,
  ): Promise<ContentVisibilityBatch> {
    const authors = [...new Set(namedAuthorIds)].sort();
    if (authors.length > CONTENT_VISIBILITY_BATCH_LIMIT)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const facts = new Map<string, ContentVisibilityFact>();
    const namedAccountIds: string[] = [];
    for (const author of authors) {
      if (!viewer || author === viewer)
        facts.set(author, { decision: 'allow', optionalUntil: null });
      else namedAccountIds.push(author);
    }
    if (!viewer || !namedAccountIds.length) return { facts, namedAccountIds };

    const heads = await tx.query<BlockCoverageHead & { account_id: string }>(
      'SELECT account_id,block_coverage,provenance,valid_until FROM whaleu_safety.account_heads WHERE account_id=ANY($1::uuid[])',
      [[viewer, ...namedAccountIds].sort()],
    );
    // Both directions are direct_post denials. Return only already-named authors,
    // not relationship identities, direction, display snapshots or incoming actors.
    const blocked = await tx.query<{ author_id: string }>(
      `SELECT blocked_id AS author_id FROM whaleu_safety.blocks
       WHERE blocker_id=$1 AND blocked_id=ANY($2::uuid[]) AND active
       UNION
       SELECT blocker_id AS author_id FROM whaleu_safety.blocks
       WHERE blocked_id=$1 AND blocker_id=ANY($2::uuid[]) AND active`,
      [viewer, namedAccountIds],
    );
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    const coverage = new Map(
      heads.rows.map((head) => [
        head.account_id,
        validateBlockCoverage(head, now),
      ]),
    );
    const viewerCoverage = coverage.get(viewer);
    const blockedAuthors = new Set(blocked.rows.map((row) => row.author_id));
    for (const author of namedAccountIds) {
      const authorCoverage = coverage.get(author);
      if (!viewerCoverage || !authorCoverage) {
        facts.set(author, { decision: 'unknown', optionalUntil: null });
        continue;
      }
      const until = Math.min(
        viewerCoverage.validUntil ?? Number.POSITIVE_INFINITY,
        authorCoverage.validUntil ?? Number.POSITIVE_INFINITY,
      );
      facts.set(author, {
        decision: blockedAuthors.has(author) ? 'deny' : 'allow',
        // Denial also depends on valid coverage; its expiry invalidates a count
        // that excluded this author just as allowance expiry invalidates one.
        optionalUntil: Number.isFinite(until) ? until : null,
      });
    }
    return { facts, namedAccountIds };
  }
}
