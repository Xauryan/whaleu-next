import type {
  AssertionRecord,
  FactKind,
  VerificationStatus,
} from './contracts.js';

export function safeStudentNumber(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 100 &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}@]/u.test(value)
  );
}

/** Never elevate absence, a generic student flag, a role or a chosen school. */
export function assertionStatus(
  record: AssertionRecord | undefined,
  accountId: string,
  kind: FactKind,
  now: Date,
): VerificationStatus {
  if (
    !record ||
    record.account_id !== accountId ||
    record.fact_kind !== kind ||
    record.coverage_state !== 'complete' ||
    record.provenance_state !== 'accepted' ||
    record.source_account_id !== accountId ||
    !record.source_reference?.trim() ||
    !record.policy_reference?.trim() ||
    record.method === 'unknown'
  )
    return 'unavailable';
  if (record.issuer_institution_id !== record.source_issuer_institution_id)
    return 'unavailable';
  const methodAllowed =
    kind === 'phone'
      ? ['phone_provider', 'reconciled_import'].includes(record.method)
      : kind === 'student_number'
        ? ['institutional_sso', 'reconciled_import'].includes(record.method)
        : [
            'document_review',
            'institutional_email',
            'institutional_sso',
            'reconciled_import',
          ].includes(record.method);
  if (!methodAllowed) return 'unavailable';
  // An explicit covered absence/revocation/expiry asserts no currently verified fact.
  if (record.assertion_state !== 'verified') return record.assertion_state;
  if (
    !record.verified_at ||
    !Number.isFinite(record.verified_at.getTime()) ||
    record.verified_at > now ||
    record.expiry_kind === 'unknown'
  )
    return 'unavailable';
  if (record.expiry_kind === 'at') {
    if (
      !record.expires_at ||
      !Number.isFinite(record.expires_at.getTime()) ||
      record.expires_at <= record.verified_at
    )
      return 'unavailable';
    if (record.expires_at <= now) return 'expired';
  } else if (record.expires_at !== null) return 'unavailable';
  if (kind !== 'phone' && !record.issuer_institution_id) return 'unavailable';
  if (kind === 'student_number' && !safeStudentNumber(record.student_number))
    return 'unavailable';
  if (kind === 'phone' && !record.phone_binding_reference) return 'unavailable';
  return 'verified';
}
