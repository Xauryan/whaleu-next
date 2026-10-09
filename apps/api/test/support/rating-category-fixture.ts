/** Disposable canonical owner facts and real AppModule only. No runtime issuer. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { ratingEditFixture } from './rating-edit-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalRatingCategoryEnvelope,
  ratingCategoryApprovalDigest,
} from '../../src/community/content-review/rating-category-contracts.js';
import type { RatingCategoryEnvelope } from '../../src/community/content-review/rating-category-contracts.js';
import {
  prepareRatingCategoriesSchema,
  ratingCategoryManagementContextSchema,
  ratingCategoryPreparationSchema,
  ratingCategoryReceiptSchema,
} from '../../src/ratings/category-management/contracts.js';
import { ratingPublicIdSchema } from '../../src/ratings/contracts.js';
import type { PrepareRatingCategories } from '../../src/ratings/category-management/contracts.js';
export const ratingCategoryPrefix = '/v1/ratings/category-management';
/** Bridge validated public UUIDs to Node's stronger UUID template type in old fixtures. */
export function ratingFixtureUuid(
  value: unknown,
): ReturnType<typeof randomUUID> {
  return ratingPublicIdSchema.parse(value) as ReturnType<typeof randomUUID>;
}
export async function writeCategoryApproval(
  tx: PoolClient,
  value: RatingCategoryEnvelope,
  options: {
    result?: 'allow' | 'reject' | 'pending' | 'failed';
    consumeUntil?: Date;
    visibilityUntil?: Date;
    policyUntil?: Date;
  } = {},
) {
  const envelope = canonicalRatingCategoryEnvelope(value),
    digest = ratingCategoryApprovalDigest(envelope),
    policyRevisionId = randomUUID(),
    decisionId = randomUUID(),
    eventId = randomUUID();
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
  ).rows[0]!.now.getTime();
  const evaluatedAt = new Date(
    Math.min(
      now - 1000,
      (options.consumeUntil?.getTime() ?? Infinity) - 1000,
      (options.visibilityUntil?.getTime() ?? Infinity) - 1000,
      (options.policyUntil?.getTime() ?? Infinity) - 1000,
    ),
  );
  await tx.query(
    "INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until) VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-category-review','synthetic-category-policy',$2,$3)",
    [
      policyRevisionId,
      new Date(evaluatedAt.getTime() - 1000),
      options.policyUntil ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
    VALUES($1,$2,'publish_rating_categories',4,$3,$4::jsonb,$5,$6,'complete','accepted','synthetic-category-review','synthetic-exact-category-release',$7,$8,$9,$10)`,
    [
      decisionId,
      envelope.accountId,
      digest,
      canonicalJson(envelope),
      policyRevisionId,
      options.result ?? 'allow',
      evaluatedAt,
      options.consumeUntil ?? new Date(now + 3600000),
      options.visibilityUntil ? 'until' : 'durable',
      options.visibilityUntil ?? null,
    ],
  );
  await tx.query(
    "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-category-review','synthetic-category-event',$3)",
    [eventId, decisionId, evaluatedAt],
  );
  await tx.query(
    'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
    [decisionId, eventId],
  );
  return {
    decisionId,
    policyRevisionId,
    eventId,
    digest,
    envelope,
    version: 4 as const,
  };
}
export function approveCategoryEnvelope(
  pool: Pool,
  envelope: RatingCategoryEnvelope,
  options: Parameters<typeof writeCategoryApproval>[2] = {},
) {
  return withCommunityScopeWriter(pool, (tx) =>
    writeCategoryApproval(tx, envelope, options),
  );
}
export async function ratingCategoryFixture() {
  const f = await ratingEditFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const context = async (actor: Actor, regionId: string | null = null) => {
    let get = f.auth(
      request(f.http).get(`${ratingCategoryPrefix}/context`),
      actor,
    );
    if (regionId) get = get.query({ regionId });
    const response = await get;
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingCategoryManagementContextSchema.parse(response.body);
  };
  const intent = (
    current: ReturnType<typeof ratingCategoryManagementContextSchema.parse>,
    patch: Partial<PrepareRatingCategories> = {},
  ) =>
    prepareRatingCategoriesSchema.parse({
      clientRequestId: randomUUID(),
      regionId: current.regionId,
      expectedCatalogRevision: current.catalogRevision,
      expectedScopeRevision: current.scopeRevision,
      parentId: null,
      expectedParentRevision: null,
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Native category',
          description: 'Exact reviewed native category',
        },
      ],
      assetIds: [],
      ...patch,
    });
  const prepare = async (actor: Actor, input: PrepareRatingCategories) => {
    const response = await f
      .auth(request(f.http).post(`${ratingCategoryPrefix}/prepare`), actor)
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingCategoryPreparationSchema.parse(response.body);
  };
  const approve = async (
    actor: Actor,
    input: PrepareRatingCategories,
    options: Parameters<typeof writeCategoryApproval>[2] = {},
  ) => {
    const row = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.category_command_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, input.clientRequestId],
      )
    ).rows[0];
    assert.ok(row, 'Exact persisted category preparation is required');
    return approveCategoryEnvelope(
      f.pool,
      canonicalRatingCategoryEnvelope(row.envelope),
      options,
    );
  };
  const commit = (
    actor: Actor,
    input: PrepareRatingCategories,
    contextRevision: string,
  ) =>
    f
      .auth(request(f.http).post(`${ratingCategoryPrefix}/categories`), actor)
      .send({ ...input, expectedContextRevision: contextRevision });
  const create = async (
    actor: Actor,
    regionId: string | null = null,
    patch: Partial<PrepareRatingCategories> = {},
  ) => {
    const before = await context(actor, regionId),
      input = intent(before, patch),
      prepared = await prepare(actor, input),
      reviewed = await approve(actor, input);
    const response = await commit(actor, input, prepared.contextRevision);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = ratingCategoryReceiptSchema.parse(response.body);
    if (receipt.outcome === 'rejected') assert.fail(JSON.stringify(receipt));
    return { before, input, prepared, reviewed, receipt };
  };
  return {
    ...f,
    categoryContext: context,
    categoryIntent: intent,
    prepareCategories: prepare,
    approveCategories: approve,
    commitCategories: commit,
    createCategories: create,
  };
}
