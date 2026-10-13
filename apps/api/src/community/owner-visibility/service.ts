import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { retainOwnerRestoreCapability } from './capability.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { ApplicationError } from '../../http/application-error.js';
import { SafetyRepository } from '../../safety/repository.js';
import { safetyCountProofOwner } from '../../safety/count-epochs.js';
import { requiredOwnerEpoch } from '../../database/required-owner-proof.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { canonicalJson } from '../content-review/contracts.js';
import { OwnerVisibilityRepository } from './repository.js';
import { retainOwnerVisibilityProof } from './proof.js';
import type {
  OwnerVisibilityCommand,
  OwnerVisibilityManagement,
  OwnerVisibilityReceipt,
} from './contracts.js';
const requireRestoreSafetyEpoch = requiredOwnerEpoch(
  safetyCountProofOwner,
  'SAFETY_UNAVAILABLE',
);
export const ownerVisibilityIntentHash = (
  actor: string,
  command: OwnerVisibilityCommand,
): string =>
  createHash('sha256')
    .update(
      'whaleu:post-owner-visibility:v1\n' + canonicalJson({ actor, command }),
    )
    .digest('hex');
@Injectable()
export class OwnerVisibilityService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(OwnerVisibilityRepository)
    private readonly repository: OwnerVisibilityRepository,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.repository.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'post_owner_visibility_causal'))
        )
          throw new ApplicationError('POST_OWNER_VISIBILITY_UNAVAILABLE');
        throw error;
      });
  }
  @AccountPolicy('browse', 'entry')
  async management(
    token: string,
    postId: string,
  ): Promise<OwnerVisibilityManagement> {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx);
      const target = await this.repository.target(
        session.accountId,
        postId,
        tx,
      );
      const state = await this.repository.state(postId, tx);
      await retainOwnerVisibilityProof(
        {
          actor: session.accountId,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId,
        },
        tx,
      );
      const result = {
        postId,
        ownerHidden: state.owner_hidden,
        version: state.version,
        canChange: target.deleted_at === null && state.version < 2147483647,
      };
      await retainOwnerRestoreCapability(session.accountId, result, tx);
      return result;
    });
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  async command(
    token: string,
    command: OwnerVisibilityCommand,
    cancel = false,
  ): Promise<OwnerVisibilityReceipt> {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx),
        actor = session.accountId;
      const intentHash = ownerVisibilityIntentHash(actor, command);
      await this.repository.lockRequest(actor, command.clientRequestId, tx);
      const previous = await this.repository.receipt(
        actor,
        command.clientRequestId,
        tx,
      );
      if (previous) {
        if (previous.intent_hash !== intentHash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await retainOwnerVisibilityProof(
          {
            actor,
            sessionId: session.sessionId,
            tokenHash: hashToken(token),
            postId: null,
          },
          tx,
        );
        return previous.receipt;
      }
      if (!cancel)
        await enforceAccountPunishment(
          actor,
          command.ownerHidden ? 'protective_cleanup' : 'interaction',
          tx,
        );
      const target = await this.repository.target(
        actor,
        command.postId,
        tx,
        true,
      );
      const state = await this.repository.state(command.postId, tx);
      const base = {
        requestId: command.clientRequestId,
        postId: command.postId,
        ownerHidden: command.ownerHidden,
        expectedVersion: command.expectedVersion,
      };
      let receipt: OwnerVisibilityReceipt;
      if (cancel)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'POST_OWNER_VISIBILITY_CANCELLED',
        };
      else if (target.deleted_at)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'POST_OWNER_VISIBILITY_UNAVAILABLE',
        };
      else if (state.version !== command.expectedVersion)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'POST_OWNER_VISIBILITY_STALE',
        };
      else {
        if (!command.ownerHidden) {
          // Restoring discoverability is an action. It must retain current
          // Safety coverage, without acquiring new publication/phone authority.
          await requireRestoreSafetyEpoch(tx);
          await this.safety.restriction(actor, tx, 'interaction');
          const safety = (
            await tx.query<{ until: string | null }>(
              'SELECT valid_until::text AS until FROM whaleu_safety.account_heads WHERE account_id=$1',
              [actor],
            )
          ).rows[0];
          if (!safety) throw new ApplicationError('SAFETY_UNAVAILABLE');
          if (safety.until)
            registerTransactionExactDeadline(
              tx,
              safety.until,
              'SAFETY_UNAVAILABLE',
            );
        }
        const instant = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]!;
        receipt = {
          ...base,
          outcome: 'applied',
          version: state.version + 1,
          changed: state.owner_hidden !== command.ownerHidden,
          recordedAt: instant.now.toISOString(),
        };
      }
      // The immutable terminal receipt and exact new state commit together. SQL
      // guards reject missing/zero-row writes, wrong actors and forged receipts.
      await this.repository.record(
        actor,
        session.sessionId,
        intentHash,
        command,
        receipt,
        tx,
      );
      if (receipt.outcome === 'applied')
        await this.repository.apply(actor, command, receipt.recordedAt, tx);
      await retainOwnerVisibilityProof(
        {
          actor,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId: command.postId,
        },
        tx,
      );
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async receipt(
    token: string,
    requestId: string,
  ): Promise<OwnerVisibilityReceipt> {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx);
      const row = await this.repository.receipt(
        session.accountId,
        requestId,
        tx,
      );
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      await retainOwnerVisibilityProof(
        {
          actor: session.accountId,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId: null,
        },
        tx,
      );
      return row.receipt;
    });
  }
}
