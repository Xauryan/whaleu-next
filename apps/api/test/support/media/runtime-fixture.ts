import { MEDIA_BATCH_APPLICATION } from '../../../src/media/application-v3.js';
import { MediaBatchRepository } from '../../../src/media/batch-repository.js';
import { CommunityMediaBatchApplication } from '../../../src/community/media/application-v3.js';
import { CommunityMediaBatchPublicationProof } from '../../../src/community/media/batch-publication-proof.js';
import { MediaContentSnapshotFacade } from '../../../src/media/content-snapshot.facade.js';
import { MEDIA_UPLOAD_APPLICATION_V2 } from '../../../src/media/application-v2.js';
import { MEDIA_INGRESS_STORAGE } from '../../../src/media/ingress-storage.js';
import { MediaIngressRepository } from '../../../src/media/ingress-repository.js';
import { CommunityMediaUploadApplicationV2 } from '../../../src/community/media/application-v2.js';
import { SyntheticMediaIngressStorage } from './synthetic-ingress-storage.js';
import { APP_CONFIG } from '../../../src/config/config.js';
import { IdentityRateLimiter } from '../../../src/identity/rate-limit.js';
import {
  CONTENT_MEDIA_PROOF,
  CurrentContentMediaProof,
} from '../../../src/community/content-review/media-proof.js';
/** Explicit test DI only. Real owner gates, real Review and normal publication
 * services remain in place; only Media capability wiring is opted into this
 * disposable loopback app. No configuration/environment switch reaches it. */
import { Test } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { configureHttp } from '../../../src/http/http.js';
import { AppModule } from '../../../src/app.module.js';
import { DatabaseService } from '../../../src/database/database.js';
import { MEDIA_ATTACHMENT } from '../../../src/community/community-policy.js';
import { CommunityAccessService } from '../../../src/community/community-access.service.js';
import { CommunityRepository } from '../../../src/community/community.repository.js';
import { CommunityMediaOwner } from '../../../src/community/media/owner.js';
import { CommunityMediaAttachmentAdapter } from '../../../src/community/media/attachment-adapter.js';
import { CommunityMediaApplication } from '../../../src/community/media/application.js';
import { CommunityMediaDeliveryAuthorizer } from '../../../src/community/media/delivery-authorizer.js';
import { MediaOwnerProofRegistry } from '../../../src/media/owner-proof.js';
import { MediaPrepareScopes } from '../../../src/media/prepare-scope.js';
import { MediaIntentRepository } from '../../../src/media/intent-repository.js';
import { MediaLifecycleRepository } from '../../../src/media/lifecycle-repository.js';
import { MediaAssetRepository } from '../../../src/media/asset-repository.js';
import { MediaDeliveryService } from '../../../src/media/delivery.js';
import { MEDIA_APPLICATION } from '../../../src/media/application.js';
import { directoryRuntimeFixture } from '../directory-runtime-fixture.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import { SyntheticMediaWorker } from './synthetic-worker.js';

export async function syntheticMediaRuntimeFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  options: { readonly authRateLimit?: true } = {},
) {
  const storage = await SyntheticMediaStorage.create();
  const ingressStorage = new SyntheticMediaIngressStorage(storage);
  let config!: RuntimeConfig;
  const ordinaryApps: INestApplication[] = [];
  let owner!: CommunityMediaOwner;
  let owners!: MediaOwnerProofRegistry;
  let assets!: MediaAssetRepository;
  let batches!: MediaBatchRepository;
  const lifecycle = new MediaLifecycleRepository();
  let closeBase: (() => Promise<void>) | undefined;
  try {
    const base = await directoryRuntimeFixture(undefined, {
      createApp: async (runtimeConfig) => {
        config = runtimeConfig;
        const builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        })
          .overrideProvider(MediaContentSnapshotFacade)
          .useClass(MediaContentSnapshotFacade)
          .overrideProvider(CONTENT_MEDIA_PROOF)
          .useClass(CurrentContentMediaProof)
          .overrideProvider(MEDIA_ATTACHMENT)
          .useFactory({
            inject: [CommunityAccessService, CommunityRepository],
            factory: (
              access: CommunityAccessService,
              community: CommunityRepository,
            ) => {
              owner = new CommunityMediaOwner(access, community);
              owners = new MediaOwnerProofRegistry([owner]);
              const scopes = new MediaPrepareScopes(owner);
              batches = new MediaBatchRepository(
                scopes,
                new MediaIntentRepository(scopes),
                lifecycle,
                {
                  readyOwned: (actor, intentId, tx) =>
                    assets.readyOwned(actor, intentId, tx),
                },
                new CommunityMediaBatchPublicationProof(),
              );
              assets = new MediaAssetRepository(owners, batches);
              return new CommunityMediaAttachmentAdapter(assets, owner, owners);
            },
          })
          .overrideProvider(MEDIA_INGRESS_STORAGE)
          .useValue(ingressStorage)
          .overrideProvider(MEDIA_UPLOAD_APPLICATION_V2)
          .useFactory({
            inject: [DatabaseService, CommunityAccessService, MEDIA_ATTACHMENT],
            factory: (
              database: DatabaseService,
              access: CommunityAccessService,
              _attachment: CommunityMediaAttachmentAdapter,
            ) => {
              const scopes = new MediaPrepareScopes(owner);
              return new CommunityMediaUploadApplicationV2(
                database,
                access,
                scopes,
                new MediaIntentRepository(scopes),
                lifecycle,
                assets,
                new MediaIngressRepository(ingressStorage),
              );
            },
          })
          .overrideProvider(MEDIA_BATCH_APPLICATION)
          .useFactory({
            inject: [DatabaseService, CommunityAccessService, MEDIA_ATTACHMENT],
            factory: (
              database: DatabaseService,
              access: CommunityAccessService,
              _attachment: CommunityMediaAttachmentAdapter,
            ) =>
              new CommunityMediaBatchApplication(
                database,
                access,
                new MediaPrepareScopes(owner),
                lifecycle,
                batches,
                new MediaIngressRepository(ingressStorage, 3),
              ),
          })
          .overrideProvider(MEDIA_APPLICATION)
          .useFactory({
            inject: [DatabaseService, CommunityAccessService, MEDIA_ATTACHMENT],
            factory: (
              database: DatabaseService,
              access: CommunityAccessService,
              _attachment: CommunityMediaAttachmentAdapter,
            ) => {
              const scopes = new MediaPrepareScopes(owner);
              const delivery = new MediaDeliveryService(
                database,
                new CommunityMediaDeliveryAuthorizer(access, assets, owners),
                storage,
              );
              return new CommunityMediaApplication(
                database,
                access,
                scopes,
                new MediaIntentRepository(scopes),
                lifecycle,
                assets,
                delivery,
              );
            },
          });
        if (options.authRateLimit) {
          // Explicit disposable-test opt-in only. Keep the REAL limiter and its
          // database buckets; provider login remains unconfigured/unavailable.
          // This public fixture constant is not a production credential.
          builder.overrideProvider(IdentityRateLimiter).useFactory({
            inject: [APP_CONFIG, DatabaseService],
            factory: (authConfig: RuntimeConfig, database: DatabaseService) =>
              new IdentityRateLimiter(
                { ...authConfig, AUTH_RATE_LIMIT_KEY: '02'.repeat(32) },
                database,
              ),
          });
        }
        const module = await builder.compile();
        return module.createNestApplication({ logger: false });
      },
    });
    closeBase = base.close;
    return {
      ...base,
      storage,
      ingressStorage,
      startOrdinaryRuntime: async () => {
        // Same disposable database, genuinely ordinary AppModule, no override.
        const app = await NestFactory.create(AppModule.register(config), {
          logger: false,
        });
        ordinaryApps.push(app);
        configureHttp(app);
        await app.listen(0, '127.0.0.1');
        return app;
      },
      worker: new SyntheticMediaWorker(base.pool, storage, fixtures),
      close: async () => {
        try {
          for (const app of ordinaryApps) await app.close();
          await base.close();
        } finally {
          await storage.dispose();
        }
      },
    };
  } catch (error) {
    // Constructor/registry failures after the app starts must not strand its
    // migration lease, schemas, listening server or pool in a failed test.
    try {
      await closeBase?.();
    } finally {
      await storage.dispose();
    }
    throw error;
  }
}
