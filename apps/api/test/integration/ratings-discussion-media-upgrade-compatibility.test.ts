/** Current binary against the accepted pre-Media7 schema. Original Media2
 * recovery/lifecycle must never require a discussion relation to exist. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  MEDIA_UPLOAD_APPLICATION_V2,
  type MediaUploadApplicationV2,
} from '../../src/media/application-v2.js';
import { mediaRequestHash } from '../../src/media/contracts-v2.js';
import { sha256 } from '../../src/media/processing/protocol.js';

test('actual 0082 Media2 prepare/status/recover/cancel requires no Media7 schema', async (t) => {
  const bytes = Buffer.from('registered synthetic legacy declaration');
  const f = await syntheticMediaRuntimeFixture(
    [{ sha256: sha256(bytes), verdict: 'allow' }],
    { maximumMigration: 82 },
  );
  t.after(() => f.close());
  assert.equal(
    (
      await f.pool.query(
        "SELECT to_regclass('whaleu_media.ratings_discussion_batches') relation",
      )
    ).rows[0].relation,
    null,
  );
  const actor = await f.actor();
  const media = f.app.get<MediaUploadApplicationV2>(
    MEDIA_UPLOAD_APPLICATION_V2,
  );
  const input = {
    clientRequestId: randomUUID(),
    purpose: 'community-post-image',
    draftId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  const prepared = await media.prepareV2(actor.accessToken, input);
  assert.equal(
    (await media.prepareV2(actor.accessToken, input)).intentId,
    prepared.intentId,
  );
  assert.equal(
    (await media.recoverRequest(actor.accessToken, input.clientRequestId))
      .state,
    'active',
  );
  assert.equal(
    (await media.statusV2(actor.accessToken, prepared.intentId)).intentId,
    prepared.intentId,
  );
  const cancelled = await media.cancelRequest(
    actor.accessToken,
    input.clientRequestId,
    { requestHash: mediaRequestHash(actor.accountId, input) },
  );
  assert.equal(cancelled.state, 'terminal');
  if (cancelled.state !== 'terminal') assert.fail('terminal original recovery');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(
    (await media.recoverRequest(actor.accessToken, input.clientRequestId))
      .state,
    'terminal',
  );
});
