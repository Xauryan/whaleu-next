import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { hashToken } from '../identity/tokens.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { enforceAccountPunishment } from '../safety/account-moderation/policy.js';
import { PersonalTimetableRepository } from './repository.js';
import {
  timetableCommandSchema,
  timetableDetailSchema,
  timetableIdSchema,
  timetableReceipt,
} from './contracts.js';
import type {
  TimetableCommand,
  TimetableReceipt,
  TimetableRecovery,
} from './contracts.js';
@Injectable()
export class PersonalTimetableService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PersonalTimetableRepository)
    private readonly repository: PersonalTimetableRepository,
  ) {}
  private async transaction<T>(
    token: string,
    work: (account: string, tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.identity.session(token, tx);
          // Identity already locks the canonical account, session and presented token.
          // Keep SQL precision across owner-lock waits and final deferred constraints.
          const row = (
            await tx.query<{ until: string }>(
              `SELECT least(t.expires_at,s.absolute_expires_at)::text AS until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3`,
              [hashToken(token), session.sessionId, session.accountId],
            )
          ).rows[0];
          if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
          registerTransactionExactDeadline(
            tx,
            row.until,
            'ACCESS_TOKEN_EXPIRED',
          );
          await this.repository.lock(session.accountId, tx);
          return work(session.accountId, tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ApplicationError('TIMETABLE_UNAVAILABLE');
    }
  }
  private command(raw: TimetableCommand): TimetableCommand {
    const parsed = timetableCommandSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Invalid request');
    return parsed.data;
  }
  @AccountPolicy('private_self_service', 'entry')
  list(token: string) {
    return this.transaction(token, async (account, tx) => {
      await enforceAccountPunishment(account, 'private_self_service', tx);
      return { terms: await this.repository.terms(account, tx) };
    });
  }
  @AccountPolicy('private_self_service', 'entry')
  detail(token: string, termId: string) {
    if (!timetableIdSchema.safeParse(termId).success)
      throw new BadRequestException('Invalid request');
    return this.transaction(token, async (account, tx) => {
      await enforceAccountPunishment(account, 'private_self_service', tx);
      const term = await this.repository.term(account, termId, tx);
      if (!term) throw new ApplicationError('TIMETABLE_NOT_FOUND');
      return timetableDetailSchema.parse({
        term,
        entries: await this.repository.entries(account, termId, tx),
      });
    });
  }
  @AccountPolicy('private_self_service', 'owner_after_recovery')
  execute(token: string, raw: TimetableCommand): Promise<TimetableReceipt> {
    const command = this.command(raw);
    return this.transaction(token, async (account, tx) => {
      const previous = await this.repository.previous(account, command, tx);
      if (previous) return previous;
      try {
        await enforceAccountPunishment(account, 'private_self_service', tx);
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          (error.code !== 'SAFETY_ACCESS_SUSPENDED' &&
            error.code !== 'SAFETY_ACTION_RESTRICTED')
        )
          throw error;
        // Do not read or expose current private data on a suspended write.
        return this.repository.save(
          account,
          timetableReceipt(command, 'rejected', null, error.code),
          tx,
        );
      }
      return this.repository.save(
        account,
        await this.repository.apply(account, command, tx),
        tx,
      );
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recover(token: string, requestId: string): Promise<TimetableRecovery> {
    if (!timetableIdSchema.safeParse(requestId).success)
      throw new BadRequestException('Invalid request');
    return this.transaction(token, async (account, tx) => {
      const receipt = await this.repository.recover(account, requestId, tx);
      return receipt
        ? { status: 'settled', receipt }
        : { status: 'unknown', requestId };
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(
    token: string,
    requestId: string,
    raw: TimetableCommand,
  ): Promise<TimetableReceipt> {
    const command = this.command(raw);
    if (requestId !== command.requestId)
      throw new ApplicationError('TIMETABLE_REQUEST_CONFLICT');
    return this.transaction(token, async (account, tx) => {
      const previous = await this.repository.previous(account, command, tx);
      if (previous) return previous;
      // Seals only this exact unapplied request; never changes or reads schedule data.
      return this.repository.save(
        account,
        timetableReceipt(command, 'cancelled', null),
        tx,
      );
    });
  }
}
