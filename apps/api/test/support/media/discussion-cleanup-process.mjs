/** Disposable PostgreSQL crash fixture only; no provider, storage or HTTP access. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { inTransaction } from '../../../src/database/database.ts';
import { assertLocalExperienceConnection } from '../../../src/experience/worker.ts';
import { CommunityMediaCleanupFacade } from '../../../src/community/media/cleanup-facade.ts';
import { CommunityMediaCleanupWorker } from '../../../src/community/media/cleanup-worker.ts';
import { UnavailableCommunityMediaAttachment } from '../../../src/community/media/unavailable-attachment.ts';

process.once('message', async (message) => {
  let pool;
  try {
    assert.equal(message.command, 'run');
    const url = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    pool = new Pool({
      connectionString: url.toString(),
      ssl: false,
      max: 1,
      statement_timeout: 15000,
    });
    const database = {
      transaction: (operation) =>
        inTransaction(
          pool,
          async (tx) => {
            await assertLocalExperienceConnection(tx);
            return operation(tx);
          },
          { isolationLevel: 'read committed' },
        ),
    };
    class PausingDetach extends UnavailableCommunityMediaAttachment {
      async detachMany(targets, tx) {
        await super.detachMany(targets, tx);
        const target = targets.find(
          (value) => value.id === message.pauseTarget,
        );
        if (target) {
          process.send?.({
            event: 'detached-before-cursor',
            kind: target.kind,
            id: target.id,
          });
          await new Promise(() => {});
        }
      }
    }
    const result = await new CommunityMediaCleanupWorker(
      database,
      new CommunityMediaCleanupFacade(),
      new PausingDetach(),
    ).runOnePage(message.jobId);
    process.send?.({ event: 'completed', result });
    await pool.end();
    process.exit(0);
  } catch (error) {
    process.send?.({
      event: 'failure',
      error: error instanceof Error ? error.message : 'cleanup failed',
    });
    await pool?.end();
    process.exit(1);
  }
});
