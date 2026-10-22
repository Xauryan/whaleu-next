/** TEST ONLY: independently installed 0181 identity witnesses, not executable
 * preparation authority. Run each under a rollback-only historical transaction;
 * never apply 0181 or modify its ledger on a predecessor fixture.
 */
const namespace = 'CREATE SCHEMA whaleu_real_deletion;';
const relation =
  namespace + ' CREATE TABLE whaleu_real_deletion.preparations(n integer);';

export const historicalRealDeletionPartials = [
  ['empty namespace', namespace],
  ['preparations relation', relation],
  ...['preparation_guard', 'preparation_unavailable'].map(
    (name) =>
      [
        `${name} function`,
        `${namespace} CREATE FUNCTION whaleu_real_deletion.${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
      ] as const,
  ),
  [
    'preparation_catalog function',
    `${namespace} CREATE FUNCTION whaleu_real_deletion.preparation_catalog() RETURNS text LANGUAGE sql AS $$SELECT 'partial'::text$$`,
  ],
  [
    'preparation_protocol function',
    `${namespace} CREATE FUNCTION whaleu_real_deletion.preparation_protocol() RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$`,
  ],
  [
    'preparation_guard trigger',
    `${relation} CREATE TRIGGER preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_real_deletion.preparations FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()`,
  ],
  [
    'preparation_no_truncate trigger',
    `${relation} CREATE TRIGGER preparation_no_truncate BEFORE TRUNCATE ON whaleu_real_deletion.preparations FOR EACH STATEMENT EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()`,
  ],
] as const;

// A similarly named namespace is not the newly introduced owner. Its generic
// relation/function/trigger names must not be forbidden outside that owner.
export const historicalRealDeletionLookalikeSql = `
CREATE SCHEMA whaleu_real_deletion_archive;
CREATE TABLE whaleu_real_deletion_archive.preparations(n integer);
CREATE FUNCTION whaleu_real_deletion_archive.preparation_guard() RETURNS trigger
 LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER preparation_guard BEFORE INSERT OR UPDATE OR DELETE
 ON whaleu_real_deletion_archive.preparations FOR EACH ROW
 EXECUTE FUNCTION whaleu_real_deletion_archive.preparation_guard();`;
