import { checkTransactionDeadlines } from '../../../src/database/transaction-deadlines.js';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../../src/database/database.js';
import { MediaAssetRepository } from '../../../src/media/asset-repository.js';
import { MediaLifecycleRepository } from '../../../src/media/lifecycle-repository.js';
import { MediaOwnerProofRegistry } from '../../../src/media/owner-proof.js';

/** Real overlapping transactions on the published synthetic asset. No sleeps,
 * timing lottery, query substitution or provider/authentication overrides. */
export async function verifyMediaReaderConcurrency(
  t: TestContext,
  pool: Pool,
  input: {
    actorId: string;
    intentId: string;
    assetId: string;
    digest: string;
    postId: string;
  },
  concurrentHttp: () => Promise<void>,
) {
  const assets = new MediaAssetRepository(new MediaOwnerProofRegistry([]));
  const lifecycle = new MediaLifecycleRepository();
  const parent = {
    ownerKind: 'community' as const,
    resourceKind: 'post' as const,
    resourceId: input.postId,
    contentVersion: 1 as const,
  };
  const prove = (tx: PoolClient) =>
    assets.verifyContentBindings(
      parent,
      [{ assetId: input.assetId, digest: input.digest }],
      tx,
    );
  const transaction = <T>(work: (tx: PoolClient) => Promise<T>) =>
    inTransaction(pool, work, { isolationLevel: 'read committed' });
  const locked = (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '55P03';

  await t.test(
    'Media readers coexist through final fences and concurrent detail/report HTTP',
    async () => {
      await transaction(async (first) => {
        await prove(first);
        await checkTransactionDeadlines(first);
        // First reader retains its intent/asset/binding/head locks while the
        // second reader completes both its exact proof and final fence.
        await transaction(async (second) => {
          await prove(second);
          assert.equal(
            await assets.readyOwned(input.actorId, input.intentId, second),
            input.assetId,
          );
        });
        await concurrentHttp();
        await prove(first);
      });
    },
  );
  await t.test(
    'Media reader-first excludes detach writers and GC intent acquisition',
    async () => {
      await transaction(async (reader) => {
        await prove(reader);
        await assert.rejects(
          transaction((writer) => assets.detach(parent, writer)),
          locked,
        );
        await transaction(async (collector) => {
          // This is the exact FOR UPDATE SKIP LOCKED acquisition used by the
          // lifecycle collector; a live reader cannot be selected for collection.
          assert.equal(
            (
              await collector.query(
                'SELECT id FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE SKIP LOCKED',
                [input.intentId],
              )
            ).rowCount,
            0,
          );
          assert.equal(await lifecycle.expireOne(collector), false);
          assert.equal(await lifecycle.claimCleanup(collector), null);
        });
        await prove(reader);
      });
      await transaction(async (writer) => {
        assert.equal(
          (
            await writer.query(
              'SELECT id FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE NOWAIT',
              [input.intentId],
            )
          ).rowCount,
          1,
        );
      });
    },
  );
  await t.test(
    'Media writer-first keeps readers fail-closed, then permits fresh proof after release',
    async () => {
      await transaction(async (writer) => {
        await writer.query(
          'SELECT id FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE NOWAIT',
          [input.intentId],
        );
        await assert.rejects(transaction(prove), locked);
        await assert.rejects(
          transaction((reader) =>
            assets.readyOwned(input.actorId, input.intentId, reader),
          ),
          locked,
        );
      });
      await transaction(prove);
    },
  );
  await t.test(
    'Media shared-to-exclusive upgrade is NOWAIT and rolls back without consuming a binding',
    async () => {
      await transaction(async (first) => {
        await prove(first);
        await assert.rejects(
          transaction(async (second) => {
            assert.equal(
              await assets.readyOwned(input.actorId, input.intentId, second),
              input.assetId,
            );
            await assets.detach(parent, second);
          }),
          locked,
        );
        await prove(first);
      });
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
            [input.assetId],
          )
        ).rowCount,
        1,
      );
      await transaction(prove);
    },
  );
}
