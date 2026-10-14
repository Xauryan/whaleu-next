import { setTimeout as sleep } from 'node:timers/promises';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import { RatingPromotionEnrollment } from '../../src/ratings/group-promotion/enrollment.js';
test(
  'all-of current purpose authority, independent defaults, exact enrollment and safe historical recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const foreign = await f.actor();
    const base = `/v1/rating-group-promotion/programs/${f.programId}`;
    assert.equal(
      (
        await request(f.app.getHttpServer())
          .get(base)
          .set('Authorization', `Bearer ${foreign.accessToken}`)
      ).status,
      403,
    );
    const admitted = await admitPromotion(f);
    await f.worker.maintain();
    await f.db.transaction(
      (tx) =>
        f.app
          .get(RatingPromotionEnrollment)
          .revoke(
            f.programId,
            f.destinationIds[0]!,
            'synthetic:revocation',
            tx,
          ),
      { isolationLevel: 'read committed' },
    );
    await f.worker.drain();
    const rows = (
      await f.pool.query(
        'SELECT stable_destination_id,state FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
        [admitted.status.campaignId],
      )
    ).rows;
    assert.equal(
      rows.find((r) => r.stable_destination_id === f.destinationIds[0])?.state,
      'suppressed_unsent',
    );
    assert.equal(
      await f.sender.receiptCount(),
      1,
      'separately enrolled default audience still included',
    );
    await f.pool.query(
      'UPDATE whaleu_ratings.promotion_grants SET active=false WHERE program_id=$1',
      [f.programId],
    );
    const replay = await request(f.app.getHttpServer())
      .post(base + '/campaigns')
      .set('Authorization', `Bearer ${f.token}`)
      .send(admitted.body);
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(replay.body.campaignId, admitted.status.campaignId);
    assert.equal('payload' in replay.body, false);
    const hidden = await request(f.app.getHttpServer())
      .get(base + `/intents/${admitted.body.requestId}`)
      .set('Authorization', `Bearer ${foreign.accessToken}`);
    assert.equal(hidden.status, 404);
    const current = await request(f.app.getHttpServer())
      .get(`/v1/rating-group-promotion/campaigns/${admitted.status.campaignId}`)
      .set('Authorization', `Bearer ${f.token}`);
    assert.equal(current.status, 200);
    assert.equal('payload' in current.body, false);
  },
);

test(
  'test export needs its own current source permission even when operator test grant exists',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({ allowTestExport: false });
    t.after(() => f.close());
    const denied = await request(f.app.getHttpServer())
      .post(`/v1/rating-group-promotion/programs/${f.programId}/previews`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        type: f.binding.systemKey,
        mode: 'test',
        expectedProgramRevision: f.programRevision,
        testDestinationId: f.testDestinationId,
      });
    assert.equal(denied.status, 503, JSON.stringify(denied.body));
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_intents',
        )
      ).rows[0].n,
      0,
    );
    const normal = await admitPromotion(f);
    assert.ok(normal.status.campaignId);
  },
);

test(
  'program expiry during a later final validator vetoes the earlier valid promotion proof',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture();
    t.after(() => f.close());
    const app = f.app.get(RatingGroupPromotionService);
    let entered = false;
    await f.pool.query(
      "UPDATE whaleu_ratings.promotion_programs SET valid_until=clock_timestamp()+interval '800 milliseconds' WHERE id=$1",
      [f.programId],
    );
    await assert.rejects(
      () =>
        app.run(async (tx) => {
          const p = await app.program(f.programId, tx);
          await f.runtime.authority.current(f.actorId, p, 'send', tx);
          const later = {
            maximumFacts: 1,
            failureCode: 'PROMOTION_UNAVAILABLE' as const,
            async validate() {
              entered = true;
              await sleep(850);
            },
          };
          enableRequiredTransactionProof(tx, later);
          registerRequiredTransactionFact(tx, later, 'later', {});
          return { wouldEmit: true };
        }),
      /unavailable/i,
    );
    assert.equal(entered, true);
    assert.equal(await f.sender.receiptCount(), 0);
  },
);

for (const change of [
  'grant_aba',
  'enrollment_aba',
  'session_revocation',
] as const)
  test(
    `final dispatch reproof rejects ${change} after synthetic preparation`,
    { timeout: 240000 },
    async (t) => {
      const f = await createPromotionFixture({
        receivers: 1,
        auxiliaryReceivers: false,
      });
      t.after(() => f.close());
      const c = await admitPromotion(f);
      await f.worker.maintain();
      const prepare = f.sender.prepare.bind(f.sender);
      let reached = false;
      f.sender.prepare = async (...args) => {
        const prepared = await prepare(...args);
        reached = true;
        if (change === 'grant_aba') {
          await f.pool.query(
            'UPDATE whaleu_ratings.promotion_grants SET active=false WHERE program_id=$1',
            [f.programId],
          );
          await f.pool.query(
            'UPDATE whaleu_ratings.promotion_grants SET active=true WHERE program_id=$1',
            [f.programId],
          );
        } else if (change === 'session_revocation')
          await f.pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=(SELECT originating_session_id FROM whaleu_ratings.promotion_campaigns WHERE id=$1)",
            [c.status.campaignId],
          );
        else {
          const r = (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.promotion_receivers WHERE id=$1',
              [f.destinationIds[0]],
            )
          ).rows[0];
          await f.db.transaction(
            async (tx) => {
              const owner = f.app.get(RatingPromotionEnrollment);
              await owner.revoke(f.programId, r.id, 'synthetic:aba-revoke', tx);
              await owner.enroll(
                f.programId,
                [
                  {
                    accountLineage: r.account_lineage,
                    canonicalReceiver: 'synthetic:school_treehole:0',
                    opaqueRef: r.opaque_ref,
                    kind: r.audience_kind,
                    schoolScopeId: r.school_scope_id,
                    label: r.label,
                    ownerEvidenceRef: r.owner_evidence_ref,
                    purposeGrantId: r.purpose_grant_id,
                    consentPolicyRevision: r.consent_policy_revision,
                    validUntil: r.valid_until,
                  },
                ],
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
        }
        return prepared;
      };
      await f.worker.drain();
      assert.equal(reached, true);
      assert.equal(await f.sender.receiptCount(), 0);
      const row = (
        await f.pool.query(
          'SELECT state,dispatches FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
          [c.status.campaignId],
        )
      ).rows[0];
      assert.equal(row.state, 'suppressed_unsent');
      assert.equal(row.dispatches, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_notifications.rating_group_permits',
          )
        ).rows[0].n,
        0,
      );
    },
  );

test(
  'opaque legacy category visibility cannot become export authority through a promotion policy',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({ opaqueCatalog: true });
    t.after(() => f.close());
    const policy = (
      await f.pool.query(
        'SELECT enabled FROM whaleu_ratings.promotion_policy_revisions WHERE program_id=$1',
        [f.programId],
      )
    ).rows[0];
    assert.equal(policy.enabled, true);
    const result = await request(f.app.getHttpServer())
      .post(`/v1/rating-group-promotion/programs/${f.programId}/previews`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        type: 'course',
        mode: 'normal',
        expectedProgramRevision: f.programRevision,
      });
    assert.notEqual(result.status, 200);
    assert.ok(
      [403, 404, 503].includes(result.status),
      JSON.stringify(result.body),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_previews',
        )
      ).rows[0].n,
      0,
    );
  },
);
