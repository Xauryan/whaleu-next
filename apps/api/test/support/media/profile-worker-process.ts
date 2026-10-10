/** Explicit test worker process only: parent-owned disposable PG + private
 * synthetic root capability. No migrations, provider/device or runtime enable. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { loadConfig } from '../../../src/config/config.js';
import { poolOptions } from '../../../src/database/database.js';
import { mediaV2IdSchema } from '../../../src/media/contracts-v2.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import type { SyntheticProcessRoot } from './synthetic-storage.js';
import { SyntheticMediaWorker } from './synthetic-worker.js';
import type {
  RegisteredMediaFixture,
  SyntheticCrashPoint,
} from './synthetic-worker.js';

type Stage = 'seal' | 'process' | 'review';
interface Start {
  command: 'start';
  databaseUrl: string;
  storageRoot: SyntheticProcessRoot;
  fixtures: readonly RegisteredMediaFixture[];
  intentId: string;
  stages: readonly Stage[];
  cut: SyntheticCrashPoint | 'review-ready' | null;
  expectStale?: boolean;
}
const send = (value: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC_REQUIRED'));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
async function park(point: string): Promise<void> {
  const resumed = new Promise<void>((resolve) =>
    process.once('message', (message: unknown) => {
      assert.deepEqual(message, { command: 'continue' });
      resolve();
    }),
  );
  await send({ event: 'checkpoint', point });
  await resumed;
}
let pool: Pool | undefined, storage: SyntheticMediaStorage | undefined;
async function close() {
  await pool?.end();
  pool = undefined;
  await storage?.dispose();
  storage = undefined;
}
process.once('message', (message: Start) => {
  void (async () => {
    assert.equal(message.command, 'start');
    mediaV2IdSchema.parse(message.intentId);
    const database = new URL(message.databaseUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
    assert.equal(database.pathname, '/whaleu_test');
    assert.ok(
      [
        null,
        'sealed',
        'thumb-written',
        'display-written',
        'review-ready',
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
    storage = await SyntheticMediaStorage.reopenProcessRoot(
      message.storageRoot,
    );
    pool = new Pool(poolOptions(config));
    const identity = (
      await pool.query<{
        protocol_version: number;
        owner_kind: string;
        resource_kind: string;
        target_kind: string;
        slot: string;
        ordinal: number;
      }>(
        'SELECT protocol_version,owner_kind,resource_kind,target_kind,slot,ordinal FROM whaleu_media.upload_intents WHERE id=$1',
        [message.intentId],
      )
    ).rows[0];
    assert.deepEqual(identity, {
      protocol_version: 5,
      owner_kind: 'profile',
      resource_kind: 'avatar',
      target_kind: 'edit',
      slot: 'avatar',
      ordinal: 0,
    });
    const worker = new SyntheticMediaWorker(
      pool,
      storage,
      message.fixtures,
      async (point) => {
        if (point === message.cut) await park(point);
      },
    );
    const results: { stage: Stage; claimed: boolean }[] = [];
    try {
      for (const stage of message.stages) {
        assert.ok(['seal', 'process', 'review'].includes(stage));
        // This isolated test process must not claim another actor's pending work.
        assert.equal(
          (
            await pool.query(
              `SELECT 1 FROM whaleu_media.jobs j JOIN whaleu_media.upload_intents i ON i.id=j.intent_id WHERE j.kind=$1 AND i.id<>$2 AND i.state IN ('sealing','processing','awaiting_review') AND j.status IN ('pending','retryable','leased')`,
              [stage, message.intentId],
            )
          ).rowCount,
          0,
        );
        const claimed = await worker.runOne(stage);
        results.push({ stage, claimed });
        if (message.cut === 'review-ready' && stage === 'review' && claimed)
          await park('review-ready');
      }
      assert.notEqual(
        message.expectStale,
        true,
        'Old generation unexpectedly settled',
      );
      await send({ event: 'worker-complete', results });
    } catch (error) {
      if (
        !message.expectStale ||
        !(error instanceof Error) ||
        error.message !== 'SYNTHETIC_MEDIA_UNAVAILABLE'
      )
        throw error;
      await send({ event: 'worker-rejected', reason: 'stale-generation' });
    }
    await close();
    process.exit(0);
  })().catch(async (error: unknown) => {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.message : 'Profile worker failed',
    }).catch(() => undefined);
    await close().catch(() => undefined);
    process.exit(1);
  });
});
