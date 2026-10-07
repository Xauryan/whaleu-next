import { z } from 'zod';
import type { DatabaseService } from '../database/database.js';
import { supportedPostgresVersion } from '../database/database.js';

const optionsSchema = z.strictObject({
  mode: z.enum(['dry-run', 'apply']).default('dry-run'),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  batchSize: z.number().int().min(1).max(1000).default(100),
});
export type MaintenanceOptions = z.infer<typeof optionsSchema>;
export interface MaintenanceResult {
  readonly mode: MaintenanceOptions['mode'];
  readonly retentionDays: number;
  readonly batchSize: number;
  readonly candidateSessions: number;
  readonly accessTokens: number;
  readonly refreshTokens: number;
  readonly sessions: number;
}

export function maintenanceOptions(input: unknown): MaintenanceOptions {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success)
    throw new Error('Invalid authentication maintenance options');
  return parsed.data;
}

/** Internal operator-only maintenance. Never registered with a public HTTP controller.
 * Budget counts ALL deleted rows, including token histories; never depend on cascades.
 */
export class IdentityMaintenance {
  constructor(
    private readonly database: Pick<DatabaseService, 'transaction'>,
  ) {}

  async run(
    input: Partial<MaintenanceOptions> = {},
  ): Promise<MaintenanceResult> {
    const options = maintenanceOptions(input);
    return this.database.transaction(async (client) => {
      if (options.mode === 'dry-run')
        await client.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
        );
      const state = await client.query<{ version: number; cutoff: Date }>(
        `SELECT current_setting('server_version_num')::integer AS version,
          clock_timestamp() - ($1::integer * interval '1 day') AS cutoff`,
        [options.retentionDays],
      );
      if (!supportedPostgresVersion(state.rows[0]?.version ?? 0))
        throw new Error('PostgreSQL 18.6 or a newer 18.x patch is required');
      const cutoff = state.rows[0]!.cutoff;
      // LEAST ignores NULL revoked_at. An active session is terminal only when refresh
      // has expired (access cannot outlive it); a revoked one can never be refreshed.
      // Apply locks prevent a concurrent pre-expiry rotation from extending a session
      // between the eligibility check and deleting any of its replay evidence.
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM whaleu_identity.sessions
          WHERE LEAST(refresh_expires_at, revoked_at) <= $1
          ORDER BY LEAST(refresh_expires_at, revoked_at), id LIMIT $2
          ${options.mode === 'apply' ? 'FOR UPDATE SKIP LOCKED' : ''}`,
        [cutoff, Math.min(options.batchSize, 100)],
      );
      const ids = candidates.rows.map(({ id }) => id);
      const empty: MaintenanceResult = {
        ...options,
        candidateSessions: ids.length,
        accessTokens: 0,
        refreshTokens: 0,
        sessions: 0,
      };
      if (!ids.length) return empty;
      const access = await client.query<{ token_hash: string }>(
        'SELECT token_hash FROM whaleu_identity.access_tokens WHERE session_id=ANY($1::uuid[]) LIMIT $2',
        [ids, options.batchSize],
      );
      const accessHashes = access.rows.map(({ token_hash }) => token_hash);
      const refresh = await client.query<{ token_hash: string }>(
        'SELECT token_hash FROM whaleu_identity.refresh_tokens WHERE session_id=ANY($1::uuid[]) LIMIT $2',
        [ids, options.batchSize - accessHashes.length],
      );
      const refreshHashes = refresh.rows.map(({ token_hash }) => token_hash);
      const sessionBudget =
        options.batchSize - accessHashes.length - refreshHashes.length;
      // Preview which sessions will be empty after the planned token deletions. This
      // is also the deletion predicate; an unexpected child row prevents deletion.
      const sessions = await client.query<{ id: string }>(
        `SELECT s.id FROM whaleu_identity.sessions s
        WHERE s.id=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM whaleu_identity.access_tokens a WHERE a.session_id=s.id AND NOT (a.token_hash=ANY($2::text[])))
        AND NOT EXISTS (SELECT 1 FROM whaleu_identity.refresh_tokens r WHERE r.session_id=s.id AND NOT (r.token_hash=ANY($3::text[])))
        LIMIT $4`,
        [ids, accessHashes, refreshHashes, sessionBudget],
      );
      if (options.mode === 'dry-run')
        return {
          ...empty,
          accessTokens: accessHashes.length,
          refreshTokens: refreshHashes.length,
          sessions: sessions.rows.length,
        };
      const deletedAccess = await client.query(
        'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=ANY($1::text[]) AND session_id=ANY($2::uuid[])',
        [accessHashes, ids],
      );
      const deletedRefresh = await client.query(
        'DELETE FROM whaleu_identity.refresh_tokens WHERE token_hash=ANY($1::text[]) AND session_id=ANY($2::uuid[])',
        [refreshHashes, ids],
      );
      const deletedSessions = await client.query(
        `DELETE FROM whaleu_identity.sessions s WHERE s.id=ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM whaleu_identity.access_tokens a WHERE a.session_id=s.id)
        AND NOT EXISTS (SELECT 1 FROM whaleu_identity.refresh_tokens r WHERE r.session_id=s.id)`,
        [sessions.rows.map(({ id }) => id)],
      );
      return {
        ...empty,
        accessTokens: deletedAccess.rowCount ?? 0,
        refreshTokens: deletedRefresh.rowCount ?? 0,
        sessions: deletedSessions.rowCount ?? 0,
      };
    });
  }
}
