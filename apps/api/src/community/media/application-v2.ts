import {
  mediaStatusV2Schema,
  mediaCancelV2Schema,
} from '../../media/contracts-v2.js';
import type { PoolClient } from 'pg';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import type { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type {
  MediaUploadApplicationV2,
  MediaIngressClaim,
} from '../../media/application-v2.js';
import type { MediaStatusV2 } from '../../media/contracts-v2.js';
import {
  mediaRequestHash,
  prepareMediaV2Schema,
} from '../../media/contracts-v2.js';
import type { MediaPrepareScopes } from '../../media/prepare-scope.js';
import type { MediaIntentRepository } from '../../media/intent-repository.js';
import type { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import type { MediaAssetRepository } from '../../media/asset-repository.js';
import { MediaRecoveryRepository } from '../../media/recovery-repository.js';
import type { MediaIngressRepository } from '../../media/ingress-repository.js';
import type { StoredObjectMeasurement } from '../../media/storage-port.js';

/** Normal runtime authenticates before rejecting, with no provider/issuer or IO. */
export class UnavailableCommunityMediaUploadApplicationV2 implements MediaUploadApplicationV2 {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
  ) {}
  private unavailable(token: string): Promise<never> {
    return this.database.transaction(
      async (tx) => {
        await this.access.mediaSession(token, tx);
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      },
      { isolationLevel: 'read committed' },
    );
  }
  prepareV2(token: string): Promise<never> {
    return this.unavailable(token);
  }
  recoverRequest(token: string): Promise<never> {
    return this.unavailable(token);
  }
  cancelRequest(token: string): Promise<never> {
    return this.unavailable(token);
  }
  statusV2(token: string): Promise<never> {
    return this.unavailable(token);
  }
  finalizeV2(token: string): Promise<never> {
    return this.unavailable(token);
  }
  cancelV2(token: string): Promise<never> {
    return this.unavailable(token);
  }
  grant(token: string): Promise<never> {
    return this.unavailable(token);
  }
  admit(token: string): Promise<never> {
    return this.unavailable(token);
  }
  observe(token: string): Promise<never> {
    return this.unavailable(token);
  }
  retire(): Promise<never> {
    return Promise.reject(new ApplicationError('MEDIA_UNAVAILABLE'));
  }
}
/** Test-DI-only v2 application. No AppModule feature flag can construct this. */
export class CommunityMediaUploadApplicationV2 implements MediaUploadApplicationV2 {
  private readonly recovery: MediaRecoveryRepository;
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
    private readonly scopes: MediaPrepareScopes,
    private readonly intents: MediaIntentRepository,
    private readonly lifecycle: MediaLifecycleRepository,
    assets: MediaAssetRepository,
    private readonly ingress: MediaIngressRepository,
  ) {
    this.recovery = new MediaRecoveryRepository(lifecycle, assets);
  }
  prepareV2(token: string, raw: unknown): Promise<MediaStatusV2> {
    return this.authorized(token, async (session, tx) => {
      const input = prepareMediaV2Schema.parse(raw);
      const hash = mediaRequestHash(session.accountId, input);
      // Recovery bypasses current publication authority only for an immutable
      // existing original request. A first allocation still needs owner proof.
      const previous = await this.recovery.recover(
        session.accountId,
        input.clientRequestId,
        tx,
      );
      if (previous.state !== 'not_recorded') {
        if (previous.requestHash !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (!previous.status)
          throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
        return previous.status;
      }
      const receipt = await this.intents.prepare(
        await this.scopes.authorizeV2(session.accountId, input, tx),
        tx,
      );
      return this.recovery
        .status(session.accountId, receipt.intentId, tx)
        .then((value) => mediaStatusV2Schema.parse(value));
    });
  }
  recoverRequest(token: string, id: string) {
    return this.authorized(
      token,
      (s, tx) => this.recovery.recover(s.accountId, id, tx),
      false,
    );
  }
  cancelRequest(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.recovery.cancelRequest(s.accountId, id, input, tx),
    );
  }
  statusV2(token: string, id: string) {
    return this.authorized(
      token,
      (s, tx) =>
        this.recovery
          .status(s.accountId, id, tx)
          .then((value) => mediaStatusV2Schema.parse(value)),
      false,
    );
  }
  cancelV2(token: string, id: string) {
    return this.authorized(token, (s, tx) =>
      this.recovery
        .cancel(s.accountId, id, tx)
        .then((value) => mediaCancelV2Schema.parse(value)),
    );
  }
  async finalizeV2(token: string, id: string): Promise<MediaStatusV2> {
    // Separate receipt-only snapshot keeps historical access independent of a
    // lost draft permission and avoids taking owner locks after intent locks.
    const status = await this.statusV2(token, id);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        status.status,
      )
    )
      return status;
    return this.authorized(token, async (session, tx) => {
      const input = await this.ingress.originalInput(session.accountId, id, tx);
      await this.scopes.authorizeV2(session.accountId, input, tx);
      await this.lifecycle.finalize(session.accountId, id, tx);
      return this.recovery
        .status(session.accountId, id, tx)
        .then((value) => mediaStatusV2Schema.parse(value));
    });
  }
  async grant(token: string, id: string) {
    const result = await this.authorized(token, async (s, tx) =>
      this.ingress.grant(
        s,
        id,
        await this.scopes.authorizeV2(
          s.accountId,
          await this.ingress.originalInput(s.accountId, id, tx),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    return result;
  }
  admit(token: string, id: string, grantId: string) {
    return this.authorized(token, async (s, tx) =>
      this.ingress.admit(
        s,
        id,
        grantId,
        await this.scopes.authorizeV2(
          s.accountId,
          await this.ingress.originalInput(s.accountId, id, tx),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ) {
    return this.authorized(token, async (s, tx) =>
      this.ingress.observe(
        s,
        claim,
        measurement,
        await this.scopes.authorizeV2(
          s.accountId,
          await this.ingress.originalInput(s.accountId, claim.intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
  }
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes = 0,
  ): Promise<void> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        if (await this.ingress.retire(claim, proof, transferredBytes, tx))
          await this.recovery.cancel(claim.actorAccountId, claim.intentId, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  private authorized<T>(
    token: string,
    run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        return run(await this.access.mediaSession(token, tx), tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
