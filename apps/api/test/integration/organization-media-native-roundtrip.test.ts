import request from 'supertest';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import {
  organizationMediaFixture,
  createOrganizationDraft,
  organizationOk,
} from '../support/media/organization-runtime-fixture.js';
import {
  NativeExperienceTransport,
  memoryStorage,
  nativeOrigin,
} from '../support/experience-native-bridge.js';
import { NativeMediaReadBridge } from '../support/media/native-read-bridge.js';
import { sha256 } from '../../src/media/processing/protocol.js';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const {
  WechatNativeMediaFiles,
} = require('../../../wechat/src/media/native-files.ts');
const { MediaLocalFiles } = require('../../../wechat/src/media/local-files.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const {
  createOrganizationMediaRuntime,
} = require('../../../wechat/src/organizations/media-runtime.ts');
const {
  NativeMediaUploadBridge,
} = require('../../../wechat/test/support/media-upload-bridge.ts');
interface UploadView {
  status: string;
  message: string;
  progress: number;
}
interface ReadView {
  status: string;
  message: string;
  src: string;
}
interface Uploader {
  pick(target: Target): Promise<string | null>;
  recover(target: Target): Promise<string | null>;
  cancelPending(target: Target): Promise<void>;
  clear(): void;
  dispose(): void;
}
interface Reader {
  load(target: {
    organizationId: string;
    audience: 'public' | 'management';
    slot: string;
    applicationRevision: number;
  }): Promise<void>;
  clear(): void;
  dispose(): void;
}
interface Target {
  organizationId: string;
  slot: string;
  applicationRevision: number;
}
interface UploadBridge {
  wx: unknown;
  dropUploadResponse: boolean;
  exchanges: { path: string; status: number; bytes: number }[];
  select(
    bytes: Buffer,
    mime: string,
    info: { width: number; height: number; type: string },
  ): Promise<string>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
}
test(
  'native organization picker/hash/multipart lost response, slot journal recovery, authenticated inline delivery and revision clear use real PG/API/storage',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 72, height: 72, channels: 3, background: '#314d80' },
    })
      .png()
      .toBuffer();
    const f = await organizationMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = await f.actor();
    const org = await createOrganizationDraft(f, actor);
    const http = f.app.getHttpServer(),
      credential = `Bearer ${actor.accessToken}`;
    const bridge = (await NativeMediaUploadBridge.create(
      f.port,
      nativeOrigin,
      'organizations',
    )) as UploadBridge;
    t.after(() => bridge.dispose());
    const durable = memoryStorage(),
      sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), actor);
    const transport = new NativeExperienceTransport(f.port),
      auth = {
        refresh: async () => {
          throw new Error('Unexpected synthetic authentication refresh');
        },
      },
      api = new ApiClient(nativeOrigin, transport, sessions, auth);
    const files = new WechatNativeMediaFiles(bridge.wx, systemClock),
      registry = new MediaLocalFiles(files);
    const options = {
      api,
      sessions,
      storage: durable,
      origin: nativeOrigin,
      clock: systemClock,
      newRequestId: async () => randomUUID(),
      wx: bridge.wx,
      files,
      registry,
      auth,
    };
    const views: UploadView[] = [];
    const runtime = createOrganizationMediaRuntime(options),
      first = runtime.createUploader((view: UploadView) =>
        views.push(view),
      ) as Uploader;
    const target = {
      organizationId: org.id,
      slot: 'avatar',
      applicationRevision: 1,
    };
    await bridge.select(bytes, 'image/png', {
      width: 72,
      height: 72,
      type: 'png',
    });
    bridge.dropUploadResponse = true;
    assert.equal(await first.pick(target), null);
    await bridge.idle();
    assert.equal(
      bridge.exchanges.length,
      1,
      JSON.stringify({ views, http: transport.exchanges }),
    );
    assert.equal(bridge.exchanges[0]?.status, 200);
    first.dispose();
    bridge.dropUploadResponse = false;
    // A new native runtime has no local file or old controller. It recovers the
    // original exact receipt and finalizes without retransmitting image bytes.
    const secondRuntime = createOrganizationMediaRuntime(options),
      second = secondRuntime.createUploader((view: UploadView) =>
        views.push(view),
      ) as Uploader;
    t.after(() => second.dispose());
    let finalized!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      finalized = resolve;
    });
    transport.checkResponse = (path, status) => {
      if (path.endsWith('/finalize') && status === 200) finalized();
    };
    const recovering = second.recover(target);
    await Promise.race([
      finalizing,
      recovering.then(() => {
        assert.fail(
          `Recovery stopped before finalize: ${JSON.stringify({ views, http: transport.exchanges })}`,
        );
      }),
    ]);
    for (const stage of ['seal', 'process', 'review'] as const)
      assert.equal(await f.worker.runOne(stage), true);
    const assetId = await recovering;
    assert.ok(assetId);
    assert.equal(bridge.exchanges.length, 1);
    assert.equal(views.at(-1)?.status, 'ready');
    organizationOk(
      await request(http)
        .post(`/v1/organizations/${org.id}/content`)
        .set('Authorization', credential)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          expectedAuthorityVersion: 1,
          data: org.data,
          mediaChanges: { avatar: { action: 'replace', assetId } },
        }),
    );
    await secondRuntime.reconcile(org.id);
    assert.equal(secondRuntime.pendingTargets(org.id).length, 0);
    assert.equal(
      await second.recover({ ...target, applicationRevision: 2 }),
      null,
    );
    assert.equal(views.at(-1)?.status, 'idle');
    const readBridge = await NativeMediaReadBridge.create(
      f.port,
      'organizations',
    );
    t.after(() => readBridge.dispose());
    const readersSession = new SessionStore();
    readersSession.completeLogin(readersSession.beginLogin(), actor);
    const readerApi = new ApiClient(
        nativeOrigin,
        new NativeExperienceTransport(f.port),
        readersSession,
        auth,
      ),
      readFiles = new WechatNativeMediaFiles(readBridge.wx, systemClock),
      readRegistry = new MediaLocalFiles(readFiles);
    const readViews: ReadView[] = [];
    const readRuntime = createOrganizationMediaRuntime({
      ...options,
      api: readerApi,
      sessions: readersSession,
      wx: readBridge.wx,
      files: readFiles,
      registry: readRegistry,
    });
    const reader = readRuntime.createReader((view: ReadView) =>
      readViews.push(view),
    ) as Reader;
    t.after(() => reader.dispose());
    await reader.load({
      organizationId: org.id,
      audience: 'management',
      slot: 'avatar',
      applicationRevision: 2,
    });
    assert.equal(readViews.at(-1)?.status, 'ready');
    assert.match(readViews.at(-1)?.src ?? '', /^wxfile:\/\/tmp\//);
    assert.equal(readBridge.exchanges.at(-1)?.authorized, true);
    reader.clear();
    assert.equal(readViews.at(-1)?.src, '');
    await readBridge.idle();
    await reader.load({
      organizationId: randomUUID(),
      audience: 'management',
      slot: 'avatar',
      applicationRevision: 2,
    });
    assert.equal(readViews.at(-1)?.status, 'unavailable');
    assert.equal(readViews.at(-1)?.src, '');
    organizationOk(
      await request(http)
        .post(`/v1/organizations/${org.id}/content`)
        .set('Authorization', credential)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 1,
          data: org.data,
          mediaChanges: {},
        }),
    );
    await reader.load({
      organizationId: org.id,
      audience: 'management',
      slot: 'avatar',
      applicationRevision: 2,
    });
    assert.equal(readViews.at(-1)?.status, 'unavailable');
    assert.equal(readViews.at(-1)?.src, '');
  },
);
