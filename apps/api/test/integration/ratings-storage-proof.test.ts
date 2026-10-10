import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import { ratingRuntimeFixture } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import { RatingsRepository } from '../../src/ratings/repository.js';
import { RatingsAccessService } from '../../src/ratings/access.js';
import { RatingsService } from '../../src/ratings/service.js';
import { prepareLegacyBoundaryRequest } from '../support/rating-legacy-boundary-fixture.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test('rating storage causality, independent fresh provenance and final catalog proof', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const actor = await f.actor(),
    other = await f.actor(),
    c = await f.catalog(actor),
    target = c.targets[0]!,
    service = f.app.get(RatingsService),
    records = f.app.get(RatingsRepository);
  await t.test(
    'deterministic repeated-score sequence agrees with raw scores and five buckets',
    async () => {
      let state = 13;
      const actors = [actor, other],
        revisions: (string | null)[] = [null, null];
      for (let i = 0; i < 40; i++) {
        state = (state * 48271) % 2147483647;
        const who = state % 2,
          value = (state % 5) + 1,
          a = actors[who]!;
        const receipt = await service.setScore(a.accessToken, target.id, {
          clientRequestId: randomUUID(),
          regionId: null,
          expectedTargetRevision: target.revision,
          expectedRevision: revisions[who]!,
          score: value,
        });
        assert.notEqual(receipt.outcome, 'rejected');
        if (receipt.outcome !== 'rejected') revisions[who] = receipt.revision;
      }
      const raw = (
          await f.pool.query<{
            n: string;
            sum: string;
            b1: string;
            b2: string;
            b3: string;
            b4: string;
            b5: string;
          }>(
            `SELECT count(*) n,sum(score) sum,count(*) FILTER(WHERE score=1) b1,count(*) FILTER(WHERE score=2) b2,count(*) FILTER(WHERE score=3) b3,count(*) FILTER(WHERE score=4) b4,count(*) FILTER(WHERE score=5) b5 FROM whaleu_ratings.scores WHERE target_id=$1`,
            [target.id],
          )
        ).rows[0]!,
        summary = await service.summary(actor.accessToken, target.id, null);
      assert.equal(summary.status, 'known');
      if (summary.status === 'known') {
        assert.equal(summary.count, Number(raw.n));
        assert.equal(summary.sum, Number(raw.sum));
        assert.deepEqual(summary.distribution, {
          '1': Number(raw.b1),
          '2': Number(raw.b2),
          '3': Number(raw.b3),
          '4': Number(raw.b4),
          '5': Number(raw.b5),
        });
      }
    },
  );
  await t.test(
    'one transaction may apply multiple deltas around an earlier immutable noop receipt',
    async () => {
      await inTransaction(
        f.pool,
        async (tx) => {
          await lockSafetyPolicy(tx);
          await tx.query(
            'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
            [target.id],
          );
          const old = (
            await tx.query<{ score: number; revision: string }>(
              'SELECT score,revision FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
              [target.id, actor.accountId],
            )
          ).rows[0]!;
          let revision = old.revision;
          for (const value of [old.score, old.score === 5 ? 1 : 5, 3]) {
            const key = randomUUID();
            await prepareLegacyBoundaryRequest(
              tx,
              actor.accountId,
              'set_score',
              {
                clientRequestId: key,
                targetId: target.id,
                regionId: c.regionId,
                expectedTargetRevision: target.revision,
                expectedRevision: revision,
                score: value,
              },
            );
            const result = await records.setScore(
              target.id,
              actor.accountId,
              {
                clientRequestId: key,
                regionId: null,
                expectedTargetRevision: target.revision,
                expectedRevision: revision,
                score: value,
              },
              tx,
            );
            revision = result.revision;
            await tx.query(
              'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
              [
                actor.accountId,
                key,
                JSON.stringify({
                  requestId: key,
                  operation: 'set_score',
                  ...result,
                }),
              ],
            );
          }
        },
        { isolationLevel: 'read committed' },
      );
      assert.equal(
        (await service.myScore(actor.accessToken, target.id, null)).myScore
          ?.score,
        3,
      );
    },
  );
  await t.test(
    'applied receipt extra fields or wrong microsecond time atomically rolls back score',
    async () => {
      const before = (
        await f.pool.query(
          'SELECT to_jsonb(s) data FROM whaleu_ratings.score_summaries s WHERE target_id=$1',
          [target.id],
        )
      ).rows[0]!.data;
      for (const mode of ['time', 'body'])
        await assert.rejects(
          inTransaction(
            f.pool,
            async (tx) => {
              await lockSafetyPolicy(tx);
              await tx.query(
                'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
                [target.id],
              );
              const prior = (
                  await tx.query<{ revision: string }>(
                    'SELECT revision FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
                    [target.id, actor.accountId],
                  )
                ).rows[0]!,
                key = randomUUID();
              await prepareLegacyBoundaryRequest(
                tx,
                actor.accountId,
                'set_score',
                {
                  clientRequestId: key,
                  targetId: target.id,
                  regionId: c.regionId,
                  expectedTargetRevision: target.revision,
                  expectedRevision: prior.revision,
                  score: 4,
                },
              );
              const result = await records.setScore(
                  target.id,
                  actor.accountId,
                  {
                    clientRequestId: key,
                    regionId: null,
                    expectedTargetRevision: target.revision,
                    expectedRevision: prior.revision,
                    score: 4,
                  },
                  tx,
                ),
                receipt = {
                  requestId: key,
                  operation: 'set_score',
                  ...result,
                  ...(mode === 'time'
                    ? { occurredAt: '2026-10-08T00:00:00.000001Z' }
                    : { body: 'forbidden in receipt' }),
                };
              await tx.query(
                'UPDATE whaleu_ratings.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, key, JSON.stringify(receipt)],
              );
              await tx.query(
                'SET CONSTRAINTS whaleu_ratings.rating_request_causal IMMEDIATE',
              );
            },
            { isolationLevel: 'read committed' },
          ),
        );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT to_jsonb(s) data FROM whaleu_ratings.score_summaries s WHERE target_id=$1',
            [target.id],
          )
        ).rows[0]!.data,
        before,
      );
    },
  );
  await t.test(
    'source transaction cannot be forged and a new directory is not a new score history',
    async () => {
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at,source_transaction) VALUES($1,$2,'new_native','complete','accepted','synthetic-forged-source','synthetic-policy',clock_timestamp(),(pg_current_xact_id()::text::bigint+1)::text::xid8)`,
            [randomUUID(), randomUUID()],
          ),
        ),
      );
      const historical = await f.catalog(actor, { baseline: false }),
        h = historical.targets[0]!;
      assert.deepEqual(await service.summary(actor.accessToken, h.id, null), {
        status: 'unavailable',
      });
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) SELECT id,$2,'fresh_zero',source_id,'synthetic-late-baseline','synthetic-policy' FROM whaleu_ratings.targets WHERE id=$1`,
            [h.id, randomUUID()],
          ),
        ),
      );
    },
  );
  await t.test(
    'catalog expiry after its required proof still rejects at final transaction clock',
    async () => {
      let laterEntered = false;
      const expires = new Date(Date.now() + 1200),
        fresh = await f.catalog(actor, { validUntil: expires });
      await assert.rejects(
        inTransaction(
          f.pool,
          async (tx) => {
            records.enable(tx);
            await f.app
              .get(RatingsAccessService)
              .resolve(actor.accessToken, null, tx, { phone: true });
            await records.catalog(null, tx);
            const later = {
              maximumFacts: 1,
              failureCode: 'RATING_UNAVAILABLE' as const,
              async validate() {
                assert.equal(
                  (
                    await tx.query<{ valid: boolean }>(
                      'SELECT $1::timestamptz>clock_timestamp() valid',
                      [expires],
                    )
                  ).rows[0]?.valid,
                  true,
                  'catalog must still be valid when the later final validator begins',
                );
                laterEntered = true;
                await sleep(Math.max(1, expires.getTime() - Date.now() + 40));
              },
            };
            enableRequiredTransactionProof(tx, later);
            registerRequiredTransactionFact(tx, later, 'later', {});
            return fresh.catalogId;
          },
          { isolationLevel: 'read committed' },
        ),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'RATING_UNAVAILABLE',
      );
      assert.equal(
        laterEntered,
        true,
        'the test must cross expiry in the later final validator, not during initial catalog admission',
      );
    },
  );
  await t.test(
    'ancestor disabled in a new accepted catalog denies every direct target path',
    async () => {
      const original = await f.catalog(actor, { depth: 3 }),
        item = original.targets[0]!,
        root = await f.publish(actor, original, item);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-ancestor-change','synthetic-policy',clock_timestamp())`,
          [id],
        );
        for (const level of [1, 2, 3])
          await tx.query(
            `INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal) SELECT $1,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,CASE WHEN level=1 THEN false ELSE active END,hidden,ordinal FROM whaleu_ratings.categories WHERE catalog_id=$2 AND level=$3`,
            [id, original.catalogId, level],
          );
        await tx.query(
          'INSERT INTO whaleu_ratings.target_memberships SELECT $1,target_id,category_id,ordinal FROM whaleu_ratings.target_memberships WHERE catalog_id=$2',
          [id, original.catalogId],
        );
        await tx.query(
          'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
          [id],
        );
        await tx.query(
          "UPDATE whaleu_ratings.catalog_heads SET catalog_id=$1 WHERE scope_key='global'",
          [id],
        );
      });
      for (const path of [
        `targets/${item.id}`,
        `targets/${item.id}/my-score`,
        `targets/${item.id}/score-summary`,
        `targets/${item.id}/comments`,
        `comments/${root.id}`,
      ]) {
        const r = await f.auth(
          request(f.http).get(`/v1/ratings/${path}`),
          actor,
        );
        assert.equal(r.status, 404, JSON.stringify(r.body));
      }
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/requests/${root.input.clientRequestId}`,
            ),
            actor,
          )
        ).status,
        200,
      );
    },
  );
});
