import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import 'reflect-metadata';
import test, { type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
import assert from 'node:assert/strict';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import {
  deterministicCopy,
  digest,
  nativeLocator,
} from '../../src/ratings/group-promotion/contracts.js';
function observeComposition(
  f: Awaited<ReturnType<typeof createPromotionFixture>>,
  t: TestContext,
) {
  const trace: Record<string, unknown>[] = [];
  for (const [stage, port] of [
    ['generation', f.generation],
    ['shortlink', f.shortlinks],
    ['delivery', f.sender],
  ] as const) {
    const prepare = port.prepare.bind(port);
    port.prepare = async (...args) => {
      const prepared = await prepare(...args);
      if (!prepared) return prepared;
      return {
        ...prepared,
        dispatch(permit) {
          const enteredAt = performance.now();
          let error: string | undefined;
          try {
            return prepared.dispatch(permit);
          } catch (e) {
            error = String(e);
            throw e;
          } finally {
            trace.push({
              stage,
              identity: prepared.identity,
              issuedAt: permit.expiresAt - 100,
              enteredAt,
              returnedAt: performance.now(),
              error,
            });
          }
        },
      };
    };
  }
  t.after(async () => {
    try {
      const effects = (
        await f.pool.query(
          'SELECT stage,state,reason,dispatches,result_text IS NOT NULL result_present,attempt_id,next_action_at::text,next_action_at<=clock_timestamp() due FROM whaleu_notifications.rating_group_effects',
        )
      ).rows;
      const attempts = (
        await f.pool.query(
          "SELECT identity FROM whaleu_notifications.rating_group_attempts WHERE operation='dispatch'",
        )
      ).rows;
      const receipts = [];
      for (const a of attempts) {
        const port =
          a.identity.stage === 'generation'
            ? f.generation
            : a.identity.stage === 'shortlink'
              ? f.shortlinks
              : f.sender;
        const receipt = await port.receipt(a.identity);
        receipts.push({
          identity: a.identity,
          kind: receipt?.kind ?? null,
          outputPresent: receipt?.output !== undefined,
        });
      }
      t.diagnostic(
        JSON.stringify({ compositionTrace: trace, effects, receipts }),
      );
    } finally {
      await f.close();
    }
  });

  const snapshot = async () => ({
    effects: (
      await f.pool.query(
        'SELECT stage,state,reason,dispatches,result_text IS NOT NULL result_present,next_action_at::text,next_action_at<=clock_timestamp() due FROM whaleu_notifications.rating_group_effects',
      )
    ).rows,
    campaigns: (
      await f.pool.query(
        'SELECT payload_hash,copy_provenance,compose_by::text,clock_timestamp()>=compose_by compose_due,next_maintenance_at::text,next_maintenance_at<=clock_timestamp() maintenance_due FROM whaleu_ratings.promotion_campaigns',
      )
    ).rows,
  });
  const maintain = f.worker.maintain.bind(f.worker);
  f.worker.maintain = async () => {
    const result = await maintain();
    trace.push({ maintain: result, snapshot: await snapshot() });
    return result;
  };
  const drain = f.worker.drain.bind(f.worker);
  f.worker.drain = async () => {
    const result = await drain();
    trace.push({ drain: result, snapshot: await snapshot() });
    return result;
  };
  const service = f.app.get(RatingGroupPromotionService);
  const run = service.run.bind(service);
  service.run = async function <T>(
    work: (tx: PoolClient) => Promise<T>,
    ms = 3000,
  ): Promise<T> {
    try {
      return await run(work, ms);
    } catch (error) {
      trace.push({ transactionBudget: ms, error: String(error) });
      throw error;
    }
  };
}

test(
  'generation exact qualification rejects overlong output and freezes one independent fallback payload',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    observeComposition(f, t);
    f.generation.setBehavior('accept', 'x'.repeat(29));
    const c = await admitPromotion(f, { copyMode: 'assisted' });
    await f.worker.maintain();
    await f.worker.drain();
    await f.pool.query(
      'UPDATE whaleu_ratings.promotion_campaigns SET next_maintenance_at=clock_timestamp() WHERE id=$1',
      [c.status.campaignId],
    );
    await f.worker.maintain();
    await f.worker.drain();
    const row = (
      await f.pool.query(
        'SELECT payload,copy_provenance FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    assert.equal(row.payload.copy, deterministicCopy('course'));
    assert.equal(row.copy_provenance, 'fallback');
    const effects = (
      await f.pool.query(
        'SELECT stage,state FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
        [c.status.campaignId],
      )
    ).rows;
    assert.equal(effects.filter((e) => e.stage === 'generation').length, 1);
    assert.equal(await f.generation.receiptCount(), 1);
    assert.equal(
      effects.filter((e) => e.stage === 'delivery' && e.state === 'confirmed')
        .length,
      2,
    );
    const reservations = (
      await f.pool.query(
        'SELECT sum(microcredits)::int cost,bool_and(settled) settled FROM whaleu_ratings.promotion_cost_reservations',
      )
    ).rows[0];
    assert.equal(reservations.cost, 500000);
    assert.equal(reservations.settled, true);
  },
);
test(
  'required shortlink fails closed on a confirmed but wrong locator and never delivers',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    observeComposition(f, t);
    f.shortlinks.setBehavior(
      'accept',
      JSON.stringify({
        locator: 'https://unapproved.example',
        nativeLocatorHash: '0'.repeat(64),
        expiresAt: Date.now() + 3600000,
      }),
    );
    const c = await admitPromotion(f, { linkMode: 'shortlink_required' });
    await f.worker.maintain();
    await f.worker.drain();
    await f.pool.query(
      'UPDATE whaleu_ratings.promotion_campaigns SET next_maintenance_at=clock_timestamp() WHERE id=$1',
      [c.status.campaignId],
    );
    await f.worker.maintain();
    assert.equal(
      (
        await f.pool.query(
          'SELECT payload_hash FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [c.status.campaignId],
        )
      ).rows[0].payload_hash,
      null,
    );
    assert.equal(await f.sender.receiptCount(), 0);
  },
);

test(
  'qualified generation and exact required shortlink freeze once and deliver the same payload',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    observeComposition(f, t);
    const copy = '来分享你的课程体验吧',
      locator = 'synthetic://rating-promotion/accepted';
    await f.qualify(copy, locator);
    f.generation.setBehavior('accept', copy);
    f.shortlinks.setBehavior(
      'accept',
      JSON.stringify({
        locator,
        nativeLocatorHash: digest(nativeLocator(f.binding)),
        expiresAt: Date.now() + 3600000,
      }),
    );
    const c = await admitPromotion(f, {
      copyMode: 'assisted',
      linkMode: 'shortlink_required',
    });
    await f.worker.maintain();
    await f.worker.drain();
    await f.pool.query(
      'UPDATE whaleu_ratings.promotion_campaigns SET next_maintenance_at=clock_timestamp() WHERE id=$1',
      [c.status.campaignId],
    );
    await f.worker.maintain();
    await f.worker.drain();
    const row = (
      await f.pool.query(
        'SELECT payload,payload_hash,copy_provenance FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    assert.equal(row.payload.copy, copy);
    assert.equal(row.payload.locator, locator);
    assert.equal(row.copy_provenance, 'generated');
    const effects = (
      await f.pool.query(
        'SELECT stage,state,payload_hash FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
        [c.status.campaignId],
      )
    ).rows;
    assert.equal(effects.length, 4);
    assert.ok(effects.every((e) => e.state === 'confirmed'));
    assert.ok(
      effects
        .filter((e) => e.stage === 'delivery')
        .every((e) => e.payload_hash === row.payload_hash),
    );
  },
);

test(
  'unknown optional generation freezes qualified fallback at the real composition deadline and late evidence never changes it',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    observeComposition(f, t);
    f.generation.setBehavior('defer_receipt', '来分享你的课程体验吧');
    const c = await admitPromotion(f, { copyMode: 'assisted' });
    await f.worker.maintain();
    await f.worker.drain();
    const effect = (
      await f.pool.query(
        "SELECT e.id,a.identity FROM whaleu_notifications.rating_group_effects e JOIN whaleu_notifications.rating_group_attempts a ON a.id=e.attempt_id WHERE e.campaign_id=$1 AND e.stage='generation'",
        [c.status.campaignId],
      )
    ).rows[0];
    await f.pool.query(
      "UPDATE whaleu_notifications.rating_group_effects SET next_action_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [effect.id],
    );
    const due = (
      await f.pool.query(
        'SELECT compose_by FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0].compose_by as Date;
    await sleep(Math.max(0, due.getTime() - Date.now() + 30));
    await f.worker.maintain();
    await f.worker.drain();
    const before = (
      await f.pool.query(
        'SELECT payload,payload_hash,copy_provenance FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    assert.equal(before.payload.copy, deterministicCopy('course'));
    assert.equal(before.copy_provenance, 'fallback');
    const status = await request(f.app.getHttpServer())
      .get(`/v1/rating-group-promotion/campaigns/${c.status.campaignId}`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.counts.confirmed, 1);
    assert.equal(status.body.stages.generation.unknown, 1);
    assert.equal(status.body.completed, false);
    const receipt = await f.generation.receipt(effect.identity);
    assert.ok(receipt);
    assert.equal(receipt.output, undefined);
    assert.equal(await f.worker.admitEvidence(receipt), true);
    assert.equal(await f.worker.consumeEvidence(), 1);
    const after = (
      await f.pool.query(
        'SELECT payload,payload_hash,copy_provenance FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    assert.deepEqual(after, before);
    assert.equal(await f.generation.receiptCount(), 1);
    assert.equal(await f.sender.receiptCount(), 1);
  },
);
