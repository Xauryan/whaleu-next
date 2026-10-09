/** Synthetic isolated facts through normal AppModule and canonical owner tables.
 * No runtime issuer, approval override, production data or historical zero. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../../src/community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { createRatingCommentSchema } from '../../src/ratings/contracts.js';
import type { CreateRatingComment } from '../../src/ratings/contracts.js';
export async function writeRatingApproval(
  tx: PoolClient,
  value: RatingContentEnvelope,
  options: {
    result?: 'allow' | 'reject' | 'pending' | 'failed';
    consumeUntil?: Date;
    visibilityUntil?: Date;
  } = {},
) {
  const envelope = canonicalRatingEnvelope(value),
    digest = ratingApprovalDigest(envelope),
    policyRevisionId = randomUUID(),
    decisionId = randomUUID(),
    eventId = randomUUID();
  const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime(),
    evaluatedAt = new Date(
      Math.min(
        now - 1000,
        (options.consumeUntil?.getTime() ?? Infinity) - 1000,
        (options.visibilityUntil?.getTime() ?? Infinity) - 1000,
      ),
    );
  await tx.query(
    `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until) VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-rating-review','synthetic-rating-policy',$2,NULL)`,
    [policyRevisionId, new Date(evaluatedAt.getTime() - 1000)],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until) VALUES($1,$2,$3,1,$4,$5::jsonb,$6,$7,'complete','accepted','synthetic-rating-review','synthetic-exact-rating-approval',$8,$9,$10,$11)`,
    [
      decisionId,
      envelope.accountId,
      envelope.purpose,
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
    `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-rating-review','synthetic-rating-event',$3)`,
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
    version: 1 as const,
  };
}
export async function approveRating(
  pool: Pool,
  envelope: RatingContentEnvelope,
  options: Parameters<typeof writeRatingApproval>[2] = {},
) {
  return withCommunityScopeWriter(pool, (tx) =>
    writeRatingApproval(tx, envelope, options),
  );
}
export async function setRatingReviewState(
  pool: Pool,
  id: string,
  state: 'allow' | 'held' | 'revoked',
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-rating-review','synthetic-rating-state',clock_timestamp())`,
      [eventId, id, state],
    );
    await tx.query(
      'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
      [id, eventId],
    );
    return eventId;
  });
}
export async function ratingRuntimeFixture() {
  const f = await directoryRuntimeFixture(),
    http = f.app.getHttpServer();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const auth = (r: request.Test, a: Actor) =>
    r.set('Authorization', `Bearer ${a.accessToken}`);
  const catalog = async (
    a: Actor,
    options: {
      regionId?: string | null;
      count?: number;
      baseline?: boolean;
      depth?: 1 | 2 | 3;
      validUntil?: Date;
      hidden?: boolean;
    } = {},
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const catalogId = randomUUID(),
        regionId = options.regionId ?? null,
        rootId = randomUUID(),
        categoryIds = [rootId],
        categoryRevisions = [randomUUID()];
      await tx.query(
        `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,'complete','accepted','synthetic-rating-catalog','synthetic-effective-override-policy',clock_timestamp()-interval '1 second',$3)`,
        [catalogId, regionId, options.validUntil ?? null],
      );
      for (let i = 0; i < (options.depth ?? 1); i++) {
        if (i) {
          categoryIds.push(randomUUID());
          categoryRevisions.push(randomUUID());
        }
        await tx.query(
          `INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal) VALUES($1,$2,$3,$4,$5,$6,'general',NULL,$7,'Synthetic description',true,$8,$9)`,
          [
            catalogId,
            categoryIds[i],
            categoryRevisions[i],
            i ? categoryIds[i - 1] : null,
            i + 1,
            regionId ? 'regional' : 'global',
            `Synthetic category ${i + 1}`,
            options.hidden ?? false,
            i,
          ],
        );
      }
      const categoryId = categoryIds.at(-1)!,
        categoryRevision = categoryRevisions.at(-1)!,
        targets = [];
      for (let i = 0; i < (options.count ?? 1); i++) {
        const id = randomUUID(),
          revision = randomUUID(),
          source = randomUUID(),
          name = `Synthetic target ${i + 1}`;
        const envelope = canonicalRatingEnvelope({
          version: 1,
          accountId: a.accountId,
          purpose: 'publish_rating_target',
          clientRequestId: randomUUID(),
          targetId: id,
          targetRevision: revision,
          categoryId,
          categoryRevision,
          catalogRevision: catalogId,
          scope: { regionId },
          assetIds: [],
          name,
          description: 'Synthetic target description',
        });
        const approval = await writeRatingApproval(tx, envelope);
        await tx.query(
          `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,$3,'complete','accepted','synthetic-new-target-source','synthetic-new-domain-target-policy',clock_timestamp())`,
          [
            source,
            id,
            options.baseline === false ? 'historical' : 'new_native',
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic target description',true,$8::jsonb)`,
          [
            id,
            revision,
            categoryId,
            a.accountId,
            regionId,
            source,
            name,
            canonicalJson(envelope),
          ],
        );
        if (options.baseline !== false)
          await tx.query(
            `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,'synthetic-independent-score-baseline','synthetic-fresh-target-score-policy')`,
            [id, randomUUID(), source],
          );
        await tx.query(
          `INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('target',$1,1,$2,$3,'publish_rating_target',1,$4,$5::jsonb,$6::jsonb)`,
          [
            id,
            approval.decisionId,
            a.accountId,
            approval.digest,
            canonicalJson(envelope),
            canonicalJson(envelope.scope),
          ],
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.target_memberships(catalog_id,target_id,category_id,ordinal) VALUES($1,$2,$3,$4)',
          [catalogId, id, categoryId, i],
        );
        targets.push({ id, revision, approval });
      }
      await tx.query(
        'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
        [catalogId],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES(coalesce($1::uuid::text,'global'),$1,$2) ON CONFLICT(scope_key) DO UPDATE SET catalog_id=EXCLUDED.catalog_id`,
        [regionId, catalogId],
      );
      return {
        catalogId,
        categoryId,
        categoryRevision,
        rootId,
        categoryIds,
        categoryRevisions,
        regionId,
        targets,
      };
    });
  type Catalog = Awaited<ReturnType<typeof catalog>>;
  type Target = Catalog['targets'][number];
  const body = (
    c: Catalog,
    t: Target,
    patch: Partial<CreateRatingComment> = {},
  ): CreateRatingComment =>
    createRatingCommentSchema.parse({
      clientRequestId: randomUUID(),
      regionId: c.regionId,
      expectedTargetRevision: t.revision,
      authorMode: 'named',
      body: 'Synthetic root comment',
      assetIds: [],
      ...patch,
    });
  const envelope = (
    a: Actor,
    c: Catalog,
    t: Target,
    input: CreateRatingComment,
  ) =>
    canonicalRatingEnvelope({
      version: 1,
      accountId: a.accountId,
      purpose: 'publish_rating_comment',
      clientRequestId: input.clientRequestId,
      targetId: t.id,
      targetRevision: input.expectedTargetRevision,
      categoryId: c.categoryId,
      categoryRevision: c.categoryRevision,
      catalogRevision: c.catalogId,
      scope: { regionId: c.regionId },
      assetIds: [],
      authorMode: input.authorMode,
      body: input.body,
    });
  const publish = async (
    a: Actor,
    c: Catalog,
    t: Target,
    input = body(c, t),
  ) => {
    const approval = await approveRating(f.pool, envelope(a, c, t, input));
    const response = await auth(
      request(http).post(`/v1/ratings/targets/${t.id}/comments`),
      a,
    ).send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    return {
      id: response.body.subjectId as string,
      revision: response.body.revision as string,
      receipt: response.body,
      approval,
      input,
    };
  };
  return { ...f, http, auth, catalog, body, envelope, publish };
}
export type RatingRuntimeFixture = Awaited<
  ReturnType<typeof ratingRuntimeFixture>
>;
