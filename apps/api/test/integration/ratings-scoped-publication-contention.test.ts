import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../src/http/application-error.js';
import {
  ratingScopedFixture,
  writeRatingScopedSource,
} from '../support/rating-scoped-fixture.js';

// Do not prelock or retry this setup: it preserves the production publication
// failure that the full-pool expiry test deliberately isolates its setup from.
test(
  'a real publication epoch conflict rolls back all setup state; the same source identity publishes after release',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    await f.seedScopedCatalogs({ different: false });
    await f.publish({ activate: true });
    const source = {
      id: randomUUID(),
      revision: randomUUID(),
      kind: 'scope_absence' as const,
      key: 'global',
      scopeKeys: ['global'],
      payload: (
        await f.pool.query(
          `SELECT s.payload FROM whaleu_ratings.scoped_source_heads h
          JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
          WHERE h.source_kind='scope_absence' AND h.source_key='global'`,
        )
      ).rows[0]!.payload as Record<string, unknown>,
    };
    const domain = { kind: 'global_compat' as const };
    const snapshot = async () => {
      // Include all application rows, not just the source head or release count:
      // deferred compatibility projection, lineage, receipts and epochs count.
      const tables = (
        await f.pool.query<{ table_schema: string; table_name: string }>(
          "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema LIKE 'whaleu\\_%' ESCAPE '\\' AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
        )
      ).rows;
      const state: Record<string, unknown> = {};
      for (const { table_schema, table_name } of tables) {
        assert.match(table_schema, /^[a-z_][a-z0-9_]*$/);
        assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
        state[`${table_schema}.${table_name}`] = (
          await f.pool.query(
            `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) rows FROM ${table_schema}.${table_name} r`,
          )
        ).rows[0]!.rows;
      }
      state['sequences'] = (
        await f.pool.query(
          "SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY schemaname,sequencename",
        )
      ).rows;
      return state;
    };
    const before = await snapshot();
    const holder = await f.pool.connect();
    const finalFence =
      'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT';
    let restore: (() => void) | undefined;
    let rawCode: unknown;
    let rawMessage: unknown;
    let rollbacks = 0;
    let commits = 0;
    let attemptedFinal = 0;
    try {
      await holder.query('BEGIN');
      // Real SQL, no injected error. This mode admits the ordinary publication
      // ROW EXCLUSIVE write phase but conflicts with its final SHARE NOWAIT.
      await holder.query(
        'LOCK TABLE whaleu_ratings.navigation_epoch IN SHARE UPDATE EXCLUSIVE MODE',
      );
      assert.equal(
        (
          await holder.query(
            `SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid()
            AND relation='whaleu_ratings.navigation_epoch'::regclass
            AND mode='ShareUpdateExclusiveLock' AND granted`,
          )
        ).rows[0]!.n,
        1,
      );
      await assert.rejects(
        f.atomicChange(
          async (tx) => {
            // The ordinary fixture's first authority lock is still its policy
            // gate. The raw competing connection intentionally holds no gate.
            assert.equal(
              (
                await tx.query(
                  `SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid()
                AND locktype='advisory' AND mode='ExclusiveLock' AND granted`,
                )
              ).rows[0]!.n,
              1,
            );
            const original = tx.query.bind(tx);
            restore = () => {
              tx.query = original;
            };
            // Observe and rethrow the actual driver error; never fabricate a
            // result, bypass the final proof, or turn its rejection into success.
            tx.query = (async (sql: string, values?: unknown[]) => {
              if (sql === finalFence) attemptedFinal++;
              try {
                const result = await original(sql, values);
                if (sql === 'ROLLBACK') rollbacks++;
                if (sql === 'COMMIT') commits++;
                return result;
              } catch (error) {
                if (sql === finalFence) {
                  rawMessage =
                    error instanceof Error ? error.message : undefined;
                  rawCode =
                    error && typeof error === 'object' && 'code' in error
                      ? error.code
                      : undefined;
                }
                throw error;
              }
            }) as PoolClient['query'];
            await writeRatingScopedSource(tx, source);
            assert.equal(
              (
                await tx.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.scoped_source_attestations WHERE id=$1 AND revision=$2',
                  [source.id, source.revision],
                )
              ).rows[0]!.n,
              1,
              'The failed transaction really wrote its tentative source',
            );
          },
          { domain },
        ),
        (error: unknown) => {
          assert.ok(error instanceof ApplicationError);
          assert.equal(error.code, 'RATING_UNAVAILABLE');
          assert.equal(error.getStatus(), 503);
          return true;
        },
      );
      restore?.();
      restore = undefined;
      assert.equal(attemptedFinal, 1);
      assert.equal(rawCode, '55P03');
      assert.equal(typeof rawMessage, 'string');
      assert.match(rawMessage as string, /navigation_epoch/);
      assert.equal(rollbacks, 1);
      assert.equal(commits, 0);
      assert.deepEqual(
        await snapshot(),
        before,
        'The rejected source/publication setup leaves every application row and sequence unchanged',
      );
      t.diagnostic(
        'Real navigation_epoch holder: final SHARE NOWAIT returned 55P03; RATING_UNAVAILABLE/503, one ROLLBACK, no COMMIT, full state unchanged',
      );
    } finally {
      restore?.();
      await holder.query('ROLLBACK');
      holder.release();
    }
    // An explicit new transaction after verified rollback and holder release,
    // with the exact failed source identity. No catch/retry helper is involved.
    const published = await f.atomicChange(
      (tx) => writeRatingScopedSource(tx, source),
      { domain },
    );
    assert.ok(published.releaseId);
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT source_id,source_revision FROM whaleu_ratings.scoped_source_heads
          WHERE source_kind=$1 AND source_key=$2`,
          [source.kind, source.key],
        )
      ).rows[0],
      { source_id: source.id, source_revision: source.revision },
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::int n FROM whaleu_ratings.scoped_source_attestations
          WHERE id=$1 AND revision=$2`,
          [source.id, source.revision],
        )
      ).rows[0]!.n,
      1,
    );
    const categories = await f.scopedCategories(f.creator, { kind: 'global' });
    assert.equal(categories.response.status, 200);
  },
);
