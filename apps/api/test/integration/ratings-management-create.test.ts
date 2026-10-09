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
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';

test('M1 native create exact source, immutable catalog, zero, scoring and recovery', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const actor = await f.actor(),
    other = await f.actor(),
    noPhone = await f.actor({ phone: 'unverified' });
  const c = await f.catalog(actor, { count: 2, depth: 3 });
  const intent = {
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: c.categoryId,
    expectedCategoryRevision: c.categoryRevision,
    expectedCatalogRevision: c.catalogId,
    name: 'New native target',
    description: 'Exact reviewed description',
    assetIds: [],
  };
  const post = (path: string, body: object, a = actor) =>
    f
      .auth(request(f.http).post('/v1/ratings/management/' + path), a)
      .send(body);
  const missing = await post('prepare', intent);
  assert.equal(missing.status, 503, JSON.stringify(missing.body));
  const policy = randomUUID();
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-native-source-v1','synthetic-native-policy-v1','synthetic-owning-source-issuer',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
      [policy],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
      [policy],
    );
  });
  assert.equal(
    (
      await post(
        'prepare',
        { ...intent, clientRequestId: randomUUID() },
        noPhone,
      )
    ).body.error.code,
    'PHONE_VERIFICATION_REQUIRED',
  );
  const prepared = await post('prepare', intent);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.deepEqual((await post('prepare', intent)).body, prepared.body);
  assert.equal(
    (await post('prepare', { ...intent, name: 'Different' })).body.error.code,
    'REQUEST_CONFLICT',
  );
  const command = {
    ...intent,
    expectedContextRevision: prepared.body.contextRevision,
  };
  const noReview = await post('targets', command);
  assert.equal(noReview.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.target_create_transitions',
      )
    ).rows[0].n,
    0,
  );
  const p = (
    await f.pool.query<{ envelope: RatingContentEnvelope }>(
      'SELECT envelope FROM whaleu_ratings.target_preparations WHERE target_id=$1',
      [prepared.body.targetId],
    )
  ).rows[0]!;
  await approveRating(f.pool, p.envelope);
  const [first, repeated] = await Promise.all([
    post('targets', command),
    post('targets', command),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(first.body, repeated.body);
  const receipt = await f.auth(
    request(f.http).get(
      '/v1/ratings/management/requests/' + intent.clientRequestId,
    ),
    actor,
  );
  assert.deepEqual(receipt.body, first.body);
  assert.equal(
    (
      await f.auth(
        request(f.http).get(
          '/v1/ratings/management/requests/' + intent.clientRequestId,
        ),
        other,
      )
    ).status,
    404,
  );
  assert.deepEqual((await post('prepare', intent)).body, prepared.body);
  const target = prepared.body.targetId,
    newCatalog = first.body.catalogRevision;
  const summary = await f.auth(
    request(f.http).get(`/v1/ratings/targets/${target}/score-summary`),
    actor,
  );
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.status, 'known');
  assert.equal(summary.body.count, 0);
  const detail = await f.auth(
    request(f.http).get(`/v1/ratings/targets/${target}`),
    actor,
  );
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  const scored = await f
    .auth(request(f.http).put(`/v1/ratings/targets/${target}/my-score`), actor)
    .send({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: prepared.body.revision,
      expectedRevision: null,
      score: 5,
    });
  assert.equal(scored.status, 200, JSON.stringify(scored.body));
  const origin = (
    await f.pool.query(
      'SELECT state,origin_campus_id,coverage_state,provenance_state FROM whaleu_ratings.target_origin_sources WHERE target_id=$1',
      [target],
    )
  ).rows[0];
  assert.deepEqual(origin, {
    state: 'unknown',
    origin_campus_id: null,
    coverage_state: 'missing',
    provenance_state: 'unknown',
  });
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.target_create_transitions',
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.target_memberships WHERE catalog_id=$1',
        [c.catalogId],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.target_memberships WHERE catalog_id=$1',
        [newCatalog],
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.categories WHERE catalog_id=$1',
        [newCatalog],
      )
    ).rows[0].n,
    3,
  );
  // Original shared request namespace remains conflict-safe from either family.
  const conflict = await f
    .auth(request(f.http).put(`/v1/ratings/targets/${target}/my-score`), actor)
    .send({
      clientRequestId: intent.clientRequestId,
      regionId: null,
      expectedTargetRevision: prepared.body.revision,
      expectedRevision: null,
      score: 4,
    });
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
  await assert.rejects(
    inTransaction(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_ratings.target_create_transitions SET revision=$1',
        [randomUUID()],
      ),
    ),
  );
  await assert.rejects(
    inTransaction(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted',$3,'synthetic-native-policy-v1',clock_timestamp())`,
        [
          randomUUID(),
          randomUUID(),
          `rating-create:${actor.accountId}:${randomUUID()}`,
        ],
      ),
    ),
  );
  const stale = await post('prepare', {
    ...intent,
    clientRequestId: randomUUID(),
  });
  assert.equal(stale.body.error.code, 'RATING_CREATION_CONTEXT_CHANGED');
});
