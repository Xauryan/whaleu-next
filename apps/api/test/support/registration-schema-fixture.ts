import { registrationCatalogBody } from '../../src/identity/registration/catalog.js';
import { REGISTRATION_GUARD_PROTOCOL } from '../../src/identity/registration/digests.js';
/** Unit-only catalog observations. This fixture does not create or qualify a
 * PostgreSQL schema; integration coverage must exercise the real migration. */
export function registrationSchemaFixture(
  sql: string,
): { rows: unknown[] } | undefined {
  if (sql.includes("current_setting('transaction_isolation')"))
    return {
      rows: [
        {
          isolation: 'read committed',
          statement_timeout: '10000',
          lock_timeout: '0',
        },
      ],
    };
  if (
    sql.startsWith('SELECT set_config(') ||
    sql === 'SET CONSTRAINTS ALL IMMEDIATE'
  )
    return { rows: [] };
  if (sql.includes('pg_try_advisory_xact_lock_shared'))
    return { rows: [{ locked: true }] };
  if (sql === 'SELECT clock_timestamp() AS now')
    return { rows: [{ now: new Date() }] };
  const shape = {
    invoker: true,
    sql: true,
    config: ['search_path=pg_catalog'],
    scalar: true,
    safe: true,
  };
  if (sql.includes('registration-schema-metadata-v1'))
    return {
      rows: [
        {
          catalogFunction: {
            ...shape,
            stable: true,
            body: registrationCatalogBody,
          },
          marker: {
            ...shape,
            immutable: true,
            sameOwner: true,
            body: `SELECT '${JSON.stringify({ version: 1, protocol: REGISTRATION_GUARD_PROTOCOL, migration: '0179_identity_registration_guard.sql', catalog: 'a'.repeat(64) })}'::jsonb`,
          },
        },
      ],
    };
  if (sql === 'SELECT whaleu_identity.registration_guard_catalog() catalog')
    return { rows: [{ catalog: 'a'.repeat(64) }] };
  return undefined;
}
