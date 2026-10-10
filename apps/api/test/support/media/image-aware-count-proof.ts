import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { captureImageAwareCountProof } from '../../../src/community/count-proof.js';
import { CommunityDiscoveryCounts } from '../../../src/community/discovery-counts.js';
import { ContentReviewCountFacade } from '../../../src/community/content-review/count-snapshot.facade.js';
import { ContentReviewCountRepository } from '../../../src/community/content-review/count-snapshot.repository.js';
import { LikedHistoryRepository } from '../../../src/community/liked/repository.js';
import { CampusContentScopeFacade } from '../../../src/campus/content-scope.facade.js';
import { SafetyContentVisibilityFacade } from '../../../src/safety/content-visibility.facade.js';
import { inTransaction } from '../../../src/database/database.js';
import {
  OptionalCountRunner,
  OptionalCountUnavailable,
} from '../../../src/database/optional-count.js';
import { ApplicationError } from '../../../src/http/application-error.js';
import {
  MediaRequiredProof,
  mediaCountProofOwner,
} from '../../../src/media/required-proof.js';
import { CountProofCollector } from '../../../src/database/count-proof.js';
import {
  checkTransactionDeadlines,
  hasTransactionDeadlines,
  registerOptionalTransactionProof,
  registerTransactionDeadline,
} from '../../../src/database/transaction-deadlines.js';

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
  'upload_request_fences',
  'upload_ingress',
  'upload_ingress_writers',
] as const;

/** Run inside the disposable synthetic Media fixture's existing migration lease.
 * These tests exercise optional finalization with real owner triggers/locks;
 * no publication, provider, object bytes, or production switch is involved. */
