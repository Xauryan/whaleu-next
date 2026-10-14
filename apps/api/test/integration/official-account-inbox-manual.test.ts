import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { OfficialSourceSelector } from '../../src/official-account-operations/selection.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
import { ApplicationError } from '../../src/http/application-error.js';

test(
  'manual newest reads tolerate old committed inbox backlog but veto late low-xid source and dependency commits',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const older = await f.publish('Older manual source'),
        newer = await f.publish('Newest manual source');
      const space = f.world.scope.home.spaceId;
      const selector = new OfficialSourceSelector(f.source);
      const select = async () =>
        f.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            return selector.select(
              {
                schoolSpaceId: space,
                citySpaceId: null,
                kind: 'manual_newest',
                limit: 1,
              },
              tx,
            );
          },
          { isolationLevel: 'read committed' },
        );
      assert.ok(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_official.pending_causes LIMIT 1',
          )
        ).rowCount,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT baseline_started FROM whaleu_official.source_roots WHERE space_id=$1',
            [space],
          )
        ).rows[0].baseline_started,
        false,
      );
      assert.deepEqual(
        (await select()).facts.map((fact) => fact.postId),
        [newer.id],
      );
      const other = await f.actor();
      for (const kind of ['source', 'dependency'] as const) {
        const low = await f.pool.connect();
        try {
          await low.query('BEGIN');
          const xid = (
            await low.query<{ xid: string }>(
              'SELECT pg_current_xact_id()::text xid',
            )
          ).rows[0]!.xid;
          if (kind === 'source')
            await low.query(
              'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
              [older.id],
            );
          else
            await low.query(
              'UPDATE whaleu_identity.accounts SET id=id WHERE id=$1',
              [other.accountId],
            );
          let observed = false;
          await assert.rejects(
            f.database.transaction(
              async (tx) => {
                await boundHotTransaction(tx);
                const snapshot = (
                  await tx.query<{ snapshot: string }>(
                    'SELECT pg_current_snapshot()::text snapshot',
                  )
                ).rows[0]!.snapshot;
                assert.equal(
                  (
                    await tx.query<{ visible: boolean }>(
                      'SELECT pg_visible_in_snapshot($1::xid8,$2::pg_snapshot) visible',
                      [xid, snapshot],
                    )
                  ).rows[0]!.visible,
                  false,
                );
                const result = await selector.select(
                  {
                    schoolSpaceId: space,
                    citySpaceId: null,
                    kind: 'manual_newest',
                    limit: 1,
                  },
                  tx,
                );
                assert.deepEqual(
                  result.facts.map((fact) => fact.postId),
                  [newer.id],
                );
                await low.query('COMMIT');
                observed = true;
                return result;
              },
              { isolationLevel: 'read committed' },
            ),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'OFFICIAL_SOURCE_UNAVAILABLE',
          );
          assert.equal(
            observed,
            true,
            'The low transaction committed after selection and before final proof',
          );
          assert.ok(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_official.pending_causes WHERE source_xid=$1::xid8 AND kind=$2',
                [xid, kind],
              )
            ).rowCount,
          );
          // It is now an old committed obligation, so manual reads do not require a daily rebuild.
          assert.deepEqual(
            (await select()).facts.map((fact) => fact.postId),
            [newer.id],
          );
        } finally {
          await low.query('ROLLBACK');
          low.release();
        }
      }
      await f.ready();
    } finally {
      await f.close();
    }
  },
);
