/** TEST ONLY: 0181 creates a wholly new namespace. Requiring its exact absence
 * also rejects an empty or unledgered partial installation, including all of
 * its relations, row types, functions and relation-owned triggers. Keep this
 * separate from the unchanged 0180 identity sentinel and use it only inside
 * existing exact historical ledger, managed-transaction and DDL fences.
 * This grants no current runtime or real-deletion authority.
 */
export const historicalRealDeletionAbsenceSql =
  "NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='whaleu_real_deletion')";
