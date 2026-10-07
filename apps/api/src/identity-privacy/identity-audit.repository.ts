import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ContentIdentityTarget } from './contracts.js';

export interface IdentityAuditEntry {
  readonly batchId: string;
  readonly actorAccountId: string;
  readonly sessionId: string;
  readonly grantId: string | null;
  readonly requestId: string;
  readonly target: ContentIdentityTarget;
  readonly outcome: 'disclosed' | 'unavailable' | 'denied';
  readonly fields: readonly ('accountId' | 'nickname' | 'studentNumber')[];
}
@Injectable()
export class IdentityAuditRepository {
  async append(
    entries: readonly IdentityAuditEntry[],
    transaction: PoolClient,
  ): Promise<void> {
    try {
      for (const entry of entries) {
        // Metadata only: no subject-account link, nickname, student number, body, URL or token.
        const result = await transaction.query(
          `INSERT INTO whaleu_authorization.identity_view_audit
           (id,batch_id,actor_account_id,session_id,grant_id,request_id,target_kind,target_id,outcome,disclosed_fields)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            randomUUID(),
            entry.batchId,
            entry.actorAccountId,
            entry.sessionId,
            entry.grantId,
            entry.requestId,
            entry.target.kind,
            entry.target.id,
            entry.outcome,
            [...entry.fields],
          ],
        );
        if (result.rowCount !== 1)
          throw new ApplicationError('IDENTITY_AUDIT_UNAVAILABLE');
      }
    } catch {
      throw new ApplicationError('IDENTITY_AUDIT_UNAVAILABLE');
    }
  }
}
