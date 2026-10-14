import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { registerOptionalTransactionProof } from '../../src/database/transaction-deadlines.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { DmVerificationFacade } from '../../src/verification/dm-eligibility.facade.js';
import { RatingVerificationFacade } from '../../src/verification/rating-eligibility.facade.js';
import { LocalPublicationEligibilitySource } from '../../src/verification/publication-eligibility.source.js';
import { revokeAssertion } from '../../src/verification/revocation.js';
import { PHONE_CONSENT } from '../../src/verification/phone-binding.service.js';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { acceptRelatedSyncPolicy } from '../support/related-sync-fixtures.js';
import {
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

test(
  'corrected provenance reaches live SQL and TS consumers, explicit identity selection, related root and child, and exact revocation',
  { timeout: 240000 },
  async (t) => {
    let runtimeConfig: RuntimeConfig | undefined;
    const reviewPolicyId = randomUUID(),
      relatedPolicyId = randomUUID(),
      issuer = 'synthetic:school-uid:review';
    const f = await schoolUidFixture({
      configureTestModule(_builder, config) {
        runtimeConfig = config;
      },
    });
    t.after(() => f.close());
    assert.ok(runtimeConfig);
    Object.assign(runtimeConfig, {
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: reviewPolicyId,
      COMMUNITY_RELATED_REVIEW_POLICY_ID: relatedPolicyId,
      COMMUNITY_TEXT_REVIEW_OPERATOR: issuer,
    });
    const owner = await f.actor(),
      profileId = await f.profile(owner),
      application = await f.submit(owner);
    await f.approve(f.admin, application);
    const auth = `Bearer ${owner.accessToken}`,
      http = f.app.getHttpServer();
    const phone = async () => {
      const requestId = randomUUID();
      let r = await request(http)
        .post('/v1/me/phone-binding/requests')
        .set('Authorization', auth)
        .send({ requestId, consent: PHONE_CONSENT, replacesRequestId: null });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      r = await request(http)
        .post(`/v1/me/phone-binding/requests/${requestId}/authorize`)
        .set('Authorization', auth)
        .send({
          code: 'synthetic-school-uid-phone-' + randomUUID(),
          consent: PHONE_CONSENT,
        });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.state, 'verified');
    };
    const select = async (campusId: string) => {
      const view = await request(http)
        .get('/v1/me/identity-campus')
        .set('Authorization', auth);
      assert.equal(view.status, 200, JSON.stringify(view.body));
      assert.ok(view.body.expectedStateRevision);
      const r = await request(http)
        .put('/v1/me/identity-campus')
        .set('Authorization', auth)
        .send({
          requestId: randomUUID(),
          campusId,
          expectedStateRevision: view.body.expectedStateRevision,
        });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r;
    };
    await phone();
    await select(f.home.campusId);
    // A real independent, synthetic institutional-number assertion before transfer.
    // Its issuer/pointer stays immutable and cannot confer B-school number authority.
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const h = (
        await tx.query(
          'SELECT * FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
          [owner.accountId],
        )
      ).rows[0];
      const number = randomUUID(),
        snapshot = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,verified_at,expiry_kind,student_number) VALUES($1,$2,'student_number','verified','complete','accepted','institutional_sso','synthetic-independent-number','synthetic-number/v1',$2,$3,$3,clock_timestamp(),'policy_exempt','000004721')`,
        [number, owner.accountId, f.home.institutionId],
      );
      await tx.query(
        `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) SELECT $1,account_id,revision+1,affiliation_assertion_id,$2,phone_assertion_id,application_state,application_coverage FROM whaleu_verification.snapshots WHERE id=$3`,
        [snapshot, number, h.snapshot_id],
      );
      await tx.query(
        `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_independent_number')`,
        [
          randomUUID(),
          owner.accountId,
          randomUUID(),
          h.revision,
          snapshot,
          h.revision + 1,
        ],
      );
      await tx.query(
        'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
        [owner.accountId, h.revision + 1, snapshot],
      );
    });
    const independent = async () =>
      (
        await f.pool.query(
          `SELECT s.student_number_assertion_id,s.phone_assertion_id,s.application_state,s.application_coverage FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1`,
          [owner.accountId],
        )
      ).rows[0];
    const profileBefore = (
      await f.pool.query(
        'SELECT public_id,selected_campus_id,preferences FROM whaleu_profile.profiles WHERE account_id=$1',
        [owner.accountId],
      )
    ).rows[0];
    const before = await independent();
    await f.correct(f.admin, profileId, f.destination.campusId);
    assert.deepEqual(await independent(), before);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT public_id,selected_campus_id,preferences FROM whaleu_profile.profiles WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0],
      profileBefore,
    );
    const summary = await request(http)
      .get('/v1/me/verification')
      .set('Authorization', auth);
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.affiliation.status, 'verified');
    assert.equal(summary.body.studentNumber.status, 'unavailable');
    const stale = await request(http)
      .get('/v1/me/identity-campus')
      .set('Authorization', auth);
    assert.equal(stale.status, 200);
    assert.notEqual(stale.body.selection, 'valid');
    await select(f.destination.campusId);
    const sql = (
      await f.pool.query(
        `SELECT whaleu_verification.course_comment_fact($1,'affiliation',clock_timestamp()) course,whaleu_verification.window_rating_fact($1,'affiliation',clock_timestamp()) AS "window",whaleu_verification.major_rating_fact($1,'affiliation',clock_timestamp()) major,whaleu_authorization.school_admin_region_allowed($1,$2) school`,
        [owner.accountId, f.destination.regionId],
      )
    ).rows[0];
    assert.deepEqual(sql, {
      course: true,
      window: true,
      major: true,
      school: true,
    });
    await inTransaction(f.pool, async (tx) => {
      await f.app
        .get(DmVerificationFacade)
        .require(owner.accountId, tx, { phone: true });
      const rating = await f.app
        .get(RatingVerificationFacade)
        .affiliation(owner.accountId, tx);
      assert.equal(rating.status, 'verified');
      const publication = await f.app
        .get(LocalPublicationEligibilitySource)
        .resolve(owner.accountId, tx);
      assert.equal(publication.status, 'verified');
      if (publication.status === 'verified')
        assert.equal(publication.institutionId, f.destination.institutionId);
    });
    // Existing phone writer remains a valid independent three-statement protocol.
    await phone();
    assert.equal((await f.own(owner)).status, 'assigned');
    await f.correct(f.admin, profileId, f.home.campusId);
    await select(f.home.campusId);
    const operator = new TextReviewOperator(
      f.app.get(TextReviewRuntime),
      issuer,
    );
    await inTransaction(f.pool, async (tx) => {
      await operator.run(
        {
          command: 'init-policy',
          basis: 'Synthetic school UID consumer acceptance',
        },
        tx,
      );
      await operator.run(
        {
          command: 'init-related-policy',
          basis: 'Synthetic school UID related consumer acceptance',
        },
        tx,
      );
    });
    await acceptRelatedSyncPolicy(f.pool, f.home.regionId, {
      reviewPolicyId: relatedPolicyId,
      issuer,
    });
    await setRegionPolicy(f.pool, f.home.regionId, {
      relatedSyncEnabled: true,
      unverifiedCommentEnabled: true,
    });
    const decide = async (requestId: string) => {
      const q = (
        await f.pool.query(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [owner.accountId, requestId],
        )
      ).rows[0];
      assert.ok(q);
      await inTransaction(f.pool, (tx) =>
        operator.run(
          {
            command: 'decide',
            accountId: owner.accountId,
            requestId,
            digest: q.digest,
            decision: 'allow',
            basis: 'Synthetic exact corrected-account Review',
          },
          tx,
        ),
      );
    };
    const body = {
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion',
      text: 'Corrected provenance actual related root',
      authorMode: 'named',
      commentsPolicy: 'open',
      imageAssetIds: [],
      syncToRelatedCampuses: true,
    };
    let response = await request(http)
      .post('/v1/community/reviews/posts')
      .set('Authorization', auth)
      .send(body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await decide(body.clientRequestId);
    response = await request(http)
      .post('/v1/community/posts')
      .set('Authorization', auth)
      .send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const postId = String(response.body.resourceId);
    const child = {
      clientRequestId: randomUUID(),
      text: 'Corrected provenance actual inherited related child',
      authorMode: 'named',
      imageAssetIds: [],
    };
    response = await request(http)
      .post(`/v1/community/reviews/posts/${postId}/comments`)
      .set('Authorization', auth)
      .send(child);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await decide(child.clientRequestId);
    response = await request(http)
      .post(`/v1/community/posts/${postId}/comments`)
      .set('Authorization', auth)
      .send(child);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const envelopes = (
      await f.pool.query(
        `SELECT content_kind,envelope FROM whaleu_community.content_approval_bindings WHERE (content_kind='post' AND content_id=$1) OR (content_kind='comment' AND content_id=$2) ORDER BY content_kind`,
        [postId, response.body.resourceId],
      )
    ).rows;
    assert.equal(envelopes.length, 2);
    assert.equal(
      envelopes.find((e) => e.content_kind === 'post')?.envelope.scope.sync,
      'related',
    );
    assert.equal(
      envelopes.find((e) => e.content_kind === 'comment')?.envelope.scope.sync,
      'inherited_related',
    );
    const current = (
      await f.pool.query(
        'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
        [owner.accountId],
      )
    ).rows[0];
    await inTransaction(f.pool, (tx) =>
      revokeAssertion(tx, {
        accountId: owner.accountId,
        actorAccountId: f.admin.accountId,
        operationId: randomUUID(),
        fact: 'affiliation',
        expectedRevision: current.revision,
        reasonCode: 'synthetic_correction_revoked',
      }),
    );
    assert.notEqual((await f.own(owner)).status, 'assigned');
    assert.equal(
      (
        await f.pool.query(
          `SELECT a.method,a.assertion_state FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1`,
          [owner.accountId],
        )
      ).rows[0].assertion_state,
      'revoked',
    );
    await t.test(
      'finite correction has only exact current expiry descendants and no new UID allocation',
      async () => {
        const finite = await f.actor(),
          finiteProfile = await f.profile(finite);
        await setSyntheticSnapshot(f.pool, finite.accountId, [
          syntheticAssertion(
            finite.accountId,
            f.home.institutionId,
            'affiliation',
            {
              origin_region_id: f.home.regionId,
              expires_at: new Date(Date.now() + 15000),
            },
          ),
        ]);
        const correction = await f.correct(
          f.admin,
          finiteProfile,
          f.destination.campusId,
        );
        assert.equal(correction.receipt.outcome, 'applied');
        const allocationCount = async () =>
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_school_uid.allocations WHERE account_id=$1',
              [finite.accountId],
            )
          ).rows[0].n;
        const allocated = await allocationCount();
        assert.equal(allocated, 1);
        const expire = (mode: 'exact' | 'extended' | 'orphan') =>
          inTransaction(f.pool, async (tx) => {
            const h = (
              await tx.query(
                'SELECT h.*,s.affiliation_assertion_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1 FOR UPDATE OF h',
                [finite.accountId],
              )
            ).rows[0];
            const assertion = randomUUID(),
              snapshot = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,phone_binding_reference,verified_at,expiry_kind,expires_at,previous_assertion_id)
          SELECT $1,account_id,fact_kind,'expired',coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,phone_binding_reference,verified_at,expiry_kind,${mode === 'extended' ? "expires_at+interval '1 second'" : 'expires_at'},id
          FROM whaleu_verification.assertions WHERE id=$2`,
              [assertion, h.affiliation_assertion_id],
            );
            if (mode === 'orphan') return;
            await tx.query(
              `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
          SELECT $1,account_id,revision+1,$2,student_number_assertion_id,phone_assertion_id,application_state,application_coverage FROM whaleu_verification.snapshots WHERE id=$3`,
              [snapshot, assertion, h.snapshot_id],
            );
            await tx.query(
              `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
          VALUES($1,$2,$3,'expire','affiliation',$4,$5,$6,$7,'synthetic_exact_expiry')`,
              [
                randomUUID(),
                finite.accountId,
                randomUUID(),
                f.admin.accountId,
                h.revision,
                snapshot,
                h.revision + 1,
              ],
            );
            await tx.query(
              'UPDATE whaleu_verification.account_heads SET snapshot_id=$2,revision=revision+1 WHERE account_id=$1',
              [finite.accountId, snapshot],
            );
          });
        await assert.rejects(expire('exact'), { code: '23514' });
        const publicRead = () =>
          request(http).get(`/v1/profiles/${finiteProfile}`);
        const beforeExpiry = await publicRead();
        assert.equal(
          beforeExpiry.status,
          200,
          JSON.stringify(beforeExpiry.body),
        );
        assert.equal(beforeExpiry.body.schoolUidStatus, 'assigned');
        assert.ok(beforeExpiry.body.affiliation);
        assert.ok(beforeExpiry.body.publicUid);
        const remainingSql = `SELECT extract(epoch FROM (a.expires_at-clock_timestamp()))*1000 remaining FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1`;
        const remaining = Number(
          (await f.pool.query(remainingSql, [finite.accountId])).rows[0]
            .remaining,
        );
        assert.ok(
          Number.isFinite(remaining) && remaining > 500 && remaining <= 15000,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(remaining - 400)),
        );
        const database = f.app.get(DatabaseService),
          original = database.transaction,
          run = original.bind(database);
        let laterProofRan = false,
          laterProofInvalidated = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const result = await work(tx);
            assert.equal(
              (result as unknown as { schoolUidStatus: string })
                .schoolUidStatus,
              'assigned',
            );
            // This registers after the actual UID proof. Its real deadline must still
            // be live when this later proof starts, then expire inside the same fixed
            // 600 ms optional-proof budget, before the final deadline sweep.
            registerOptionalTransactionProof(tx, {
              validate: async () => {
                laterProofRan = true;
                const left = Number(
                  (await tx.query(remainingSql, [finite.accountId])).rows[0]
                    .remaining,
                );
                assert.ok(
                  left > 0 && left < 550,
                  `Real expiry remaining: ${left} ms`,
                );
                await new Promise((resolve) =>
                  setTimeout(resolve, Math.ceil(left) + 20),
                );
                return true;
              },
              invalidate: () => {
                laterProofInvalidated = true;
              },
            });
            return result;
          }, options);
        try {
          const expiredDuringProof = await publicRead();
          assert.equal(
            expiredDuringProof.status,
            200,
            JSON.stringify(expiredDuringProof.body),
          );
          assert.equal(expiredDuringProof.body.schoolUidStatus, 'unavailable');
          assert.equal(expiredDuringProof.body.affiliation, null);
          assert.equal(expiredDuringProof.body.publicUid, null);
          for (const key of [
            'status',
            'profileId',
            'displayName',
            'bio',
            'avatar',
            'postsHidden',
            'isOwn',
          ])
            assert.deepEqual(
              expiredDuringProof.body[key],
              beforeExpiry.body[key],
              key,
            );
          assert.equal(laterProofRan, true);
          assert.equal(laterProofInvalidated, false);
        } finally {
          database.transaction = original;
        }
        await assert.rejects(expire('extended'), { code: '23514' });
        await assert.rejects(expire('orphan'), { code: '23514' });
        await expire('exact');
        assert.equal(await allocationCount(), allocated);
        assert.notEqual((await f.own(finite)).status, 'assigned');
        const expired = await request(http)
          .get('/v1/me/verification')
          .set('Authorization', `Bearer ${finite.accessToken}`);
        assert.equal(expired.status, 200);
        assert.equal(expired.body.affiliation.status, 'expired');
      },
    );
  },
);
