import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { officialAccountFixture } from '../support/official-account-fixture.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { OfficialDraftCoverageMaintainer } from '../../src/official-account-operations/coverage.js';
import { OfficialSourceSelector } from '../../src/official-account-operations/selection.js';
import { boundHotTransaction } from '../../src/community/hot-score/transaction.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';

test(
  'ten thousand native publications converge incrementally and prove bounded exact prefixes',
  { timeout: 1800000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      // Actual canonical publication receipts + all four native enrollment owners +
      // original Review binding and original exact-score materializer. Never seed ready.
      // Half are historical: inactive inventory must not become a hidden SQL scan.
      const refreshActors = async () => {
        for (const actor of [f.world.author, f.world.reader]) {
          const next = await f.app
            .get(IdentityService)
            .refresh(actor.refreshToken);
          assert.equal(next.accountId, actor.accountId);
          Object.assign(actor, next);
        }
      };
      const safetyPlan = async (stage: string) => {
        const plan = await f.pool.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM whaleu_safety.account_punishment_policy_observation($1,$2)',
          [f.world.author.accountId, 'content_management'],
        );
        console.log(
          'official-10k-safety-plan',
          stage,
          JSON.stringify(plan.rows),
        );
        console.log(
          'official-10k-safety-cardinality',
          stage,
          (
            await f.pool.query(
              'SELECT (SELECT count(*) FROM whaleu_safety.account_punishments) punishments,(SELECT count(*) FROM whaleu_safety.account_punishment_heads) heads,(SELECT count(*) FROM whaleu_safety.account_punishment_terminals) terminals',
            )
          ).rows,
        );
      };
      let safetyCalls = 0,
        safetyMaxMs = 0;
      f.observer.setHook(async ({ sql, durationMs }) => {
        if (sql.includes('account_punishment_policy_observation')) {
          safetyCalls++;
          safetyMaxMs = Math.max(safetyMaxMs, durationMs);
        }
      });
      await safetyPlan('before-enrollment');
      const ids: string[] = [];
      f.observer.setFailureHook(async ({ sql, code }) => {
        console.error(
          'official-10k-owner-sql-failure',
          JSON.stringify({ enrolled: ids.length, sql, code }),
        );
        try {
          await safetyPlan('after-owner-failure');
        } catch (diagnostic) {
          console.error('official-safety-plan-unavailable', String(diagnostic));
        }
      });
      for (let i = 0; i < 10000; i++) {
        const post = await f.world.dated(
          new Date(
            Date.now() - (i < 5000 ? 48 * 3600000 : 3600000) + i,
          ).toISOString(),
        );
        await f.eligibility(post.id);
        ids.push(post.id);
        if (ids.length % 1000 === 0)
          console.log('official-native-enrolled', ids.length);
      }
      await safetyPlan('after-10000-enrollment');
      console.log('official-10k-safety-observation', {
        safetyCalls,
        safetyMaxMs,
      });
      const liveIds = ids.slice(5000);
      const native = (
        await f.pool.query(
          'SELECT post_id FROM whaleu_post_hotness.view_baselines WHERE post_id=ANY($1::uuid[])',
          [ids],
        )
      ).rows;
      assert.equal(native.length, 10000);
      // Bootstrap must keep its finite high-water mark while real traffic arrives.
      const firstBatch = await f.maintain.runCycle({ programId: f.programId });
      assert.equal(firstBatch.more, true);
      const captured = (
        await f.pool.query(
          'SELECT baseline_highwater FROM whaleu_official.source_roots WHERE space_id=$1',
          [f.world.scope.home.spaceId],
        )
      ).rows[0];
      await refreshActors();
      await f.publish('arrival during finite bootstrap');
      await f.view(f.world.reader, [liveIds[0]!]);
      await f.settleAll(liveIds[0]!);
      await f.app.get(HotScoreMaterializer).refresh(liveIds[0]!);
      console.log('official-10k-finite-baseline-started', firstBatch);
      const initialized = await f.ready();
      console.log('official-10k-baseline-settled', initialized);
      assert.ok(initialized.examined + firstBatch.examined >= 10000);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT baseline_highwater FROM whaleu_official.source_roots WHERE space_id=$1',
            [f.world.scope.home.spaceId],
          )
        ).rows[0],
        captured,
      );
      assert.ok(initialized.cycles > 1);
      const selector = new OfficialSourceSelector(f.source);
      const read = (kind: 'daily_hot' | 'manual_newest') =>
        f.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            return selector.select(
              {
                schoolSpaceId: f.world.scope.home.spaceId,
                citySpaceId: null,
                kind,
              },
              tx,
            );
          },
          { isolationLevel: 'read committed' },
        );
      const daily = await read('daily_hot'),
        manual = await read('manual_newest');
      assert.equal(daily.facts.length, 30);
      assert.equal(manual.facts.length, 10);
      assert.ok(daily.examined <= 128);
      assert.ok(manual.examined <= 128);
      const baseline = (
        await f.pool.query(
          'SELECT baseline_highwater,baseline_cursor FROM whaleu_official.source_roots WHERE space_id=$1',
          [f.world.scope.home.spaceId],
        )
      ).rows[0];
      for (let round = 0; round < 4; round++) {
        await refreshActors();
        const fresh = await f.publish(`interleaved ${round}`);
        await f.view(f.world.reader, [liveIds[round]!, fresh.id]);
        await f.like(f.world.reader, liveIds[round]!);
        await f.settleAll(liveIds[round]!);
        await f.app.get(HotScoreMaterializer).refresh(liveIds[round]!);
        await f.app.get(HotScoreMaterializer).refresh(fresh.id);
        const progress = await f.ready();
        assert.ok(
          progress.examined < 128,
          `ordinary traffic inspected ${progress.examined}`,
        );
        const after = (
          await f.pool.query(
            'SELECT baseline_highwater,baseline_cursor FROM whaleu_official.source_roots WHERE space_id=$1',
            [f.world.scope.home.spaceId],
          )
        ).rows[0];
        assert.deepEqual(after, baseline);
        assert.equal((await read('daily_hot')).facts.length, 30);
      }
      // More than one cycle of temporal expiry cannot be reported ready early.
      await f.pool.query(
        "UPDATE whaleu_official.source_ranks SET valid_until=clock_timestamp()-interval '1 second' WHERE post_id=ANY($1::uuid[])",
        [liveIds.slice(0, 129)],
      );
      const expiry = await f.maintain.runCycle({ programId: f.programId });
      assert.notEqual(expiry.state, 'ready');
      assert.equal(expiry.more, true);
      await f.ready();
      assert.equal((await read('daily_hot')).facts.length, 30);
      // Historical structural unknown is not silently denied or a daily blocker.
      const old = await f.world.dated(
        new Date(Date.now() - 48 * 3600000).toISOString(),
      );
      await f.ready();
      const oldRank = (
        await f.pool.query(
          'SELECT daily_active,decision FROM whaleu_official.source_ranks WHERE post_id=$1',
          [old.id],
        )
      ).rows[0];
      assert.deepEqual(oldRank, { daily_active: false, decision: 'unknown' });
      assert.equal((await read('daily_hot')).facts.length, 30);
      const plan = await f.pool.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT post_id FROM whaleu_official.source_ranks WHERE space_id=$1 AND daily_active AND decision='allow' ORDER BY score DESC,post_id DESC LIMIT 30`,
        [f.world.scope.home.spaceId],
      );
      console.log('official-daily-frontier-plan', JSON.stringify(plan.rows));
      assert.match(JSON.stringify(plan.rows), /official_rank_frontier/);
      // A missing low-score certificate must not disappear beneath LIMIT/top-k.
      await f.pool.query(
        'DELETE FROM whaleu_post_hotness.scores WHERE post_id=$1',
        [ids.at(-1)],
      );
      await assert.rejects(() => read('daily_hot'));
      const missing = await f.maintain.runCycle({ programId: f.programId });
      assert.notEqual(missing.state, 'ready');
      await assert.rejects(() => read('daily_hot'));
      assert.equal((await read('manual_newest')).facts.length, 10);
      const plans = await f.pool.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM whaleu_community.posts WHERE space_id=$1 AND published_at<=clock_timestamp() ORDER BY published_at DESC,id DESC LIMIT 10`,
        [f.world.scope.home.spaceId],
      );
      assert.match(JSON.stringify(plans.rows), /Index/);
    } finally {
      await f.close();
    }
  },
);

