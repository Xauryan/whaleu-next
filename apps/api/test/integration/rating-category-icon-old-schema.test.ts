/** New owner composition must preserve the exact original Category v2 path on schema87. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { ratingCategoryManagementFixture } from '../support/rating-category-management-fixture.js';

test(
  'schema87 original Category v2 read prepare commit and receipt recovery never depend on Category icon tables',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({ maximumMigration: 87 });
    t.after(() => f.close());
    const absent = async () =>
      assert.equal(
        (
          await f.pool.query(
            "SELECT to_regclass('whaleu_ratings.category_icon_preparations') present",
          )
        ).rows[0]!.present,
        null,
      );
    await absent();
    const before = await f.managementContext(f.admin);
    const input = f.managementIntent(before, 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'campuses', campusIds: [f.campusA] },
      nodes: [
        {
          key: 'oldschema',
          parentKey: null,
          name: 'Original schema87 category',
          description: 'No new media authority',
        },
      ],
    });
    const prepared = await f.prepareManagement(f.admin, input);
    assert.equal(input.protocolVersion, 2);
    assert.equal(prepared.requestId, input.payload.clientRequestId);
    await f.approveManagement(f.admin, input);
    const committed = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.outcome, 'applied');
    const after = await f.managementContext(f.admin);
    assert.notEqual(after.snapshotRevision, before.snapshotRevision);
    const read = await f
      .auth(
        request(f.http).get(
          `/v2/ratings/category-management/categories/${committed.body.result.categoryIds[0]}`,
        ),
        f.admin,
      )
      .query({
        contextId: after.commandContext.id,
        contextToken: after.commandContext.token,
      });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const receipt = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${input.payload.clientRequestId}`,
      ),
      f.admin,
    );
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.deepEqual(receipt.body, committed.body);
    const recovered = await f.managementPost(f.admin, 'prepare', input);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(recovered.body, committed.body);
    const replay = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.deepEqual(replay.body, committed.body);
    await absent();
  },
);
