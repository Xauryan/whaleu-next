import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaStorage } from '../support/media/synthetic-storage.js';
import { SyntheticMediaWorker } from '../support/media/synthetic-worker.js';
import type {
  SyntheticAssetVerdict,
  SyntheticCrashPoint,
} from '../support/media/synthetic-worker.js';
import { MediaPrepareScopes } from '../../src/media/prepare-scope.js';
import { MediaIntentRepository } from '../../src/media/intent-repository.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { sealManifest } from '../../src/media/manifest.js';
import type { MediaManifest } from '../../src/media/contracts.js';
import { MEDIA_MAX_INPUT_BYTES } from '../../src/media/contracts.js';
import {
  MEDIA_ATTACHMENT,
  UnavailableMedia,
} from '../../src/community/community-policy.js';

type FixtureImage = {
  jpeg(): FixtureImage;
  png(): FixtureImage;
  withMetadata(metadata: { orientation: number }): FixtureImage;
  toBuffer(): Promise<Buffer>;
  metadata(): Promise<{
    width?: number;
    height?: number;
    orientation?: number;
    exif?: Buffer;
    icc?: Buffer;
    xmp?: Buffer;
  }>;
};
type FixtureSharp = (
  input:
    | Buffer
    | {
        create: {
          width: number;
          height: number;
          channels: 3;
          background: { r: number; g: number; b: number };
        };
      },
) => FixtureImage;

/** Real disposable PostgreSQL + actual generated/decoded/reencoded bytes.
 * This is not Community publication, HTTP delivery, production isolation,
 * provider acceptance, full process-death recovery or GC/quiescence proof. */
