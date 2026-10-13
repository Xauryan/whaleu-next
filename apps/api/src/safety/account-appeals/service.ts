import {
  AccountPolicy,
  AccountPolicyFor,
  booleanAccountPolicy,
} from '../account-policy/decorator.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { lockSafetyPolicy } from '../locks.js';
import { SafetyRepository } from '../repository.js';
import { AccountPunishmentOwner } from '../account-moderation/owner.js';
import {
  appealSubmitCommandSchema,
  appealDecisionCommandSchema,
  appealSubmitReceiptSchema,
  appealDecisionReceiptSchema,
  appealViewSchema,
  appealManagementViewSchema,
} from '../account-moderation/contracts.js';
import type {
  AppealSubmitCommand,
  AppealDecisionCommand,
  AppealSubmitReceipt,
  AppealDecisionReceipt,
  ModerationPageQuery,
  PunishmentReference,
} from '../account-moderation/contracts.js';
import { AccountAppealsRepository } from './repository.js';
import type { AppealCase, AppealSession } from './repository.js';
import {
  retainAppealIdentity,
  retainAppealRead,
  retainAppealCommand,
} from './proof.js';
import { appealIntentHash, safeAppealText } from './evidence.js';
import { decodeAppealCursor, encodeAppealCursor } from './cursor.js';
type Command = AppealSubmitCommand | AppealDecisionCommand;
type Receipt = AppealSubmitReceipt | AppealDecisionReceipt;
const unavailable = 'SAFETY_MODERATION_UNAVAILABLE' as const;
const reference = (c: AppealCase): PunishmentReference => ({
  punishmentId: c.punishment_id,
  kind: c.kind,
  revision: c.revision,
});
@Injectable()
export class AccountAppealsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(AccountPunishmentOwner)
    private readonly punishments: AccountPunishmentOwner,
    @Inject(AccountAppealsRepository)
    private readonly repository: AccountAppealsRepository,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.database
      .transaction(
        async (tx) => {
          await tx.query(`SELECT set_config('lock_timeout',CASE WHEN current_setting('lock_timeout')::interval=interval '0'
        OR current_setting('lock_timeout')::interval>interval '100 milliseconds' THEN '100ms' ELSE current_setting('lock_timeout') END,true)`);
          const until = (
            await tx.query<{ until: string }>(
              "SELECT (clock_timestamp()+interval '15 seconds')::text until",
            )
          ).rows[0]!.until;
          registerTransactionExactDeadline(tx, until, unavailable);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      )
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationError ||
          error instanceof BadRequestException
        )
          throw error;
        throw new ApplicationError(unavailable);
      });
  }
  private async session(token: string, tx: PoolClient): Promise<AppealSession> {
    const session = await this.identity.session(token, tx);
    const result = {
      actorId: session.accountId,
      sessionId: session.sessionId,
      tokenHash: hashToken(token),
    };
    await retainAppealIdentity(
      {
        actor: result.actorId,
        sessionId: result.sessionId,
        tokenHash: result.tokenHash,
      },
      tx,
    );
    return result;
  }
  private async admin(
    actor: string,
    write: boolean,
    tx: PoolClient,
  ): Promise<string> {
    await this.safety.restriction(
      actor,
      tx,
      write ? 'noncontent_management' : 'privileged_read',
    );
    const grant = (
      await tx.query<{ id: string; until: string | null }>(
        `SELECT id,expires_at::text until FROM whaleu_authorization.role_grants
      WHERE account_id=$1 AND role='super_admin' AND operating_region_id IS NULL AND revoked_at IS NULL
      AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY id LIMIT 1 FOR SHARE`,
        [actor],
      )
    ).rows[0];
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    registerTransactionExactDeadline(
      tx,
      grant.until,
      'AUTHORIZATION_UNAVAILABLE',
    );
    if (
      !(
        await tx.query<{ current: boolean }>(
          'SELECT whaleu_safety.account_appeal_admin_current($1,$2) current',
          [actor, grant.id],
        )
      ).rows[0]?.current
    )
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return grant.id;
  }
  private parseReceipt(receipt: Receipt, action: Command['action']): Receipt {
    return action === 'submit_appeal'
      ? appealSubmitReceiptSchema.parse(receipt)
      : appealDecisionReceiptSchema.parse(receipt);
  }
  private base(command: Command) {
    return command.action === 'submit_appeal'
      ? {
          requestId: command.clientRequestId,
          action: command.action,
          punishment: command.punishment,
        }
      : {
          requestId: command.clientRequestId,
          action: command.action,
          appealId: command.appealId,
        };
  }
  private async recoverLocked(
    session: AppealSession,
    command: Command,
    tx: PoolClient,
  ): Promise<Receipt | null> {
    await this.repository.requestLock(
      session.actorId,
      command.clientRequestId,
      tx,
    );
    const previous = await this.repository.request(
      session.actorId,
      command.clientRequestId,
      tx,
    );
    if (!previous) return null;
    if (previous.intent_hash !== appealIntentHash(session.actorId, command))
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.parseReceipt(previous.receipt, command.action);
  }
  @AccountPolicyFor(
    (args) =>
      (args[1] as Command).action === 'submit_appeal'
        ? 'restricted_self_service'
        : 'noncontent_management',
    'owner_after_recovery',
  )
  async command(
    token: string,
    supplied: Command,
    cancel = false,
  ): Promise<Receipt> {
    const command: Command =
      supplied.action === 'submit_appeal'
        ? appealSubmitCommandSchema.parse(supplied)
        : appealDecisionCommandSchema.parse(supplied);
    if (
      !safeAppealText(
        command.action === 'submit_appeal' ? command.text : command.reason,
      )
    )
      throw new BadRequestException('Invalid request');
    const prior = await this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.repository.rate(session.actorId, 'read', tx);
      const previous = await this.recoverLocked(session, command, tx);
      if (previous || !cancel) return previous;
      const receipt = this.parseReceipt(
        {
          ...this.base(command),
          outcome: 'rejected',
          code: 'SAFETY_MODERATION_CANCELLED',
        } as Receipt,
        command.action,
      );
      await this.repository.save(
        {
          session,
          command,
          hash: appealIntentHash(session.actorId, command),
          receipt,
        },
        tx,
      );
      retainAppealCommand(session.actorId, command.clientRequestId, tx);
      return receipt;
    });
    if (prior) return prior;
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx, true);
      const session = await this.session(token, tx);
      const previous = await this.recoverLocked(session, command, tx);
      if (previous) return previous;
      if (command.action === 'submit_appeal')
        return this.submit(session, command, tx);
      return this.decide(session, command, tx);
    });
  }
  private async submit(
    session: AppealSession,
    command: AppealSubmitCommand,
    tx: PoolClient,
  ): Promise<AppealSubmitReceipt> {
    await this.repository.caseLock(command.punishment.punishmentId, tx);
    // This exact ownership read is deliberately independent of posting/phone,
    // base coverage, public feedback, Review, and any provider or online reviewer.
    const punishment = await this.punishments.observeOwned(
      session.actorId,
      command.punishment,
      tx,
    );
    const open = await this.repository.open(
      command.punishment.punishmentId,
      tx,
    );
    let receipt: AppealSubmitReceipt;
    if (open) {
      const existing = await this.repository.case(open, session.actorId, tx);
      if (!existing) throw new ApplicationError(unavailable);
      receipt = {
        ...this.base(command),
        outcome: 'applied',
        appealId: open,
        recordedAt: existing.submitted_at.toISOString(),
        reusedOpenCase: true,
      } as AppealSubmitReceipt;
    } else if (punishment.state !== 'active') {
      receipt = {
        ...this.base(command),
        outcome: 'rejected',
        code: 'SAFETY_MODERATION_STALE',
      } as AppealSubmitReceipt;
    } else {
      await this.repository.rate(session.actorId, 'submit', tx);
      receipt = {
        ...this.base(command),
        outcome: 'applied',
        appealId: randomUUID(),
        recordedAt: await this.now(tx),
        reusedOpenCase: false,
      } as AppealSubmitReceipt;
      registerTransactionExactDeadline(tx, punishment.endsAt, unavailable);
    }
    await this.repository.save(
      {
        session,
        command,
        hash: appealIntentHash(session.actorId, command),
        receipt,
        ...(receipt.outcome === 'applied'
          ? { appealId: receipt.appealId }
          : {}),
      },
      tx,
    );
    if (receipt.outcome === 'applied' && !receipt.reusedOpenCase)
      await this.repository.create(
        receipt.appealId,
        session.actorId,
        command,
        receipt.recordedAt,
        tx,
      );
    retainAppealCommand(session.actorId, command.clientRequestId, tx);
    return appealSubmitReceiptSchema.parse(receipt);
  }
  private async decide(
    session: AppealSession,
    command: AppealDecisionCommand,
    tx: PoolClient,
  ): Promise<AppealDecisionReceipt> {
    const grantId = await this.admin(session.actorId, true, tx);
    const observed = await this.repository.case(command.appealId, null, tx);
    if (!observed) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    await this.repository.caseLock(observed.punishment_id, tx);
    const appeal = await this.repository.case(command.appealId, null, tx);
    if (!appeal) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
    let receipt: AppealDecisionReceipt;
    const effective = await this.punishments.isEffective(reference(appeal), tx);
    const mismatchedOutcome =
      (command.decision === 'closed_no_longer_effective') === effective;
    if (
      appeal.outcome !== null ||
      appeal.state_version !== command.expectedStateVersion ||
      mismatchedOutcome
    ) {
      receipt = {
        requestId: command.clientRequestId,
        action: command.action,
        appealId: appeal.id,
        outcome: 'rejected',
        code: 'SAFETY_MODERATION_STALE',
      };
      await this.repository.save(
        {
          session,
          command,
          hash: appealIntentHash(session.actorId, command),
          receipt,
          grantId,
          appealId: appeal.id,
        },
        tx,
      );
    } else {
      await this.repository.rate(session.actorId, 'decide', tx);
      const at = await this.now(tx),
        eventId = randomUUID();
      const releaseEventId =
        command.decision === 'released' ? randomUUID() : null;
      receipt = {
        requestId: command.clientRequestId,
        action: command.action,
        appealId: appeal.id,
        outcome: 'applied',
        decision: command.decision,
        eventId,
        recordedAt: at,
      };
      if (effective) {
        const punishment = await this.punishments.observe(
          appeal.punishment_id,
          tx,
        );
        registerTransactionExactDeadline(tx, punishment.endsAt, unavailable);
      }
      await this.repository.save(
        {
          session,
          command,
          hash: appealIntentHash(session.actorId, command),
          receipt,
          grantId,
          appealId: appeal.id,
        },
        tx,
      );
      // The decision's database trigger invokes the punishment owner's release
      // function. No appeal code writes heads, baseline Safety, Identity or Errand.
      await this.repository.decide(
        {
          id: eventId,
          appeal,
          session,
          grantId,
          command,
          outcome: command.decision,
          at,
          releaseEventId,
        },
        tx,
      );
      if (releaseEventId) {
        const released = await this.punishments.releaseExact(
          {
            ...session,
            grantId,
            requestId: command.clientRequestId,
            causeId: appeal.id,
          },
          reference(appeal),
          command.reason,
          'appeal_released',
          tx,
        );
        if (released.eventId !== releaseEventId)
          throw new ApplicationError(unavailable);
      }
    }
    retainAppealCommand(session.actorId, command.clientRequestId, tx);
    return appealDecisionReceiptSchema.parse(receipt);
  }
  private async now(tx: PoolClient): Promise<string> {
    return (
      await tx.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) now",
      )
    ).rows[0]!.now.toISOString();
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recovery(token: string, request: string, management: boolean) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.repository.rate(session.actorId, 'read', tx);
      const previous = await this.repository.request(
        session.actorId,
        request,
        tx,
      );
      const action = management ? 'decide_appeal' : 'submit_appeal';
      if (!previous || previous.receipt.action !== action)
        return { state: 'not_recorded' as const };
      return {
        state: 'recorded' as const,
        receipt: this.parseReceipt(previous.receipt, action),
      };
    });
  }
  private async project(row: AppealCase, management: boolean, tx: PoolClient) {
    const punishment = await this.punishments.view(row.punishment_id, tx);
    const value = {
      appealId: row.id,
      punishment,
      text: row.text,
      submittedAt: row.submitted_at.toISOString(),
      state: row.outcome === null ? 'pending' : 'decided',
      decision:
        row.outcome === null
          ? null
          : {
              outcome: row.outcome,
              reason: row.decision_reason,
              recordedAt: row.decided_at?.toISOString(),
            },
    };
    return management
      ? appealManagementViewSchema.parse({
          ...value,
          stateVersion: row.state_version,
          canDecide: row.outcome === null,
        })
      : appealViewSchema.parse(value);
  }
  @AccountPolicyFor(
    (args) =>
      booleanAccountPolicy(
        args[2] ?? false,
        'privileged_read',
        'restricted_self_service',
      ),
    'entry',
  )
  detail(token: string, appealId: string, management = false) {
    return this.run(async (tx) => {
      if (management) await lockSafetyPolicy(tx);
      const session = await this.session(token, tx);
      const grant = management
        ? await this.admin(session.actorId, false, tx)
        : null;
      await retainAppealRead(appealId, session.actorId, grant, tx);
      await this.repository.rate(session.actorId, 'read', tx);
      const row = await this.repository.case(
        appealId,
        management ? null : session.actorId,
        tx,
      );
      if (!row) throw new ApplicationError('SAFETY_MODERATION_NOT_FOUND');
      return this.project(row, management, tx);
    });
  }
  @AccountPolicyFor(
    (args) =>
      booleanAccountPolicy(
        args[2] ?? false,
        'privileged_read',
        'restricted_self_service',
      ),
    'entry',
  )
  list(token: string, query: ModerationPageQuery, management = false) {
    return this.run(async (tx) => {
      if (management) await lockSafetyPolicy(tx);
      const session = await this.session(token, tx);
      const grant = management
        ? await this.admin(session.actorId, false, tx)
        : null;
      const seek = decodeAppealCursor(
        query.cursor,
        session.actorId,
        management,
        query.limit,
      );
      await retainAppealRead('page', session.actorId, grant, tx);
      await this.repository.rate(session.actorId, 'read', tx);
      const rows = await this.repository.page(
        management ? null : session.actorId,
        query.limit,
        seek,
        tx,
      );
      const page = rows.slice(0, query.limit),
        last = page.at(-1);
      const items = [];
      for (const row of page)
        items.push(await this.project(row, management, tx));
      return {
        items,
        nextCursor:
          rows.length > query.limit && last
            ? encodeAppealCursor(
                { at: last.submitted_at.toISOString(), id: last.id },
                session.actorId,
                management,
                query.limit,
              )
            : null,
      };
    });
  }
}
