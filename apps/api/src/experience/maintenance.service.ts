import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  ApplicationError,
  TitleMaintenanceContinuationConflict,
} from '../http/application-error.js';
import { lockExperienceOwner } from './ingress.js';
import { ExperienceRepository } from './repository.js';
import { levelFor } from './catalog.js';
import {
  maintenanceIntentHash,
  maintenanceTitleKeys,
} from './maintenance.contracts.js';
import type {
  MaintenanceIntent,
  MaintenanceReceipt,
} from './maintenance.contracts.js';
import { TitleMaintenanceRepository } from './maintenance.repository.js';
import type { MaintenanceItem } from './maintenance.repository.js';
type ReceiptFailure = {
  errorCode:
    | 'EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND'
    | 'EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT';
};
type MaintenanceResult =
  MaintenanceReceipt | ReceiptFailure | { successorRequestId: string };
function finalized(result: MaintenanceResult): MaintenanceReceipt {
  if ('errorCode' in result) throw new ApplicationError(result.errorCode);
  if ('successorRequestId' in result)
    throw new TitleMaintenanceContinuationConflict(result.successorRequestId);
  return result;
}

@Injectable()
export class ExperienceTitleMaintenanceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authority: AuthorizationService,
    @Inject(ExperienceRepository)
    private readonly records: ExperienceRepository,
    @Inject(TitleMaintenanceRepository)
    private readonly maintenance: TitleMaintenanceRepository,
  ) {}

  async receipt(token: string, requestId: string): Promise<MaintenanceReceipt> {
    const result = await this.database
      .transaction<MaintenanceResult>(async (tx) => {
        await boundMaintenanceTransaction(tx);
        const actor = await this.identity.session(token, tx);
        await this.authority.requireGlobalTitleMaintenance(actor.accountId, tx);
        const prior = await this.maintenance.request(
          actor.accountId,
          requestId,
          tx,
        );
        if (!prior)
          return { errorCode: 'EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND' };
        return prior.receipt;
      })
      .catch(maintenanceFailure);
    return finalized(result);
  }

  /** One owner, one authenticated transaction; continuation lives in immutable receipts. */
  async batch(
    token: string,
    input: MaintenanceIntent,
  ): Promise<MaintenanceReceipt> {
    const result = await this.database
      .transaction<MaintenanceResult>(
        async (tx) => {
          await boundMaintenanceTransaction(tx);
          const actor = await this.identity.session(token, tx);
          const grant = await this.authority.requireGlobalTitleMaintenance(
            actor.accountId,
            tx,
          );
          const hash = maintenanceIntentHash(input);
          await this.maintenance.requestLock(
            actor.accountId,
            input.requestId,
            tx,
          );
          const prior = await this.maintenance.request(
            actor.accountId,
            input.requestId,
            tx,
          );
          if (prior) {
            if (prior.intent_hash !== hash)
              return { errorCode: 'EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT' };
            return prior.receipt;
          }
          const previousId =
            'previousRequestId' in input ? input.previousRequestId : null;
          const previous =
            previousId === null
              ? null
              : await this.maintenance.request(
                  actor.accountId,
                  previousId,
                  tx,
                  true,
                );
          if (previousId !== null && !previous)
            return { errorCode: 'EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND' };
          if (previous) {
            const successor = await this.maintenance.successor(
              actor.accountId,
              previous.request_id,
              tx,
            );
            if (successor) return { successorRequestId: successor };
            if (previous.receipt.done)
              return { errorCode: 'EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT' };
          }
          const operation =
            'operation' in input ? input.operation : previous!.operation;
          const boundary = previous
            ? {
                runStartedAt: previous.run_started_at,
                upperAccountId: previous.upper_account_id,
              }
            : await this.identity.beginTitleMaintenanceSweep(tx);
          const cursorBefore = previous?.cursor_after ?? null;
          const candidates =
            await this.identity.titleMaintenanceCandidateWindow(
              { ...boundary, cursorAccountId: cursorBefore },
              tx,
            );
          const owner = candidates[0];
          let item: MaintenanceItem | null = null;
          if (owner) {
            // No identity/provider or role locks may be acquired after the terminal owner lock.
            const eligible =
              operation === 'repair_default_title'
                ? await this.identity.canonicalWechatTitleEligibility(owner, tx)
                : await this.identity.lockTitleMaintenanceAccount(owner, tx);
            if (operation === 'repair_level_titles' && !eligible)
              throw new ApplicationError('EXPERIENCE_MAINTENANCE_UNAVAILABLE');
            // Enrollment alone is not history. Never create baseline/state/appearance here.
            await lockExperienceOwner(tx, owner, true);
            const state =
              operation === 'repair_level_titles'
                ? await this.records.state(owner, tx)
                : null;
            const balance = state?.balance ?? null;
            const keys = maintenanceTitleKeys(operation, balance, eligible);
            const missing = (
              await this.maintenance.missingTitles(owner, keys, tx)
            ).sort();
            const outcome =
              operation === 'repair_default_title' && !eligible
                ? ('skipped_ineligible' as const)
                : operation === 'repair_level_titles' && balance === null
                  ? ('skipped_unknown_level' as const)
                  : missing.length > 0
                    ? ('repaired' as const)
                    : ('unchanged' as const);
            item = {
              ownerId: owner,
              eligible,
              knownBalance: balance,
              stateRevision: state?.revision ?? null,
              observedLevel:
                balance === null ? null : levelFor(BigInt(balance)),
              outcome,
              grantedTitleKeys: missing,
            };
          }
          const receipt: MaintenanceReceipt = {
            requestId: input.requestId,
            operation,
            runId: previous?.run_id ?? input.requestId,
            previousRequestId: previousId,
            visited: Number(Boolean(item)),
            updatedOwners: Number(item?.outcome === 'repaired'),
            grantedTitles: item?.grantedTitleKeys.length ?? 0,
            skippedUnknownLevel: Number(
              item?.outcome === 'skipped_unknown_level',
            ),
            skippedIneligible: Number(item?.outcome === 'skipped_ineligible'),
            done: candidates.length < 2,
          };
          await this.maintenance.save(
            {
              actorId: actor.accountId,
              sessionId: actor.sessionId,
              grantId: grant.id,
              intentHash: hash,
              ...boundary,
              cursorBefore,
              cursorAfter: owner ?? cursorBefore,
              receipt,
              item,
            },
            tx,
          );
          return receipt;
        },
        { isolationLevel: 'read committed' },
      )
      .catch(maintenanceFailure);
    // Recovery metadata leaves the transaction only after fresh deadline finalization.
    return finalized(result);
  }
}

