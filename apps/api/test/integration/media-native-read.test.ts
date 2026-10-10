import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import sharp from 'sharp';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} from '../support/experience-native-bridge.js';
import { NativeMediaReadBridge } from '../support/media/native-read-bridge.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
// Structural boundary keeps native CommonJS compilation separate from API ESM.
interface MediaReadView {
  readonly status: 'idle' | 'loading' | 'ready' | 'denied' | 'unavailable';
  readonly localSrc: string;
  readonly expanded: boolean;
}

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  createMediaReadRuntime,
} = require('../../../wechat/src/media/runtime.ts');

/** Drain real transport work and its queued controller continuations before
 * expiring a token; a wall-clock sleep cannot prove the JSON reads settled. */
class DrainedNativeTransport extends NativeExperienceTransport {
  private readonly pending = new Set<Promise<unknown>>();
  override send(
    input: Parameters<NativeExperienceTransport['send']>[0],
  ): ReturnType<NativeExperienceTransport['send']> {
    const operation = super.send(input);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([...this.pending]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.pending.size === 0) return;
    }
  }
}

type NativePage = {
  data: {
    mediaRead: MediaReadView;
    loaded?: boolean;
    error?: string;
    post?: { images: unknown[] } | null;
  };
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onLoad(query: { postId: string }): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onOpenMedia(): void;
  onCloseMedia(): void;
  onReload(): void;
};
async function until(
  predicate: () => boolean | Promise<boolean>,
  reason: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(typeof reason === 'function' ? reason() : reason);
}

