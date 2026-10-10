/** TEST ONLY: explicit, separate API/processing process over the parent-owned
 * disposable database and capability-checked private synthetic object root.
 * No migrations, schema cleanup, production wiring or real provider calls. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from '../../../src/app.module.js';
import { loadConfig } from '../../../src/config/config.js';
import {
  DatabaseService,
  poolOptions,
} from '../../../src/database/database.js';
import { configureHttp } from '../../../src/http/http.js';
import { MEDIA_ATTACHMENT } from '../../../src/community/community-policy.js';
import { CommunityAccessService } from '../../../src/community/community-access.service.js';
import { CommunityRepository } from '../../../src/community/community.repository.js';
import { CommunityMediaOwner } from '../../../src/community/media/owner.js';
import { CommunityMediaAttachmentAdapter } from '../../../src/community/media/attachment-adapter.js';
import { CommunityMediaBatchApplication } from '../../../src/community/media/application-v3.js';
import { CommunityMediaBatchPublicationProof } from '../../../src/community/media/batch-publication-proof.js';
import { MediaOwnerProofRegistry } from '../../../src/media/owner-proof.js';
import { MediaPrepareScopes } from '../../../src/media/prepare-scope.js';
import { MediaIntentRepository } from '../../../src/media/intent-repository.js';
import { MediaLifecycleRepository } from '../../../src/media/lifecycle-repository.js';
import { MediaAssetRepository } from '../../../src/media/asset-repository.js';
import { MediaBatchRepository } from '../../../src/media/batch-repository.js';
import { MediaIngressRepository } from '../../../src/media/ingress-repository.js';
import { MEDIA_DISCUSSION_BATCH_APPLICATION } from '../../../src/media/application-v4.js';
import { MEDIA_INGRESS_STORAGE } from '../../../src/media/ingress-storage.js';
import { MediaContentSnapshotFacade } from '../../../src/media/content-snapshot.facade.js';
import {
  CONTENT_MEDIA_PROOF,
  CurrentContentMediaProof,
} from '../../../src/community/content-review/media-proof.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import type { SyntheticProcessRoot } from './synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './synthetic-ingress-storage.js';
import { SyntheticMediaWorker } from './synthetic-worker.js';
import type { RegisteredMediaFixture } from './synthetic-worker.js';

type Stage = 'seal' | 'process' | 'review';
type Cut =
  | 'multipart-partial'
  | 'multipart-observed'
  | 'worker-output'
  | 'review-ready'
  | 'publication-committed'
  | null;
interface Start {
  command: 'start';
  mode: 'api' | 'worker';
  databaseUrl: string;
  storageRoot: SyntheticProcessRoot;
  fixtures: readonly RegisteredMediaFixture[];
  stages?: readonly Stage[];
  cut: Cut;
}
const send = (message: Record<string, unknown>): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC_REQUIRED'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
async function park(
  point: string,
  metadata: Record<string, unknown> = {},
): Promise<never> {
  await send({ event: 'checkpoint', point, ...metadata });
  return new Promise<never>(() => {});
}
let app: INestApplication | undefined,
  pool: Pool | undefined,
  storage: SyntheticMediaStorage | undefined;
async function start(message: Start): Promise<void> {
  assert.equal(message.command, 'start');
  assert.ok(message.mode === 'api' || message.mode === 'worker');
  const database = new URL(message.databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.ok(
    [
      null,
      'multipart-partial',
      'multipart-observed',
      'worker-output',
      'review-ready',
      'publication-committed',
    ].includes(message.cut),
  );
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: database.toString(),
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '4',
    PG_STATEMENT_TIMEOUT_MS: '15000',
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
  });
  storage = await SyntheticMediaStorage.reopenProcessRoot(message.storageRoot);
  if (message.mode === 'worker') {
    pool = new Pool(poolOptions(config));
    const worker = new SyntheticMediaWorker(
      pool,
      storage,
      message.fixtures,
      async (point) => {
        if (message.cut === 'worker-output' && point === 'display-written')
          await park('worker-output');
      },
    );
    const results: { stage: Stage; claimed: boolean }[] = [];
    for (const stage of message.stages ?? []) {
      assert.ok(['seal', 'process', 'review'].includes(stage));
      const claimed = await worker.runOne(stage);
      results.push({ stage, claimed });
      if (message.cut === 'review-ready' && stage === 'review' && claimed)
        await park('review-ready');
    }
    await send({ event: 'worker-complete', results });
    await pool.end();
    pool = undefined;
    await storage.dispose();
    process.exit(0);
  }
  const sharedStorage = storage;
  if (message.cut === 'multipart-partial') {
    const original = sharedStorage.writePlannedStream.bind(sharedStorage);
    sharedStorage.writePlannedStream = async (object, scratch, source) => {
      // The generator resumes only after writeEffect has written the preceding
      // chunk. Park before asking the real multipart stream for further bytes.
      async function* chunks() {
        for await (const chunk of source) {
          yield chunk as Uint8Array;
          await park('multipart-partial', { object, scratch });
        }
      }
      return original(object, scratch, Readable.from(chunks()));
    };
  }
  const ingressStorage = new SyntheticMediaIngressStorage(sharedStorage);
  let owner!: CommunityMediaOwner,
    assets!: MediaAssetRepository,
    batches!: MediaBatchRepository;
  const lifecycle = new MediaLifecycleRepository();
  const module = await Test.createTestingModule({
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
        const owners = new MediaOwnerProofRegistry([owner]),
          scopes = new MediaPrepareScopes(owner);
        batches = new MediaBatchRepository(
          scopes,
          new MediaIntentRepository(scopes),
          lifecycle,
          { readyOwned: (actor, id, tx) => assets.readyOwned(actor, id, tx) },
          new CommunityMediaBatchPublicationProof(),
          4,
        );
        assets = new MediaAssetRepository(owners, undefined, batches);
        return new CommunityMediaAttachmentAdapter(assets, owner, owners);
      },
    })
    .overrideProvider(MEDIA_INGRESS_STORAGE)
    .useValue(ingressStorage)
    .overrideProvider(MEDIA_DISCUSSION_BATCH_APPLICATION)
    .useFactory({
      inject: [DatabaseService, CommunityAccessService, MEDIA_ATTACHMENT],
      factory: (
        db: DatabaseService,
        access: CommunityAccessService,
        _attachment: CommunityMediaAttachmentAdapter,
      ) =>
        new CommunityMediaBatchApplication(
          db,
          access,
          new MediaPrepareScopes(owner),
          lifecycle,
          batches,
          new MediaIngressRepository(ingressStorage, 4),
        ),
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      const observed =
        message.cut === 'multipart-observed' &&
        res.statusCode === 200 &&
        /^\/v4\/media\/upload-intents\/[^/]+\/uploads\/[^/]+$/.test(req.path);
      const committed =
        message.cut === 'publication-committed' &&
        res.statusCode === 201 &&
        /^\/v1\/community\/(?:posts\/[^/]+\/comments|comments\/[^/]+\/replies)$/.test(
          req.path,
        );
      if (req.method === 'POST' && (observed || committed)) {
        void park(observed ? 'multipart-observed' : 'publication-committed');
        return res;
      }
      return original(body);
    }) as Response['json'];
    next();
  });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  await send({
    event: 'api-ready',
    port: Number(new URL(await app.getUrl()).port),
    writerInstanceId: ingressStorage.writerInstanceId,
  });
}
process.once('message', (message: Start) => {
  void start(message).catch(async (error: unknown) => {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.message : 'Child process failed',
    }).catch(() => undefined);
    await app?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await storage?.dispose().catch(() => undefined);
    process.exit(1);
  });
});
