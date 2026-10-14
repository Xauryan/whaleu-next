import type { PoolClient } from 'pg';
import type { TestContext } from 'node:test';
import {
  RatingGroupRepository,
  type Claim,
} from '../../src/notifications/rating-group/repository.js';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import { DurableSyntheticRatingGroupPort } from '../../src/notifications/rating-group/synthetic.js';
import {
  effectIdentity,
  type EffectIdentity,
} from '../../src/ratings/group-promotion/contracts.js';
// Test-only timing observation. No state changes, retries or alternate permit minting.
function observeDispatchTiming(
  f: Awaited<ReturnType<typeof createPromotionFixture>>,
  t: TestContext,
) {
  const phases: Record<string, unknown>[] = [];
  const dispatches: {
    identity: EffectIdentity;
    issuedAt: number;
    enteredAt: number;
    returnedAt: number;
    error?: string;
  }[] = [];
  const service = f.app.get(RatingGroupPromotionService);
  const run = service.run.bind(service);
  service.run = async function <T>(
    work: (tx: PoolClient) => Promise<T>,
    ms = 3000,
  ): Promise<T> {
    const startedAt = performance.now();
    let callbackEndedAt = 0;
    try {
      return await run(async (tx) => {
        const value = await work(tx);
        callbackEndedAt = performance.now();
        return value;
      }, ms);
    } finally {
      if (ms === 1000)
        phases.push({
          startedAt,
          callbackEndedAt,
          returnedAt: performance.now(),
        });
    }
  };
  const prepare = f.sender.prepare.bind(f.sender);
  f.sender.prepare = async (...args) => {
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
          dispatches.push({
            identity: prepared.identity,
            issuedAt: permit.expiresAt - 100,
            enteredAt,
            returnedAt: performance.now(),
            ...(error ? { error } : {}),
          });
        }
      },
    };
  };
  return async () => {
    const receipts = [];
    for (const d of dispatches) {
      const receipt = await f.sender.receipt(d.identity);
      receipts.push({
        attemptId: d.identity.attemptId,
        kind: receipt?.kind ?? null,
      });
    }
    const effects = (
      await f.pool.query(
        'SELECT id,state,dispatches,reason FROM whaleu_notifications.rating_group_effects ORDER BY id',
      )
    ).rows;
    t.diagnostic(
      JSON.stringify({
        ratingPromotionTiming: { phases, dispatches, receipts, effects },
      }),
    );
  };
}
test(
  'five-second hung receipt releases local worker, preserves receiver gate/quota, and late exact original evidence settles after cancellation',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    const diagnostics = observeDispatchTiming(f, t);
    t.after(async () => {
      try {
        await diagnostics();
      } finally {
        await f.close();
      }
    });
    f.sender.setBehavior('defer_receipt');
    const c = await admitPromotion(f);
    await f.worker.maintain();
    const began = performance.now(),
      first = await f.worker.drain(),
      elapsed = performance.now() - began;
    assert.equal(first.claimed, 1);
    assert.equal(first.unknown, 1);
    assert.ok(elapsed >= 4900 && elapsed < 10000, `drain ${elapsed}ms`);
    const unknown = (
      await f.pool.query(
        `SELECT e.*,a.identity FROM whaleu_notifications.rating_group_effects e JOIN whaleu_notifications.rating_group_attempts a ON a.id=e.attempt_id WHERE e.campaign_id=$1 AND e.state='dispatch_unknown'`,
        [c.status.campaignId],
      )
    ).rows[0];
    assert.ok(unknown);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_receiver_gates WHERE effect_id=$1',
          [unknown.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_counters WHERE campaign_id=$1',
          [c.status.campaignId],
        )
      ).rows[0].n,
      1,
    );
    f.sender.setBehavior('accept');
    await f.worker.drain();
    assert.equal(
      await f.sender.receiptCount(),
      2,
      'another physical receiver progresses',
    );
    await request(f.app.getHttpServer())
      .post(
        `/v1/rating-group-promotion/campaigns/${c.status.campaignId}/cancel`,
      )
      .set('Authorization', `Bearer ${f.token}`)
      .send({ requestId: randomUUID() })
      .expect(200);
    const restarted = new DurableSyntheticRatingGroupPort(
      f.sender.path,
      f.runtime.domainId,
      f.runtime.ticketSecret,
    );
    const receipt = await restarted.reconcile(
      unknown.identity as EffectIdentity,
      new AbortController().signal,
    );
    assert.ok(receipt);
    assert.equal(
      await f.worker.admitEvidence({ ...receipt, destinationId: randomUUID() }),
      false,
    );
    assert.equal(await f.worker.admitEvidence(receipt), true);
    assert.equal(await f.worker.consumeEvidence(), 1);
    assert.equal(await f.sender.receiptCount(), 2);
    assert.equal(
      (
        await f.pool.query(
          'SELECT state,dispatches FROM whaleu_notifications.rating_group_effects WHERE id=$1',
          [unknown.id],
        )
      ).rows[0].dispatches,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_receiver_gates WHERE effect_id=$1',
          [unknown.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(await f.worker.admitEvidence(receipt), true);
    assert.equal(await f.worker.consumeEvidence(), 0);
    assert.ok(
      (
        await f.pool.query(
          'SELECT cancelled_at FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
          [c.status.campaignId],
        )
      ).rows[0].cancelled_at,
    );
  },
);

