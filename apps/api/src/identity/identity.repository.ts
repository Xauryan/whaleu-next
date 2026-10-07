import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import type { ProviderIdentity, SessionView } from './contracts.js';

const ACCESS_MS = 10 * 60 * 1000;
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export interface TokenHashes {
  readonly access: string;
  readonly refresh: string;
}
interface SessionRow {
  id: string;
  account_id: string;
  status: 'active' | 'blocked';
  access_expires_at: Date;
  refresh_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}
interface RefreshRow extends SessionRow {
  consumed_at: Date | null;
}
interface AccessRow extends SessionRow {
  token_expires_at: Date;
}

function view(row: SessionRow): SessionView {
  return {
    accountId: row.account_id,
    sessionId: row.id,
    expiresAt: row.access_expires_at.getTime(),
    refreshExpiresAt: row.refresh_expires_at.getTime(),
  };
}
async function databaseTime(client: PoolClient): Promise<number> {
  const result = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  );
  return result.rows[0]!.now.getTime();
}

@Injectable()
export class IdentityRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async createSession(
    identity: ProviderIdentity,
    tokens: TokenHashes,
  ): Promise<SessionView> {
    return this.database.transaction(async (client) => {
      // Serialize first sign-in for the same app-scoped subject. Unique PK is the final invariant.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([identity.provider, identity.appId, identity.subject])],
      );
      const existing = await client.query<{ account_id: string }>(
        'SELECT account_id FROM whaleu_identity.provider_identities WHERE provider=$1 AND app_id=$2 AND subject=$3',
        [identity.provider, identity.appId, identity.subject],
      );
      const accountId = existing.rows[0]?.account_id ?? randomUUID();
      if (!existing.rows[0]) {
        await client.query(
          'INSERT INTO whaleu_identity.accounts (id) VALUES ($1)',
          [accountId],
        );
        await client.query(
          'INSERT INTO whaleu_identity.provider_identities (provider, app_id, subject, account_id, union_subject) VALUES ($1,$2,$3,$4,$5)',
          [
            identity.provider,
            identity.appId,
            identity.subject,
            accountId,
            identity.unionSubject ?? null,
          ],
        );
      }
      const account = await client.query<{ status: string }>(
        'SELECT status FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      );
      if (account.rows[0]?.status !== 'active')
        throw new ApplicationError('ACCOUNT_BLOCKED');
      const now = await databaseTime(client);
      // A fresh login has a bounded number of active device sessions; do not silently allow unbounded rows.
      await client.query(
        `UPDATE whaleu_identity.sessions SET revoked_at=$2, revoke_reason='session_limit'
        WHERE id IN (SELECT id FROM whaleu_identity.sessions WHERE account_id=$1 AND revoked_at IS NULL
          AND refresh_expires_at > $2 ORDER BY created_at DESC, id DESC OFFSET 9)`,
        [accountId, new Date(now)],
      );
      const sessionId = randomUUID();
      const result = await client.query<SessionRow>(
        `INSERT INTO whaleu_identity.sessions
        (id, account_id, access_expires_at, refresh_expires_at, absolute_expires_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [
          sessionId,
          accountId,
          new Date(now + ACCESS_MS),
          new Date(now + REFRESH_MS),
          new Date(now + SESSION_MS),
        ],
      );
      await this.insertTokens(
        client,
        sessionId,
        tokens,
        new Date(now + ACCESS_MS),
      );
      return view(result.rows[0]!);
    });
  }

  async rotate(refreshHash: string, tokens: TokenHashes): Promise<SessionView> {
    // Return errors out of the transaction, so replay revocation is COMMITTED before throwing.
    const outcome = await this.database.transaction(
      async (client): Promise<SessionView | ApplicationErrorCode> => {
        // Lock by session, not just token: different generations serialize too.
        const result = await client.query<RefreshRow>(
          `SELECT s.*, a.status, r.consumed_at
        FROM whaleu_identity.refresh_tokens r JOIN whaleu_identity.sessions s ON s.id=r.session_id
        JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE r.token_hash=$1 FOR UPDATE OF s`,
          [refreshHash],
        );
        const row = result.rows[0];
        if (!row) return 'AUTHENTICATION_REQUIRED';
        if (row.revoked_at) return 'SESSION_REVOKED';
        if (row.status !== 'active') return 'ACCOUNT_BLOCKED';
        const now = await databaseTime(client);
        if (
          row.refresh_expires_at.getTime() <= now ||
          row.absolute_expires_at.getTime() <= now
        )
          return 'REFRESH_TOKEN_EXPIRED';
        // Re-read after the session lock: a waiter must see a prior transaction's token consumption.
        const token = await client.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM whaleu_identity.refresh_tokens WHERE token_hash=$1',
          [refreshHash],
        );
        if (token.rows[0]!.consumed_at) {
          await client.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=$2, revoke_reason='refresh_replay' WHERE id=$1",
            [row.id, new Date(now)],
          );
          return 'REFRESH_TOKEN_REUSED';
        }
        const refreshExpires = Math.min(
          now + REFRESH_MS,
          row.absolute_expires_at.getTime(),
        );
        const accessExpires = Math.min(now + ACCESS_MS, refreshExpires);
        await client.query(
          'UPDATE whaleu_identity.refresh_tokens SET consumed_at=$2 WHERE token_hash=$1',
          [refreshHash, new Date(now)],
        );
        await client.query(
          'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1 AND expires_at > $2',
          [row.id, new Date(now)],
        );
        await client.query(
          'UPDATE whaleu_identity.sessions SET access_expires_at=$2, refresh_expires_at=$3 WHERE id=$1',
          [row.id, new Date(accessExpires), new Date(refreshExpires)],
        );
        await this.insertTokens(
          client,
          row.id,
          tokens,
          new Date(accessExpires),
        );
        return {
          accountId: row.account_id,
          sessionId: row.id,
          expiresAt: accessExpires,
          refreshExpiresAt: refreshExpires,
        };
      },
    );
    if (typeof outcome === 'string') throw new ApplicationError(outcome);
    return outcome;
  }

  async authenticate(accessHash: string): Promise<SessionView> {
    const result = await this.database.query<AccessRow & { now: Date }>(
      `SELECT s.*, a.status, t.expires_at AS token_expires_at, clock_timestamp() AS now
      FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id
      JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE t.token_hash=$1`,
      [accessHash],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
    if (row.revoked_at) throw new ApplicationError('SESSION_REVOKED');
    if (row.status !== 'active') throw new ApplicationError('ACCOUNT_BLOCKED');
    if (row.token_expires_at <= row.now || row.absolute_expires_at <= row.now)
      throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
    return view(row);
  }

  async revoke(accessHash: string): Promise<void> {
    // A known expired access token can only terminate its own session. This handles
    // lost refresh responses and logout/refresh races without granting any account access.
    const result = await this.database.query(
      `UPDATE whaleu_identity.sessions s
      SET revoked_at=COALESCE(s.revoked_at,clock_timestamp()), revoke_reason=COALESCE(s.revoke_reason,'logout')
      FROM whaleu_identity.access_tokens t WHERE t.token_hash=$1 AND t.session_id=s.id RETURNING s.id`,
      [accessHash],
    );
    if (!result.rowCount) throw new ApplicationError('AUTHENTICATION_REQUIRED');
  }

  private async insertTokens(
    client: PoolClient,
    sessionId: string,
    tokens: TokenHashes,
    expiresAt: Date,
  ): Promise<void> {
    await client.query(
      'INSERT INTO whaleu_identity.access_tokens (token_hash,session_id,expires_at) VALUES ($1,$2,$3)',
      [tokens.access, sessionId, expiresAt],
    );
    await client.query(
      'INSERT INTO whaleu_identity.refresh_tokens (token_hash,session_id) VALUES ($1,$2)',
      [tokens.refresh, sessionId],
    );
  }
}
