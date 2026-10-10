import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import {
  ratingScopedFixture,
  writeRatingScopedSource,
} from '../support/rating-scoped-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
  editSyntheticAdoptedTarget,
} from '../support/rating-scoped-adoption-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import {
  ratingScopedContextSchema,
  ratingScopedIntentSchema,
  type RatingScopedContext,
} from '../../src/ratings/scoped/contracts.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import { ratingScopedCommandHash } from '../../src/ratings/scoped/protocol-registry.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { ratingIso } from '../../src/ratings/repository.js';

// 2,048 genuine v1 target/Review/source/baseline chains, not synthetic candidates.
// Retained root rows plus a 1,001-target child produce both exact sample sizes in
// one fixture. Each target gets independent accepted placements in three scopes.
test(
  'M3B full 1001/2048 real scoped random pools, mixed Review, deduplication and hostile full-domain changes',
  { timeout: 900000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator,
      scorer = await f.actor();
    const rootId = randomUUID(),
      leafId = randomUUID();
    const roots = await f.catalog(actor, {
      count: 1047,
      categoryIds: [rootId],
    });
    const legacy = await f.catalog(actor, {
      count: 1001,
      depth: 2,
      categoryIds: [rootId, leafId],
      sharedTargets: roots.targets.map((target) => ({
        id: target.id,
        categoryId: rootId,
      })),
    });
    const targets = [...roots.targets, ...legacy.targets];
    assert.equal(targets.length, 2048);
    const targetIds = targets.map((target) => target.id).sort();
    const campuses = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    for (const scopes of [['global'], campuses]) {
      for (const categoryId of [rootId, leafId]) {
        const prepared = await prepareSyntheticOpaqueAdoption(
          f,
          legacy.catalogId,
          categoryId,
          scopes,
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          writeSyntheticOpaqueAdoption(tx, prepared),
        );
      }
    }
    await f.declareAll();
    for (const scope of ['global', ...campuses])
      await f.declareScope(scope, {
        categoryIds: [rootId, leafId].sort(),
        targetIds,
        legacyCatalogIds: [legacy.catalogId],
      });
    await f.capability();
    await f.publish({ activate: true });
    const edited = await editSyntheticAdoptedTarget(
      f,
      targets[0]!.id,
      { kind: 'global' },
      'One genuine scoped v5 successor among 2047 v1 definitions',
    );
    assert.equal(edited.receipt.result['contentVersion'], 2);
    const versions = (
      await f.pool.query(`SELECT v.envelope->>'version' version,count(*)::int n
    FROM whaleu_ratings.target_definition_heads h JOIN whaleu_ratings.target_definition_versions v
    ON (v.target_id,v.content_version,v.definition_revision)=(h.target_id,h.content_version,h.definition_revision)
    GROUP BY v.envelope->>'version' ORDER BY version`)
    ).rows;
    assert.deepEqual(versions, [
      { version: '1', n: 2047 },
      { version: '5', n: 1 },
    ]);
    const counts = (
      await f.pool
        .query(`SELECT count(*)::int paths,count(DISTINCT m.target_id)::int targets
    FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.scoped_catalog_heads h ON h.catalog_id=m.catalog_id`)
    ).rows[0]!;
    assert.deepEqual(counts, { paths: 6144, targets: 2048 });
    const context = async (anchor: string | null = f.campusA) => {
      const response = await f.requestScopedContext(actor, {
        purpose: 'random',
        mode: 'public',
        selector:
          anchor === null
            ? { kind: 'global' }
            : { kind: 'institution_with_global', anchorCampusId: anchor },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return ratingScopedContextSchema.parse(response.body);
    };
    const sample = (
      current: RatingScopedContext,
      categoryId = rootId,
      minimumAverage?: number,
    ) =>
      f.auth(request(f.http).get('/v2/ratings/random-target'), actor).query({
        contextId: current.id,
        contextToken: current.token,
        categoryId,
        ...(minimumAverage === undefined ? {} : { minimumAverage }),
      });
    const unavailable = (result: {
      status: number;
      body: {
        error?: { code?: string };
        candidateCount?: number;
        item?: unknown;
      };
    }) => {
      assert.notEqual(result.status, 200, JSON.stringify(result.body));
      assert.ok(
        [
          'RATING_SCOPE_UNAVAILABLE',
          'RATING_SCOPED_CONTEXT_CHANGED',
          'RATING_UNAVAILABLE',
          'CONTENT_REVIEW_UNAVAILABLE',
        ].includes(result.body.error?.code ?? ''),
        JSON.stringify(result.body),
      );
      assert.equal(
        result.body.candidateCount,
        undefined,
        'Unknown source must not look like a smaller successful pool',
      );
      assert.equal(result.body.item, undefined);
    };
    let previouslySelected = '';

    await t.test(
      '1001 child and 2048 root candidates are untruncated, despite 6144 real paths and >520 mixed descriptors',
      async () => {
        const observer = observeDirectoryQueries(f.app);
        let reviews = 0,
          batches = 0;
        try {
          observer.setHook(async ({ sql }) => {
            if (
              sql.includes(
                'WITH ORDINALITY w(id,content_version,revision,review_version,account_id,ordinal)',
              )
            )
              reviews++;
            if (
              sql.includes('paths AS MATERIALIZED') &&
              sql.includes('LIMIT 128')
            )
              batches++;
          });
          const current = await context();
          const result = await sample(current);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.candidateCount, 2048);
          assert.ok(targetIds.includes(result.body.item.target.id));
          previouslySelected = result.body.item.target.id;
          assert.deepEqual(result.body.item.locator.selector, {
            kind: 'campus',
            campusId: f.campusA,
          });
          assert.equal(
            result.body.item.locator.protocolGeneration,
            current.protocolGeneration,
          );
          assert.ok(
            reviews >= 48,
            `Expected 48 real 128-descriptor batches; saw ${reviews}`,
          );
          assert.ok(
            batches >= 49,
            'Exact 6144 path boundary requires a real final empty continuation',
          );
          const child = await sample(current, leafId);
          assert.equal(child.status, 200, JSON.stringify(child.body));
          assert.equal(child.body.candidateCount, 1001);
          assert.ok(
            legacy.targets.some(
              (target) => target.id === child.body.item.target.id,
            ),
          );
        } finally {
          observer.restore();
        }
        const global = await context(null);
        const globalResult = await sample(global);
        assert.equal(
          globalResult.status,
          200,
          JSON.stringify(globalResult.body),
        );
        assert.equal(globalResult.body.candidateCount, 2048);
        assert.deepEqual(globalResult.body.item.locator.selector, {
          kind: 'global',
        });
        assert.equal(
          globalResult.body.item.locator.protocolGeneration,
          global.protocolGeneration,
        );
        const otherAnchor = await context(f.campusB);
        const anchored = await sample(otherAnchor);
        assert.equal(anchored.status, 200, JSON.stringify(anchored.body));
        assert.equal(anchored.body.candidateCount, 2048);
        assert.deepEqual(anchored.body.item.locator.selector, {
          kind: 'campus',
          campusId: f.campusB,
        });
      },
    );

    const scored = legacy.targets[0]!;
    const scoreIntent = async (
      owner: typeof actor,
      score: number,
      expectedRevision: string | null,
    ) => {
      const c = await f.scopedContext(owner, { kind: 'global' }, 'interact');
      const category = (
        await f.pool.query(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [c.heads[0]!.catalogRevision, leafId],
        )
      ).rows[0]!;
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'set_score_scoped',
        context: scopedCommandContext(c),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: leafId,
          expectedCategoryRevision: category.effective_revision,
          targetId: scored.id,
          expectedTargetRevision: scored.revision,
          expectedRevision,
          score,
        },
      });
    };
    let scoreRevision = '';
    await t.test(
      'threshold filtering evaluates all 2048 real summaries with exact rational 4.5 versus 4.6 semantics',
      async () => {
        for (const [owner, score] of [
          [actor, 4],
          [scorer, 5],
        ] as const) {
          const input = await scoreIntent(owner, score, null);
          const response = await f
            .auth(
              request(f.http).put(`/v2/ratings/targets/${scored.id}/my-score`),
              owner,
            )
            .send(input);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const receipt = scopedSuccess(response.body);
          if (owner === actor)
            scoreRevision = String(receipt.result['revision']);
        }
        const current = await context();
        const included = await sample(current, rootId, 4.5);
        assert.equal(included.status, 200, JSON.stringify(included.body));
        assert.equal(included.body.candidateCount, 1);
        assert.equal(included.body.item.target.id, scored.id);
        assert.equal(included.body.item.summary.sum, 9);
        assert.equal(included.body.item.summary.count, 2);
        const excluded = await sample(current, rootId, 4.6);
        assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
        assert.equal(excluded.body.candidateCount, 0);
        assert.equal(excluded.body.item, null);
        const missing = await sample(current, randomUUID());
        assert.equal(missing.body.error.code, 'RATING_NOT_FOUND');
      },
    );

    await t.test(
      'unknown Review on a previously unselected target fails the whole query; explicit deny removes exactly one',
      async () => {
        const affected = targets.find(
          (target) =>
            target.id !== previouslySelected && target.id !== targets[0]!.id,
        )!;
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const id = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
        VALUES($1,$2,'allow','missing','accepted','synthetic-random-unknown','synthetic-incomplete-review-observation',clock_timestamp())`,
            [id, affected.approval.decisionId],
          );
          await tx.query(
            'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
            [affected.approval.decisionId, id],
          );
        });
        unavailable(await sample(await context()));
        await setRatingReviewState(
          f.pool,
          affected.approval.decisionId,
          'revoked',
        );
        const denied = await sample(await context());
        assert.equal(denied.status, 200, JSON.stringify(denied.body));
        assert.equal(
          denied.body.candidateCount,
          2047,
          'A proven deny excludes its three paths but only one business target',
        );
        assert.notEqual(denied.body.item.target.id, affected.id);
        await setRatingReviewState(
          f.pool,
          affected.approval.decisionId,
          'allow',
        );
        assert.equal((await sample(await context())).body.candidateCount, 2048);
      },
    );

    await t.test(
      'an expired global or unselected empty-campus source fails full institution sampling rather than silently skipping that scope',
      async () => {
        for (const scopeKey of [
          `campus:${f.scope.related.campusId}`,
          'global',
        ]) {
          const current = (
            await f.pool.query(
              `SELECT s.payload FROM whaleu_ratings.scoped_source_heads h
        JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
        WHERE h.source_kind='scope_absence' AND h.source_key=$1`,
              [scopeKey],
            )
          ).rows[0]!;
          const domain =
            scopeKey === 'global'
              ? { kind: 'global_compat' as const }
              : {
                  kind: 'region_compat' as const,
                  regionId: f.scope.related.regionId,
                };
          const deadline = new Date(Date.now() + 10000);
          await f.atomicChange(
            (tx) =>
              writeRatingScopedSource(tx, {
                kind: 'scope_absence',
                key: scopeKey,
                scopeKeys: [scopeKey],
                payload: current.payload,
                validUntil: deadline,
              }),
            { domain },
          );
          const captured = await context();
          await f.pool.query(
            'SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.1)',
            [deadline],
          );
          unavailable(await sample(captured));
          await f.atomicChange(
            (tx) =>
              writeRatingScopedSource(tx, {
                kind: 'scope_absence',
                key: scopeKey,
                scopeKeys: [scopeKey],
                payload: current.payload,
              }),
            { domain },
          );
          assert.equal(
            (await sample(await context())).body.candidateCount,
            2048,
          );
        }
      },
    );

    const duringFirstBatch = async (
      change: (tx: PoolClient) => Promise<void>,
      minimumAverage?: number,
    ) => {
      const current = await context(),
        observer = observeDirectoryQueries(f.app);
      let changed = false;
      try {
        observer.setHook(async ({ sql }, tx) => {
          if (!changed && sql.includes('paths AS MATERIALIZED')) {
            changed = true;
            await change(tx);
          }
        });
        const response = await sample(current, rootId, minimumAverage);
        assert.equal(
          changed,
          true,
          'A real first pool batch was observed before the writer',
        );
        unavailable(response);
      } finally {
        observer.restore();
      }
    };
    await t.test(
      'a real unselected-target lifecycle change during the complete scan invalidates it and rolls back',
      async () => {
        const affected = targets.find(
          (target) =>
            target.id !== previouslySelected && target.id !== targets[0]!.id,
        )!;
        const before = (
          await f.pool.query(
            'SELECT to_jsonb(t) row FROM whaleu_ratings.targets t WHERE id=$1',
            [affected.id],
          )
        ).rows[0]!.row;
        await duringFirstBatch(async (tx) => {
          const changed = await tx.query(
            'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
            [affected.id, randomUUID()],
          );
          assert.equal(changed.rowCount, 1);
        });
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT to_jsonb(t) row FROM whaleu_ratings.targets t WHERE id=$1',
              [affected.id],
            )
          ).rows[0]!.row,
          before,
        );
      },
    );
    await t.test(
      'a source phantom and zero-row unseen-membership writer invalidate the complete candidate set, with no artifacts left behind',
      async () => {
        const id = randomUUID(),
          revision = randomUUID(),
          key = `synthetic-phantom:${id}`;
        await duringFirstBatch(async (tx) => {
          // Real future-effective source insertion changes negative observation and
          // its owner epochs even though no current source head is replaced.
          const payload = {
            complete: true,
            categoryIds: [],
            targetIds: [],
            legacyCatalogIds: [],
          };
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,
        coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
        VALUES($1,$2,'scope_absence',$3,ARRAY[$4],$5::jsonb,
        whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind','scope_absence','key',$3::text,'scopeKeys',ARRAY[$4]::text[],'payload',$5::jsonb)),
        'complete','accepted','synthetic-random-phantom','synthetic-future-source','synthetic-future-policy',clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '20 minutes')`,
            [
              id,
              revision,
              key,
              `campus:${f.scope.related.campusId}`,
              canonicalJson(payload),
            ],
          );
        });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
        await duringFirstBatch(async (tx) => {
          const result = await tx.query(
            'UPDATE whaleu_ratings.scoped_target_memberships SET ordinal=ordinal WHERE false',
          );
          assert.equal(result.rowCount, 0);
        });
      },
    );
    await t.test(
      'a real scoped score threshold transition after scan observation cannot escape the complete-pool final proof',
      async () => {
        const input = await scoreIntent(actor, 3, scoreRevision);
        await f.app.get(RatingScopedCommands).prepare(actor.accessToken, input);
        const before = (
          await f.pool.query(
            'SELECT to_jsonb(s) row FROM whaleu_ratings.score_summaries s WHERE target_id=$1',
            [scored.id],
          )
        ).rows[0]!.row;
        await duringFirstBatch(async (tx) => {
          const hash = ratingScopedCommandHash(input);
          await tx.query(
            'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
            [
              actor.accountId,
              input.payload.clientRequestId,
              input.operation,
              hash,
            ],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
        SELECT account_id,request_id,'execution',context_id,target_revision,jsonb_build_object('intentHash',intent_hash,'operation',operation,'contextId',context_id,'contextRevision',context_revision)
        FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2`,
            [actor.accountId, input.payload.clientRequestId],
          );
          const revision = randomUUID();
          const changed = (
            await tx.query<{ occurred_at: string }>(
              `UPDATE whaleu_ratings.scores SET score=3,revision=$3,request_id=$4
        WHERE target_id=$1 AND account_id=$2 RETURNING ${ratingIso('updated_at')} occurred_at`,
              [
                scored.id,
                actor.accountId,
                revision,
                input.payload.clientRequestId,
              ],
            )
          ).rows[0]!;
          const result = {
            targetId: scored.id,
            subjectId: scored.id,
            revision,
            occurredAt: changed.occurred_at,
          };
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result)
        VALUES($1,$2,$3,$4,$5::jsonb,'applied',$6::jsonb)`,
            [
              actor.accountId,
              input.payload.clientRequestId,
              input.operation,
              hash,
              canonicalJson(input),
              canonicalJson(result),
            ],
          );
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              actor.accountId,
              input.payload.clientRequestId,
              canonicalJson({
                protocolVersion: 2,
                requestId: input.payload.clientRequestId,
                operation: input.operation,
                intentHash: hash,
                outcome: 'applied',
                result,
              }),
            ],
          );
        }, 4.5);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT to_jsonb(s) row FROM whaleu_ratings.score_summaries s WHERE target_id=$1',
              [scored.id],
            )
          ).rows[0]!.row,
          before,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, input.payload.clientRequestId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await sample(await context(), rootId, 4.5)).body.candidateCount,
          1,
        );
      },
    );
  },
);
