/** Private owner-to-owner metadata. None of these references are public DTOs. */
export interface PublicationAffiliationMetadata {
  assertionId: string;
  snapshotId: string;
  institutionId: string;
  originRegionId: string;
  validUntil: number | null;
}

export type ScopeRelation = 'home' | 'related' | 'foreign' | 'global';
export type IdentityCampusResolution =
  | {
      status: 'valid';
      campusId: string;
      institutionId: string;
      identityRegionId: string;
      originRegionId: string;
      selectionId: string;
      topologySnapshotId: string;
      relation: ScopeRelation;
      validUntil: number | null;
    }
  | { status: 'selection_required' }
  | { status: 'unavailable' };

export type RegionGroupResolution =
  | {
      status: 'known';
      sameGroup: boolean;
      topologySnapshotId: string;
      validUntil: number | null;
    }
  | { status: 'unavailable' };

export type RegionalCommunityPolicy =
  | {
      status: 'known';
      revisionId: string;
      unverifiedPostEnabled: boolean;
      unverifiedCommentEnabled: boolean;
      unverifiedCategories: readonly string[];
      relatedSyncEnabled: boolean;
      validUntil: number | null;
    }
  | { status: 'unavailable' };

export interface PolicyProvenance {
  coverage_state: 'complete' | 'missing' | 'conflicting';
  provenance_state: 'accepted' | 'unknown' | 'conflicting';
  source_reference: string | null;
  policy_reference: string | null;
  effective_at: Date;
  expiry_kind: 'at' | 'policy_exempt' | 'unknown';
  valid_until: Date | null;
}
