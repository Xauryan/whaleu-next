import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { canonicalJson } from '../community/content-review/contracts.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { SafetyErrandManagementFacade } from '../safety/errand-management/facade.js';
import { ErrandNotificationsFacade } from '../notifications/errand.facade.js';
import { ErrandAccessService } from './access.js';
import { ErrandAdminRepository } from './admin-repository.js';
import {
  errandAdminReceiptSchema,
  errandAdminRejectionSchema,
} from './admin-command-contracts.js';
import type {
  AdminDeleteErrand,
  RestrictErrandAccepter,
  ErrandAdminOperation,
  ErrandAdminReceipt,
} from './admin-command-contracts.js';

export function errandManagementFailure(error: unknown): never {
  if (error instanceof ApplicationError || error instanceof BadRequestException)
    throw error;
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    if (error.constraint === 'errand_restriction_unavailable')
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    if (error.constraint === 'errand_management_session_expired')
      throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
    if (
      error.constraint === 'errand_management_authorization_expired' ||
      error.constraint === 'errand_management_authority_invalid'
    )
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  }
  throw new ApplicationError('ERRAND_UNAVAILABLE');
}
/** Only this administrative writer entry chooses the exclusive gate, before all
 * actor/request/order locks. Lifecycle commands retain their separate E1 entry. */
