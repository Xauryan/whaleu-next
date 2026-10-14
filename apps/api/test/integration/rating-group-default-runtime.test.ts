import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createPromotionFixture } from './support/rating-group-promotion.js';
import { RATING_GROUP_PROMOTION_RUNTIME } from '../../src/ratings/group-promotion/contracts.js';
test(
  'ordinary AppModule remains null and has no automatic promotion effects',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({ disabled: true });
    t.after(() => f.close());
    assert.equal(f.app.get(RATING_GROUP_PROMOTION_RUNTIME), null);
    const base = `/v1/rating-group-promotion`;
    assert.equal(
      (
        await request(f.app.getHttpServer()).get(
          `${base}/capabilities?programId=${f.programId}`,
        )
      ).status,
      401,
    );
    const result = await request(f.app.getHttpServer())
      .get(`${base}/capabilities?programId=${f.programId}`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body, {
      enabled: false,
      mode: 'disabled',
      actions: [],
      reason: 'runtime_disabled',
    });
    assert.equal(
      (
        await request(f.app.getHttpServer())
          .post(`${base}/programs/${f.programId}/previews`)
          .set('Authorization', `Bearer ${f.token}`)
          .send({
            type: 'course',
            mode: 'normal',
            expectedProgramRevision: f.programRevision,
          })
      ).status,
      503,
    );
    assert.deepEqual(await f.worker.drain(), {
      claimed: 0,
      confirmed: 0,
      unknown: 0,
    });
    assert.equal(await f.sender.receiptCount(), 0);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_group_effects',
        )
      ).rows[0].n,
      0,
    );
  },
);
