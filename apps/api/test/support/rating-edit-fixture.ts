/** Synthetic canonical owner facts only; no real issuer/provider or bypass. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingDeletionFixture } from './rating-deletion-fixture.js';
import { approveRating } from './rating-runtime-fixture.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import {
  prepareRatingTargetEditSchema,
  ratingTargetEditContextSchema,
  ratingTargetEditPreparationSchema,
  ratingTargetEditReceiptSchema,
} from '../../src/ratings/management/target-edit/contracts.js';
import type { PrepareRatingTargetEdit } from '../../src/ratings/management/target-edit/contracts.js';
export const ratingEditPrefix = '/v1/ratings/management/owner-edit';
export async function ratingEditFixture(maximumMigration?: number) {
  const f = await ratingDeletionFixture(maximumMigration);
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const context = async (actor: Actor, id: string) => {
    const response = await f.auth(
      request(f.http).get(`${ratingEditPrefix}/targets/${id}/context`),
      actor,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingTargetEditContextSchema.parse(response.body);
  };
  const intent = (
    current: ReturnType<typeof ratingTargetEditContextSchema.parse>,
    patch: Partial<PrepareRatingTargetEdit> = {},
  ) =>
    prepareRatingTargetEditSchema.parse({
      clientRequestId: randomUUID(),
      targetId: current.targetId,
      regionId: current.regionId,
      expectedTargetRevision: current.revision,
      expectedDefinitionRevision: current.definitionRevision,
      expectedContentVersion: current.contentVersion,
      categoryId: current.categoryId,
      expectedCategoryRevision: current.categoryRevision,
      expectedCatalogRevision: current.catalogRevision,
      name: current.name,
      description: current.description,
      assetIds: [],
      ...patch,
    });
  const prepare = async (actor: Actor, input: PrepareRatingTargetEdit) => {
    const response = await f
      .auth(request(f.http).post(`${ratingEditPrefix}/prepare`), actor)
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingTargetEditPreparationSchema.parse(response.body);
  };
  const approval = async (
    actor: Actor,
    input: PrepareRatingTargetEdit,
    options: Parameters<typeof approveRating>[2] = {},
  ) => {
    const row = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, input.clientRequestId],
      )
    ).rows[0];
    assert.ok(row, 'A real persisted preparation is required for exact Review');
    return approveRating(
      f.pool,
      canonicalRatingEnvelope(row.envelope),
      options,
    );
  };
  const commit = (
    actor: Actor,
    input: PrepareRatingTargetEdit,
    contextRevision: string,
  ) =>
    f
      .auth(request(f.http).post(`${ratingEditPrefix}/commit`), actor)
      .send({ ...input, expectedContextRevision: contextRevision });
  const edit = async (
    actor: Actor,
    id: string,
    patch: Partial<PrepareRatingTargetEdit>,
  ) => {
    const before = await context(actor, id),
      input = intent(before, patch),
      prepared = await prepare(actor, input);
    const reviewed =
      before.name === input.name && before.description === input.description
        ? null
        : await approval(actor, input);
    const response = await commit(actor, input, prepared.contextRevision);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = ratingTargetEditReceiptSchema.parse(response.body);
    if (receipt.outcome === 'rejected') assert.fail(JSON.stringify(receipt));
    return { before, input, prepared, reviewed, receipt };
  };
  return {
    ...f,
    editContext: context,
    editIntent: intent,
    prepareEdit: prepare,
    approveEdit: approval,
    commitEdit: commit,
    edit,
  };
}
