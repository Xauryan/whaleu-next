import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ratingRuntimeFixture,
  approveRating,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { ratingTargetCreateHash } from '../../src/ratings/management/service.js';
import type { PrepareRatingTarget } from '../../src/ratings/management/contracts.js';
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';

test('M1 independent origin, CAS contention, rollback, namespace and policy boundaries', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor();
  const c = await f.catalog(a, { count: 0 });
  const policy = randomUUID();
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-source','synthetic-native-policy','synthetic-source-owner',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
      [policy],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
      [policy],
    );
  });
  const intent = (name: string): PrepareRatingTarget => ({
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: c.categoryId,
    expectedCategoryRevision: c.categoryRevision,
    expectedCatalogRevision: c.catalogId,
    name,
    description: '',
    assetIds: [],
  });
  const post = (path: string, body: object, actor = a) =>
    f
      .auth(request(f.http).post('/v1/ratings/management/' + path), actor)
      .send(body);
  const x = intent('Origin anchored'),
    y = intent('Concurrent other target');
  // Canonical explicit campus origin is independent of the global display scope.
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_ratings.native_origin_evidence(id,account_id,request_id,intent_hash,region_id,policy_id,origin_state,origin_campus_id,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,$3,$4,NULL,$5,'known_school',$6,'synthetic-exact-original-campus','synthetic-original-campus-policy',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
      [
        randomUUID(),
        a.accountId,
        x.clientRequestId,
        ratingTargetCreateHash(x),
        policy,
        f.scope.home.campusId,
      ],
    ),
  );
  const xp = await post('prepare', x),
    yp = await post('prepare', y, b);
  assert.equal(xp.status, 200, JSON.stringify(xp.body));
  assert.equal(yp.status, 200, JSON.stringify(yp.body));
  for (const targetId of [xp.body.targetId, yp.body.targetId]) {
    const envelope = (
      await f.pool.query<{ envelope: RatingContentEnvelope }>(
        'SELECT envelope FROM whaleu_ratings.target_preparations WHERE target_id=$1',
        [targetId],
      )
    ).rows[0]!.envelope;
    await approveRating(f.pool, envelope);
  }
  // Namespace reservation exists before a receipt, including other command families.
  const conflict = await f
    .auth(
      request(f.http).put(`/v1/ratings/targets/${xp.body.targetId}/my-score`),
      a,
    )
    .send({
      clientRequestId: x.clientRequestId,
      regionId: null,
      expectedTargetRevision: xp.body.revision,
      expectedRevision: null,
      score: 1,
    });
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
  // A forged preparation cannot use a hash unrelated to its exact canonical intent.
  await assert.rejects(
    inTransaction(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.target_preparations SELECT account_id,$1,$2,session_id,$3,revision,$4,policy_id,origin_evidence_id,intent,envelope,created_at,valid_until FROM whaleu_ratings.target_preparations WHERE target_id=$5`,
        [
          randomUUID(),
          '0'.repeat(64),
          randomUUID(),
          'z'.repeat(43),
          xp.body.targetId,
        ],
      ),
    ),
  );
  const created = await post('targets', {
    ...x,
    expectedContextRevision: xp.body.contextRevision,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const loser = await post(
    'targets',
    { ...y, expectedContextRevision: yp.body.contextRevision },
    b,
  );
  assert.equal(loser.body.code, 'RATING_CREATION_CONTEXT_CHANGED');
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.targets WHERE id=$1',
        [yp.body.targetId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.target_sources WHERE target_id=$1',
        [yp.body.targetId],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_community.rating_approval_bindings WHERE subject_id=$1',
        [yp.body.targetId],
      )
    ).rows[0].n,
    0,
  );
  const origin = (
    await f.pool.query(
      `SELECT t.region_id,o.origin_campus_id,o.state FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_origin_sources o ON o.target_id=t.id WHERE t.id=$1`,
      [xp.body.targetId],
    )
  ).rows[0];
  assert.deepEqual(origin, {
    region_id: null,
    origin_campus_id: f.scope.home.campusId,
    state: 'known_school',
  });
  // Explicit deployment policy may require known origin, without granting any actor privilege.
  const strict = randomUUID();
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,require_known_origin,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-source','synthetic-native-policy-v2','synthetic-source-owner',2,true,true,'complete','accepted',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
      [strict],
    );
    await tx.query(
      "UPDATE whaleu_ratings.native_create_policy_heads SET policy_id=$1 WHERE scope_key='global'",
      [strict],
    );
  });
  const unknown = {
    ...intent('Missing required origin'),
    expectedCatalogRevision: created.body.catalogRevision,
  };
  assert.equal(
    (await post('prepare', unknown)).body.error.code,
    'RATING_UNAVAILABLE',
  );
  // Historic success still recovers after the policy changed and current head moved.
  assert.deepEqual(
    (
      await post('targets', {
        ...x,
        expectedContextRevision: xp.body.contextRevision,
      })
    ).body,
    created.body,
  );
  await assert.rejects(
    inTransaction(f.pool, (tx) =>
      tx.query('TRUNCATE whaleu_ratings.native_create_policy_heads'),
    ),
  );
  // Specialist concepts cannot be enabled by a mislabeled generic native policy.
  await assert.rejects(
    inTransaction(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.native_create_policies SELECT $1,region_id,'course',source_reference,policy_reference,issuer,99,enabled,require_known_origin,coverage,provenance,effective_at,valid_until FROM whaleu_ratings.native_create_policies WHERE id=$2`,
        [randomUUID(), policy],
      ),
    ),
  );
});