test(
  'registered synthetic Media pipeline commits actual immutable bytes and exact safety evidence',
  {
    timeout: 120000,
  },
  async (t) => {
    const name = 'sharp';
    const loaded: unknown = await import(name);
    const sharp = (loaded as { default: FixtureSharp }).default;
    const fixtures: {
      bytes: Buffer;
      mime: 'image/jpeg' | 'image/png';
      verdict: SyntheticAssetVerdict;
    }[] = [];
    for (const mime of ['image/jpeg', 'image/png'] as const) {
      for (const [index, verdict] of (
        ['allow', 'held', 'revoked'] as const
      ).entries()) {
        const image = sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: { r: 30 + index * 20, g: 100, b: 170 },
          },
        });
        fixtures.push({
          mime,
          verdict,
          bytes: await (mime === 'image/jpeg' ? image.jpeg() : image.png())
            .withMetadata({ orientation: 6 })
            .toBuffer(),
        });
      }
    }
    const registry = fixtures.map((fixture) => ({
      sha256: sha256(fixture.bytes),
      verdict: fixture.verdict,
    }));
    const f = await directoryRuntimeFixture();
    const storage = await SyntheticMediaStorage.create();
    const worker = new SyntheticMediaWorker(f.pool, storage, registry);
    try {
      // Narrow fixture owner capability, not a replacement production Community
      // authorization port. Actual owner prepare/attach/read acceptance is separate.
      const prepare = async (fixture: (typeof fixtures)[number]) => {
        const actor = await f.actor();
        const scopeId = randomUUID();
        const scopes = new MediaPrepareScopes({
          authorizePrepare: async (actorAccountId) => ({
            actorAccountId,
            serverScopeId: scopeId,
            scopeRevision: 'registered-synthetic-scope-v1',
            ownerKind: 'community',
            resourceKind: 'post',
            targetKind: 'draft',
            contentVersion: 1,
            audience: 'content-gated',
            purpose: 'community-post-image',
            slot: 'images',
            ordinal: 0,
          }),
        });
        const repository = new MediaIntentRepository(scopes);
        const request = {
          clientRequestId: randomUUID(),
          purpose: 'community-post-image',
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          slot: 'images',
          ordinal: 0,
          declaration: { bytes: fixture.bytes.length, mime: fixture.mime },
        };
        const prepareAgain = () =>
          withCommunityScopeWriter(f.pool, async (tx) =>
            repository.prepare(
              await scopes.authorize(actor.accountId, request, tx),
              tx,
            ),
          );
        const receipt = await prepareAgain();
        assert.equal((await prepareAgain()).intentId, receipt.intentId);
        return {
          actor: actor.accountId,
          intentId: receipt.intentId,
          prepareAgain,
        };
      };
      const state = async (intentId: string) =>
        (
          await f.pool.query<{ state: string }>(
            'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
            [intentId],
          )
        ).rows[0]!.state;
      const read = async (object: MediaManifest['original']['object']) => {
        const opened = await storage.openExact(object, MEDIA_MAX_INPUT_BYTES);
        const chunks: Buffer[] = [];
        for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      };
      await t.test('normal runtime stays unavailable', () => {
        assert.ok(f.app.get(MEDIA_ATTACHMENT) instanceof UnavailableMedia);
      });
      for (const fixture of fixtures)
        await t.test(
          `${fixture.mime} ${fixture.verdict} uses real bytes and exact manifest`,
          async () => {
            const intent = await prepare(fixture);
            await worker.upload(intent.actor, intent.intentId, fixture.bytes);
            assert.equal(await state(intent.intentId), 'sealing');
            await worker.runOne('seal');
            await worker.runOne('process');
            assert.equal(await state(intent.intentId), 'awaiting_review');
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.asset_safety_events e JOIN whaleu_media.assets a ON a.id=e.asset_id WHERE a.intent_id=$1',
                  [intent.intentId],
                )
              ).rowCount,
              0,
            );
            await worker.runOne('review');
            assert.equal(
              await state(intent.intentId),
              fixture.verdict === 'allow'
                ? 'ready'
                : fixture.verdict === 'held'
                  ? 'awaiting_review'
                  : 'rejected',
            );
            if (fixture.verdict !== 'allow')
              await assert.rejects(
                withCommunityScopeWriter(f.pool, (tx) =>
                  tx.query(
                    "UPDATE whaleu_media.upload_intents SET state='ready',updated_at=clock_timestamp() WHERE id=$1",
                    [intent.intentId],
                  ),
                ),
              );
            const asset = (
              await f.pool.query<{
                id: string;
                manifest: MediaManifest;
                manifest_digest: string;
              }>('SELECT * FROM whaleu_media.assets WHERE intent_id=$1', [
                intent.intentId,
              ])
            ).rows[0]!;
            assert.equal(
              sealManifest(asset.manifest).digest,
              asset.manifest_digest,
            );
            assert.deepEqual(
              await read(asset.manifest.original.object),
              fixture.bytes,
            );
            assert.deepEqual(
              asset.manifest.variants.map((v) => [v.width, v.height]),
              [
                [300, 400],
                [600, 800],
              ],
            );
            for (const variant of asset.manifest.variants) {
              const actual = await read(variant.object);
              assert.equal(actual.length, variant.bytes);
              assert.equal(sha256(actual), variant.sha256);
              const metadata = await sharp(actual).metadata();
              assert.equal(metadata.width, variant.width);
              assert.equal(metadata.height, variant.height);
              assert.equal(metadata.orientation, undefined);
              assert.equal(metadata.exif, undefined);
              assert.equal(metadata.icc, undefined);
              assert.equal(metadata.xmp, undefined);
            }
            const event = (
              await f.pool.query<{
                state: string;
                manifest_digest: string;
                provenance: { fixtureDigest: string };
              }>(
                'SELECT * FROM whaleu_media.asset_safety_events WHERE asset_id=$1',
                [asset.id],
              )
            ).rows[0]!;
            assert.equal(event.state, fixture.verdict);
            assert.equal(event.manifest_digest, asset.manifest_digest);
            assert.equal(event.provenance.fixtureDigest, sha256(fixture.bytes));
            assert.equal(await worker.runOne('process'), false);
            assert.equal(await worker.runOne('review'), false);
            assert.equal(
              (await intent.prepareAgain()).intentId,
              intent.intentId,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                  [intent.intentId],
                )
              ).rowCount,
              1,
            );
            await assert.rejects(
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_media.assets SET manifest_digest=$2 WHERE id=$1',
                  [asset.id, 'f'.repeat(64)],
                ),
              ),
            );
          },
        );
      await t.test(
        'unknown bytes cannot acquire synthetic approval or storage plan',
        async () => {
          const fixture = fixtures[0]!;
          const intent = await prepare(fixture);
          const unknown = Buffer.from(fixture.bytes);
          unknown[unknown.length - 1] = unknown[unknown.length - 1]! ^ 1;
          await assert.rejects(
            worker.upload(intent.actor, intent.intentId, unknown),
            /SYNTHETIC_MEDIA_UNAVAILABLE/,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1',
                [intent.intentId],
              )
            ).rowCount,
            0,
          );
          assert.equal(await state(intent.intentId), 'prepared');
          await withCommunityScopeWriter(f.pool, (tx) =>
            worker.lifecycle.cancel(intent.actor, intent.intentId, tx),
          );
        },
      );
      for (const point of [
        'uploaded',
        'sealed',
        'thumb-written',
        'display-written',
      ] as const) {
        await t.test(
          `retry after ${point} reuses durable exact objects and one asset`,
          async () => {
            const fixture = fixtures[0]!;
            const intent = await prepare(fixture);
            let injected = false;
            const crashing = new SyntheticMediaWorker(
              f.pool,
              storage,
              registry,
              async (observed: SyntheticCrashPoint) => {
                if (observed === point && !injected) {
                  injected = true;
                  throw new Error('INJECTED_CRASH');
                }
              },
            );
            if (point === 'uploaded')
              await assert.rejects(
                crashing.upload(intent.actor, intent.intentId, fixture.bytes),
                /INJECTED_CRASH/,
              );
            else {
              await crashing.upload(
                intent.actor,
                intent.intentId,
                fixture.bytes,
              );
              if (point === 'sealed')
                await assert.rejects(crashing.runOne('seal'), /INJECTED_CRASH/);
              else {
                await crashing.runOne('seal');
                await assert.rejects(
                  crashing.runOne('process'),
                  /INJECTED_CRASH/,
                );
              }
            }
            const attempts = (
              await f.pool.query(
                'SELECT * FROM whaleu_media.object_attempts WHERE intent_id=$1',
                [intent.intentId],
              )
            ).rows;
            const destinations = (
              await f.pool.query(
                'SELECT id,object_key,object_version FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY id',
                [intent.intentId],
              )
            ).rows;
            // Simulates lease expiration, not process-death/quiescence proof.
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "UPDATE whaleu_media.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE intent_id=$1 AND status='leased'",
                [intent.intentId],
              ),
            );
            const restarted = new SyntheticMediaWorker(
              f.pool,
              storage,
              registry,
            );
            if (point === 'uploaded')
              await restarted.upload(
                intent.actor,
                intent.intentId,
                fixture.bytes,
              );
            if (point === 'uploaded' || point === 'sealed')
              await restarted.runOne('seal');
            await restarted.runOne('process');
            await restarted.runOne('review');
            assert.equal(await state(intent.intentId), 'ready');
            const resumed = (
              await f.pool.query(
                'SELECT * FROM whaleu_media.object_attempts WHERE intent_id=$1',
                [intent.intentId],
              )
            ).rows;
            assert.equal(resumed.length, 1);
            assert.equal(resumed[0].id, attempts[0].id);
            assert.equal(resumed[0].source_version, attempts[0].source_version);
            assert.equal(resumed[0].sealed_version, attempts[0].sealed_version);
            if (destinations.length)
              assert.deepEqual(
                (
                  await f.pool.query(
                    'SELECT id,object_key,object_version FROM whaleu_media.derived_object_attempts WHERE intent_id=$1 ORDER BY id',
                    [intent.intentId],
                  )
                ).rows,
                destinations,
              );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                  [intent.intentId],
                )
              ).rowCount,
              1,
            );
          },
        );
      }
      await t.test(
        'cancellation fences stale lease and retains exact planned orphan obligations',
        async () => {
          const fixture = fixtures[0]!;
          const intent = await prepare(fixture);
          await worker.upload(intent.actor, intent.intentId, fixture.bytes);
          await worker.runOne('seal');
          const crashing = new SyntheticMediaWorker(
            f.pool,
            storage,
            registry,
            async (point) => {
              if (point === 'thumb-written') throw new Error('INJECTED_CRASH');
            },
          );
          await assert.rejects(crashing.runOne('process'), /INJECTED_CRASH/);
          const row = (
            await f.pool.query<{
              id: string;
              expected_generation: string;
              lease_token: string;
              attempt: number;
              object_attempt_id: string;
            }>(
              "SELECT * FROM whaleu_media.jobs WHERE intent_id=$1 AND kind='process'",
              [intent.intentId],
            )
          ).rows[0]!;
          assert.equal(
            await withCommunityScopeWriter(f.pool, (tx) =>
              worker.lifecycle.settleJob(
                {
                  id: row.id,
                  intentId: intent.intentId,
                  kind: 'process',
                  generation: row.expected_generation,
                  token: randomUUID(),
                  attempt: row.attempt,
                  objectAttemptId: row.object_attempt_id,
                },
                'succeeded',
                tx,
              ),
            ),
            false,
            'matching generation with wrong token cannot settle',
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            worker.lifecycle.cancel(intent.actor, intent.intentId, tx),
          );
          assert.equal(
            await withCommunityScopeWriter(f.pool, (tx) =>
              worker.lifecycle.settleJob(
                {
                  id: row.id,
                  intentId: intent.intentId,
                  kind: 'process',
                  generation: row.expected_generation,
                  token: row.lease_token,
                  attempt: row.attempt,
                  objectAttemptId: row.object_attempt_id,
                },
                'succeeded',
                tx,
              ),
            ),
            false,
          );
          assert.equal(await worker.runOne('process'), false);
          assert.equal(await state(intent.intentId), 'cancelled');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                [intent.intentId],
              )
            ).rowCount,
            0,
          );
          const cleanup = (
            await f.pool.query<{ state: string }>(
              `SELECT c.state FROM whaleu_media.cleanup_obligations c
        LEFT JOIN whaleu_media.object_attempts a ON a.id=c.object_attempt_id
        LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
        WHERE coalesce(a.intent_id,d.intent_id)=$1`,
              [intent.intentId],
            )
          ).rows;
          assert.equal(
            cleanup.length,
            4,
            'staging, sealed and both planned derivative destinations remain accountable',
          );
          assert.ok(
            cleanup.every((item) => item.state === 'pending'),
            'obligations are not deletion/quiescence proof',
          );
        },
      );
    } finally {
      await storage.dispose();
      await f.close();
    }
  },
);