test(
  'future ingress and transient owner uncertainty remain bounded durable obligations',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const live = await f.publish('temporal owner coverage');
      let unavailable = true;
      const transient = new OfficialDraftCoverageMaintainer(f.database, {
        inspect: async (id, score, tx) => {
          if (id === live.id && unavailable) {
            unavailable = false;
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
          }
          return f.source.inspect(id, score, tx);
        },
        project: f.source.project.bind(f.source),
      });
      const first = await transient.runCycle({ programId: f.programId });
      assert.notEqual(first.state, 'ready');
      const obligation = (
        await f.pool.query(
          'SELECT decision,next_proof_at FROM whaleu_official.source_ranks WHERE post_id=$1',
          [live.id],
        )
      ).rows[0];
      assert.equal(obligation.decision, 'unknown');
      assert.ok(obligation.next_proof_at);
      await new Promise((resolve) => setTimeout(resolve, 5100));
      await f.ready();
      const at = new Date(Date.now() + 15000),
        future = await f.world.dated(at.toISOString());
      await f.eligibility(future.id);
      await f.ready();
      assert.equal(
        (
          await f.pool.query(
            'SELECT daily_active FROM whaleu_official.source_ranks WHERE post_id=$1',
            [future.id],
          )
        ).rows[0].daily_active,
        false,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, at.getTime() - Date.now() + 25)),
      );
      const selector = new OfficialSourceSelector(f.source),
        read = () =>
          f.database.transaction(
            async (tx) => {
              await boundHotTransaction(tx);
              return selector.select(
                {
                  schoolSpaceId: f.world.scope.home.spaceId,
                  citySpaceId: null,
                  kind: 'daily_hot',
                },
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
      await assert.rejects(read);
      await f.ready();
      assert.ok((await read()).facts.some((x) => x.postId === future.id));
    } finally {
      await f.close();
    }
  },
);

