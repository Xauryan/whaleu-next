import { RatingGroupRepository } from '../../src/notifications/rating-group/repository.js';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
import { RatingPromotionScheduler } from '../../src/ratings/group-promotion/schedule.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import { commandHash } from '../../src/ratings/group-promotion/contracts.js';
test(
  'opaque canonical command replay, pre-admission seal, strict receiverless effect uniqueness and terminal metadata',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const base = `/v1/rating-group-promotion/programs/${f.programId}`;
    const post = (path: string, body: object) =>
      request(f.app.getHttpServer())
        .post(base + path)
        .set('Authorization', `Bearer ${f.token}`)
        .send(body);
    const c = await admitPromotion(f, { copyMode: 'assisted' });
    // A complete recipient snapshot is not payload adoption. NULL=NULL must
    // never make a pre-composition delivery an admissible ledger node.
    const uncomposed = (
      await f.pool.query(
        'SELECT payload,payload_hash FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    assert.equal(uncomposed.payload, null);
    assert.equal(uncomposed.payload_hash, null);
    await assert.rejects(
      () =>
        f.pool.query(
          `INSERT INTO whaleu_notifications.rating_group_effects(id,campaign_id,stage,stable_destination_id,original_key,profile_id,account_lineage,input_hash,payload_hash) SELECT $1,c.id,'delivery',r.stable_destination_id,$2,p.profile_id,p.account_lineage,$3,NULL FROM whaleu_ratings.promotion_campaigns c JOIN whaleu_ratings.promotion_programs p ON p.id=c.program_id JOIN whaleu_ratings.promotion_campaign_recipients r ON r.campaign_id=c.id WHERE c.id=$4 ORDER BY r.stable_destination_id LIMIT 1`,
          [randomUUID(), 'c'.repeat(64), 'd'.repeat(64), c.status.campaignId],
        ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' &&
        error.constraint === 'rating_group_payload_adopted',
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 AND stage='delivery'",
          [c.status.campaignId],
        )
      ).rows[0].n,
      0,
    );

    const same = await post('/campaigns', c.body);
    assert.equal(same.status, 202);
    assert.equal(same.body.campaignId, c.status.campaignId);
    assert.equal('payload' in same.body, false);
    assert.equal(
      (await post('/campaigns', { ...c.body, requestHash: '0'.repeat(64) }))
        .status,
      409,
    );
    assert.equal(
      (await post('/campaigns', { ...c.body, type: 'canteen' })).status,
      400,
    );
    await f.worker.maintain();
    const generation = (
      await f.pool.query(
        `SELECT * FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 AND stage='generation'`,
        [c.status.campaignId],
      )
    ).rows[0];
    assert.ok(generation);
    await assert.rejects(
      () =>
        f.pool.query(
          `INSERT INTO whaleu_notifications.rating_group_effects(id,campaign_id,stage,original_key,profile_id,account_lineage,input_hash) SELECT $1,campaign_id,stage,$2,profile_id,account_lineage,input_hash FROM whaleu_notifications.rating_group_effects WHERE id=$3`,
          [randomUUID(), 'a'.repeat(64), generation.id],
        ),
      (e: { code?: string; constraint?: string }) =>
        e.code === '23505' &&
        e.constraint === 'rating_group_receiverless_effect',
    );
    const preview = await post('/previews', {
      type: 'course',
      mode: 'normal',
      expectedProgramRevision: f.programRevision,
    });
    assert.equal(preview.status, 200);
    const intent = await post('/intents', {
      previewId: preview.body.previewId,
      copyMode: 'deterministic',
      linkMode: 'native',
    });
    assert.equal(intent.status, 200);
    const sealed = await post(`/requests/${intent.body.requestId}/cancel`, {
      cancelRequestId: randomUUID(),
      requestHash: intent.body.requestHash,
    });
    assert.equal(sealed.status, 200);
    assert.equal(sealed.body.sealed, true);
    const delayed = await post('/campaigns', {
      requestId: intent.body.requestId,
      requestHash: intent.body.requestHash,
      intentTicket: intent.body.intentTicket,
    });
    assert.equal(delayed.status, 202);
    assert.equal(delayed.body.admission, 'sealed');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_campaigns WHERE request_id=$1',
          [intent.body.requestId],
        )
      ).rows[0].n,
      0,
    );
    const row = (
      await f.pool.query(
        'SELECT command,request_hash FROM whaleu_ratings.promotion_intents WHERE request_id=$1',
        [c.body.requestId],
      )
    ).rows[0];
    assert.equal(commandHash(row.command), row.request_hash);
    await assert.rejects(
      () =>
        f.pool.query(
          'INSERT INTO whaleu_ratings.promotion_campaign_recipients SELECT $1,stable_destination_id,enrollment_revision,registry_revision,audience_kind,school_scope_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$2 AND stable_destination_id=$3',
          [c.status.campaignId, f.programId, f.testDestinationId],
        ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' &&
        error.constraint === 'promotion_recipient_exact',
    );
  },
);

