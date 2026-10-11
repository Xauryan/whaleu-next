/** Real Category extension snapshots and final read fences, never injected proof facts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { categoryIconManagementFixture } from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { checkTransactionDeadlines } from '../../src/database/transaction-deadlines.js';
import { retainCategoryIconState } from '../../src/ratings/category-management/icon-proof.js';

test(
  'two Category final readers coexist while a third zero-row owner writer waits for both exact fences',
  { timeout: 120000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    await f.execute(
      f.intent(await f.context(), 'create_categories_scoped', {
        parentId: null,
        placement: { kind: 'global' },
        nodes: [
          {
            key: 'root',
            parentKey: null,
            name: 'Actual Category fence',
            description: 'Exact original release',
            icon: { mode: 'clear' },
          },
        ],
      }),
    );
    const keys = [...f.scopeKeys].sort();
    const latch = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const firstReady = latch(),
      secondReady = latch(),
      releaseFirst = latch(),
      releaseSecond = latch();
    let firstPid = 0,
      secondPid = 0,
      writerPid = 0,
      finished = false;
    t.after(() => {
      releaseFirst.resolve();
      releaseSecond.resolve();
    });
    const first = inTransaction(
      f.pool,
      async (tx) => {
        firstPid = (
          await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        await retainCategoryIconState(keys, tx);
        await checkTransactionDeadlines(tx);
        firstReady.resolve();
        await releaseFirst.promise;
      },
      { isolationLevel: 'read committed' },
    );
    const second = inTransaction(
      f.pool,
      async (tx) => {
        secondPid = (
          await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        await retainCategoryIconState(keys, tx);
        await checkTransactionDeadlines(tx);
        secondReady.resolve();
        await releaseSecond.promise;
      },
      { isolationLevel: 'read committed' },
    );
    await Promise.all([firstReady.promise, secondReady.promise]);
    const locks = (
      await f.pool.query<{ pid: number }>(
        `SELECT DISTINCT pid FROM pg_locks WHERE relation='whaleu_ratings.category_icon_epoch'::regclass AND mode='RowShareLock' AND granted AND pid=ANY($1::int[])`,
        [[firstPid, secondPid]],
      )
    ).rows;
    assert.equal(
      locks.length,
      2,
      'Both actual readers hold their final Category epoch fences',
    );
    const writer = withCommunityScopeWriter(f.pool, async (tx) => {
      writerPid = (
        await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      await tx.query(
        'DELETE FROM whaleu_ratings.category_icon_upload_scope_fences WHERE false',
      );
    }).then(() => {
      finished = true;
    });
    // PostgreSQL can initially report one MultiXact blocker rather than every
    // shared tuple locker. Release the first and prove the second still blocks.
    const waitBlocked = async (expected?: number) => {
      let blockers: number[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        if (writerPid)
          blockers = (
            await f.pool.query<{ ids: number[] }>(
              'SELECT pg_blocking_pids($1) ids',
              [writerPid],
            )
          ).rows[0]!.ids;
        if (expected ? blockers.includes(expected) : blockers.length > 0)
          return;
        await delay(10);
      }
      assert.fail(
        JSON.stringify({ firstPid, secondPid, writerPid, blockers, expected }),
      );
    };
    try {
      await waitBlocked();
      assert.equal(finished, false);
      releaseFirst.resolve();
      await first;
      await waitBlocked(secondPid);
      assert.equal(finished, false);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.all([first, second, writer]);
    }
    assert.equal(finished, true);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await retainCategoryIconState(keys, tx);
        await tx.query(
          'DELETE FROM whaleu_ratings.category_icon_upload_scope_fences WHERE false',
        );
      }),
      /Rating|rating|scope/i,
      'An outer captured Category read cannot be erased by a zero-row writer',
    );
    await inTransaction(f.pool, (tx) => retainCategoryIconState(keys, tx), {
      isolationLevel: 'read committed',
    });
  },
);