@Injectable()
export class ErrandAdminCommandService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(ErrandAdminRepository)
    private readonly records: ErrandAdminRepository,
    @Inject(SafetyErrandManagementFacade)
    private readonly safety: SafetyErrandManagementFacade,
    @Inject(ErrandNotificationsFacade)
    private readonly notices: ErrandNotificationsFacade,
  ) {}
  delete(token: string, orderId: string, body: AdminDeleteErrand) {
    return this.execute(token, orderId, 'admin_delete', body);
  }
  restrictAccepter(
    token: string,
    orderId: string,
    body: RestrictErrandAccepter,
  ) {
    return this.execute(token, orderId, 'restrict_accepter', body);
  }
  private async execute(
    token: string,
    orderId: string,
    operation: ErrandAdminOperation,
    body: AdminDeleteErrand | RestrictErrandAccepter,
  ): Promise<ErrandAdminReceipt> {
    try {
      return await this.db.transaction(
        async (tx) => {
          // Bounded ordinary-phase contention, including a raw writer holding an account
          // before asking for Safety. This never weakens the final NOWAIT grant proof.
          await tx.query(
            "SELECT set_config('lock_timeout',CASE WHEN current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '1 second' THEN '1000ms' ELSE current_setting('lock_timeout') END,true)",
          );
          const session = await this.access.common(token, tx, true);
          const target = await this.records.target(orderId, tx);
          if (!target) throw new ApplicationError('ERRAND_NOT_FOUND');
          const selected = await this.authorization.requireErrandManagement(
            session.accountId,
            target.target_region_id,
            tx,
          );
          const requestId = body.clientRequestId,
            intent = { orderId, command: body };
          const hash = createHash('sha256')
            .update(
              'whaleu:errand-admin-command:v1\n' +
                canonicalJson({ operation, intent }),
            )
            .digest('hex');
          await tx.query(
            'INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash,admin_creation_transaction) VALUES($1,$2,$3,$4,pg_current_xact_id()) ON CONFLICT DO NOTHING',
            [session.accountId, requestId, operation, hash],
          );
          const request = (
            await tx.query<{
              operation: string;
              intent_hash: string;
              receipt: unknown;
            }>(
              'SELECT operation,intent_hash,receipt FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
              [session.accountId, requestId],
            )
          ).rows[0]!;
          if (request.operation !== operation || request.intent_hash !== hash)
            throw new ApplicationError('REQUEST_CONFLICT');
          if (request.receipt !== null) {
            const result = errandAdminReceiptSchema.parse(request.receipt);
            await this.access.recheck(token, tx);
            return result;
          }
          const restrict =
            operation === 'restrict_accepter' ||
            ('publisherRestriction' in body &&
              body.publisherRestriction !== null);
          await tx.query(
            `INSERT INTO whaleu_errands.admin_request_contexts(actor_id,request_id,order_id,target_region_id,grant_id,session_id,operation,expected_revision,intent,restriction_requested) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              session.accountId,
              requestId,
              orderId,
              target.target_region_id,
              selected.grant.id,
              session.sessionId,
              operation,
              body.expectedRevision,
              JSON.stringify(intent),
              restrict,
            ],
          );
          const checkpoint = checkpointTransactionDeadlines(tx);
          await tx.query('SAVEPOINT errand_admin_command');
          let receipt: ErrandAdminReceipt;
          try {
            const row = await this.records.target(orderId, tx, true);
            if (!row) throw new ApplicationError('ERRAND_UNAVAILABLE');
            if (row.target_region_id !== target.target_region_id)
              throw new ApplicationError('ERRAND_UNAVAILABLE');
            if (row.revision !== body.expectedRevision)
              throw new ApplicationError('ERRAND_REVISION_CONFLICT');
            if (row.deleted_at !== null)
              throw new ApplicationError('ERRAND_STATE_CONFLICT');
            if (
              operation === 'admin_delete' &&
              row.publisher_id === session.accountId
            )
              throw new ApplicationError('ERRAND_USE_OWNER_COMMAND');
            if (
              operation === 'restrict_accepter' &&
              (!row.accepter_id ||
                !['accepted', 'completed'].includes(row.state))
            )
              throw new ApplicationError('ERRAND_STATE_CONFLICT');
            const subjectId =
              operation === 'admin_delete'
                ? row.publisher_id
                : row.accepter_id!;
            const context = {
              actorId: session.accountId,
              sessionId: session.sessionId,
              grantId: selected.grant.id,
              requestId,
              kind: 'order' as const,
              operation,
              orderId,
              targetRegionId: row.target_region_id,
            };
            let issued: null | Awaited<
              ReturnType<SafetyErrandManagementFacade['issue']>
            > = null;
            if (restrict) {
              await this.authorization.requireUnprotectedErrandTarget(
                subjectId,
                tx,
              );
              const reason =
                'deleteReason' in body ? body.deleteReason : body.reason;
              const duration =
                'publisherRestriction' in body
                  ? body.publisherRestriction!
                  : body.duration;
              issued = await this.safety.issue(
                context,
                { subjectId, action: 'all', reason, duration },
                tx,
              );
            }
            const eventId = randomUUID(),
              revision =
                operation === 'admin_delete' ? randomUUID() : row.revision;
            const occurredAt = (
              await tx.query<{ now: string }>(
                `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') now`,
              )
            ).rows[0]!.now;
            await tx.query(
              `INSERT INTO whaleu_errands.admin_events(id,actor_id,request_id,order_id,operation,subject_id,observed_revision,result_revision,observed_state,observed_accepter_id,delete_reason,safety_event_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [
                eventId,
                session.accountId,
                requestId,
                orderId,
                operation,
                subjectId,
                row.revision,
                revision,
                row.state,
                row.accepter_id,
                'deleteReason' in body ? body.deleteReason : null,
                issued?.eventId ?? null,
                occurredAt,
              ],
            );
            if (operation === 'admin_delete') {
              await tx.query(
                'UPDATE whaleu_errands.orders SET revision=$2,deleted_at=$3,deleted_by=$4,deletion_reason=$5,admin_delete_event_id=$6 WHERE id=$1',
                [
                  orderId,
                  revision,
                  occurredAt,
                  session.accountId,
                  'deleteReason' in body ? body.deleteReason : '',
                  eventId,
                ],
              );
              const transitionId = randomUUID();
              await tx.query(
                `INSERT INTO whaleu_errands.transitions(id,order_id,actor_id,operation,prior_state,next_state,request_id,revision,occurred_at) VALUES($1,$2,$3,'admin_delete',$4,$4,$5,$6,$7)`,
                [
                  transitionId,
                  orderId,
                  session.accountId,
                  row.state,
                  requestId,
                  revision,
                  occurredAt,
                ],
              );
              await this.notices.recordAdminDeleted(
                {
                  transitionId,
                  recipientAccountId: row.publisher_id,
                  orderId,
                  reason: 'deleteReason' in body ? body.deleteReason : '',
                  occurredAt,
                },
                tx,
              );
            }
            if (issued) await this.notices.recordFeature(issued.notice, tx);
            receipt = {
              requestId,
              operation,
              outcome: 'applied',
              orderId,
              revision,
              occurredAt,
            };
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              !errandAdminRejectionSchema.safeParse(error.code).success
            )
              throw error;
            await tx.query('ROLLBACK TO SAVEPOINT errand_admin_command');
            restoreTransactionDeadlines(tx, checkpoint);
            receipt = {
              requestId,
              operation,
              outcome: 'rejected',
              code: errandAdminRejectionSchema.parse(error.code),
            };
          }
          await tx.query('RELEASE SAVEPOINT errand_admin_command');
          const result = errandAdminReceiptSchema.parse(receipt);
          await tx.query(
            'UPDATE whaleu_errands.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
            [session.accountId, requestId, JSON.stringify(result)],
          );
          await this.access.recheck(token, tx);
          return result;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
  async receipt(token: string, requestId: string): Promise<ErrandAdminReceipt> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.access.common(token, tx);
          const row = (
            await tx.query<{ target_region_id: string; receipt: unknown }>(
              `SELECT c.target_region_id,r.receipt FROM whaleu_errands.requests r JOIN whaleu_errands.admin_request_contexts c ON c.actor_id=r.account_id AND c.request_id=r.request_id WHERE r.account_id=$1 AND r.request_id=$2 AND r.operation IN ('admin_delete','restrict_accepter') AND r.receipt IS NOT NULL`,
              [session.accountId, requestId],
            )
          ).rows[0];
          if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
          await this.authorization.requireErrandManagement(
            session.accountId,
            row.target_region_id,
            tx,
          );
          const receipt = errandAdminReceiptSchema.parse(row.receipt);
          await this.access.recheck(token, tx);
          return receipt;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
}
