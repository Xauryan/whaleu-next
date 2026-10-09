import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingRuntimeFixture } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { RatingRandomDraw } from '../../src/ratings/random/draw.js';

test('R3R native institution includes every campus across groups, validates duplicate paths and preserves detail context', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const ordinary = await f.actor();
  const admin = await f.actor({ affiliation: 'unverified', identity: false });
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',NULL,$2,'synthetic-random-scope-global-admin')`,
      [randomUUID(), admin.accountId],
    ),
  );
  const global = await f.catalog(admin);
  const scopes = [f.scope.home, f.scope.related, f.scope.foreign];
  const expected = new Map<string, string | null>([
    [global.targets[0]!.id, null],
  ]);
  for (const scope of scopes) {
    const catalog = await f.catalog(admin, {
      regionId: scope.regionId,
      categoryIds: global.categoryIds,
      sharedTargets: [
        { id: global.targets[0]!.id, categoryId: global.categoryId },
      ],
    });
    expected.set(catalog.targets[0]!.id, scope.regionId);
  }
  const select = (actor = admin) =>
    f
      .auth(request(f.http).get('/v1/ratings/random-target'), actor)
      .query({ categoryId: global.rootId, campusId: f.scope.home.campusId });
  const denied = await select(ordinary);
  assert.equal(
    denied.body.error.code,
    'RATING_SCOPE_UNAVAILABLE',
    JSON.stringify(denied.body),
  );
  assert.equal(denied.body.item, undefined);
  const draw = f.app.get(RatingRandomDraw),
    original = draw.index.bind(draw);
  t.after(() => {
    draw.index = original;
  });
  const seen = new Set<string>();
  for (let index = 0; index < 4; index++) {
    draw.index = (count) => {
      assert.equal(count, 4);
      return index;
    };
    const result = await select();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(
      result.body.candidateCount,
      4,
      'the global target has four valid paths but only one sampling slot',
    );
    seen.add(result.body.item.target.id);
    const regional = expected.get(result.body.item.target.id);
    if (regional !== null) assert.equal(result.body.item.regionId, regional);
    const detail = await f
      .auth(
        request(f.http).get(
          `/v1/ratings/targets/${result.body.item.target.id}`,
        ),
        admin,
      )
      .query(
        result.body.item.regionId === null
          ? {}
          : { regionId: result.body.item.regionId },
      );
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(result.body.item.target, detail.body);
  }
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort());
  // A real active sibling without accepted topology evidence is not silently
  // ignored, even though the original selected campus and role still exist.
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Synthetic missing topology sibling','synthetic',true)`,
      [randomUUID(), f.scope.institutionId],
    ),
  );
  const incomplete = await select();
  assert.equal(
    incomplete.body.error.code,
    'IDENTITY_CAMPUS_UNAVAILABLE',
    JSON.stringify(incomplete.body),
  );
  assert.equal(incomplete.body.item, undefined);
});