// This is a synthetic native-device acceptance test, not target-device approval.
// The actual Page module, controllers, decoders, authenticated HTTP, PostgreSQL
// owner proofs, publication and delivery all run. Only device I/O and the
// explicitly registered test media provider are replaced by disposable bridges.
for (const format of ['png', 'jpeg'] as const)
  test(
    `actual native Page + authenticated loopback HTTP + exclusive ${format} files enforce current-reader image lifecycle`,
    { timeout: 240_000 },
    async () => {
      const bytes = await sharp({
        create: {
          width: 80,
          height: 60,
          channels: 3,
          background: { r: 24, g: 96, b: 160 },
        },
      })
        .toFormat(format)
        .toBuffer();
      const f = await syntheticMediaRuntimeFixture(
        [{ sha256: sha256(bytes), verdict: 'allow' }],
        { authRateLimit: true },
      );
      let bridge: NativeMediaReadBridge | undefined;
      let native: NativePage | undefined;
      let community: { views?: { dispose(): void } } | undefined;
      const globals = globalThis as typeof globalThis & {
        Page?: unknown;
        getApp?: unknown;
        wx?: unknown;
      };
      const previous = {
        Page: globals.Page,
        getApp: globals.getApp,
        wx: globals.wx,
      };
      const pageModule =
        require.resolve('../../../wechat/src/pages/community-detail/community-detail.ts');
      try {
        const author = await f.actor();
        const reader = await f.actor();
        const replacementReader = await f.actor();
        const http = f.app.getHttpServer();
        const authorAuth = `Bearer ${author.accessToken}`;
        const providerLogin = await request(http)
          .post('/v1/auth/wechat/login')
          .send({ code: 'synthetic-native-provider-disabled' });
        assert.equal(providerLogin.status, 503);
        assert.equal(
          providerLogin.body.error.code,
          'AUTH_NOT_CONFIGURED',
          'Auth rate-limit opt-in cannot enable provider login',
        );
        const initialBuckets = (
          await f.pool.query('SELECT 1 FROM whaleu_identity.rate_buckets')
        ).rowCount;
        assert.equal(
          initialBuckets,
          2,
          'Real auth rate limiter consumes global and address buckets even before unavailable provider rejection',
        );
        const prepared = await request(http)
          .post('/v1/media/upload-intents')
          .set('Authorization', authorAuth)
          .send({
            clientRequestId: randomUUID(),
            purpose: 'community-post-image',
            draftId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            slot: 'images',
            ordinal: 0,
            declaration: { mime: `image/${format}`, bytes: bytes.length },
          });
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
        const intentId = prepared.body.intentId as string;
        await f.worker.upload(author.accountId, intentId, bytes);
        for (const stage of ['seal', 'process', 'review'] as const)
          assert.equal(await f.worker.runOne(stage), true);
        const intent = await request(http)
          .get(`/v1/media/upload-intents/${intentId}`)
          .set('Authorization', authorAuth);
        assert.equal(intent.status, 200, JSON.stringify(intent.body));
        assert.equal(intent.body.status, 'ready');
        const assetId = intent.body.assetId as string;
        const asset = (
          await f.pool.query<{ manifest_digest: string }>(
            'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
            [assetId],
          )
        ).rows[0]!;
        const body = {
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion' as const,
          text: 'Synthetic reader image native acceptance',
          imageAssetIds: [assetId],
          authorMode: 'named' as const,
          commentsPolicy: 'open' as const,
        };
        await seedReviewPolicy(f.pool);
        const envelope = await postApprovalEnvelope(
          f.app,
          f.pool,
          author.accountId,
          body,
        );
        await approveEnvelope(f.pool, {
          ...envelope,
          images: [{ assetId, digest: asset.manifest_digest }],
        });
        const published = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', authorAuth)
          .send(body);
        assert.equal(published.status, 201, JSON.stringify(published.body));
        const binding = (
          await f.pool.query<{ id: string; resource_id: string }>(
            'SELECT id,resource_id FROM whaleu_media.bindings WHERE asset_id=$1',
            [assetId],
          )
        ).rows[0]!;
        const variant = (
          await f.pool.query<{ sha256: string }>(
            "SELECT sha256 FROM whaleu_media.variants WHERE asset_id=$1 AND variant_name='display-v1'",
            [assetId],
          )
        ).rows[0]!;
        const uploadCount = (
          await f.pool.query('SELECT 1 FROM whaleu_media.upload_intents')
        ).rowCount;
        const port = (http.address() as AddressInfo).port;
        bridge = await NativeMediaReadBridge.create(port);
        const device = bridge;
        const json = new DrainedNativeTransport(port);
        const storage = platformStorage();
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), reader);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, json, systemClock),
          {
            async login() {
              assert.fail('Viewing cannot request a provider login');
            },
          },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, json, sessions, auth);
        const identity = { sessions, auth, api };
        const wx = {
          ...storage,
          ...device.wx,
          navigateTo(input: { success(): void }) {
            input.success();
          },
          previewImage() {
            assert.fail('N1 must never use native previewImage');
          },
          chooseMedia() {
            assert.fail('Read-only browsing must not pick or upload');
          },
          uploadFile() {
            assert.fail('Read-only browsing must not upload');
          },
          saveFile() {
            assert.fail('Private temporary media must not become a saved file');
          },
        };
        const runtime = createCommunityRuntime(
          identity,
          wx,
          nativeOrigin,
          systemClock,
        );
        community = runtime;
        const mediaRead = createMediaReadRuntime(
          identity,
          wx,
          nativeOrigin,
          systemClock,
          runtime.privateViews,
          true,
        );
        const renderHistory: MediaReadView[] = [];
        const abortSources: string[] = [];
        const unlinkSources: { path: string; source: string }[] = [];
        Object.assign(globals, {
          wx,
          getApp: () => ({ identity, community: runtime, mediaRead }),
          Page(value: NativePage) {
            native = value;
            value.setData = (patch, callback) => {
              value.data = { ...value.data, ...patch };
              if ('mediaRead' in patch)
                renderHistory.push(structuredClone(value.data.mediaRead));
              callback?.();
            };
          },
        });
        delete require.cache[pageModule];
        require(pageModule);
        assert.ok(
          native,
          'Capture the real community-detail Page registration',
        );
        const page = native as NativePage;
        device.beforeAbort = () => {
          abortSources.push(page.data.mediaRead.localSrc);
        };
        device.beforeUnlink = (path) => {
          unlinkSources.push({ path, source: page.data.mediaRead.localSrc });
        };
        page.onLoad({ postId: binding.resource_id });
        page.onShow();
        await until(
          () => page.data.mediaRead.status === 'ready',
          () =>
            `A normal reader must receive the image without upload Work: ${JSON.stringify({ media: page.data.mediaRead, loaded: page.data.loaded, error: page.data.error, exchanges: json.exchanges, downloads: device.exchanges })}`,
        );
        assert.equal(page.data.loaded, true);
        assert.equal(page.data.post?.images.length, 1);
        assert.equal(page.data.mediaRead.expanded, false);
        const firstPath = page.data.mediaRead.localSrc;
        assert.match(firstPath, /^wxfile:\/\/tmp\//);
        assert.equal(
          sha256(await device.bytes(firstPath)),
          variant.sha256,
          'File contains the exact current server variant',
        );
        assert.deepEqual(
          device.exchanges.map((item) => item.status),
          [200],
        );
        assert.ok(device.exchanges.every((item) => item.authorized));
        assert.equal(
          (await f.pool.query('SELECT 1 FROM whaleu_media.upload_intents'))
            .rowCount,
          uploadCount,
        );

        await json.idle();

        // Genuine server access-token expiry and genuine /auth/refresh, not a fake
        // authorization callback or a fabricated 401 response.
        await f.pool.query(
          "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",
          [reader.sessionId],
        );
        page.onOpenMedia();
        page.onOpenMedia();
        assert.equal(page.data.mediaRead.localSrc, '');
        await until(
          () =>
            page.data.mediaRead.status === 'ready' &&
            page.data.mediaRead.expanded,
          () =>
            `Expanded view must finish real refresh and reauthorization: ${JSON.stringify({ media: page.data.mediaRead, exchanges: json.exchanges, downloads: device.exchanges, revision: sessions.snapshot().revision, accountPresent: !!sessions.snapshot().credentials })}`,
        );
        assert.deepEqual(
          device.exchanges.slice(-2).map((item) => item.status),
          [401, 200],
        );
        assert.equal(
          json.exchanges.filter((item) => item.path === '/v1/auth/refresh')
            .length,
          1,
        );
        assert.equal(sessions.snapshot().revision, 1);
        assert.equal(
          sessions.snapshot().credentials.accountId,
          reader.accountId,
        );
        assert.equal(
          sessions.snapshot().credentials.sessionId,
          reader.sessionId,
        );
        assert.notEqual(
          sessions.snapshot().credentials.accessToken,
          reader.accessToken,
        );
        assert.notEqual(
          sessions.snapshot().credentials.refreshToken,
          reader.refreshToken,
        );
        assert.equal(
          (await f.pool.query('SELECT 1 FROM whaleu_identity.rate_buckets'))
            .rowCount,
          initialBuckets! + 2,
          'Refresh must consume the actual global and address rate-limit buckets',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_identity.refresh_tokens WHERE session_id=$1 AND consumed_at IS NOT NULL',
              [reader.sessionId],
            )
          ).rowCount,
          1,
          'The original refresh token was consumed by real rotation',
        );
        await until(
          () => device.removed.includes(firstPath),
          'Old inline file must be removed before expanded view persists',
        );
        const expanded = page.data.mediaRead.localSrc;
        page.onCloseMedia();
        page.onCloseMedia();
        await until(
          () =>
            page.data.mediaRead.status === 'ready' &&
            !page.data.mediaRead.expanded,
          'Closing reauthorizes a fresh inline image',
        );
        assert.notEqual(page.data.mediaRead.localSrc, expanded);
        assert.equal(
          device.exchanges.length,
          4,
          'Repeated open and close taps must coalesce',
        );

        // Hold a real fully downloaded file. Hide must clear setData immediately;
        // the later native success callback cannot repaint it and must unlink it.
        const hidden = device.holdNext();
        page.onOpenMedia();
        await hidden.arrived;
        page.onHide();
        assert.equal(page.data.mediaRead.localSrc, '');
        const hiddenRenders = renderHistory.length;
        hidden.release();
        await device.idle();
        await until(
          async () => (await device.fileCount()) === 0,
          'Late hidden output must be removed from the real filesystem',
        );
        assert.equal(renderHistory.length, hiddenRenders);
        page.onShow();
        await until(
          () => page.data.mediaRead.status === 'ready',
          'Re-show must reread the parent and obtain fresh authorized bytes',
        );

        // A same-account new local login epoch is not a token refresh.
        const sameAccount = device.holdNext();
        page.onOpenMedia();
        await sameAccount.arrived;
        const currentCredentials = sessions.snapshot().credentials;
        sessions.completeLogin(sessions.beginLogin(), currentCredentials);
        assert.equal(page.data.mediaRead.localSrc, '');
        sameAccount.release();
        await device.idle();
        await until(
          async () => (await device.fileCount()) === 0,
          'Same-account old epoch must lose every late file',
        );
        const beforeStaleTap = device.exchanges.length;
        page.onOpenMedia();
        await json.idle();
        await device.idle();
        assert.equal(
          device.exchanges.length,
          beforeStaleTap,
          'An old descriptor cannot be reopened after a new login epoch',
        );
        page.onShow();
        await until(
          () => page.data.mediaRead.status === 'ready',
          'A fresh parent read can restore the same reader',
        );

        const replaced = device.holdNext();
        page.onOpenMedia();
        await replaced.arrived;
        sessions.completeLogin(sessions.beginLogin(), replacementReader);
        assert.equal(page.data.mediaRead.localSrc, '');
        replaced.release();
        await device.idle();
        await until(
          async () => (await device.fileCount()) === 0,
          'Other-account output must not survive ownership replacement',
        );
        page.onShow();
        await until(
          () => page.data.mediaRead.status === 'ready',
          'Replacement reader must independently pass real current owner authorization',
        );

        const safety = async (state: 'allow' | 'held') =>
          withCommunityScopeWriter(f.pool, async (tx) => {
            const revision =
              Number(
                (
                  await tx.query<{ revision: string }>(
                    'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                    [assetId],
                  )
                ).rows[0]!.revision,
              ) + 1;
            const event = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_media.asset_safety_events
        (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        VALUES($1,$2,$3,$4,$5,'media-static-v1','registered-synthetic-media',$6,'{}',clock_timestamp()-interval '2 hours',clock_timestamp()+interval '1 hour')`,
              [
                event,
                assetId,
                revision,
                state,
                asset.manifest_digest,
                `${state}:${event}`,
              ],
            );
            await tx.query(
              'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
              [assetId, revision, event],
            );
          });
        await safety('held');
        page.onOpenMedia();
        assert.equal(page.data.mediaRead.localSrc, '');
        await until(
          () => page.data.mediaRead.status === 'denied',
          'Held media must fail the real server visibility decision',
        );
        assert.equal(
          device.exchanges.at(-1)!.status,
          404,
          'Current held Media is a known parent denial, not unknown availability',
        );
        assert.equal(page.data.mediaRead.expanded, false);
        await until(
          async () => (await device.fileCount()) === 0,
          'Error body and previously visible bytes must both be removed',
        );
        await safety('allow');
        page.onReload();
        await until(
          () => page.data.mediaRead.status === 'ready',
          'Fresh parent read is required after reallow',
        );

        const removed = await request(http)
          .delete(`/v1/community/posts/${binding.resource_id}`)
          .set('Authorization', authorAuth);
        assert.equal(removed.status, 204, JSON.stringify(removed.body));
        page.onOpenMedia();
        assert.equal(page.data.mediaRead.localSrc, '');
        await until(
          () => ['denied', 'unavailable'].includes(page.data.mediaRead.status),
          'Deleted parent cannot deliver bytes from a retained descriptor',
        );
        assert.ok(device.exchanges.at(-1)!.status >= 400);
        page.onReload();
        await until(
          () => page.data.post === null && page.data.mediaRead.localSrc === '',
          'Fresh parent denial clears the entire private image binding',
        );
        page.onUnload();
        await until(
          async () => (await device.fileCount()) === 0,
          'Unload must leave no real native temporary files',
        );
        assert.ok(
          abortSources.every((source) => source === ''),
          'Clear current setData before any native abort callback',
        );
        assert.ok(
          unlinkSources.every((item) => item.source !== item.path),
          'Revoke the current source before any unlink callback',
        );
        assert.ok(
          device.generated.length > 5,
          'Exercise real file churn across authorization boundaries',
        );
        assert.equal(
          new Set(device.removed).size,
          device.generated.length,
          'Every materialized response, including errors and late outputs, was removed',
        );
        const persistent = JSON.stringify([...storage.storage.values]);
        assert.equal(persistent.includes('wxfile://'), false);
        for (const view of renderHistory) {
          assert.deepEqual(Object.keys(view).sort(), [
            'expanded',
            'localSrc',
            'status',
          ]);
          assert.equal(
            JSON.stringify(view).includes(reader.accessToken),
            false,
          );
          assert.equal(
            JSON.stringify(view).includes(replacementReader.accessToken),
            false,
          );
        }
        assert.equal(
          (await f.pool.query('SELECT 1 FROM whaleu_media.upload_intents'))
            .rowCount,
          uploadCount,
          'Reader browsing never creates an upload intent',
        );
      } finally {
        native?.onUnload();
        community?.views?.dispose();
        Object.assign(globals, previous);
        delete require.cache[pageModule];
        try {
          await bridge?.dispose();
        } finally {
          await f.close();
        }
      }
    },
  );

test('default synthetic Media fixture keeps auth refresh unavailable and does not consume its token', async () => {
  await assert.rejects(
    syntheticMediaRuntimeFixture([]),
    /MEDIA_PROCESSOR_UNAVAILABLE/,
  );
  // The next fixture's own schema/lease guards prove failed construction cleaned up.
  const f = await syntheticMediaRuntimeFixture([
    { sha256: '0'.repeat(64), verdict: 'allow' },
  ]);
  try {
    const actor = await f.actor();
    const response = await request(f.app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: actor.refreshToken });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AUTH_NOT_CONFIGURED');
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_identity.rate_buckets'))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_identity.refresh_tokens WHERE session_id=$1 AND consumed_at IS NOT NULL',
          [actor.sessionId],
        )
      ).rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});
