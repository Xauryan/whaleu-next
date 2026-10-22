/** Internal immutable evidence shapes, not verified capabilities. Runtime
 * consumers validate exact persisted canonical envelopes and final lifetimes. */
import type { EffectiveContentEnvelope } from '../content-review/contracts.js';
import type {
  ReclassificationCategory,
  ReclassificationCommand,
} from './contracts.js';

export interface OriginalCategoryApprovalEvidence {
  readonly decisionId: string;
  readonly digest: string;
  /** Unmodified original category, scope, component and Media descriptors. */
  readonly envelope: EffectiveContentEnvelope;
}
export interface CategoryCommandReviewEnvelope {
  readonly version: 1;
  readonly purpose: 'community_post_category_reclassification';
  readonly postId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly command: ReclassificationCommand;
  readonly intentHash: string;
  readonly grantId: string;
  readonly original: OriginalCategoryApprovalEvidence;
  readonly previous: {
    readonly revision: number;
    readonly eventId: string | null;
    /** System water may be an original source, never a command target. */
    readonly category: ReclassificationCategory | 'water';
  };
  readonly targetCategory: ReclassificationCategory;
  readonly policy: {
    readonly id: string;
    readonly sourceKey: string;
    readonly revision: number;
    readonly digest: string;
  };
}
export interface CategoryChildReviewEnvelope {
  readonly version: 1;
  readonly purpose: 'community_child_current_parent_classification';
  readonly actorId: string;
  readonly requestId: string;
  readonly childKind: 'comment' | 'reply';
  readonly original: OriginalCategoryApprovalEvidence;
  readonly parent: {
    readonly postId: string;
    readonly eventId: string;
    readonly revision: number;
    readonly category: ReclassificationCategory;
    readonly policyId: string;
    readonly reviewId: string;
  };
}

/** Database-derived and checked at commit, then retained as historical authority.
 * Subsequent administrator session/grant revocation does not revoke the content. */
export interface CategorySelectedAuthorityEvidence {
  readonly id: string;
  readonly accountId: string;
  readonly role: 'school_admin' | 'super_admin';
  readonly operatingRegionId: string | null;
  readonly validFrom: string;
  readonly expiresAt: string | null;
}