test(
  'eight unknown receivers retain their gates without exhausting account capacity for a ninth independent receiver',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 9,
      auxiliaryReceivers: false,
    });
    const diagnostics = observeDispatchTiming(f, t);
    t.after(async () => {
      try {
        await diagnostics();
      } finally {
        await f.close();
      }
    });
    f.sender.setBehavior('defer_receipt');
    const c = await admitPromotion(f);
    await f.worker.maintain();
    for (let i = 0; i < 8; i++) {
      const result = await f.worker.drain();
      assert.equal(result.unknown, 1);
      // Keep each unresolved receiver awaiting its scheduled metadata reconcile,
      // so this checks eight simultaneous durable unknown gates rather than
      // letting a successful reconciliation silently free them first.
      await f.pool.query(
        "UPDATE whaleu_notifications.rating_group_effects SET next_action_at=clock_timestamp()+interval '1 hour' WHERE state='dispatch_unknown'",
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_receiver_gates',
        )
      ).rows[0].n,
      8,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_emission_slots',
        )
      ).rows[0].n,
      0,
    );
    f.sender.setBehavior('accept');
    await f.worker.drain();
    const states = (
      await f.pool.query(
        'SELECT state,count(*)::int n FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 GROUP BY state',
        [c.status.campaignId],
      )
    ).rows;
    assert.equal(states.find((r) => r.state === 'confirmed')?.n, 1);
    assert.equal(states.find((r) => r.state === 'dispatch_unknown')?.n, 8);
    assert.equal(await f.sender.receiptCount(), 9);
  },
);

