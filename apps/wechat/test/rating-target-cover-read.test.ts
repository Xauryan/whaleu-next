import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { RatingCoverReadController } from '../src/ratings/target-cover-read-controller';
import type { RatingCoverReadTransfer } from '../src/ratings/target-cover-download';
import { RATINGS_MEDIA_PROTOCOL } from '../src/ratings/target-cover-media-contract';
import { FakeClock, deferred } from './helpers';
import { wireCredentials } from './identity-helpers';
import { scopedContext } from './rating-scoped-helpers';
import { otherId, requestId, targetId } from './ratings-helpers';
import type { LocalMediaFile } from '../src/media/contracts';
test('Ratings in-page close and account change revoke src; delayed bytes are released', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const clock = new FakeClock(),
    file = Object.freeze({ localId: 'test-cover' });
  const late = deferred<LocalMediaFile>(),
    released: LocalMediaFile[] = [];
  const transfer: RatingCoverReadTransfer = {
    download: () => late.promise,
    resolve: async () => 'wxfile://tmp/cover.jpg',
    release: async (value) => {
      released.push(value);
    },
  };
  const controller = new RatingCoverReadController(
    sessions,
    transfer,
    clock,
    () => undefined,
  );
  const context = {
    ...scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      clock.now(),
    ),
    protocolVersion: 3 as const,
    capabilities: ['target_cover'],
  };
  const work = controller.load(
    async () => ({
      context,
      cover: {
        protocol: RATINGS_MEDIA_PROTOCOL,
        kind: 'ratings-target-media',
        contextId: context.id,
        contextToken: context.token,
        targetId,
        appearanceId: otherId,
        bindingId: requestId,
        width: 1200,
        height: 800,
        variants: ['thumb-v1', 'display-v1'],
      },
    }),
    true,
  );
  await Promise.resolve();
  await Promise.resolve();
  sessions.logout();
  late.resolve(file);
  await work;
  assert.equal(controller.snapshot().localSrc, '');
  assert.equal(controller.snapshot().expanded, false);
  assert.ok(released.includes(file));
  controller.dispose();
});
test('capability revocation, unknown descriptor and mixed context remove any prior source', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const clock = new FakeClock(),
    released: LocalMediaFile[] = [],
    file = Object.freeze({ localId: 'old-cover' });
  let downloads = 0;
  const transfer: RatingCoverReadTransfer = {
    download: async () => {
      ++downloads;
      return file;
    },
    resolve: async () => 'wxfile://tmp/current.jpg',
    release: async (value) => {
      released.push(value);
    },
  };
  const controller = new RatingCoverReadController(
    sessions,
    transfer,
    clock,
    () => undefined,
  );
  const context = {
    ...scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      clock.now(),
    ),
    protocolVersion: 3 as const,
    capabilities: ['target_cover'],
  };
  const cover = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    kind: 'ratings-target-media' as const,
    contextId: context.id,
    contextToken: context.token,
    targetId,
    appearanceId: otherId,
    bindingId: requestId,
    width: 800,
    height: 600,
    variants: ['thumb-v1', 'display-v1'] as const,
  };
  await controller.load(async () => ({ context, cover }));
  assert.equal(controller.snapshot().status, 'ready');
  await controller.load(async () => ({
    context: { ...context, capabilities: [] },
    cover,
  }));
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(controller.snapshot().localSrc, '');
  await controller.load(async () => ({
    context,
    cover: { ...cover, contextId: otherId },
  }));
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(downloads, 1);
  await controller.load(async () => {
    throw new Error('Unknown current cover');
  });
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.ok(released.includes(file));
  controller.dispose();
});
