/** TEST ONLY: additive0182 identities outside the already excluded real-deletion
 * namespace. Use only under existing historical ledger and table/DDL fences.
 * No grants, authority, current runtime fallback or whole-catalog assertion. */
export const historicalRealRequestAbsenceSql = `
  NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='whaleu_real_deletion_admission')
  AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('whaleu_identity.accounts')
    AND a.attname='real_deletion_request_id' AND NOT a.attisdropped)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('whaleu_identity.accounts')
    AND c.conname=ANY(ARRAY['deletion_authority_unambiguous','accounts_real_deletion_request_id_fkey']))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('whaleu_identity.accounts')
    AND t.tgname=ANY(ARRAY['real_deletion_pointer','real_deletion_account_complete']))`;

/** Independent unledgered witnesses, not executable request/admission authority.
 * Existing integration loops run each in its own rollback-only transaction. */
export const historicalRealRequestPartials = [
  [
    '0182 empty admission namespace',
    'CREATE SCHEMA whaleu_real_deletion_admission;',
  ],
  [
    '0182 account pointer column',
    'ALTER TABLE whaleu_identity.accounts ADD COLUMN real_deletion_request_id uuid;',
  ],
  [
    '0182 account authority constraint',
    'ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT deletion_authority_unambiguous CHECK (true);',
  ],
  [
    '0182 account pointer constraint',
    'ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT accounts_real_deletion_request_id_fkey CHECK (true);',
  ],
  [
    '0182 account pointer trigger',
    'CREATE TRIGGER real_deletion_pointer BEFORE INSERT OR UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard();',
  ],
  [
    '0182 account complete trigger',
    'CREATE CONSTRAINT TRIGGER real_deletion_account_complete AFTER INSERT OR UPDATE ON whaleu_identity.accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard();',
  ],
] as const;
