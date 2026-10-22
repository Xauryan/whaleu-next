import { createHash } from 'node:crypto';
import {
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
} from '../../src/identity/session-epoch-contract.js';
/** Unit-only observations, not a substitute for the real 0180 PG migration. */
export function sessionEpochFixture(
  sql: string,
  options: { qualified?: boolean; finalValid?: boolean } = {},
): { rows: unknown[] } | undefined {
  if (sql.includes('identity-session-epoch-schema-v1'))
    return {
      rows: [
        {
          qualified: options.qualified ?? true,
          body_hashes: [
            sessionEpochAccountBody,
            sessionEpochIssuedBody,
            sessionEpochMarkerBody,
          ].map((body) => createHash('sha256').update(body).digest('hex')),
        },
      ],
    };
  if (sql.includes('identity-session-epoch-final-v1'))
    return { rows: [{ valid: options.finalValid ?? true }] };
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
  if (sql.includes('pg_try_advisory_xact_lock_shared'))
    return { rows: [{ locked: true }] };
  if (
    sql.startsWith('SELECT set_config(') ||
    sql === 'SET CONSTRAINTS ALL IMMEDIATE' ||
    /^SELECT id FROM whaleu_identity\.(accounts|sessions) WHERE id=ANY\(/.test(
      sql,
    )
  )
    return { rows: [] };
  return undefined;
}
