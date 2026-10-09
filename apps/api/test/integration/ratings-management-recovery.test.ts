import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import {
  ratingRuntimeFixture,
  approveRating,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ratingTargetCreateHash } from '../../src/ratings/management/service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import type { PrepareRatingTarget } from '../../src/ratings/management/contracts.js';
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';

test('M1 durable terminal recovery, expired preparation, same-account session change and cancel/create races', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  const c = await f.catalog(actor, { count: 0 });
  let current = c.catalogId,
    policy = randomUUID();
  const writePolicy = async (revision: number, until: Date) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-source','synthetic-policy','synthetic-source-owner',$2,true,'complete','accepted',clock_timestamp(),$3)`,
        [policy, revision, until],
      );
      await tx.query(
        "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1) ON CONFLICT(scope_key,generic_kind) DO UPDATE SET policy_id=EXCLUDED.policy_id",
        [policy],
      );
    });
  await writePolicy(1, new Date(Date.now() + 3600000));
  const input = (name: string): PrepareRatingTarget => ({
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: c.categoryId,
    expectedCategoryRevision: c.categoryRevision,
    expectedCatalogRevision: current,
    name,
    description: '',
    assetIds: [],
  });
  const post = (path: string, body: object, token = actor.accessToken) =>
    request(f.http)
      .post('/v1/ratings/management/' + path)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (id: string) =>
    f.auth(request(f.http).get('/v1/ratings/management/requests/' + id), actor);
  const unknown = input('No issued approval');
  const up = await post('prepare', unknown);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(
    (
      await post('targets', {
        ...unknown,
        expectedContextRevision: up.body.contextRevision,
      })
    ).body.error.code,
    'CONTENT_REVIEW_UNAVAILABLE',
  );
  const cancelled = await post('cancel', unknown);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.code, 'RATING_CREATION_CANCELLED');
  assert.deepEqual((await get(unknown.clientRequestId)).body, cancelled.body);
  assert.deepEqual((await post('cancel', unknown)).body, cancelled.body);
  assert.deepEqual(
    (
      await post('targets', {
        ...unknown,
        expectedContextRevision: up.body.contextRevision,
      })
    ).body,
    cancelled.body,
  );
  const neverPrepared = input('Cancel missing prepare response');
  assert.equal(
    (await post('cancel', neverPrepared)).body.code,
    'RATING_CREATION_CANCELLED',
  );
  const rejected = input('Explicit reject');
  const rp = await post('prepare', rejected);
  let envelope = (
    await f.pool.query<{ envelope: RatingContentEnvelope }>(
      'SELECT envelope FROM whaleu_ratings.target_preparations WHERE target_id=$1',
      [rp.body.targetId],
    )
  ).rows[0]!.envelope;
  await approveRating(f.pool, envelope, { result: 'reject' });
  const refusal = await post('targets', {
    ...rejected,
    expectedContextRevision: rp.body.contextRevision,
  });
  assert.equal(refusal.body.code, 'CONTENT_REJECTED');
  assert.deepEqual((await get(rejected.clientRequestId)).body, refusal.body);
  // New valid session for the same authenticated provider/account safely closes old preparation.
  const oldSession = input('Old session');
  const sp = await post('prepare', oldSession);
  assert.equal(sp.status, 200, JSON.stringify(sp.body));
  const identity = (
    await f.pool.query<{ provider: 'wechat'; app_id: string; subject: string }>(
      'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
      [actor.accountId],
    )
  ).rows[0]!;
  const access = mintToken('access'),
    refresh = mintToken('refresh');
  await f.app.get(IdentityRepository).createSession(
    {
      provider: identity.provider,
      appId: identity.app_id,
      subject: identity.subject,
    },
    { access: hashToken(access), refresh: hashToken(refresh) },
  );
  const closed = await post(
    'targets',
    { ...oldSession, expectedContextRevision: sp.body.contextRevision },
    access,
  );
  assert.equal(closed.body.code, 'RATING_CREATION_CONTEXT_CHANGED');
  assert.deepEqual((await get(oldSession.clientRequestId)).body, closed.body);
  // Future/expired optional origin facts are unknown, not an extra user permission gate.
  for (const timing of ['future', 'expired'] as const) {
    const q = input(timing + ' original campus');
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.native_origin_evidence(id,account_id,request_id,intent_hash,region_id,policy_id,origin_state,origin_campus_id,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,$3,$4,NULL,$5,'known_school',$6,'synthetic-origin','synthetic-origin-policy',$7,$8)`,
        [
          randomUUID(),
          actor.accountId,
          q.clientRequestId,
          ratingTargetCreateHash(q),
          policy,
          f.scope.home.campusId,
          new Date(Date.now() + (timing === 'future' ? 60000 : -120000)),
          new Date(Date.now() + (timing === 'future' ? 120000 : -60000)),
        ],
      ),
    );
    const prep = await post('prepare', q);
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.equal(
      (
        await f.pool.query(
          'SELECT origin_evidence_id FROM whaleu_ratings.target_preparations WHERE target_id=$1',
          [prep.body.targetId],
        )
      ).rows[0].origin_evidence_id,
      null,
    );
    await post('cancel', q);
  }
  const race = input('Cancel/create race');
  const prep = await post('prepare', race);
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  envelope = (
    await f.pool.query<{ envelope: RatingContentEnvelope }>(
      'SELECT envelope FROM whaleu_ratings.target_preparations WHERE target_id=$1',
      [prep.body.targetId],
    )
  ).rows[0]!.envelope;
  await approveRating(f.pool, envelope);
  const [one, two] = await Promise.all([
    post('targets', {
      ...race,
      expectedContextRevision: prep.body.contextRevision,
    }),
    post('cancel', race),
  ]);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(two.status, 200, JSON.stringify(two.body));
  assert.deepEqual(one.body, two.body);
  assert.deepEqual((await get(race.clientRequestId)).body, one.body);
  if (one.body.outcome === 'applied') current = one.body.catalogRevision;
  const counts = (
    await f.pool.query(
      'SELECT count(*)::int n FROM whaleu_ratings.targets WHERE id=$1',
      [prep.body.targetId],
    )
  ).rows[0].n;
  assert.equal(counts, one.body.outcome === 'applied' ? 1 : 0);
  // Real clock expiry, no mutation of immutable preparations or synthetic allow switch.
  policy = randomUUID();
  await writePolicy(2, new Date(Date.now() + 800));
  const short = input('Expires while app closed');
  const shortPrep = await post('prepare', short);
  assert.equal(shortPrep.status, 200, JSON.stringify(shortPrep.body));
  await sleep(850);
  const expired = await post('targets', {
    ...short,
    expectedContextRevision: shortPrep.body.contextRevision,
  });
  assert.equal(expired.body.code, 'RATING_CREATION_CONTEXT_CHANGED');
  assert.deepEqual((await get(short.clientRequestId)).body, expired.body);
  const fresh = input('New intent after confirmed cancellation');
  assert.equal(
    (await post('cancel', fresh)).body.code,
    'RATING_CREATION_CANCELLED',
  );
});
