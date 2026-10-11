import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import sharp from 'sharp';
import {
  schoolQrFixture,
  grantSchool,
  publishSchoolQr,
} from '../support/media/school-qr-runtime-fixture.js';
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
  createSchoolQrRuntime,
} = require('../../../wechat/src/school-configuration/qr-runtime.ts');
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
  cancelPending(): Promise<void>;
  clear(): void;
  dispose(): void;
}
interface Reader {
  load(target: {
    campusId: string;
    entryKey: string;
    entryRevision: number;
  }): Promise<void>;
  clear(): void;
  dispose(): void;
}
interface Target {
  regionId: string;
  entryKey: string;
  expectedRevision: number;
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
  'native school QR picker/hash/multipart lost response, new-runtime journal recovery, guest inline download and campus clear use real PG/API/storage',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 72, height: 72, channels: 3, background: '#314d80' },
    })
      .png()
      .toBuffer();
    const f = await schoolQrFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = await f.actor();
    await grantSchool(f, actor);
    const bridge = (await NativeMediaUploadBridge.create(
      f.port,
      nativeOrigin,
      'school-configuration',
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
    const runtime = createSchoolQrRuntime(options),
      first = runtime.createUploader((view: UploadView) =>
        views.push(view),
      ) as Uploader;
    const target = {
      regionId: f.scope.home.regionId,
      entryKey: 'treehole',
      expectedRevision: 0,
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
    const secondRuntime = createSchoolQrRuntime(options),
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
    await publishSchoolQr(f, actor, 'treehole', 0, {
      action: 'replace',
      assetId,
    });
    // A bound historical journal is released before a later scope is considered.
    assert.equal(
      await second.recover({ ...target, expectedRevision: 1 }),
      null,
    );
    assert.equal(views.at(-1)?.status, 'idle');
    const readBridge = await NativeMediaReadBridge.create(
      f.port,
      'school-configuration',
    );
    t.after(() => readBridge.dispose());
    const guests = new SessionStore(),
      guestApi = new ApiClient(
        nativeOrigin,
        new NativeExperienceTransport(f.port),
        guests,
        auth,
      ),
      readFiles = new WechatNativeMediaFiles(readBridge.wx, systemClock),
      readRegistry = new MediaLocalFiles(readFiles);
    const readViews: ReadView[] = [];
    const guestRuntime = createSchoolQrRuntime({
      ...options,
      api: guestApi,
      sessions: guests,
      wx: readBridge.wx,
      files: readFiles,
      registry: readRegistry,
    });
    const reader = guestRuntime.createReader((view: ReadView) =>
      readViews.push(view),
    ) as Reader;
    t.after(() => reader.dispose());
    await reader.load({
      campusId: f.scope.home.campusId,
      entryKey: 'treehole',
      entryRevision: 1,
    });
    assert.equal(readViews.at(-1)?.status, 'ready');
    assert.match(readViews.at(-1)?.src ?? '', /^wxfile:\/\/tmp\//);
    assert.equal(readBridge.exchanges.at(-1)?.authorized, false);
    reader.clear();
    assert.equal(readViews.at(-1)?.src, '');
    await readBridge.idle();
    await reader.load({
      campusId: f.scope.foreign.campusId,
      entryKey: 'treehole',
      entryRevision: 1,
    });
    assert.equal(readViews.at(-1)?.status, 'unavailable');
    assert.equal(readViews.at(-1)?.src, '');
    await publishSchoolQr(f, actor, 'treehole', 1, { action: 'keep' }, false);
    await reader.load({
      campusId: f.scope.home.campusId,
      entryKey: 'treehole',
      entryRevision: 1,
    });
    assert.equal(readViews.at(-1)?.status, 'unavailable');
    assert.equal(readViews.at(-1)?.src, '');
  },
);
