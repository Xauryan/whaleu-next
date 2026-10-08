import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { ErrandRestrictionReader } from './reader.js';
import { ErrandRestrictionWriter } from './writer.js';
import type {
  ErrandRestrictionContext,
  ErrandRestrictionGlobalReceipt,
} from './contracts.js';
/** Safety owns persisted restriction facts; orchestration, Authorization's final
 * target proof, public Profile display, and atomic local notices stay with their
 * owners. Every method uses the caller's managed transaction. */
@Injectable()
export class SafetyErrandManagementFacade extends ErrandRestrictionReader {
  private readonly writer = new ErrandRestrictionWriter();
  readonly issue = this.writer.issue.bind(this.writer);
  readonly release = this.writer.release.bind(this.writer);
  async beginGlobalRequest(
    context: ErrandRestrictionContext,
    intentHash: string,
    intent: unknown,
    tx: PoolClient,
  ): Promise<ErrandRestrictionGlobalReceipt | null> {
    if (
      context.kind !== 'global' ||
      !['issue', 'release'].includes(context.operation)
    )
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_safety.errand_restriction_requests(account_id,request_id,session_id,grant_id,operation,intent_hash,intent)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        context.actorId,
        context.requestId,
        context.sessionId,
        context.grantId,
        context.operation,
        intentHash,
        JSON.stringify(intent),
      ],
    );
    const row = (
      await tx.query<{
        intent_hash: string;
        operation: string;
        receipt: ErrandRestrictionGlobalReceipt | null;
      }>(
        `SELECT intent_hash,operation,receipt FROM whaleu_safety.errand_restriction_requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
        [context.actorId, context.requestId],
      )
    ).rows[0]!;
    if (row.intent_hash !== intentHash || row.operation !== context.operation)
      throw new ApplicationError('REQUEST_CONFLICT');
    return row.receipt;
  }
  async finishGlobalRequest(
    actorId: string,
    requestId: string,
    receipt: ErrandRestrictionGlobalReceipt,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query(
      'UPDATE whaleu_safety.errand_restriction_requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL',
      [actorId, requestId, JSON.stringify(receipt)],
    );
    if (result.rowCount !== 1) throw new ApplicationError('SAFETY_UNAVAILABLE');
  }
  async readGlobalRequest(
    actorId: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<ErrandRestrictionGlobalReceipt | null> {
    return (
      (
        await tx.query<{ receipt: ErrandRestrictionGlobalReceipt }>(
          `SELECT receipt FROM whaleu_safety.errand_restriction_requests WHERE account_id=$1 AND request_id=$2 AND receipt IS NOT NULL`,
          [actorId, requestId],
        )
      ).rows[0]?.receipt ?? null
    );
  }
}
