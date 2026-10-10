import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { inTransaction } from '../../../src/database/database.js';
import { checkTransactionDeadlines } from '../../../src/database/transaction-deadlines.js';
import { MediaRequiredProof } from '../../../src/media/required-proof.js';

const sources = [
  'upload_intents',
  'quota_reservations',
  'object_attempts',
  'assets',
  'variants',
  'asset_safety_events',
  'asset_safety_heads',
  'scope_consumptions',
  'bindings',
  'jobs',
  'cleanup_obligations',
  'derived_object_attempts',
];
export async function verifyMediaOwnerFenceConcurrency(
  t: TestContext,
  pool: Pool,
) {
  const prove = () =>
    inTransaction(pool, (tx) => new MediaRequiredProof().capture(tx), {
      isolationLevel: 'read committed',
    });
  await t.test(
    'Every Media source has an enabled BEFORE STATEMENT epoch writer for all mutation kinds',
    async () => {
      const rows = (
        await pool.query<{
          table_name: string;
          tgtype: number;
          tgenabled: string;
        }>(
          `SELECT c.relname table_name,t.tgtype,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='whaleu_media' AND t.tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure ORDER BY c.relname`,
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => r.table_name),
        [...sources].sort(),
      );
      for (const row of rows) {
        assert.equal(row.tgtype, 62);
        assert.equal(row.tgenabled, 'O');
      }
    },
  );
  await t.test(
    'Every zero-row Media writer excludes required final readers and rollback restores proof',
    async () => {
      for (const source of sources) {
        const writer = await pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(`DELETE FROM whaleu_media.${source} WHERE false`);
          await assert.rejects(prove(), /Media|media/);
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
        await prove();
      }
    },
  );
  await t.test(
    'Two Media final readers hold compatible epoch SHARE locks without advisory reader gates',
    async () => {
      await inTransaction(
        pool,
        async (first) => {
          await new MediaRequiredProof().capture(first);
          await checkTransactionDeadlines(first);
          await inTransaction(
            pool,
            async (second) => {
              await new MediaRequiredProof().capture(second);
              await checkTransactionDeadlines(second);
              const pids = [
                (
                  await first.query<{ pid: number }>(
                    'SELECT pg_backend_pid() pid',
                  )
                ).rows[0]!.pid,
                (
                  await second.query<{ pid: number }>(
                    'SELECT pg_backend_pid() pid',
                  )
                ).rows[0]!.pid,
              ];
              assert.equal(
                (
                  await pool.query(
                    `SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[]) AND relation='whaleu_media.media_owner_states'::regclass AND mode='ShareLock' AND granted`,
                    [pids],
                  )
                ).rowCount,
                2,
              );
              assert.equal(
                (
                  await pool.query(
                    `SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND classid=1464356110::oid`,
                    [pids],
                  )
                ).rowCount,
                0,
              );
            },
            { isolationLevel: 'read committed' },
          );
        },
        { isolationLevel: 'read committed' },
      );
    },
  );
  await t.test(
    'Media reader-first final fence makes a real writer wait before source mutation',
    async () => {
      const writer = await pool.connect();
      let pending: Promise<{ error?: unknown }> | undefined;
      try {
        await writer.query('BEGIN');
        const pid = (
          await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        await inTransaction(
          pool,
          async (reader) => {
            await new MediaRequiredProof().capture(reader);
            await checkTransactionDeadlines(reader);
            pending = writer
              .query('DELETE FROM whaleu_media.bindings WHERE false')
              .then(
                () => ({}),
                (error: unknown) => ({ error }),
              );
            let observed = false;
            const until = Date.now() + 5000;
            while (Date.now() < until) {
              observed =
                (
                  await pool.query(
                    `SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_media.bindings'::regclass AND mode='RowExclusiveLock' AND NOT granted`,
                    [pid],
                  )
                ).rowCount === 1;
              if (observed) break;
              await sleep(10);
            }
            assert.equal(
              observed,
              true,
              'the actual writer must wait on the retained source SHARE fence',
            );
          },
          { isolationLevel: 'read committed' },
        );
        assert.equal((await pending!).error, undefined);
        await writer.query('ROLLBACK');
        await prove();
      } finally {
        if (pending) await pending;
        await writer.query('ROLLBACK');
        writer.release();
      }
    },
  );
  await t.test(
    'Original Media writer overflow waits on legacy gate and retries after reader rollback',
    async () => {
      const legacy = await pool.connect(),
        writer = await pool.connect();
      let pending: Promise<{ error?: unknown }> | undefined;
      try {
        await legacy.query('BEGIN');
        await legacy.query('SELECT pg_advisory_xact_lock(1464356110,128)');
        await legacy.query(
          'SELECT pg_advisory_xact_lock_shared(1464356110,s) FROM generate_series(0,127) s',
        );
        await writer.query('BEGIN');
        const pid = (
          await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        pending = writer
          .query('DELETE FROM whaleu_media.bindings WHERE false')
          .then(
            () => ({}),
            (error: unknown) => ({ error }),
          );
        let observed = false;
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          observed =
            (
              await pool.query(
                `SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=1464356110::oid AND objid=128::oid AND mode='ShareLock' AND NOT granted`,
                [pid],
              )
            ).rowCount === 1;
          if (observed) break;
          await sleep(10);
        }
        assert.equal(
          observed,
          true,
          'writer must reach the original saturated-slot overflow gate',
        );
        await legacy.query('ROLLBACK');
        assert.equal((await pending).error, undefined);
        await assert.rejects(prove(), /Media|media/);
        await writer.query('ROLLBACK');
        await prove();
      } finally {
        await legacy.query('ROLLBACK');
        if (pending) await pending;
        await writer.query('ROLLBACK');
        legacy.release();
        writer.release();
      }
    },
  );
}