function maintenanceFailure(error: unknown): never {
  // Only expiry fences have public authority meaning; forged proof constraints do not.
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23514' &&
    'constraint' in error
  ) {
    if (error.constraint === 'maintenance_session_expired')
      throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
    if (error.constraint === 'maintenance_authorization_expired')
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['55P03', '40P01', '57014'].includes(String(error.code))
  )
    throw new ApplicationError('EXPERIENCE_MAINTENANCE_UNAVAILABLE');
  throw error;
}

/** Keep stricter deployment settings; limits remain active through deferred proofs. */
export function maintenanceTimeout(value: string, maximum: number): string {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const inherited = match
    ? Number(match[1]) * multipliers[match[2] ?? 'ms']!
    : NaN;
  if (!Number.isFinite(inherited))
    throw new ApplicationError('EXPERIENCE_MAINTENANCE_UNAVAILABLE');
  return `${Math.max(1, Math.min(inherited || maximum, maximum))}ms`;
}
async function boundMaintenanceTransaction(tx: PoolClient): Promise<void> {
  const settings = (
    await tx.query<{
      statement_timeout: string;
      lock_timeout: string;
      now: Date;
    }>(
      "SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,clock_timestamp() AS now",
    )
  ).rows[0];
  if (!settings || !Number.isFinite(settings.now.getTime()))
    throw new ApplicationError('EXPERIENCE_MAINTENANCE_UNAVAILABLE');
  await tx.query(
    "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
    [
      maintenanceTimeout(settings.statement_timeout, 5000),
      maintenanceTimeout(settings.lock_timeout, 3000),
    ],
  );
  registerTransactionDeadline(
    tx,
    settings.now.getTime() + 15000,
    'EXPERIENCE_MAINTENANCE_UNAVAILABLE',
  );
}
