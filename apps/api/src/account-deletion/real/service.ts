import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG, type RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken, requireToken } from '../../identity/tokens.js';
import { ApplicationError } from '../../http/application-error.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import {
  prepareDeletionSchema,
  deletionStatusSchema,
  acceptDeletionSchema,
  cancelDeletionSchema,
  type PreparationIntent,
  type DeletionStatusCommand,
  type PrepareDeletion,
} from './contracts.js';
import {
  preparationIntentHash,
  preparationRecoveryHash,
  equalRecoveryHash,
} from './recovery.js';
import {
  preparationRow,
  preparationReceipt,
  retainPreparation,
  type PreparationRow,
} from './preparation-repository.js';
import { retainPreparationSchema } from './qualification.js';

const unavailable = () => new ApplicationError('REAL_DELETION_UNAVAILABLE');
const missing = () => new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
function intent(input: PrepareDeletion): PreparationIntent {
  return {
    version: input.version,
    intentId: input.intentId,
    expectedGeneration: input.expectedGeneration,
    consent: input.consent,
  };
}
function rowIntent(row: PreparationRow): PreparationIntent {
  return {
    version: 1,
    intentId: row.intent_id,
    expectedGeneration: row.base_generation,
    consent: row.consent,
  };
}
@Injectable()
export class RealDeletionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async transaction<T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          // UUID-uniqueness waits and row fences are bounded too; this never raises
          // a caller's statement budget or leaves a session-level setting behind.
          await tx.query("SELECT set_config('lock_timeout', '1ms', true)");
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['55P03', '40P01', '40001', '57014'].includes(String(error.code))
      )
        throw unavailable();
      throw error;
    }
  }
  private enabled(): string {
    if (
      this.config.REAL_ACCOUNT_DELETION_ENTRY !== 'prepare_only' ||
      !this.config.WECHAT_APP_ID ||
      !this.config.WECHAT_APP_SECRET ||
      !this.config.AUTH_RATE_LIMIT_KEY
    )
      throw unavailable();
    return this.config.WECHAT_APP_ID;
  }
  private async scope(
    tx: PoolClient,
    command: DeletionStatusCommand,
  ): Promise<PreparationRow> {
    await retainPreparationSchema(tx);
    const row = await preparationRow(tx, command.intentId);
    if (
      !row ||
      !equalRecoveryHash(
        row.recovery_hash,
        preparationRecoveryHash(
          row.account_id,
          rowIntent(row),
          command.recoverySecret,
        ),
      )
    )
      throw missing();
    await tx.query(
      'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
      [row.account_id],
    );
    const current = await preparationRow(tx, command.intentId);
    if (
      !current ||
      current.intent_hash !== row.intent_hash ||
      current.recovery_hash !== row.recovery_hash
    )
      throw missing();
    await retainPreparation(tx, current);
    return current;
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  prepare(access: string, raw: unknown) {
    const app = this.enabled(),
      command = prepareDeletionSchema.parse(raw),
      value = intent(command);
    requireToken(access, 'access');
    return this.transaction(async (tx) => {
      await retainPreparationSchema(tx);
      // Discovery is not authority. Lock account UPDATE from outset, before normal
      // Identity installs its SHARE session/token proof: no lock upgrade cycle.
      const target = (
        await tx.query<{ account_id: string }>(
          `SELECT s.account_id FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1`,
          [hashToken(access)],
        )
      ).rows[0];
      if (!target) throw missing();
      await tx.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
        [target.account_id],
      );
      const session = await this.identity.session(access, tx);
      if (session.accountId !== target.account_id) throw missing();
      const digest = preparationIntentHash(value),
        recovery = preparationRecoveryHash(
          session.accountId,
          value,
          command.recoverySecret,
        );
      const old = await preparationRow(tx, command.intentId);
      if (old) {
        if (old.account_id !== session.accountId) throw missing();
        if (
          old.intent_hash !== digest ||
          !equalRecoveryHash(old.recovery_hash, recovery)
        )
          throw new ApplicationError('REAL_DELETION_INTENT_CONFLICT');
        await retainPreparation(tx, old);
        return preparationReceipt(old);
      }
      const state = (
        await tx.query<{ generation: string; active: number }>(
          `SELECT lifecycle_generation::text generation,(SELECT count(*)::integer FROM(SELECT 1 FROM whaleu_real_deletion.preparations WHERE account_id=$1 AND expires_at>clock_timestamp() LIMIT 4) limited) active FROM whaleu_identity.accounts WHERE id=$1`,
          [session.accountId],
        )
      ).rows[0];
      if (!state || state.generation !== command.expectedGeneration)
        throw missing();
      if (state.active >= 4) throw unavailable();
      // Fixed account-local cleanup budget. No global scan and no unexpired erase.
      await tx.query(
        `DELETE FROM whaleu_real_deletion.preparations WHERE intent_id IN(SELECT intent_id FROM whaleu_real_deletion.preparations WHERE account_id=$1 AND expires_at<=clock_timestamp() ORDER BY expires_at,intent_id LIMIT 4)`,
        [session.accountId],
      );
      await tx.query(
        `INSERT INTO whaleu_real_deletion.preparations(intent_id,account_id,session_id,app_id,base_generation,next_generation,intent_hash,recovery_hash,consent,created_at,expires_at,created_transaction)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp(),pg_current_xact_id())`,
        [
          command.intentId,
          session.accountId,
          session.sessionId,
          app,
          command.expectedGeneration,
          String(BigInt(command.expectedGeneration) + 1n),
          digest,
          recovery,
          command.consent,
        ],
      );
      const created = await preparationRow(tx, command.intentId);
      if (!created) throw unavailable();
      await retainPreparation(tx, created);
      return preparationReceipt(created);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  status(raw: unknown) {
    this.enabled();
    const command = deletionStatusSchema.parse(raw);
    return this.transaction(async (tx) =>
      preparationReceipt(await this.scope(tx, command)),
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async accept(raw: unknown): Promise<never> {
    this.enabled();
    acceptDeletionSchema.parse(raw);
    // Neither env nor a caller-supplied evidence flag can activate real acceptance.
    // Owner coverage, reader retirement, dedicated accept proof and cooling recovery
    // must land together. In particular, do not consume a provider code here.
    throw unavailable();
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async cancel(raw: unknown): Promise<never> {
    this.enabled();
    cancelDeletionSchema.parse(raw);
    // A not-yet-accepted preparation is not a successful cancellation of an in-flight
    // acceptance. Never return a fabricated cancelled receipt.
    throw unavailable();
  }
}
