/** Current binary, genuine pre-cover schema: no new relation may be consulted
 * by the original pure-text v2 command/current-definition path. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingTargetSchema } from '../../src/ratings/contracts.js';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import {
  scopedCommandContext,
  scopedCommandRoute,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';

test('actual 0065 v2 read, prepare, create, edit and original receipt never require cover schema', async (t) => {
  const f = await ratingScopedFixture(65);
  t.after(() => f.close());
  const actor = f.creator,
    data = await f.seedScopedCatalogs({ different: false });
  await f.issueSource({
    kind: 'native_scoped_create',
    key: 'synthetic-native-scoped-create',
    scopeKeys: f.scopeKeys,
    payload: { enabled: true, genericKind: 'general', scopeKeys: f.scopeKeys },
  });
  await f.publish({ activate: true });
  assert.equal(
    (
      await f.pool.query(
        "SELECT to_regclass('whaleu_community.rating_target_cover_definition_bindings') relation",
      )
    ).rows[0].relation,
    null,
  );
  const execute = async (intent: RatingScopedIntent) => {
    const prepared = await f
      .auth(
        request(f.http).post(
          intent.operation === 'create_target_scoped'
            ? '/v2/ratings/management/prepare'
            : '/v2/ratings/management/owner-edit/prepare',
        ),
        actor,
      )
      .send(intent);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const p = ratingScopedPreparationSchema.parse(prepared.body);
    const row = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, intent.payload.clientRequestId],
      )
    ).rows[0]!;
    await f.approveScoped(canonicalRatingScopedEnvelope(row.envelope));
    const route = scopedCommandRoute(intent);
    const result = await f
      .auth(request(f.http)[route.method](route.path), actor)
      .send({ ...intent, preparationContextRevision: p.contextRevision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return scopedSuccess(result.body);
  };
  const context = await f.scopedContext(
    actor,
    { kind: 'global' },
    'create_target',
  );
  const category = (
    await f.pool.query<{ effective_revision: string }>(
      'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
      [context.heads[0]!.catalogRevision, data.global.categoryId],
    )
  ).rows[0]!;
  const intent = ratingScopedIntentSchema.parse({
    protocolVersion: 2,
    operation: 'create_target_scoped',
    context: scopedCommandContext(context),
    payload: {
      clientRequestId: randomUUID(),
      categoryId: data.global.categoryId,
      expectedCategoryRevision: category.effective_revision,
      name: '0065 text target',
      description: 'No cover schema installed',
      assetIds: [],
    },
  });
  const receipt = await execute(intent),
    targetId = String(receipt.result['targetId']);
  const read = async (path: string) => {
    const c = await f.scopedContext(actor);
    const result = await f
      .auth(request(f.http).get(path), actor)
      .query({ contextId: c.id, contextToken: c.token });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return ratingTargetSchema.parse(result.body);
  };
  assert.equal(
    (await read(`/v2/ratings/targets/${targetId}`)).name,
    '0065 text target',
  );
  const editContext = await f.scopedContext(
    actor,
    { kind: 'global' },
    'edit_target',
  );
  const editResponse = await f
    .auth(
      request(f.http).get(
        `/v2/ratings/management/owner-edit/targets/${targetId}/context`,
      ),
      actor,
    )
    .query({ contextId: editContext.id, contextToken: editContext.token });
  assert.equal(editResponse.status, 200, JSON.stringify(editResponse.body));
  const current = ratingScopedEditContextSchema.parse(editResponse.body);
  await execute(
    ratingScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'edit_target_scoped',
      context: scopedCommandContext(editContext),
      payload: {
        clientRequestId: randomUUID(),
        targetId,
        expectedTargetRevision: current.revision,
        expectedDefinitionRevision: current.definitionRevision,
        expectedContentVersion: current.contentVersion,
        categoryId: current.categoryId,
        expectedCategoryRevision: current.categoryRevision,
        name: '0065 text edited',
        description: current.description,
        assetIds: [],
      },
    }),
  );
  assert.equal(
    (await read(`/v2/ratings/targets/${targetId}`)).name,
    '0065 text edited',
  );
  const recovered = await f.auth(
    request(f.http).get(
      `/v2/ratings/requests/${intent.payload.clientRequestId}`,
    ),
    actor,
  );
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.deepEqual(recovered.body, receipt);
  assert.equal(
    (
      await f.pool.query(
        "SELECT to_regclass('whaleu_ratings.target_cover_appearances') relation",
      )
    ).rows[0].relation,
    null,
  );
});
