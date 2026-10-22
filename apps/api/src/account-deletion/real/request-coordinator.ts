import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG, type RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../../identity/contracts.js';
import { bearerToken, hashToken } from '../../identity/tokens.js';
import {
  parseDigestKeyRing,
  ProviderIdentityDigests,
} from '../../identity/registration/digests.js';
import {
  acceptDeletionSchema,
  deletionStatusSchema,
  cancelDeletionSchema,
  type RealDeletionReceipt,
} from './contracts.js';
import { RealRequestAdmission } from './admission.js';
import { retainPreparation } from './preparation-repository.js';
import { RequestProviderReauthentication } from './reauthentication.js';
import {
  acceptedRequestReceipt,
  beginRealReauthentication,
  commitRealAcceptance,
  cancelRealRequest,
  requestStatusReceipt,
  fenceRequestProvider,
  authenticatePreparationCapability,
} from './request-repository.js';

const unavailable = () => new ApplicationError('REAL_DELETION_UNAVAILABLE');
/** Real HTTP orchestration, sharing the actual Identity server adapter. This is
 * not activation: the installed production admission owner is unavailable until
 * whole-owner erasure, reader retirement and lost-capability recovery are real.
 * No ordinary session is created, no provider code is stored or sent inside TX. */
@Injectable()
export class RealRequestCoordinator {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(RealRequestAdmission)
    private readonly admission: RealRequestAdmission,
  ) {}
  private async transaction<T>(
    work: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          await tx.query("SELECT set_config('lock_timeout', '1ms', true)");
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['55P03', '40P01', '40001', '57014', '42501'].includes(
          String(error.code),
        )
      )
        throw unavailable();
      throw error;
    }
  }
  private async exists(tx: PoolClient, id: string): Promise<boolean> {
    // Existing prepare-only roles need just requests.id SELECT for discovery;
    // no admission namespace or complete request read for an unaccepted intent.
    return (
      (
        await tx.query(
          'SELECT id FROM whaleu_real_deletion.requests WHERE id=$1',
          [id],
        )
      ).rowCount === 1
    );
  }
  async status(raw: unknown): Promise<RealDeletionReceipt | null> {
    const command = Object.freeze(deletionStatusSchema.parse(raw));
    return this.transaction(async (tx) => {
      await authenticatePreparationCapability(tx, command);
      if (!(await this.exists(tx, command.intentId))) return null;
      return requestStatusReceipt(tx, command);
    });
  }
  async accept(
    raw: unknown,
    authorization: unknown,
  ): Promise<RealDeletionReceipt> {
    const command = Object.freeze(acceptDeletionSchema.parse(raw));
    // Lost accepted response comes before mode, bearer or another provider code.
    // This grants only the exact intent's stored minimum receipt, never a bearer.
    const replay = await this.transaction(async (tx) => {
      const prepared = await authenticatePreparationCapability(tx, command);
      if (await this.exists(tx, command.intentId))
        return acceptedRequestReceipt(tx, command);
      // Only not-yet-accepted preparations need current lifecycle and expiry.
      // Invalid capabilities never reach the request-only privileges above.
      await retainPreparation(tx, prepared);
      return null;
    });
    if (replay) return replay;
    if (
      this.config.REAL_ACCOUNT_DELETION_ENTRY !== 'prepare_only' ||
      this.config.REAL_ACCOUNT_DELETION_NEW_REQUESTS !== 'qualified_owner' ||
      !this.config.IDENTITY_DELETION_DIGEST_KEYRING
    )
      throw unavailable();
    const access = bearerToken(authorization);
    const reauthentication = new RequestProviderReauthentication(
      this.provider,
      new ProviderIdentityDigests(
        parseDigestKeyRing(this.config.IDENTITY_DELETION_DIGEST_KEYRING),
      ),
    );
    const scope = await this.transaction(async (tx) => {
      // Normal session proof belongs only to this first transaction. The second
      // uses the dedicated exact+1 proof; never weaken ordinary active-session.
      const attempt = await beginRealReauthentication(
        tx,
        command,
        access,
        this.identity,
      );
      await this.admission.inspect(tx);
      return attempt;
    });
    const verified = await reauthentication.exchange(command.code, scope);
    return this.transaction(async (tx) => {
      // Concurrent accepted retry must not demand another admission receipt.
      const replay = await acceptedRequestReceipt(tx, command);
      if (replay) return replay;
      await fenceRequestProvider(tx, scope);
      await this.admission.admit(tx, scope);
      return commitRealAcceptance(
        tx,
        { command, accessHash: hashToken(access), scope, verified },
        reauthentication,
      );
    });
  }
  cancel(raw: unknown): Promise<RealDeletionReceipt> {
    const command = Object.freeze(cancelDeletionSchema.parse(raw));
    // Disabling NEW requests must never strand a cooling account. Exact command
    // replay and SQL cooling deadline are enforced by the real repository.
    return this.transaction((tx) => cancelRealRequest(tx, command));
  }
}
