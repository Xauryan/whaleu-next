import type { PoolClient } from 'pg';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type { DatabaseService } from '../../database/database.js';
import type {
  MediaApplication,
  MediaIntentStatus,
} from '../../media/application.js';
import { mediaIntentStatusSchema } from '../../media/contracts.js';
import type { MediaVariantName } from '../../media/contracts.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type { MediaPrepareScopes } from '../../media/prepare-scope.js';
import type {
  MediaIntentRepository,
  MediaIntentReceipt,
} from '../../media/intent-repository.js';
import type { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import type { MediaAssetRepository } from '../../media/asset-repository.js';
import type { MediaDeliveryService } from '../../media/delivery.js';

export class UnavailableCommunityMediaApplication implements MediaApplication {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
  ) {}
  private unavailable(token: string): Promise<never> {
    return this.database.transaction(
      async (tx) => {
        await this.access.actor(token, tx);
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      },
      { isolationLevel: 'read committed' },
    );
  }
  prepare(token: string): Promise<never> {
    return this.unavailable(token);
  }
  status(token: string): Promise<never> {
    return this.unavailable(token);
  }
  finalize(token: string): Promise<never> {
    return this.unavailable(token);
  }
  cancel(token: string): Promise<never> {
    return this.unavailable(token);
  }
  open(token: string): Promise<never> {
    return this.unavailable(token);
  }
}
/** Explicit injected implementation; normal AppModule has no storage or issuer. */
export class CommunityMediaApplication implements MediaApplication {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
    private readonly scopes: MediaPrepareScopes,
    private readonly intents: MediaIntentRepository,
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly assets: MediaAssetRepository,
    private readonly delivery: MediaDeliveryService,
  ) {}
  prepare(token: string, input: unknown): Promise<MediaIntentStatus> {
    return this.authorized(token, async (actor, tx) =>
      this.encode(
        await this.intents.prepare(
          await this.scopes.authorize(actor, input, tx),
          tx,
        ),
      ),
    );
  }
  status(token: string, id: string): Promise<MediaIntentStatus> {
    return this.authorized(token, async (actor, tx) => {
      const receipt = await this.intents.status(actor, id, tx);
      const ready = await this.assets.readyOwned(actor, id, tx);
      return ready
        ? mediaIntentStatusSchema.parse({
            ...receipt,
            status: 'ready',
            assetId: ready,
            reasonCode: null,
            retryable: false,
          })
        : this.encode(receipt);
    });
  }
  finalize(token: string, id: string): Promise<MediaIntentStatus> {
    return this.authorized(token, async (actor, tx) => {
      const receipt = await this.lifecycle.finalize(actor, id, tx);
      const ready = await this.assets.readyOwned(actor, id, tx);
      return ready
        ? mediaIntentStatusSchema.parse({
            ...receipt,
            status: 'ready',
            assetId: ready,
            reasonCode: null,
            retryable: false,
          })
        : this.encode(receipt);
    });
  }
  cancel(token: string, id: string): Promise<void> {
    return this.authorized(token, async (actor, tx) => {
      await this.lifecycle.cancel(actor, id, tx);
    });
  }
  open(token: string, id: string, variant: MediaVariantName, range?: string) {
    return this.delivery.open(token, id, variant, range);
  }
  private authorized<T>(
    token: string,
    run: (actor: string, tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        return run(await this.access.actor(token, tx), tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  private encode(receipt: MediaIntentReceipt): MediaIntentStatus {
    const reason =
      receipt.status === 'rejected'
        ? 'MEDIA_REJECTED'
        : receipt.status === 'expired'
          ? 'MEDIA_EXPIRED'
          : receipt.status === 'cancelled'
            ? 'MEDIA_CANCELLED'
            : receipt.status === 'unavailable'
              ? 'MEDIA_UNAVAILABLE'
              : null;
    return mediaIntentStatusSchema.parse({
      ...receipt,
      reasonCode: reason,
      retryable: ['prepared', 'processing', 'unavailable'].includes(
        receipt.status,
      ),
    });
  }
}