export async function verifyImageAwareCountProof(
  t: TestContext,
  pool: Pool,
  image: { postId: string; accountId: string },
) {
  const count = (between: () => Promise<void> = async () => {}) =>
    inTransaction(
      pool,
      async (tx) => {
        registerTransactionDeadline(
          tx,
          Date.now() + 60000,
          'ACCESS_TOKEN_EXPIRED',
        );
        const proof = await captureImageAwareCountProof(tx);
        assert.ok(proof, 'This fixture requires fixed128 writer capacity');
        proof.requireMedia();
        const result = {
          page: 'independently-authorized',
          total: 4097 as number | null,
        };
        registerOptionalTransactionProof(tx, {
          validate: () => proof.validate(tx),
          invalidate: () => {
            result.total = null;
          },
        });
        await between();
        return result;
      },
      { isolationLevel: 'read committed' },
    );

  await t.test(
    'optional budget proxies never become mandatory Media transaction identities',
    async () => {
      const value = await inTransaction(
        pool,
        async (tx) => {
          const runner = new OptionalCountRunner(8);
          const count = await runner.attempt(
            tx,
            async (read) => {
              assert.notEqual(read, tx);
              assert.equal(hasTransactionDeadlines(read), false);
              await read.query('SELECT 1');
              return { value: 1, candidates: 1 };
            },
            2000,
            async (managed, read) => {
              assert.equal(managed, tx);
              assert.equal(hasTransactionDeadlines(managed), true);
              assert.equal(hasTransactionDeadlines(read), false);
              const proof = await captureImageAwareCountProof(managed, read);
              assert.ok(proof);
              proof.requireMedia();
              return proof;
            },
            async () => assert.fail('Stable epochs need no fallback'),
          );
          assert.equal(count.status, 'known');
          const response = { total: count.value as number | null };
          if (count.status === 'known')
            registerOptionalTransactionProof(tx, {
              validate: count.proof!,
              invalidate: () => {
                response.total = null;
              },
            });
          return response;
        },
        { isolationLevel: 'read committed' },
      );
      assert.equal(value.total, 1);
    },
  );

  await t.test(
    'optional count rollback preserves a previously enrolled mandatory Media fact',
    async () => {
      for (const churn of [false, true]) {
        const read = inTransaction(
          pool,
          async (tx) => {
            await new MediaRequiredProof().capture(tx);
            const count = await new OptionalCountRunner(8).attempt(
              tx,
              async () => {
                throw new OptionalCountUnavailable();
              },
              2000,
              captureImageAwareCountProof,
              async () => {},
            );
            assert.equal(count.status, 'unavailable');
            if (churn)
              await pool.query('DELETE FROM whaleu_media.bindings WHERE false');
            return 'page-authorized';
          },
          { isolationLevel: 'read committed' },
        );
        if (churn)
          await assert.rejects(
            read,
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'MEDIA_UNAVAILABLE',
          );
        else assert.equal(await read, 'page-authorized');
      }
    },
  );

  await t.test(
    'failed backend batch SQL rolls back through the real managed transaction and preserves earlier Media authority',
    async () => {
      for (const churn of [false, true]) {
        let attempted = false;
        const work = inTransaction(
          pool,
          async (tx) => {
            await new MediaRequiredProof().capture(tx);
            const facts = new ContentReviewCountFacade(
              new ContentReviewCountRepository(),
              new CampusContentScopeFacade(),
              new SafetyContentVisibilityFacade(),
              {
                readBatch: async (references, read) => {
                  attempted = true;
                  assert.ok(
                    references.some(
                      (reference) =>
                        reference.parent.resourceId === image.postId,
                    ),
                  );
                  assert.notEqual(read, tx);
                  assert.equal(hasTransactionDeadlines(read), false);
                  await read.query(
                    'SELECT * FROM whaleu_media.discovery_count_absent_fixture_relation',
                  );
                  return new Map();
                },
              },
            );
            const counts = new CommunityDiscoveryCounts(
              facts,
              new LikedHistoryRepository(),
              { PG_POOL_MAX: 8 },
            );
            const result = await counts.profile(
              image.accountId,
              image.accountId,
              'posts',
              tx,
            );
            assert.equal(result.status, 'unavailable');
            assert.equal(
              (await tx.query<{ ready: number }>('SELECT 1 ready')).rows[0]!
                .ready,
              1,
            );
            if (churn)
              await pool.query('DELETE FROM whaleu_media.bindings WHERE false');
            return 'earlier-page-still-authorized';
          },
          { isolationLevel: 'read committed' },
        );
        if (churn)
          await assert.rejects(
            work,
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'MEDIA_UNAVAILABLE',
          );
        else assert.equal(await work, 'earlier-page-still-authorized');
        assert.equal(attempted, true);
      }
    },
  );

  await t.test(
    'v2 optional counts reject every active Media zero-row writer without invalidating the page',
    async () => {
      for (const source of ['media_owner_states', ...sources]) {
        const writer = await pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(`DELETE FROM whaleu_media.${source} WHERE false`);
          assert.deepEqual(
            await count(),
            { page: 'independently-authorized', total: null },
            source,
          );
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      }
      assert.deepEqual(await count(), {
        page: 'independently-authorized',
        total: 4097,
      });
    },
  );

  await t.test(
    'two Media-only optional final readers share relation fences (independent of Community legacy gate)',
    async () => {
      await inTransaction(
        pool,
        async (first) => {
          const proof = await CountProofCollector.capture(first, [
            mediaCountProofOwner,
          ]);
          assert.ok(proof);
          let firstInvalidated = false;
          registerOptionalTransactionProof(first, {
            validate: () => proof.validate(first),
            invalidate: () => {
              firstInvalidated = true;
            },
          });
          await checkTransactionDeadlines(first);
          assert.equal(firstInvalidated, false);
          await inTransaction(
            pool,
            async (second) => {
              const other = await CountProofCollector.capture(second, [
                mediaCountProofOwner,
              ]);
              assert.ok(other);
              let secondInvalidated = false;
              registerOptionalTransactionProof(second, {
                validate: () => other.validate(second),
                invalidate: () => {
                  secondInvalidated = true;
                },
              });
              await checkTransactionDeadlines(second);
              assert.equal(secondInvalidated, false);
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
                    `SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[])
          AND relation='whaleu_media.media_owner_states'::regclass AND mode='ShareLock' AND granted`,
                    [pids],
                  )
                ).rowCount,
                2,
              );
              assert.equal(
                (
                  await pool.query(
                    `SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[])
          AND locktype='advisory' AND classid=1464356110::oid`,
                    [pids],
                  )
                ).rowCount,
                0,
              );
            },
            { isolationLevel: 'read committed' },
          );
          assert.equal(firstInvalidated, false);
        },
        { isolationLevel: 'read committed' },
      );
    },
  );

  await t.test(
    'full v2 overlap retains the legacy Community conflict and invalidates only the competing count',
    async () => {
      await inTransaction(
        pool,
        async (first) => {
          const proof = await captureImageAwareCountProof(first);
          assert.ok(proof);
          proof.requireMedia();
          let firstInvalidated = false;
          registerOptionalTransactionProof(first, {
            validate: () => proof.validate(first),
            invalidate: () => {
              firstInvalidated = true;
            },
          });
          await checkTransactionDeadlines(first);
          assert.equal(firstInvalidated, false);
          const second = await inTransaction(
            pool,
            async (tx) => {
              registerTransactionDeadline(
                tx,
                Date.now() + 60000,
                'ACCESS_TOKEN_EXPIRED',
              );
              const other = await captureImageAwareCountProof(tx);
              assert.ok(other);
              other.requireMedia();
              const result = {
                page: 'authorized',
                images: 4097 as number | null,
                independent: 3 as number | null,
              };
              registerOptionalTransactionProof(tx, {
                validate: () => other.validate(tx),
                invalidate: () => {
                  result.images = null;
                },
              });
              registerOptionalTransactionProof(tx, {
                validate: async () => true,
                invalidate: () => {
                  result.independent = null;
                },
              });
              return result;
            },
            { isolationLevel: 'read committed' },
          );
          assert.deepEqual(second, {
            page: 'authorized',
            images: null,
            independent: 3,
          });
          assert.equal(firstInvalidated, false);
        },
        { isolationLevel: 'read committed' },
      );
    },
  );

  await t.test(
    'committed Media-only epoch churn after early capture invalidates the optional v2 result',
    async () => {
      const result = await count(async () => {
        await pool.query('DELETE FROM whaleu_media.bindings WHERE false');
      });
      assert.deepEqual(result, {
        page: 'independently-authorized',
        total: null,
      });
    },
  );

  await t.test(
    'retained optional v2 Media source fence blocks a real writer before its source statement',
    async () => {
      const writer = await pool.connect();
      let pending: Promise<{ error?: unknown }> | undefined;
      try {
        await writer.query('BEGIN');
        const pid = (
          await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
        ).rows[0]!.pid;
        const result = await inTransaction(
          pool,
          async (tx) => {
            const proof = await captureImageAwareCountProof(tx);
            assert.ok(proof);
            proof.requireMedia();
            const result = { total: 1 as number | null };
            registerOptionalTransactionProof(tx, {
              validate: () => proof.validate(tx),
              invalidate: () => {
                result.total = null;
              },
            });
            await checkTransactionDeadlines(tx);
            assert.equal(result.total, 1);
            pending = writer
              .query('DELETE FROM whaleu_media.bindings WHERE false')
              .then(
                () => ({}),
                (error: unknown) => ({ error }),
              );
            let observed = false;
            const expires = performance.now() + 5000;
            while (performance.now() < expires) {
              observed =
                (
                  await pool.query(
                    `SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_media.bindings'::regclass
              AND mode='RowExclusiveLock' AND NOT granted`,
                    [pid],
                  )
                ).rowCount === 1;
              if (observed) break;
              await sleep(10);
            }
            assert.equal(
              observed,
              true,
              'A pg_locks barrier proves the writer waits before mutation',
            );
            return result;
          },
          { isolationLevel: 'read committed' },
        );
        assert.equal(result.total, 1);
        assert.equal((await pending!).error, undefined);
      } finally {
        if (pending) await pending;
        await writer.query('ROLLBACK');
        writer.release();
      }
    },
  );
}