test(
  'authoritative nonacceptance retries the original key at most three times',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    const diagnostics = observeDispatchTiming(f, t);
    t.after(async () => {
      try {
        await diagnostics();
      } finally {
        await f.close();
      }
    });
    f.sender.setBehavior('not_accepted');
    // Lose only the first live receipt after the real synchronous boundary. The
    // original durable metadata must be recovered through the public HTTP route.
    let dispatchCalls = 0;
    const prepare = f.sender.prepare.bind(f.sender);
    f.sender.prepare = async (...args) => {
      const prepared = await prepare(...args);
      if (!prepared) return prepared;
      return {
        ...prepared,
        dispatch(permit) {
          dispatchCalls++;
          const completion = prepared.dispatch(permit);
          if (dispatchCalls === 1) {
            if (completion && 'subscribe' in completion) completion.dispose();
            return null;
          }
          return completion;
        },
      };
    };
    let httpRecoveries = 0;
    const c = await admitPromotion(f);
    await f.worker.maintain();
    let key: string | undefined;
    for (let n = 1; n <= 3; n++) {
      await f.worker.drain();
      const read = async () =>
        (
          await f.pool.query(
            'SELECT *,next_action_at>clock_timestamp() backed_off FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
            [c.status.campaignId],
          )
        ).rows[0];
      let row = await read();
      if (row.state === 'dispatch_unknown') {
        const original = row;
        const identity = (
          await f.pool.query(
            'SELECT identity FROM whaleu_notifications.rating_group_attempts WHERE id=$1',
            [original.attempt_id],
          )
        ).rows[0].identity as EffectIdentity;
        const until = performance.now() + 1000;
        let receipt = await f.sender.reconcile(
          identity,
          new AbortController().signal,
        );
        while (!receipt && performance.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          receipt = await f.sender.reconcile(
            identity,
            new AbortController().signal,
          );
        }
        assert.ok(
          receipt,
          'unknown cannot retry without original-attempt evidence',
        );
        assert.equal(receipt.kind, 'not_accepted');
        assert.deepEqual(effectIdentity(receipt), identity);
        assert.equal(f.sender.authenticate(receipt), true);
        t.diagnostic(
          'Unknown dispatch settled only from authenticated original-attempt not_accepted metadata; no redispatch',
        );
        const callsBeforeRecovery = dispatchCalls;
        await request(f.app.getHttpServer())
          .post(
            `/v1/rating-group-promotion/campaigns/${c.status.campaignId}/reconcile`,
          )
          .set('Authorization', `Bearer ${f.token}`)
          .send({ requestId: randomUUID(), effectId: original.id })
          .expect(202);
        await f.worker.drain();
        httpRecoveries++;
        assert.equal(dispatchCalls, callsBeforeRecovery);
        row = await read();
        assert.equal(row.attempt_id, original.attempt_id);
        assert.equal(row.dispatches, original.dispatches);
      }
      key ??= row.original_key;
      assert.equal(row.original_key, key);
      assert.equal(row.dispatches, n);
      assert.equal(row.state, n === 3 ? 'suppressed_unsent' : 'retry_wait');
      if (n < 3) {
        assert.equal(row.backed_off, true);
        await f.pool.query(
          'UPDATE whaleu_notifications.rating_group_effects SET next_action_at=clock_timestamp() WHERE id=$1',
          [row.id],
        );
      }
    }
    assert.ok(
      httpRecoveries >= 1,
      'lost live receipt uses the user-reachable recovery route',
    );
    await f.worker.drain();
    assert.equal(await f.sender.receiptCount(), 3);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_receiver_gates',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_counters',
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  'less than seven seconds remaining refuses preparation and final permit without emission',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    t.after(() => f.close());
    await admitPromotion(f);
    await f.worker.maintain();
    const app = f.app.get(RatingGroupPromotionService),
      repo = f.app.get(RatingGroupRepository),
      claim = await app.run((tx) => repo.claim('delivery', tx));
    assert.ok(claim);
    let prepared = false;
    const prepare = f.sender.prepare.bind(f.sender);
    f.sender.prepare = async (...args) => {
      prepared = true;
      return prepare(...args);
    };
    const process = Reflect.get(f.worker, 'process') as (
      claim: Claim,
      deadline: number,
    ) => Promise<string>;
    assert.equal(
      await process.call(f.worker, claim, performance.now() + 6500),
      'not_sent',
    );
    assert.equal(prepared, false);
    assert.equal(await f.sender.receiptCount(), 0);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_permits',
        )
      ).rows[0].n,
      0,
    );
    const row = (
      await f.pool.query(
        'SELECT state,dispatches FROM whaleu_notifications.rating_group_effects WHERE id=$1',
        [claim.effect.id],
      )
    ).rows[0];
    assert.equal(row.state, 'retry_wait');
    assert.equal(row.dispatches, 0);
  },
);

test(
  'actual PG slow COMMIT consumes the original proof window and cannot dispatch',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    const diagnostics = observeDispatchTiming(f, t);
    t.after(async () => {
      try {
        await diagnostics();
      } finally {
        await f.close();
      }
    });
    const c = await admitPromotion(f);
    await f.worker.maintain();
    const service = f.app.get(RatingGroupPromotionService);
    const run = service.run.bind(service);
    let delayedCommits = 0;
    service.run = async function <T>(
      work: (tx: PoolClient) => Promise<T>,
      ms = 3000,
    ): Promise<T> {
      let restore: (() => void) | undefined;
      try {
        return await run(async (tx) => {
          if (ms === 1000) {
            const query = tx.query;
            tx.query = new Proxy(query, {
              async apply(target, receiver, args) {
                if (args[0] === 'COMMIT') {
                  delayedCommits++;
                  await new Promise((resolve) => setTimeout(resolve, 140));
                }
                return Reflect.apply(target, receiver, args);
              },
            });
            restore = () => {
              tx.query = query;
            };
          }
          return work(tx);
        }, ms);
      } finally {
        restore?.();
      }
    };
    const result = await f.worker.drain();
    assert.equal(delayedCommits, 1);
    assert.equal(result.unknown, 1);
    assert.equal(await f.sender.receiptCount(), 0);
    const effect = (
      await f.pool.query(
        `SELECT state,dispatches FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 AND stage='delivery'`,
        [c.status.campaignId],
      )
    ).rows;
    assert.deepEqual(effect, [{ state: 'dispatch_unknown', dispatches: 1 }]);
  },
);