test(
  'SQL rejects uncaused terminals, mutable attempts and forged original effect identity',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 1,
      auxiliaryReceivers: false,
    });
    t.after(() => f.close());
    const c = await admitPromotion(f);
    await f.worker.maintain();
    const e = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
        [c.status.campaignId],
      )
    ).rows[0];
    const rejected = (operation: () => Promise<unknown>, constraint: string) =>
      assert.rejects(
        operation,
        (error: { code?: string; constraint?: string }) =>
          error.code === '23514' && error.constraint === constraint,
      );
    await rejected(
      () =>
        f.pool.query(
          `INSERT INTO whaleu_notifications.rating_group_effects(id,campaign_id,stage,stable_destination_id,original_key,profile_id,account_lineage,input_hash,payload_hash) SELECT $1,campaign_id,stage,stable_destination_id,$2,profile_id,account_lineage,$3,payload_hash FROM whaleu_notifications.rating_group_effects WHERE id=$4`,
          [randomUUID(), 'e'.repeat(64), 'f'.repeat(64), e.id],
        ),
      'rating_group_payload_adopted',
    );
    await rejected(
      () =>
        f.pool.query(
          "UPDATE whaleu_notifications.rating_group_effects SET state='confirmed',confirmed_at=clock_timestamp() WHERE id=$1",
          [e.id],
        ),
      'rating_group_state_causal',
    );
    await rejected(
      () =>
        f.pool.query(
          "INSERT INTO whaleu_notifications.rating_group_effects(id,campaign_id,stage,stable_destination_id,original_key,profile_id,account_lineage,input_hash,payload_hash,state) SELECT $1,campaign_id,stage,stable_destination_id,$2,profile_id,account_lineage,input_hash,payload_hash,'confirmed' FROM whaleu_notifications.rating_group_effects WHERE id=$3",
          [randomUUID(), 'b'.repeat(64), e.id],
        ),
      'rating_group_state_causal',
    );
    f.sender.setBehavior('defer_receipt');
    await f.worker.drain();
    const attempt = (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.rating_group_attempts WHERE effect_id=$1 AND operation=$2',
        [e.id, 'dispatch'],
      )
    ).rows[0];
    assert.ok(attempt);
    await rejected(
      () =>
        f.pool.query(
          'UPDATE whaleu_notifications.rating_group_attempts SET fence=fence+1 WHERE id=$1',
          [attempt.id],
        ),
      'promotion_immutable',
    );
    await rejected(
      () =>
        f.pool.query(
          'DELETE FROM whaleu_notifications.rating_group_attempts WHERE id=$1',
          [attempt.id],
        ),
      'promotion_immutable',
    );
    await rejected(
      () =>
        f.pool.query(
          "UPDATE whaleu_notifications.rating_group_effects SET state='preparing' WHERE id=$1",
          [e.id],
        ),
      'rating_group_state_causal',
    );
    const evidence = await f.sender.receipt(attempt.identity);
    assert.ok(evidence);
    await assert.rejects(
      () =>
        f.pool.query(
          `INSERT INTO whaleu_notifications.rating_group_evidence(id,effect_id,original_key,original_attempt_id,kind,profile_id,account_lineage,receipt_id,evidence) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            e.id,
            e.original_key,
            attempt.id,
            evidence.kind,
            e.profile_id,
            randomUUID(),
            evidence.receiptId,
            evidence,
          ],
        ),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' &&
        error.constraint === 'rating_group_evidence_exact',
    );
    assert.equal(await f.worker.admitEvidence(evidence), true);
    assert.equal(await f.worker.consumeEvidence(), 1);
  },
);

for (const missed of [false, true])
  test(
    `accepted scheduled slot ${missed ? 'skips missed history' : 'admits once under service authority'}`,
    { timeout: 240000 },
    async (t) => {
      const f = await createPromotionFixture();
      t.after(() => f.close());
      const principal = randomUUID(),
        grant = randomUUID(),
        lineage = randomUUID();
      await f.db.transaction(
        async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_ratings.promotion_grants(id,program_id,principal_lineage,kind,revision,actions,scope_ids,allow_default,allow_test,evidence_ref,active,valid_until) VALUES($1,$2,$3,'service',$4,ARRAY['send'],$5,true,false,'synthetic:accepted-service',true,clock_timestamp()+interval '1 day')`,
            [randomUUID(), f.programId, principal, grant, [f.regionId]],
          );
          await tx.query(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp()-$6::int*interval '1 second' AS issued_clock) INSERT INTO whaleu_ratings.promotion_schedules(program_id,lineage,principal_lineage,grant_revision,program_revision,anchor,period_seconds,next_due_at,enabled,evidence_ref) SELECT $1,$2,$3,$4,$5,issued_clock,86400,issued_clock,true,'synthetic:accepted-schedule' FROM instant`,
            [
              f.programId,
              lineage,
              principal,
              grant,
              f.programRevision,
              missed ? 90000 : 1,
            ],
          );
        },
        { isolationLevel: 'read committed' },
      );
      const scheduler = f.app.get(RatingPromotionScheduler);
      assert.deepEqual(await scheduler.admitDue(), {
        admitted: missed ? 0 : 1,
        skipped: missed ? 1 : 0,
      });
      assert.deepEqual(await scheduler.admitDue(), { admitted: 0, skipped: 0 });
      const rows = (
        await f.pool.query(
          'SELECT outcome,slot_ordinal::text ordinal FROM whaleu_ratings.promotion_slots WHERE schedule_lineage=$1',
          [lineage],
        )
      ).rows;
      assert.deepEqual(rows, [
        { outcome: missed ? 'skipped' : 'admitted', ordinal: '0' },
      ]);
      if (!missed) {
        const c = (
          await f.pool.query(
            'SELECT principal_kind,originating_session_id,recipient_count FROM whaleu_ratings.promotion_campaigns',
          )
        ).rows[0];
        assert.equal(c.principal_kind, 'service');
        assert.equal(c.originating_session_id, null);
        assert.equal(c.recipient_count, 2);
      }
      assert.equal(await f.sender.receiptCount(), 0);
    },
  );

for (const stage of ['delivery', 'generation'] as const)
  test(
    `a ${stage} permit cannot commit without the exact durable reservation`,
    { timeout: 240000 },
    async (t) => {
      const f = await createPromotionFixture();
      t.after(() => f.close());
      await admitPromotion(f, {
        copyMode: stage === 'generation' ? 'assisted' : 'deterministic',
      });
      await f.worker.maintain();
      const app = f.app.get(RatingGroupPromotionService),
        repo = f.app.get(RatingGroupRepository),
        claim = await app.run((tx) => repo.claim(stage, tx));
      assert.ok(claim);
      await assert.rejects(
        () =>
          f.pool.query(
            'INSERT INTO whaleu_notifications.rating_group_permits(attempt_id,effect_id,original_key,prepared_hash,authority_digest) VALUES($1,$2,$3,$4,$5)',
            [
              claim.identity.attemptId,
              claim.effect.id,
              claim.identity.key,
              'a'.repeat(64),
              'b'.repeat(64),
            ],
          ),
        (error: { code?: string; constraint?: string }) =>
          error.code === '23514' &&
          error.constraint === 'rating_group_permit_exact',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_notifications.rating_group_permits',
          )
        ).rows[0].n,
        0,
      );
      assert.equal(await f.sender.receiptCount(), 0);
    },
  );
