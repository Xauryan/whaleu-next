/** The own-account surface intentionally contains only independent states. */
export type VerificationStatus =
  'verified' | 'unverified' | 'unavailable' | 'expired' | 'revoked';
export type FactKind = 'affiliation' | 'student_number' | 'phone';
export type ApplicationStatus = 'none' | 'pending' | 'rejected' | 'unavailable';
export interface OwnVerificationSummary {
  readonly affiliation: { readonly status: VerificationStatus };
  readonly studentNumber: { readonly status: VerificationStatus };
  readonly phone: { readonly status: VerificationStatus };
  readonly application: { readonly status: ApplicationStatus };
}

/** Internal only. Neither this record nor provenance is an HTTP response. */
export interface AssertionRecord {
  readonly id: string;
  readonly account_id: string;
  readonly fact_kind: FactKind;
  readonly assertion_state: Exclude<VerificationStatus, 'unavailable'>;
  readonly coverage_state: 'complete' | 'missing' | 'conflict';
  readonly provenance_state: 'accepted' | 'unknown' | 'conflict';
  readonly method:
    | 'document_review'
    | 'institutional_email'
    | 'institutional_sso'
    | 'phone_provider'
    | 'reconciled_import'
    | 'unknown';
  readonly source_reference: string | null;
  readonly policy_reference: string | null;
  readonly source_account_id: string | null;
  readonly issuer_institution_id: string | null;
  readonly source_issuer_institution_id: string | null;
  readonly origin_region_id: string | null;
  readonly student_number: string | null;
  readonly phone_binding_reference: string | null;
  readonly verified_at: Date | null;
  readonly expiry_kind: 'unknown' | 'at' | 'policy_exempt';
  readonly expires_at: Date | null;
}
export interface SnapshotRecord {
  readonly id: string;
  readonly account_id: string;
  readonly revision: number;
  readonly affiliation_assertion_id: string | null;
  readonly student_number_assertion_id: string | null;
  readonly phone_assertion_id: string | null;
  readonly application_state: ApplicationStatus;
  readonly application_coverage: 'complete' | 'missing' | 'conflict';
}
export interface VerificationRead {
  readonly summary: OwnVerificationSummary;
  readonly studentNumber: string | null;
  readonly studentNumberValidUntil: number | null;
}

/** Transaction-bound phone eligibility only; no binding or identity values escape. */
export type SafetyPhoneEligibility =
  | { readonly status: 'verified'; readonly validUntil: number | null }
  | { readonly status: 'unverified' | 'unavailable' };

/** Report shape only. No importer until a complete schema export and reviewed mapping exist. */
export interface ReconciliationReport {
  readonly mode: 'dry-run';
  readonly schemaDigest: string;
  readonly batchId: string;
  readonly records: number;
  readonly issues: readonly {
    readonly recordId: string;
    readonly code:
      | 'missing_account'
      | 'missing_issuer'
      | 'account_conflict'
      | 'issuer_conflict'
      | 'number_conflict'
      | 'unknown_provenance'
      | 'unknown_expiry'
      | 'unsafe_number'
      | 'missing_coverage';
  }[];
  readonly applied: false;
}
