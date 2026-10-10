import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  NativeExperienceTransport,
  memoryStorage,
  nativeOrigin,
} from '../support/experience-native-bridge.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';

// The actual native CommonJS modules run behind a structural boundary; the
// API project does not compile the separate Mini Program source tree.
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const {
  WechatUploadFiles,
} = require('../../../wechat/src/platform/wechat-upload.ts');
const { MediaLocalFiles } = require('../../../wechat/src/media/local-files.ts');
const {
  AuthenticatedMediaUpload,
} = require('../../../wechat/src/media/authenticated-upload.ts');
const { PendingMediaStore } = require('../../../wechat/src/media/pending.ts');
const {
  HttpUploadGateway,
} = require('../../../wechat/src/media/upload-gateway.ts');
const {
  MediaUploadController,
} = require('../../../wechat/src/media/upload-controller.ts');
const {
  NativeMediaUploadBridge,
} = require('../../../wechat/test/support/media-upload-bridge.ts');

interface NativeUploadBridge {
  wx: unknown;
  exchanges: {
    path: string;
    status: number;
    bytes: number;
    authorized: boolean;
  }[];
  readLengths: number[];
  dropUploadResponse: boolean;
  select(
    bytes: Buffer,
    mime: string,
    info: { width: number; height: number; type: string },
  ): Promise<string>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
}
interface NativeController {
  select(target: { draftId: string; spaceId: string }): Promise<void>;
  start(): Promise<void>;
  recover(): Promise<void>;
  snapshot(): { status: string; assetId: string | null };
  dispose(): void;
}

test(
  'actual native picker/hash/upload bridge and restored actor journal recover a lost observed reply without retransmission',
  { timeout: 240000 },
  async () => {
    const bytes = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 28, g: 101, b: 161 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    let bridge: NativeUploadBridge | undefined;
    const controllers: NativeController[] = [];
    try {
      const actor = await f.actor(),
        other = await f.actor();
      const http = f.app.getHttpServer(),
        port = (http.address() as AddressInfo).port;
      bridge = (await NativeMediaUploadBridge.create(
        port,
        nativeOrigin,
      )) as NativeUploadBridge;
      const device = bridge;
      const durable = memoryStorage();
      const create = (credentials: typeof actor) => {
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        const json = new NativeExperienceTransport(port);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, json, systemClock),
          {
            async login() {
              assert.fail('A fixture must not call provider login');
            },
          },
          systemClock,
        );
        const files = new WechatUploadFiles(device.wx, systemClock);
        const registry = new MediaLocalFiles(files);
        const transfer = new AuthenticatedMediaUpload(
          nativeOrigin,
          device.wx,
          files,
          registry,
          sessions,
          systemClock,
          auth,
        );
        const pending = new PendingMediaStore(durable, nativeOrigin);
        const gateway = new HttpUploadGateway(
          nativeOrigin,
          json,
          sessions,
          auth,
        );
        const controller: NativeController = new MediaUploadController(
          sessions,
          pending,
          gateway,
          transfer,
          systemClock,
          async () => randomUUID(),
        );
        controllers.push(controller);
        return { sessions, json, pending, controller };
      };
      const original = create(actor);
      const metadata = await sharp(bytes).metadata();
      const selectedPath = await device.select(bytes, 'image/png', {
        width: metadata.width!,
        height: metadata.height!,
        type: metadata.format!,
      });
      await original.controller.select({
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
      });
      const frozen = original.pending.load(actor.accountId);
      assert.equal(frozen.phase, 'prepare_uncertain');
      assert.equal(frozen.prepare.declaration.sha256, sha256(bytes));
      device.dropUploadResponse = true;
      await assert.rejects(original.controller.start());
      await device.idle();
      const saved = original.pending.load(actor.accountId);
      assert.equal(saved.phase, 'upload_uncertain');
      assert.equal(device.exchanges.length, 1);
      assert.equal(device.exchanges[0]!.status, 200);
      assert.ok(
        device.readLengths.length >= 2,
        'Selection and immediately-before-upload bytes were hashed',
      );
      assert.ok(
        device.readLengths.every((length) => length > 0 && length <= 65536),
      );
      const serialized = JSON.stringify([...durable.values]);
      for (const forbidden of [
        selectedPath,
        actor.accessToken,
        actor.refreshToken,
        'grantId',
        'base64',
      ])
        assert.equal(serialized.includes(forbidden), false);
      // A different authenticated actor has no operation to query or cancel.
      original.sessions.completeLogin(original.sessions.beginLogin(), other);
      assert.equal(original.controller.snapshot().assetId, null);
      const before = original.json.exchanges.length;
      await original.controller.recover();
      assert.equal(original.json.exchanges.length, before);
      assert.ok(original.pending.load(actor.accountId));
      original.controller.dispose();

      // New controller/session/store/transfer instances intentionally have no
      // picker handles or grants. This is object-lifecycle restart coverage,
      // not a claim that an OS process was killed.
      const restored = create(actor);
      let finalized!: () => void;
      const atFinalize = new Promise<void>((resolve) => {
        finalized = resolve;
      });
      restored.json.checkResponse = (path, status) => {
        if (path.endsWith('/finalize') && status === 200) finalized();
      };
      const resumed = restored.controller.recover();
      void resumed.catch(() => undefined);
      await Promise.race([
        atFinalize,
        resumed.then(() => assert.fail('Recovery ended before finalize')),
      ]);
      for (const stage of ['seal', 'process', 'review'] as const)
        assert.equal(await f.worker.runOne(stage), true);
      await resumed;
      assert.equal(restored.controller.snapshot().status, 'ready');
      assert.equal(
        device.exchanges.length,
        1,
        'Observed response loss did not cause a second multipart transfer',
      );
      const assetId = restored.controller.snapshot().assetId!;
      const ready = restored.pending.load(actor.accountId);
      assert.equal(ready.clientRequestId, frozen.clientRequestId);
      assert.equal(ready.phase, 'ready_hint');
      assert.equal(ready.intentId, saved.intentId);
      await seedReviewPolicy(f.pool);
      const body = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion' as const,
        text: 'Native multipart recovery publication',
        imageAssetIds: [assetId],
        authorMode: 'named' as const,
        commentsPolicy: 'open' as const,
      };
      const asset = (
        await f.pool.query<{ manifest_digest: string }>(
          'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
          [assetId],
        )
      ).rows[0]!;
      const envelope = await postApprovalEnvelope(
        f.app,
        f.pool,
        actor.accountId,
        body,
      );
      await approveEnvelope(f.pool, {
        ...envelope,
        images: [{ assetId, digest: asset.manifest_digest }],
      });
      const published = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
      assert.equal(published.status, 201, JSON.stringify(published.body));
      await restored.controller.recover();
      assert.equal(restored.controller.snapshot().status, 'bound_history');
      assert.equal(restored.pending.load(actor.accountId), null);
      assert.equal(device.exchanges.length, 1);
    } finally {
      for (const controller of controllers) controller.dispose();
      await bridge?.dispose();
      await f.close();
    }
  },
);
