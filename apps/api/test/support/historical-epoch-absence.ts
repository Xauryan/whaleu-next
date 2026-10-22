/** TEST ONLY: absence of the exact new catalog identities introduced by 0180.
 * Interpolate only in historical predicates already protected by their managed
 * migration/ledger and accounts/sessions DDL fences. This grants no authority,
 * does not qualify rewritten predecessor bodies and is not a runtime fallback.
 * 0180 creates no new relation/type: it extends these two existing relations.
 */
export const historicalEpochAbsenceSql = `
  NOT EXISTS (SELECT 1 FROM pg_attribute a
    JOIN (VALUES ('whaleu_identity.accounts'::text,'session_revocation_epoch'::text),
                 ('whaleu_identity.sessions','issued_revocation_epoch')) expected(rel,name)
      ON a.attrelid=to_regclass(expected.rel) AND a.attname=expected.name
    WHERE NOT a.attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c
    JOIN (VALUES ('whaleu_identity.accounts'::text,'session_epoch_account_nonnegative'::text),
                 ('whaleu_identity.sessions','session_epoch_issued_nonnegative')) expected(rel,name)
      ON c.conrelid=to_regclass(expected.rel) AND c.conname=expected.name)
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t
    JOIN (VALUES ('whaleu_identity.accounts'::text,'session_epoch_account'::text),
                 ('whaleu_identity.sessions','session_epoch_issued')) expected(rel,name)
      ON t.tgrelid=to_regclass(expected.rel) AND t.tgname=expected.name)
  AND NOT EXISTS (SELECT 1 FROM pg_proc p
    WHERE p.pronamespace=to_regnamespace('whaleu_identity')
      AND p.proname=ANY(ARRAY['session_epoch_account_guard','session_epoch_issued_guard','session_epoch_protocol']))`;
