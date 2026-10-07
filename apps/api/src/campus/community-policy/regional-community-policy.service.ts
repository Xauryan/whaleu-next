import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import type { PolicyProvenance, RegionalCommunityPolicy } from './contracts.js';
import { validProvenance } from './fact-validation.js';

const ordinaryCategories = new Set([
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
]);
interface PolicyRecord extends PolicyProvenance {
  id: string;
  unverified_post_enabled: boolean;
  unverified_comment_enabled: boolean;
  unverified_categories: string[];
  related_sync_enabled: boolean;
}

/** Community-owned configuration companion, deliberately separate from identity.
 * Do not call it for verified ordinary publication or phone-only interactions
 * that do not depend on the regional unverified exception. No runtime writer. */
@Injectable()
export class RegionalCommunityPolicyService {
  async resolve(
    regionId: string,
    tx: PoolClient,
  ): Promise<RegionalCommunityPolicy> {
    const missing = { status: 'unavailable' } as const;
    const region = (
      await tx.query<{ is_active: boolean }>(
        'SELECT is_active FROM whaleu_campus.operating_regions WHERE id=$1 FOR SHARE',
        [regionId],
      )
    ).rows[0];
    if (!region?.is_active) return missing;
    const head = (
      await tx.query<{ revision_id: string | null; revision: number }>(
        'SELECT revision_id,revision FROM whaleu_community.region_policy_heads WHERE region_id=$1 FOR SHARE',
        [regionId],
      )
    ).rows[0];
    if (!head?.revision_id) return missing;
    const policy = (
      await tx.query<PolicyRecord>(
        'SELECT * FROM whaleu_community.region_policy_revisions WHERE id=$1 AND region_id=$2 AND revision=$3',
        [head.revision_id, regionId, head.revision],
      )
    ).rows[0];
    if (!policy) return missing;
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (
      !validProvenance(policy, now) ||
      !Array.isArray(policy.unverified_categories) ||
      new Set(policy.unverified_categories).size !==
        policy.unverified_categories.length ||
      typeof policy.unverified_post_enabled !== 'boolean' ||
      typeof policy.unverified_comment_enabled !== 'boolean' ||
      typeof policy.related_sync_enabled !== 'boolean'
    )
      return missing;
    const validUntil = policy.valid_until?.getTime() ?? null;
    registerTransactionDeadline(tx, validUntil, 'COMMUNITY_UNAVAILABLE');
    return {
      status: 'known',
      revisionId: policy.id,
      unverifiedPostEnabled: policy.unverified_post_enabled,
      unverifiedCommentEnabled: policy.unverified_comment_enabled,
      // Preserve unsupported imported category names in the immutable ledger,
      // while never elevating them (or trading) into new-write permissions.
      unverifiedCategories: policy.unverified_categories.filter((category) =>
        ordinaryCategories.has(category),
      ),
      relatedSyncEnabled: policy.related_sync_enabled,
      validUntil,
    };
  }
}