test(
  'derived rank writes dirty exact coverage and cannot hide a low rank or bless a concurrent change',
  { timeout: 180000 },
  async () => {
    const f = await officialAccountFixture();
    try {
      const first = await f.publish('rank integrity first');
      await f.ready();
      const selector = new OfficialSourceSelector(f.source);
      const read = () =>
        f.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            return selector.select(
              {
                schoolSpaceId: f.world.scope.home.spaceId,
                citySpaceId: null,
                kind: 'daily_hot',
              },
              tx,
            );
          },
          { isolationLevel: 'read committed' },
        );
      await read();
      await f.pool.query(
        "UPDATE whaleu_official.source_ranks SET decision='deny',score=NULL,certificate_hash=NULL WHERE post_id=$1",
        [first.id],
      );
      await assert.rejects(read);
      assert.ok((await f.ready()).examined <= 128);
      assert.ok((await read()).facts.some((x) => x.postId === first.id));

      const inserted = await f.publish('rank integrity new inventory');
      const predecessor = (
        await f.pool.query<{ head: string }>(
          'SELECT head::text FROM whaleu_official.source_roots WHERE space_id=$1',
          [f.world.scope.home.spaceId],
        )
      ).rows[0]!.head;
      await f.pool.query(
        `INSERT INTO whaleu_official.source_ranks(space_id,post_id,published_at,decision,source_digest,settled_sequence,daily_active) SELECT space_id,$2,published_at,'deny',source_digest,settled_sequence,true FROM whaleu_official.source_ranks WHERE post_id=$1`,
        [first.id, inserted.id],
      );
      const current = (
        await f.pool.query<{ head: string; ready: boolean }>(
          'SELECT head::text,ready FROM whaleu_official.source_roots WHERE space_id=$1',
          [f.world.scope.home.spaceId],
        )
      ).rows[0]!;
      assert.equal(BigInt(current.head), BigInt(predecessor) + 1n);
      assert.equal(current.ready, false);
      await assert.rejects(read);
      assert.ok((await f.ready()).examined <= 128);
      assert.ok((await read()).facts.some((x) => x.postId === inserted.id));

      await f.pool.query(
        "UPDATE whaleu_official.source_ranks SET decision='deny' WHERE post_id=$1",
        [first.id],
      );
      let injected = false;
      const racing = new OfficialDraftCoverageMaintainer(f.database, {
        inspect: async (id, score, tx) => {
          if (!injected) {
            injected = true;
            await f.pool.query(
              "UPDATE whaleu_official.source_ranks SET decision='deny' WHERE post_id=$1",
              [inserted.id],
            );
          }
          return f.source.inspect(id, score, tx);
        },
        project: f.source.project.bind(f.source),
      });
      assert.notEqual(
        (await racing.runCycle({ programId: f.programId })).state,
        'ready',
      );
      assert.equal(injected, true);
      const dirty = (
        await f.pool.query(
          'SELECT post_id FROM whaleu_official.source_dirty WHERE post_id=ANY($1::uuid[])',
          [[first.id, inserted.id]],
        )
      ).rows;
      assert.equal(dirty.length, 2);
      await assert.rejects(read);
      assert.ok((await f.ready()).examined <= 128);
      assert.equal((await read()).facts.length, 2);
    } finally {
      await f.close();
    }
  },
);
