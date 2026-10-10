import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  categoryPlanBefore,
  ratingCategoryManagementFixture,
} from '../support/rating-category-management-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import {
  writeRatingScopedApproval,
  writeRatingScopedSource,
} from '../support/rating-scoped-fixture.js';
import { RatingCategorySourceIssuer } from '../../src/ratings/category-management/source-issuer.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
  ratingCategoryScopedReceiptSchema,
  ratingCategoryScopedPreparationSchema,
  ratingManagedCategorySchema,
  type RatingCategoryScopedIntent,
} from '../../src/ratings/category-management/scoped-contracts.js';
import {
  ratingScopedContextSchema,
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';

function errorCode(response: { status: number; body: unknown }): string {
  assert(response.status >= 400, JSON.stringify(response.body));
  const body = response.body;
  assert(body !== null && typeof body === 'object' && 'error' in body);
  const error = body.error;
  assert(
    error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string',
  );
  return error.code;
}

test(
  'M3C exact classification authority, preview separation and historical recovery survive grant changes',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const ordinary = await f.actor(),
      exact = await f.actor(),
      regional = await f.actor();
    const exactGrant = await f.exactCategoryGrant(exact, f.campusA);
    await f.grant(regional, 'school_admin', f.regionId);
    const campus = (campusId: string) => ({
      kind: 'campus' as const,
      campusId,
    });
    await t.test(
      'ordinary and admin-preview contexts never become category management authority',
      async () => {
        assert.equal(
          errorCode(
            await f.managementPost(ordinary, 'contexts', {
              selector: campus(f.campusA),
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        const before = await f.managementArtifacts();
        const management = await f.managementContext(f.admin);
        const previewResponse = await f.requestScopedContext(f.admin, {
          selector: campus(f.campusA),
          purpose: 'read',
          mode: 'admin_preview',
        });
        assert.equal(
          previewResponse.status,
          200,
          JSON.stringify(previewResponse.body),
        );
        const preview = ratingScopedContextSchema.parse(previewResponse.body);
        const proposed = f.managementIntent(
          management,
          'set_category_visibility_scoped',
          { categoryId: f.data.local.categoryId, hidden: true },
        );
        const relabelled = ratingCategoryScopedIntentSchema.parse({
          ...proposed,
          context: scopedCommandContext(preview),
        });
        assert.equal(
          errorCode(await f.managementPost(f.admin, 'prepare', relabelled)),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        const publicContext = await f.scopedContext(
          ordinary,
          campus(f.campusA),
          'interact',
        );
        const ordinaryIntent = ratingCategoryScopedIntentSchema.parse({
          ...proposed,
          payload: { ...proposed.payload, clientRequestId: randomUUID() },
          context: scopedCommandContext(publicContext),
        });
        assert.equal(
          errorCode(
            await f.managementPost(ordinary, 'prepare', ordinaryIntent),
          ),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        assert.deepEqual(await f.managementArtifacts(), before);
        const classificationOnly = await f.actor({
          affiliation: 'unverified',
          identity: false,
        });
        await f.exactCategoryGrant(classificationOnly, f.campusA);
        assert.deepEqual(
          (await f.managementContext(classificationOnly)).campusIds,
          [f.campusA],
        );
        const publicWrite = await f.requestScopedContext(classificationOnly, {
          selector: campus(f.campusA),
          purpose: 'create_target',
          mode: 'public',
        });
        assert.equal(
          errorCode(publicWrite),
          'AFFILIATION_VERIFICATION_REQUIRED',
          'category grant cannot become ordinary target-publication authority',
        );
      },
    );
    await t.test(
      'typed exact A grant cannot become same-region B, region or global authority',
      async () => {
        const current = await f.managementContext(exact);
        assert.deepEqual(current.campusIds, [f.campusA]);
        assert.equal(current.canManageGlobal, false);
        assert.equal(
          errorCode(
            await f.managementPost(exact, 'contexts', {
              selector: campus(f.campusB),
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.equal(
          errorCode(
            await f.managementPost(exact, 'contexts', {
              selector: { kind: 'global' },
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.equal(
          (
            await f.managementPost(exact, 'contexts', {
              selector: { kind: 'region', regionId: f.regionId },
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=$1',
              [exact.accountId],
            )
          ).rowCount,
          0,
          'exact grant did not create a fake legacy region grant',
        );
        assert(
          (
            await f.managementContext(regional, campus(f.campusB))
          ).campusIds.includes(f.campusA),
        );
        assert.equal(
          errorCode(
            await f.managementPost(regional, 'contexts', {
              selector: { kind: 'global' },
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        const before = await f.managementArtifacts();
        const sharedBase = f.managementIntent(
          current,
          'edit_category_base_scoped',
          {
            categoryId: f.data.local.categoryId,
            name: 'Cannot alter B through A',
            description: '',
          },
        );
        assert.equal(
          errorCode(await f.managementPost(exact, 'prepare', sharedBase)),
          'RATING_SCOPE_UNAVAILABLE',
        );
        const scopeChange = f.managementIntent(
          current,
          'set_category_scope_scoped',
          {
            categoryId: f.data.local.categoryId,
            placement: { kind: 'campuses', campusIds: [f.campusA] },
            propagation: 'subtree',
          },
        );
        assert.equal(
          errorCode(await f.managementPost(exact, 'prepare', scopeChange)),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.deepEqual(await f.managementArtifacts(), before);
      },
    );
    const current = await f.managementContext(exact);
    const local = f.managementIntent(current, 'set_category_override_scoped', {
      categoryId: f.data.local.categoryId,
      name: { mode: 'set', value: 'A-only exact authority' },
      description: { mode: 'inherit' },
    });
    const bBefore = (
      await f.pool.query(
        'SELECT catalog_id,head_revision FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key=$1',
        [`campus:${f.campusB}`],
      )
    ).rows;
    const applied = await f.executeManagement(exact, local);
    assert.equal(
      applied.decisions.length,
      1,
      'real exact v5 Review approval is required for local text',
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT catalog_id,head_revision FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key=$1',
          [`campus:${f.campusB}`],
        )
      ).rows,
      bBefore,
    );
    await t.test(
      'revoked authority cannot commit a prepared write; original receipt stays readable',
      async () => {
        const pending = f.managementIntent(
          await f.managementContext(exact),
          'set_category_visibility_scoped',
          { categoryId: f.data.local.categoryId, hidden: true },
        );
        const prepared = await f.prepareManagement(exact, pending);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.rating_category_campus_grants SET revoked_at=clock_timestamp() WHERE id=$1',
            [exactGrant],
          ),
        );
        const before = await f.managementArtifacts();
        assert.equal(
          errorCode(
            await f.commitManagement(exact, pending, prepared.contextRevision),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.equal(
          errorCode(
            await f.managementPost(exact, 'contexts', {
              selector: campus(f.campusA),
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.deepEqual(await f.managementArtifacts(), before);
        const historical = await f.auth(
          request(f.http).get(
            `/v2/ratings/requests/${local.payload.clientRequestId}`,
          ),
          exact,
        );
        assert.equal(historical.status, 200, JSON.stringify(historical.body));
        assert.deepEqual(
          ratingCategoryScopedReceiptSchema.parse(historical.body),
          applied.receipt,
        );
        const foreign = await f.auth(
          request(f.http).get(
            `/v2/ratings/requests/${local.payload.clientRequestId}`,
          ),
          ordinary,
        );
        assert.equal(foreign.status, 404);
      },
    );
    await t.test(
      'expired and future grants, missing phone facts, and missing registry/unknown consumer fail closed',
      async () => {
        const expired = await f.actor(),
          future = await f.actor(),
          noPhone = await f.actor({ phone: 'unverified' });
        const now = (
          await f.pool.query<{ now: Date }>('SELECT clock_timestamp() now')
        ).rows[0]!.now.getTime();
        await f.exactCategoryGrant(expired, f.campusA, {
          validFrom: new Date(now - 60000),
          expiresAt: new Date(now - 1000),
        });
        await f.exactCategoryGrant(future, f.campusA, {
          validFrom: new Date(now + 3600000),
          expiresAt: new Date(now + 7200000),
        });
        await f.exactCategoryGrant(noPhone, f.campusA);
        for (const actor of [expired, future])
          assert.equal(
            errorCode(
              await f.managementPost(actor, 'contexts', {
                selector: campus(f.campusA),
              }),
            ),
            'RATING_SCOPE_UNAVAILABLE',
          );
        assert.equal(
          errorCode(
            await f.managementPost(noPhone, 'contexts', {
              selector: campus(f.campusA),
            }),
          ),
          'PHONE_VERIFICATION_REQUIRED',
        );
        await f.exactCategoryGrant(exact, f.campusB, {
          validFrom: new Date(now - 60000),
          expiresAt: new Date(now - 1000),
        });
        await f.exactCategoryGrant(exact, f.campusA, {
          validFrom: new Date(now + 3600000),
          expiresAt: new Date(now + 7200000),
        });
        for (const selector of [campus(f.campusA), campus(f.campusB)])
          assert.equal(
            errorCode(await f.managementPost(exact, 'contexts', { selector })),
            'RATING_SCOPE_UNAVAILABLE',
          );
        const recovered = await f.auth(
          request(f.http).get(
            `/v2/ratings/requests/${local.payload.clientRequestId}`,
          ),
          exact,
        );
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
        assert.deepEqual(
          recovered.body,
          applied.receipt,
          'expired/future grants do not reinterpret a historical receipt',
        );
        const current = await f.managementContext(f.admin);
        for (const systemKey of ['not_registered', 'synthetic_unknown']) {
          const before = await f.managementArtifacts();
          const command = f.managementIntent(
            current,
            'create_system_category_scoped',
            {
              systemKey,
              name: 'No invented registry',
              description: '',
              placement: { kind: 'global' },
              levelCount: 1,
            },
          );
          assert.equal(
            errorCode(await f.managementPost(f.admin, 'prepare', command)),
            'RATING_SCOPE_UNAVAILABLE',
          );
          assert.deepEqual(await f.managementArtifacts(), before);
        }
      },
    );
  },
);

test(
  'M3C stale sibling/snapshot CAS closes without partially publishing any source or head',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const current = await f.managementContext(f.admin);
    const pending = f.managementIntent(current, 'reorder_categories_scoped', {
      parentId: null,
      action: 'set',
      orderedIds: [f.data.second.categoryId, f.data.local.categoryId],
    });
    const prepared = await f.prepareManagement(f.admin, pending);
    const pendingPlan = await f.managementPlan(f.admin, pending);
    assert.deepEqual(pendingPlan.category_plan.envelopes, []);
    const addition = f.managementIntent(current, 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'campuses', campusIds: [f.campusA] },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'New sibling before old sort',
          description: '',
        },
      ],
    });
    await f.executeManagement(f.admin, addition);
    const before = await f.managementArtifacts();
    const stale = await f.commitManagement(
      f.admin,
      pending,
      prepared.contextRevision,
    );
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    const receipt = ratingCategoryScopedReceiptSchema.parse(stale.body);
    assert.equal(receipt.outcome, 'closed');
    if (receipt.outcome !== 'closed') assert.fail();
    assert.equal(receipt.code, 'RATING_SCOPED_CONTEXT_CHANGED');
    assert.deepEqual(await f.managementArtifacts(), before);
    const fresh = await f.managementContext(f.admin);
    const oldSnapshot = f.managementIntent(
      fresh,
      'set_category_visibility_scoped',
      {
        categoryId: f.data.local.categoryId,
        hidden: true,
        expectedSnapshot: current.snapshotRevision,
      },
    );
    assert.equal(
      errorCode(await f.managementPost(f.admin, 'prepare', oldSnapshot)),
      'RATING_SCOPED_CONTEXT_CHANGED',
    );
    const missingSibling = f.managementIntent(
      fresh,
      'reorder_categories_scoped',
      {
        parentId: null,
        action: 'set',
        orderedIds: [f.data.local.categoryId, f.data.second.categoryId],
      },
    );
    assert.equal(
      errorCode(await f.managementPost(f.admin, 'prepare', missingSibling)),
      'RATING_SCOPED_CONTEXT_CHANGED',
    );
    assert.deepEqual(await f.managementArtifacts(), before);
    for (const command of [oldSnapshot, missingSibling])
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [f.admin.accountId, command.payload.clientRequestId],
          )
        ).rowCount,
        0,
      );
  },
);

test(
  'M3C missing or disabled issuance source never becomes an empty successful management domain',
  { timeout: 300000 },
  async () => {
    for (const policy of ['missing', 'disabled'] as const) {
      const f = await ratingCategoryManagementFixture({ policy });
      try {
        const before = await f.managementArtifacts();
        assert.equal(
          errorCode(
            await f.managementPost(f.admin, 'contexts', {
              selector: { kind: 'campus', campusId: f.campusA },
            }),
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.deepEqual(await f.managementArtifacts(), before);
      } finally {
        await f.close();
      }
    }
  },
);

test(
  'M3C raw SQL rejects forged category derivatives and receipts with exact 23514 rollback',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    // A genuine target makes the category/target-family isolation attack concrete.
    const ordinary = await f.actor();
    const targetContext = await f.scopedContext(
      ordinary,
      { kind: 'global' },
      'create_target',
    );
    const category = (
      await f.pool.query<{ effective_revision: string }>(
        'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
        [targetContext.heads[0]!.catalogRevision, f.data.global.categoryId],
      )
    ).rows[0]!;
    const targetIntent = ratingScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'create_target_scoped',
      context: scopedCommandContext(targetContext),
      payload: {
        clientRequestId: randomUUID(),
        categoryId: f.data.global.categoryId,
        expectedCategoryRevision: category.effective_revision,
        name: 'Unrelated retained target',
        description: '',
        assetIds: [],
      },
    });
    const preparedTargetResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/prepare'), ordinary)
      .send(targetIntent);
    assert.equal(
      preparedTargetResponse.status,
      200,
      JSON.stringify(preparedTargetResponse.body),
    );
    const preparedTarget = ratingScopedPreparationSchema.parse(
      preparedTargetResponse.body,
    );
    const targetEnvelope = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [ordinary.accountId, targetIntent.payload.clientRequestId],
      )
    ).rows[0]!.envelope;
    await f.approveScoped(canonicalRatingScopedEnvelope(targetEnvelope));
    const targetResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/targets'), ordinary)
      .send({
        ...targetIntent,
        preparationContextRevision: preparedTarget.contextRevision,
      });
    assert.equal(
      targetResponse.status,
      200,
      JSON.stringify(targetResponse.body),
    );
    const targetId = scopedSuccess(targetResponse.body).result['targetId'];
    assert.equal(typeof targetId, 'string');
    const current = await f.managementContext(f.admin);
    const original = f.managementIntent(current, 'edit_category_base_scoped', {
      categoryId: f.data.local.categoryId,
      name: 'Legitimate prepared shared edit',
      description: 'Exact re-review',
    });
    await f.prepareManagement(f.admin, original);
    const approved = await f.approveManagement(f.admin, original);
    assert.equal(
      approved.length,
      2,
      'base and existing exact B override both get new Review',
    );
    const { category_plan: originalPlan } = await f.managementPlan(
      f.admin,
      original,
    );
    const base = originalPlan.sourceIssues.find(
      (s) => s.kind === 'scoped_category_base',
    );
    assert(base);
    const next = () =>
      f.managementIntent(current, 'edit_category_base_scoped', {
        categoryId: f.data.local.categoryId,
        name: 'Fresh hostile candidate',
        description: '',
      });
    const rawControl = next();
    await withCommunityScopeWriter(f.pool, (tx) =>
      f.rawCategoryPreparation(tx, f.admin, rawControl),
    );
    assert.equal(
      (await f.managementPlan(f.admin, rawControl)).category_plan.operation,
      rawControl.operation,
      'unmodified SQL fixture preparation must pass before testing mutated plans',
    );
    await t.test(
      'managed source has no authority before exact same-transaction execution',
      async () => {
        await f.rejectCategorySql('source without execution', (tx) =>
          f.insertManagedSource(tx, originalPlan, base),
        );
      },
    );
    await t.test(
      'wrong envelope, extra derivative and narrowed source scope are rejected before insertion',
      async () => {
        for (const attack of ['envelope', 'extra-source', 'scope'] as const) {
          await f.rejectCategorySql(attack, async (tx) => {
            await f.rawCategoryExecution(tx, f.admin, original);
            const item = structuredClone(base);
            if (attack === 'envelope') {
              const envelope = canonicalRatingScopedEnvelope(
                item.payload['reviewEnvelope'],
              );
              assert.equal(
                envelope.purpose,
                'publish_rating_category_base_scoped',
              );
              if (envelope.purpose !== 'publish_rating_category_base_scoped')
                assert.fail();
              item.payload['reviewEnvelope'] = {
                ...envelope,
                body: { ...envelope.body, name: 'Not the reviewed envelope' },
              };
            }
            if (attack === 'extra-source') {
              item.id = randomUUID();
              item.revision = randomUUID();
              item.key = `extra:${item.id}`;
            }
            if (attack === 'scope') item.scopeKeys = [`campus:${f.campusA}`];
            await f.insertManagedSource(tx, originalPlan, item);
          });
        }
      },
    );
    await t.test(
      'recomputed forged plans cannot omit dependent override, affected scope or inject target family',
      async () => {
        for (const attack of [
          'missing-override',
          'missing-scope',
          'dummy-target',
        ] as const) {
          const command = next();
          await f.rejectCategorySql(attack, (tx) =>
            f.rawCategoryPreparation(
              tx,
              f.admin,
              command,
              (plan, actual) => {
                if (attack === 'missing-override') {
                  const removed = new Set(
                    plan.sourceIssues
                      .filter((s) => s.kind === 'scoped_category_override')
                      .map((s) => s.id),
                  );
                  assert(
                    removed.size > 0,
                    'the attack must omit a real live override',
                  );
                  plan.sourceIssues = plan.sourceIssues.filter(
                    (s) => !removed.has(s.id),
                  );
                  plan.envelopes = plan.envelopes.filter(
                    (e) => !removed.has(e.sourceId),
                  );
                }
                if (attack === 'missing-scope') {
                  const key = `campus:${f.campusA}`;
                  categoryPlanBefore(plan, actual, [key]);
                }
              },
              attack === 'dummy-target',
            ),
          );
        }
      },
    );
    await t.test(
      'category execution cannot carry an unrelated target mutation',
      async () => {
        await f.rejectCategorySql(
          'target origin/category mutation under category cause',
          async (tx) => {
            await f.rawCategoryExecution(tx, f.admin, original);
            const result = await tx.query(
              'UPDATE whaleu_ratings.targets SET category_id=$2 WHERE id=$1',
              [targetId, f.data.second.categoryId],
            );
            assert.equal(
              result.rowCount,
              1,
              'attack must address a real target',
            );
          },
        );
      },
    );
    await t.test(
      'applied receipt cannot exist without its exact category source/release cause',
      async () => {
        const command = next();
        await f.rejectCategorySql(
          'forged applied category receipt',
          async (tx) => {
            const prepared = await f.rawCategoryPreparation(
              tx,
              f.admin,
              command,
            );
            await f.rawCategoryExecution(tx, f.admin, command);
            const occurredAt = (
              await tx.query<{ at: Date }>('SELECT clock_timestamp() at')
            ).rows[0]!.at.toISOString();
            const result = {
              releaseId: null,
              categoryIds: prepared.plan.categoryIds,
              heads: prepared.plan.beforeHeads,
              occurredAt,
            };
            const hash = ratingCategoryScopedIntentHash(command);
            const receipt = {
              protocolVersion: 2,
              requestId: command.payload.clientRequestId,
              operation: command.operation,
              intentHash: hash,
              outcome: 'applied',
              result,
            };
            await tx.query(
              `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result)
        VALUES($1,$2,$3,$4,$5::jsonb,'applied',$6::jsonb)`,
              [
                f.admin.accountId,
                command.payload.clientRequestId,
                command.operation,
                hash,
                canonicalJson(command),
                canonicalJson(result),
              ],
            );
            await tx.query(
              'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
              [
                f.admin.accountId,
                command.payload.clientRequestId,
                canonicalJson(receipt),
              ],
            );
          },
        );
      },
    );
    // The original exact, fully reviewed operation must still commit after every
    // rejected SQL attack. Otherwise a blanket reject-all verifier could pass.
    const stored = await f.managementPlan(f.admin, original);
    const legitimate = await f.commitManagement(
      f.admin,
      original,
      stored.context_revision,
    );
    assert.equal(legitimate.status, 200, JSON.stringify(legitimate.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(legitimate.body).outcome,
      'applied',
    );
    const recovery = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${original.payload.clientRequestId}`,
      ),
      f.admin,
    );
    assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
    assert.deepEqual(recovery.body, legitimate.body);
  },
);

test(
  'M3C all nine delta intents reject an exact-current forged empty noop plan',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    assert(f.solo && f.child);
    const current = await f.managementContext(f.admin),
      selected = `campus:${f.campusA}`;
    const node = {
      key: 'new_child',
      parentKey: null,
      name: 'A genuinely new category',
      description: '',
    };
    const payloads = {
      create_categories_scoped: {
        parentId: null,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        nodes: [node],
      },
      edit_category_base_scoped: {
        categoryId: f.solo.categoryId,
        name: 'A changed base name',
        description: '',
      },
      set_category_override_scoped: {
        categoryId: f.solo.categoryId,
        name: { mode: 'set', value: 'A changed campus name' },
        description: { mode: 'inherit' },
      },
      set_category_visibility_scoped: {
        categoryId: f.solo.categoryId,
        hidden: true,
      },
      reorder_categories_scoped: {
        parentId: null,
        action: 'set',
        orderedIds: [
          f.solo.categoryId,
          f.data.second.categoryId,
          f.data.local.categoryId,
        ],
      },
      set_category_scope_scoped: {
        categoryId: f.solo.categoryId,
        placement: {
          kind: 'campuses',
          campusIds: [f.campusA, f.campusB].sort(),
        },
        propagation: 'subtree',
      },
      set_category_lifecycle_scoped: {
        categoryId: f.solo.categoryId,
        state: 'disabled',
        restore: false,
      },
      batch_update_subcategories_scoped: {
        parentId: f.solo.categoryId,
        addNodes: [node],
        disableIds: [],
        restoreIds: [],
        enableIds: [],
        orderedChildren: [
          { kind: 'existing', id: f.child.categoryId },
          { kind: 'new', key: node.key },
        ],
      },
      create_system_category_scoped: {
        systemKey: 'synthetic_general',
        name: 'A new registered system root',
        description: '',
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        levelCount: 1,
      },
    };
    for (const operation of ratingCategoryScopedOperations)
      await t.test(operation, async () => {
        const control = f.managementIntent(
          current,
          operation,
          payloads[operation],
        );
        const lawful = await withCommunityScopeWriter(f.pool, (tx) =>
          f.rawCategoryPreparation(tx, f.admin, control),
        );
        assert.equal(
          lawful.plan.noop,
          false,
          `${operation}: positive control must have a real delta`,
        );
        assert(lawful.plan.sourceIssues.length > 0);
        const attack = f.managementIntent(
          current,
          operation,
          payloads[operation],
        );
        let reachedSql = false;
        await f.rejectCategorySql(`${operation}: forged empty noop`, (tx) =>
          f.rawCategoryPreparation(tx, f.admin, attack, (plan, actual) => {
            assert.equal(plan.noop, false);
            assert(plan.sourceIssues.length > 0);
            plan.sourceIssues = [];
            plan.envelopes = [];
            plan.categoryIds = [];
            plan.changes = [];
            plan.noop = true;
            plan.affectedTargetCount = 0;
            categoryPlanBefore(plan, actual, [selected]);
            assert.deepEqual(
              plan.beforeHeads,
              actual.heads.filter((head) => head.scopeKey === selected),
            );
            assert.equal(
              plan.beforeDigest,
              ratingScopedDigest('category-before', {
                heads: plan.beforeHeads,
                vector: plan.beforeVector,
              }),
            );
            assert.equal(
              plan.intentHash,
              ratingCategoryScopedIntentHash(attack),
            );
            reachedSql = true;
          }),
        );
        assert(
          reachedSql,
          `${operation}: denial must come from SQL, never the TypeScript planner`,
        );
        const partial = f.managementIntent(
          current,
          operation,
          payloads[operation],
        );
        let partialReachedSql = false;
        await f.rejectCategorySql(
          `${operation}: absence-only nonnoop without business delta`,
          (tx) =>
            f.rawCategoryPreparation(tx, f.admin, partial, (plan, actual) => {
              const absence = plan.sourceIssues.find(
                (issue) =>
                  issue.kind === 'scope_absence' && issue.key === selected,
              );
              assert(absence);
              const currentAbsence = actual.sources.find(
                (source) =>
                  source.source_kind === 'scope_absence' &&
                  source.source_key === selected,
              );
              assert(
                currentAbsence &&
                  Array.isArray(currentAbsence.payload['categoryIds']) &&
                  Array.isArray(currentAbsence.payload['targetIds']),
              );
              // Make a coherent unchanged declaration successor: create/batch must not
              // fail merely because the absence list mentions omitted new categories.
              absence.payload['categoryIds'] = structuredClone(
                currentAbsence.payload['categoryIds'],
              );
              absence.payload['targetIds'] = structuredClone(
                currentAbsence.payload['targetIds'],
              );
              plan.sourceIssues = [absence];
              plan.envelopes = [];
              plan.categoryIds = [];
              plan.changes = [];
              plan.noop = false;
              plan.affectedTargetCount = 0;
              categoryPlanBefore(plan, actual, [selected]);
              assert.equal(
                plan.intentHash,
                ratingCategoryScopedIntentHash(partial),
              );
              partialReachedSql = true;
            }),
        );
        assert(
          partialReachedSql,
          `${operation}: absence-only nonnoop must reach SQL`,
        );
      });
  },
);

test(
  'M3C exact-current genuine noops preserve sources, Review and effects and replay original receipts',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    assert(f.solo && f.child);
    const soloId = f.solo.categoryId,
      childId = f.child.categoryId;
    const unchanged = async (
      operation: RatingCategoryScopedIntent['operation'],
      payload: Record<string, unknown>,
    ) => {
      const current = await f.managementContext(f.admin);
      const input = f.managementIntent(current, operation, payload),
        before = await f.managementArtifacts();
      const prepared = await f.prepareManagement(f.admin, input);
      const stored = await f.managementPlan(f.admin, input);
      assert.equal(
        stored.category_plan.noop,
        true,
        `${operation} must be an actual no-op`,
      );
      assert.deepEqual(stored.category_plan.sourceIssues, []);
      assert.deepEqual(stored.category_plan.envelopes, []);
      const response = await f.commitManagement(
        f.admin,
        input,
        prepared.contextRevision,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = ratingCategoryScopedReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, 'noop', JSON.stringify(receipt));
      const replay = await f.commitManagement(
        f.admin,
        input,
        prepared.contextRevision,
      );
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body, receipt);
      const recovered = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${input.payload.clientRequestId}`,
        ),
        f.admin,
      );
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.deepEqual(recovered.body, receipt);
      assert.deepEqual(
        await f.managementArtifacts(),
        before,
        `${operation}: no source, Review decision/binding, target or effect mutation`,
      );
    };
    await t.test('same base text', () =>
      unchanged('edit_category_base_scoped', {
        categoryId: soloId,
        name: f.solo!.envelope.body.name,
        description: f.solo!.envelope.body.description,
      }),
    );
    await t.test('same visibility', () =>
      unchanged('set_category_visibility_scoped', {
        categoryId: soloId,
        hidden: false,
      }),
    );
    await t.test('same enabled business state', () =>
      unchanged('set_category_lifecycle_scoped', {
        categoryId: soloId,
        state: 'enabled',
        restore: false,
      }),
    );
    await t.test('same exact placement', () =>
      unchanged('set_category_scope_scoped', {
        categoryId: soloId,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        propagation: 'subtree',
      }),
    );
    await t.test('same complete sibling ordering', () =>
      unchanged('reorder_categories_scoped', {
        parentId: null,
        action: 'set',
        orderedIds: [f.data.local.categoryId, f.data.second.categoryId, soloId],
      }),
    );
    await t.test('same inherited sibling ordering', () =>
      unchanged('reorder_categories_scoped', {
        parentId: null,
        action: 'inherit',
        orderedIds: [],
      }),
    );
    await t.test('empty child batch with unchanged exact ordering', () =>
      unchanged('batch_update_subcategories_scoped', {
        parentId: soloId,
        addNodes: [],
        disableIds: [],
        restoreIds: [],
        enableIds: [],
        orderedChildren: [{ kind: 'existing', id: childId }],
      }),
    );
    const modes = {
      name: { mode: 'set', value: 'Already published exact override' },
      description: { mode: 'set', value: '' },
    };
    await f.executeManagement(
      f.admin,
      f.managementIntent(
        await f.managementContext(f.admin),
        'set_category_override_scoped',
        { categoryId: soloId, ...modes },
      ),
    );
    await t.test('same explicit override modes and text', () =>
      unchanged('set_category_override_scoped', {
        categoryId: soloId,
        ...modes,
      }),
    );
    const inherit = {
      name: { mode: 'inherit' },
      description: { mode: 'inherit' },
    };
    await f.executeManagement(
      f.admin,
      f.managementIntent(
        await f.managementContext(f.admin),
        'set_category_override_scoped',
        { categoryId: soloId, ...inherit },
      ),
    );
    await t.test('same explicit inheritance reset', () =>
      unchanged('set_category_override_scoped', {
        categoryId: soloId,
        ...inherit,
      }),
    );
  },
);

test(
  'M3C SQL independently enforces system archive, registry actions and configured child depth',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    const roots = new Map<string, string>();
    for (const systemKey of [
      'synthetic_general',
      'synthetic_no_disable',
      'synthetic_no_children',
      'synthetic_no_override',
      'synthetic_configured_depth',
    ]) {
      const input = f.managementIntent(
        await f.managementContext(f.admin),
        'create_system_category_scoped',
        {
          systemKey,
          name: `System ${systemKey}`,
          description: '',
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          levelCount: systemKey === 'synthetic_configured_depth' ? 1 : 3,
        },
      );
      const created = await f.executeManagement(f.admin, input);
      if (created.receipt.outcome !== 'applied') assert.fail();
      assert.equal(created.receipt.result.categoryIds.length, 1);
      roots.set(systemKey, created.receipt.result.categoryIds[0]!);
    }
    const current = await f.managementContext(f.admin);
    const permissiveRoot = roots.get('synthetic_general')!;
    for (const control of [
      f.managementIntent(current, 'set_category_lifecycle_scoped', {
        categoryId: permissiveRoot,
        state: 'disabled',
        restore: false,
      }),
      f.managementIntent(current, 'create_categories_scoped', {
        parentId: permissiveRoot,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        nodes: [
          {
            key: 'child',
            parentKey: null,
            name: 'Allowed system child control',
            description: '',
          },
        ],
      }),
      f.managementIntent(current, 'set_category_override_scoped', {
        categoryId: permissiveRoot,
        name: { mode: 'set', value: 'Allowed system override control' },
        description: { mode: 'inherit' },
      }),
    ]) {
      const accepted = await withCommunityScopeWriter(f.pool, (tx) =>
        f.rawCategoryPreparation(tx, f.admin, control, (plan) => {
          plan.globalRequired = true;
        }),
      );
      assert.equal(
        accepted.plan.noop,
        false,
        'system SQL must permit a real allowed action before its forbidden counterpart',
      );
    }
    for (const attack of [
      'archive',
      'disable',
      'children',
      'configured-depth',
      'campus-override',
    ] as const)
      await t.test(attack, async () => {
        const systemKey =
          attack === 'archive'
            ? 'synthetic_general'
            : attack === 'disable'
              ? 'synthetic_no_disable'
              : attack === 'children'
                ? 'synthetic_no_children'
                : attack === 'configured-depth'
                  ? 'synthetic_configured_depth'
                  : 'synthetic_no_override';
        const categoryId = roots.get(systemKey)!;
        const input =
          attack === 'archive' || attack === 'disable'
            ? f.managementIntent(current, 'set_category_lifecycle_scoped', {
                categoryId,
                state: attack === 'archive' ? 'archived' : 'disabled',
                restore: false,
              })
            : attack === 'campus-override'
              ? f.managementIntent(current, 'set_category_override_scoped', {
                  categoryId,
                  name: { mode: 'set', value: 'Forbidden system override' },
                  description: { mode: 'inherit' },
                })
              : f.managementIntent(current, 'create_categories_scoped', {
                  parentId: categoryId,
                  placement: { kind: 'campuses', campusIds: [f.campusA] },
                  nodes: [
                    {
                      key: 'child',
                      parentKey: null,
                      name: 'Forbidden system child',
                      description: '',
                    },
                  ],
                });
        const seed =
          attack === 'archive'
            ? ratingCategoryScopedIntentSchema.parse({
                ...input,
                payload: { ...input.payload, state: 'disabled' },
              })
            : input;
        let reachedSql = false;
        await f.rejectCategorySql(`SQL system policy ${attack}`, (tx) =>
          f.rawCategoryPreparation(
            tx,
            f.admin,
            input,
            (plan, actual) => {
              assert.equal(
                plan.intentHash,
                ratingCategoryScopedIntentHash(input),
              );
              assert.equal(plan.noop, false);
              assert(plan.sourceIssues.length > 0);
              plan.globalRequired = true; // Do not confuse a policy failure with missing global authority.
              if (attack === 'archive') {
                for (const issue of plan.sourceIssues.filter(
                  (s) => s.kind === 'scoped_category_lifecycle',
                ))
                  issue.payload['businessState'] = 'archived';
                for (const change of plan.changes.filter(
                  (c) => c.field === 'lifecycle',
                ))
                  change.after = 'archived';
              }
              categoryPlanBefore(plan, actual, plan.affectedScopeKeys);
              reachedSql = true;
            },
            false,
            {
              seedIntent: seed,
              allowInMemory: (snapshot) => {
                const registry = snapshot.sources.find(
                  (s) =>
                    s.source_kind === 'scoped_category_system_registry' &&
                    s.payload['systemKey'] === systemKey,
                );
                assert(registry);
                if (attack === 'disable')
                  registry.payload['allowDisable'] = true;
                if (attack === 'children')
                  registry.payload['allowChildren'] = true;
                if (attack === 'campus-override')
                  registry.payload['allowCampusOverride'] = true;
                if (attack === 'configured-depth') {
                  const parent = snapshot.categories.find(
                    (c) => c.expected.body.id === categoryId,
                  );
                  assert(parent);
                  const base = snapshot.sources.find(
                    (s) => s.id === parent.expected.baseSourceId,
                  );
                  assert(base);
                  assert.equal(
                    base.payload['maximumDepth'],
                    1,
                    'the actual owner configured a one-level root',
                  );
                  base.payload['maximumDepth'] = 3;
                }
              },
            },
          ),
        );
        assert(
          reachedSql,
          `${attack}: the negative proof must reach PostgreSQL guards`,
        );
      });
  },
);

test(
  'M3C child batches reject nested parentKey through HTTP and direct SQL',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    assert(f.solo && f.child);
    const current = await f.managementContext(f.admin);
    const allowed = f.managementIntent(
      current,
      'batch_update_subcategories_scoped',
      {
        parentId: f.solo.categoryId,
        addNodes: [
          {
            key: 'first',
            parentKey: null,
            name: 'Direct first',
            description: '',
          },
          {
            key: 'second',
            parentKey: null,
            name: 'Direct second',
            description: '',
          },
        ],
        disableIds: [],
        restoreIds: [],
        enableIds: [],
        orderedChildren: [
          { kind: 'existing', id: f.child.categoryId },
          { kind: 'new', key: 'first' },
          { kind: 'new', key: 'second' },
        ],
      },
    );
    if (allowed.operation !== 'batch_update_subcategories_scoped')
      assert.fail();
    // Deliberately bypass the decoder to exercise the independent SQL guard.
    // The legal planner seed above retains its strict null-only parentKey type.
    const nested = {
      ...allowed,
      payload: {
        ...allowed.payload,
        addNodes: allowed.payload.addNodes.map((node, n) => ({
          ...node,
          parentKey: n === 1 ? 'first' : null,
        })),
      },
    } as unknown as RatingCategoryScopedIntent;
    const before = await f.managementArtifacts();
    const response = await f.managementPost(f.admin, 'prepare', nested);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepEqual(await f.managementArtifacts(), before);
    let reachedSql = false;
    await f.rejectCategorySql(
      'nested batch parentKey cannot enter direct SQL',
      (tx) =>
        f.rawCategoryPreparation(
          tx,
          f.admin,
          nested,
          () => {
            reachedSql = true;
          },
          false,
          { seedIntent: allowed },
        ),
    );
    assert(
      reachedSql,
      'the typed nested intent must reach SQL instead of being parsed/rejected by the planner',
    );
  },
);

test(
  'M3C upgrades old M3B lifecycle bytes per-view and multi-scope through base/scope/lifecycle changes',
  { timeout: 360000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({ legacyLifecycles: true });
    t.after(() => f.close());
    assert.equal(f.legacyCases.length, 6);
    for (const item of f.legacyCases)
      await t.test(`${item.shape} ${item.operation}`, async () => {
        const original = async () =>
          (
            await f.pool.query<{ value: unknown }>(
              'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=ANY($1::uuid[]) ORDER BY id',
              [item.sources.map((s) => s.id)],
            )
          ).rows;
        const oldBytes = await original();
        const payloads = (
          await f.pool.query<{ payload: Record<string, unknown> }>(
            'SELECT payload FROM whaleu_ratings.scoped_source_attestations WHERE id=ANY($1::uuid[])',
            [item.sources.map((s) => s.id)],
          )
        ).rows;
        assert(
          payloads.every(
            (row) =>
              !Object.hasOwn(row.payload, 'businessState') &&
              !Object.hasOwn(row.payload, 'businessStateRevision') &&
              !Object.hasOwn(row.payload, 'management'),
          ),
        );
        const current = await f.managementContext(f.admin);
        const payload =
          item.operation === 'edit_category_base_scoped'
            ? {
                categoryId: item.category.categoryId,
                name: `Upgraded ${item.shape} base`,
                description: '',
              }
            : item.operation === 'set_category_scope_scoped'
              ? {
                  categoryId: item.category.categoryId,
                  placement: { kind: 'campuses', campusIds: [f.campusA] },
                  propagation: 'self',
                }
              : {
                  categoryId: item.category.categoryId,
                  state: 'enabled',
                  restore: false,
                };
        const input = f.managementIntent(current, item.operation, payload);
        const prepared = await f.prepareManagement(f.admin, input);
        await f.approveManagement(f.admin, input);
        const plan = (await f.managementPlan(f.admin, input)).category_plan;
        const successor = plan.sourceIssues.find(
          (source) => source.kind === 'scoped_category_lifecycle',
        );
        assert(
          successor,
          'the old lifecycle must be explicitly reissued, never silently lost',
        );
        await f.rejectCategorySql(
          'failed lifecycle upgrade rolls back every partition',
          async (tx) => {
            await f.rawCategoryExecution(tx, f.admin, input);
            const tampered = structuredClone(successor);
            tampered.payload['hidden'] = tampered.payload['hidden'] !== true;
            await f.insertManagedSource(tx, plan, tampered);
          },
        );
        assert.deepEqual(await original(), oldBytes);
        const committed = await f.commitManagement(
          f.admin,
          input,
          prepared.contextRevision,
        );
        assert.equal(committed.status, 200, JSON.stringify(committed.body));
        assert.equal(
          ratingCategoryScopedReceiptSchema.parse(committed.body).outcome,
          'applied',
        );
        const currentSources = (
          await f.pool.query<{
            scope_keys: string[];
            payload: Record<string, unknown>;
            issuer: string;
          }>(
            `SELECT s.scope_keys,s.payload,s.issuer
      FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
      WHERE s.source_kind='scoped_category_lifecycle' AND s.payload->>'categoryId'=$1 ORDER BY s.scope_keys`,
            [item.category.categoryId],
          )
        ).rows;
        assert.equal(
          currentSources.length,
          2,
          'C normalizes the old shared head to one exact campus head per view, including a dormant exit',
        );
        const expectedState =
          item.operation === 'set_category_lifecycle_scoped'
            ? 'enabled'
            : 'disabled';
        for (const row of currentSources) {
          assert.equal(row.issuer, 'ratings-category-management');
          assert.equal(row.scope_keys.length, 1);
          assert.equal(row.payload['businessState'], expectedState);
          assert.equal(row.payload['active'], expectedState === 'enabled');
          assert.equal(
            row.payload['hidden'],
            item.shape === 'multi_scope' ||
              row.scope_keys[0] === `campus:${f.campusB}`,
          );
          assert.equal(typeof row.payload['businessStateRevision'], 'string');
        }
        assert.equal(
          new Set(
            currentSources.map((row) => row.payload['businessStateRevision']),
          ).size,
          1,
          'business state revision is shared across exact partitions',
        );
        assert.deepEqual(
          await original(),
          oldBytes,
          'M3B payload, digest and original publication bytes remain immutable',
        );
        const replay = await f.commitManagement(
          f.admin,
          input,
          prepared.contextRevision,
        );
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.deepEqual(replay.body, committed.body);
      });
  },
);

test(
  'M3C fake issuers cannot claim management fields or downgrade an existing C source head',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const input = f.managementIntent(
      await f.managementContext(f.admin),
      'set_category_visibility_scoped',
      { categoryId: f.data.local.categoryId, hidden: true },
    );
    const published = await f.executeManagement(f.admin, input);
    assert.equal(published.receipt.outcome, 'applied');
    const plan = (await f.managementPlan(f.admin, input)).category_plan;
    const current = plan.sourceIssues.find(
      (source) => source.kind === 'scoped_category_lifecycle',
    );
    assert(current);
    const create = f.managementIntent(
      await f.managementContext(f.admin),
      'create_categories_scoped',
      {
        parentId: null,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        nodes: [
          {
            key: 'root',
            parentKey: null,
            name: 'C-owned root for issuer boundary',
            description: '',
          },
        ],
      },
    );
    await f.executeManagement(f.admin, create);
    const createdBase = (
      await f.managementPlan(f.admin, create)
    ).category_plan.sourceIssues.find(
      (source) => source.kind === 'scoped_category_base',
    );
    assert(createdBase);
    for (const attack of [
      'management-marker',
      'business-state',
      'takeover-c-key',
      'new-key-c-created-base',
    ] as const)
      await t.test(attack, async () => {
        await f.rejectCategorySql(`foreign issuer ${attack}`, async (tx) => {
          const takeover = attack === 'takeover-c-key';
          const category = takeover ? f.data.local : f.data.second;
          const source = {
            ...structuredClone(current),
            id: randomUUID(),
            revision: randomUUID(),
            key: takeover
              ? current.key
              : `synthetic-foreign:${attack}:${randomUUID()}`,
            previousSourceId: takeover ? current.id : null,
            previousSourceRevision: takeover ? current.revision : null,
            payload: {
              categoryId:
                attack === 'new-key-c-created-base'
                  ? createdBase.payload['categoryId']
                  : category.categoryId,
              baseSourceId:
                attack === 'new-key-c-created-base'
                  ? createdBase.id
                  : category.source.id,
              baseSourceRevision:
                attack === 'new-key-c-created-base'
                  ? createdBase.revision
                  : category.source.revision,
              active: true,
              hidden: attack === 'new-key-c-created-base',
            } as Record<string, unknown>,
          };
          if (attack === 'management-marker')
            source.payload['management'] = current.payload['management'];
          if (attack === 'business-state') {
            source.payload['businessState'] = 'enabled';
            source.payload['businessStateRevision'] = randomUUID();
          }
          await f.insertManagedSource(
            tx,
            plan,
            source,
            'synthetic-scoped-issuer',
          );
          const head = await tx.query(
            `INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(source_kind,source_key) DO UPDATE SET source_id=excluded.source_id,source_revision=excluded.source_revision
        WHERE scoped_source_heads.source_id=$5 AND scoped_source_heads.source_revision=$6`,
            [
              source.kind,
              source.key,
              source.id,
              source.revision,
              source.previousSourceId,
              source.previousSourceRevision,
            ],
          );
          assert.equal(head.rowCount, 1);
          // Satisfy the normal adopted-source atomic release obligation. The only
          // forbidden step is the foreign issuer's C marker/semantic/head takeover.
          await f.publish({}, tx);
        });
      });
  },
);

test(
  'M3C create and child batch SQL require every requested node, exact parent and no extra nodes',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    assert(f.solo && f.child);
    const soloId = f.solo.categoryId,
      oldChild = f.child.categoryId;
    const current = await f.managementContext(f.admin);
    const first = {
      key: 'first',
      parentKey: null,
      name: 'Requested first',
      description: '',
    };
    for (const operation of [
      'create_categories_scoped',
      'batch_update_subcategories_scoped',
    ] as const) {
      const second = {
        key: 'second',
        parentKey: operation === 'create_categories_scoped' ? 'first' : null,
        name: 'Requested second',
        description: '',
      };
      const payload =
        operation === 'create_categories_scoped'
          ? {
              parentId: null,
              placement: { kind: 'campuses', campusIds: [f.campusA] },
              nodes: [first, second],
            }
          : {
              parentId: soloId,
              addNodes: [first, second],
              disableIds: [],
              restoreIds: [],
              enableIds: [],
              orderedChildren: [
                { kind: 'existing', id: oldChild },
                { kind: 'new', key: 'first' },
                { kind: 'new', key: 'second' },
              ],
            };
      const control = f.managementIntent(current, operation, payload);
      const valid = await withCommunityScopeWriter(f.pool, (tx) =>
        f.rawCategoryPreparation(tx, f.admin, control),
      );
      assert.equal(
        valid.plan.envelopes.length,
        2,
        'legal two-node positive control',
      );
      await t.test(`${operation}: missing requested node`, async () => {
        const input = f.managementIntent(current, operation, payload);
        let reachedSql = false;
        await f.rejectCategorySql(`${operation}: partial node set`, (tx) =>
          f.rawCategoryPreparation(tx, f.admin, input, (plan) => {
            const omitted = plan.envelopes.find(
              (envelope) => envelope.body.name === second.name,
            )?.categoryId;
            assert(omitted);
            plan.sourceIssues = plan.sourceIssues.filter(
              (source) => source.payload['categoryId'] !== omitted,
            );
            plan.envelopes = plan.envelopes.filter(
              (envelope) => envelope.categoryId !== omitted,
            );
            plan.categoryIds = plan.categoryIds.filter(
              (category) => category !== omitted,
            );
            plan.changes = plan.changes.filter(
              (change) => change.categoryId !== omitted,
            );
            for (const source of plan.sourceIssues.filter(
              (source) => source.kind === 'scope_absence',
            )) {
              const ids = source.payload['categoryIds'];
              assert(Array.isArray(ids));
              source.payload['categoryIds'] = ids.filter(
                (category) => category !== omitted,
              );
            }
            assert.equal(plan.noop, false);
            assert.equal(plan.envelopes.length, 1);
            reachedSql = true;
          }),
        );
        assert(reachedSql);
      });
      await t.test(`${operation}: extra unrequested node`, async () => {
        const input = f.managementIntent(current, operation, payload);
        const extra = {
          key: 'extra',
          parentKey: operation === 'create_categories_scoped' ? 'first' : null,
          name: 'Unrequested third',
          description: '',
        };
        const seed =
          input.operation === 'create_categories_scoped'
            ? ratingCategoryScopedIntentSchema.parse({
                ...input,
                payload: {
                  ...input.payload,
                  nodes: [...input.payload.nodes, extra],
                },
              })
            : input.operation === 'batch_update_subcategories_scoped'
              ? ratingCategoryScopedIntentSchema.parse({
                  ...input,
                  payload: {
                    ...input.payload,
                    addNodes: [...input.payload.addNodes, extra],
                    orderedChildren: [
                      ...input.payload.orderedChildren,
                      { kind: 'new', key: 'extra' },
                    ],
                  },
                })
              : assert.fail();
        let reachedSql = false;
        await f.rejectCategorySql(`${operation}: unrequested node`, (tx) =>
          f.rawCategoryPreparation(
            tx,
            f.admin,
            input,
            (plan) => {
              assert.equal(
                plan.intentHash,
                ratingCategoryScopedIntentHash(input),
              );
              assert.equal(plan.envelopes.length, 3);
              reachedSql = true;
            },
            false,
            { seedIntent: seed },
          ),
        );
        assert(reachedSql);
      });
      await t.test(`${operation}: wrong existing parent`, async () => {
        const input = f.managementIntent(
          current,
          operation,
          operation === 'create_categories_scoped'
            ? {
                parentId: soloId,
                placement: { kind: 'campuses', campusIds: [f.campusA] },
                nodes: [first],
              }
            : {
                parentId: soloId,
                addNodes: [first],
                disableIds: [],
                restoreIds: [],
                enableIds: [],
                orderedChildren: [
                  { kind: 'existing', id: oldChild },
                  { kind: 'new', key: 'first' },
                ],
              },
        );
        const seed = ratingCategoryScopedIntentSchema.parse({
          ...input,
          payload: {
            ...input.payload,
            parentId: f.data.second.categoryId,
            ...(operation === 'batch_update_subcategories_scoped'
              ? { orderedChildren: [{ kind: 'new', key: 'first' }] }
              : {}),
          },
        });
        let reachedSql = false;
        await f.rejectCategorySql(`${operation}: wrong parent`, (tx) =>
          f.rawCategoryPreparation(
            tx,
            f.admin,
            input,
            (plan) => {
              assert.equal(
                plan.intentHash,
                ratingCategoryScopedIntentHash(input),
              );
              const envelope = plan.envelopes[0]!;
              if (envelope.purpose !== 'publish_rating_category_base_scoped')
                assert.fail();
              assert.equal(envelope.body.parentId, f.data.second.categoryId);
              reachedSql = true;
            },
            false,
            { seedIntent: seed },
          ),
        );
        assert(reachedSql);
      });
    }
  },
);

test(
  'M3C equal A/B views cross to global and back with exact before-compat exit authority',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({ equalViews: true });
    t.after(() => f.close());
    const categoryId = f.data.second.categoryId;
    const originalSource = (
      await f.pool.query<{ value: unknown }>(
        'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=$1',
        [f.data.second.source.id],
      )
    ).rows;
    const scopes = async () =>
      (
        await f.pool.query<{ scope_key: string }>(
          `SELECT h.scope_key FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id WHERE c.category_id=$1 ORDER BY h.scope_key`,
          [categoryId],
        )
      ).rows.map((row) => row.scope_key);
    const campuses = [f.campusA, f.campusB].sort(),
      keys = campuses.map((id) => `campus:${id}`);
    assert.deepEqual(await scopes(), keys);
    const current = await f.managementContext(f.admin);
    const input = f.managementIntent(current, 'set_category_scope_scoped', {
      categoryId,
      placement: { kind: 'global' },
      propagation: 'self',
    });
    const prepared = await f.prepareManagement(f.admin, input);
    const before = (await f.managementPlan(f.admin, input)).category_plan;
    const region = before.beforeCompatHeads.find(
      (head) =>
        head.scopeKeys.includes(`campus:${f.campusA}`) &&
        head.scopeKeys.includes(`campus:${f.campusB}`),
    );
    assert(
      region && region.legacyCatalogId,
      'equal A/B views start from a genuine canonical compat catalog',
    );
    for (const attack of ['version', 'catalog', 'scopes', 'omission'] as const)
      await t.test(`wrong beforeCompatHeads ${attack}`, async () => {
        const hostile = f.managementIntent(
          current,
          'set_category_scope_scoped',
          { categoryId, placement: { kind: 'global' }, propagation: 'self' },
        );
        let reachedSql = false;
        await f.rejectCategorySql(`before compat ${attack}`, (tx) =>
          f.rawCategoryPreparation(tx, f.admin, hostile, (plan) => {
            const row = plan.beforeCompatHeads.find(
              (head) => head.compatKey === region.compatKey,
            );
            assert(row);
            if (attack === 'version') row.versionId = randomUUID();
            if (attack === 'catalog')
              row.legacyCatalogId =
                plan.beforeCompatHeads.find(
                  (head) =>
                    head.compatKey !== region.compatKey && head.legacyCatalogId,
                )?.legacyCatalogId ?? randomUUID();
            if (attack === 'scopes') row.scopeKeys = [`campus:${f.campusA}`];
            if (attack === 'omission')
              plan.beforeCompatHeads = plan.beforeCompatHeads.filter(
                (head) => head.compatKey !== region.compatKey,
              );
            reachedSql = true;
          }),
        );
        assert(reachedSql);
      });
    await f.approveManagement(f.admin, input);
    const toGlobal = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(toGlobal.status, 200, JSON.stringify(toGlobal.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(toGlobal.body).outcome,
      'applied',
    );
    assert.deepEqual(await scopes(), ['global']);
    const global = await f.managementContext(f.admin, { kind: 'global' });
    const back = f.managementIntent(global, 'set_category_scope_scoped', {
      categoryId,
      placement: { kind: 'campuses', campusIds: campuses },
      propagation: 'self',
    });
    const returned = await f.executeManagement(f.admin, back);
    assert.equal(returned.receipt.outcome, 'applied');
    assert.deepEqual(await scopes(), keys);
    assert.deepEqual(
      (
        await f.pool.query<{ value: unknown }>(
          'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=$1',
          [f.data.second.source.id],
        )
      ).rows,
      originalSource,
    );
    for (const [command, receipt] of [
      [input, toGlobal.body],
      [back, returned.receipt],
    ] as const) {
      const recovery = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${command.payload.clientRequestId}`,
        ),
        f.admin,
      );
      assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
      assert.deepEqual(recovery.body, receipt);
    }
  },
);

test(
  'M3C equal independent bases merge atomically and unequal owner facts fail with exact source-unresolved',
  { timeout: 360000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({ multiBases: true });
    t.after(() => f.close());
    const current = await f.managementContext(f.admin),
      selected = `campus:${f.campusA}`;
    const consistent = f.multiBaseCases.find(
      (item) => item.mismatch === 'none',
    );
    assert(consistent);
    const scopePayload = (categoryId: string) => ({
      categoryId,
      placement: { kind: 'campuses', campusIds: [f.campusA] },
      propagation: 'self',
    });
    for (const item of f.multiBaseCases.filter(
      (item) => item.mismatch !== 'none',
    ))
      await t.test(`reject unequal ${item.mismatch}`, async () => {
        const before = {
          artifacts: await f.managementArtifacts(),
          ledger: await f.managementLedger(),
        };
        const input = f.managementIntent(
          current,
          'set_category_scope_scoped',
          scopePayload(item.a.categoryId),
        );
        const rejected = await f.managementPost(f.admin, 'prepare', input);
        assert.equal(
          errorCode(rejected),
          'RATING_CATEGORY_SOURCE_UNRESOLVED',
          JSON.stringify(rejected.body),
        );
        assert.deepEqual(
          {
            artifacts: await f.managementArtifacts(),
            ledger: await f.managementLedger(),
          },
          before,
        );
      });
    const exact = await f.actor();
    await f.exactCategoryGrant(exact, f.campusA);
    const exactInput = f.managementIntent(
      await f.managementContext(exact),
      'set_category_scope_scoped',
      scopePayload(consistent.a.categoryId),
    );
    assert.equal(
      errorCode(await f.managementPost(exact, 'prepare', exactInput)),
      'RATING_SCOPE_UNAVAILABLE',
      'retiring independent B placement still needs B authority',
    );
    // Grant issuance advances the shared Authorization epoch, including proofs
    // held by the administrator. Obtain a fresh proof instead of weakening it.
    const mergeContext = await f.managementContext(f.admin);
    const input = f.managementIntent(
      mergeContext,
      'set_category_scope_scoped',
      scopePayload(consistent.a.categoryId),
    );
    const prepared = await f.prepareManagement(f.admin, input);
    const plan = (await f.managementPlan(f.admin, input)).category_plan;
    assert.deepEqual(
      plan.affectedScopeKeys,
      [`campus:${f.campusA}`, `campus:${f.campusB}`].sort(),
    );
    const bases = plan.sourceIssues.filter(
      (source) => source.kind === 'scoped_category_base',
    );
    assert.equal(
      bases.length,
      1,
      'equal stable identity/shared body yields one replacement base',
    );
    const base = bases[0]!;
    const placements = plan.sourceIssues.filter(
      (source) => source.kind === 'scoped_category_scope',
    );
    assert.equal(placements.length, 2);
    assert.equal(
      placements.filter((source) => source.payload['action'] === 'retired')
        .length,
      1,
    );
    assert.equal(
      placements.filter((source) => source.placement !== undefined).length,
      1,
    );
    assert(
      placements.every(
        (source) =>
          source.payload['baseSourceId'] === base.id &&
          source.payload['baseSourceRevision'] === base.revision,
      ),
    );
    for (const original of consistent.dependencies) {
      const replacement = plan.sourceIssues.find(
        (source) => source.previousSourceId === original.id,
      );
      assert(
        replacement,
        `${original.kind}: every independent A/B dependency must have a successor`,
      );
      assert.equal(replacement.payload['baseSourceId'], base.id);
      assert.equal(replacement.payload['baseSourceRevision'], base.revision);
    }
    assert.equal(
      plan.envelopes.length,
      3,
      'new shared base and both visible/dormant override bodies require fresh Review',
    );
    const originalIds = [
      consistent.a.source.id,
      consistent.b.source.id,
      ...consistent.dependencies.map((source) => source.id),
    ];
    const originalBytes = async () =>
      (
        await f.pool.query<{ value: unknown }>(
          'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=ANY($1::uuid[]) ORDER BY id',
          [originalIds],
        )
      ).rows;
    const old = await originalBytes();
    await t.test(
      'raw plan cannot omit independent B ownership with exact current A vectors',
      async () => {
        const hostile = f.managementIntent(
          mergeContext,
          'set_category_scope_scoped',
          scopePayload(consistent.a.categoryId),
        );
        let reachedSql = false;
        await f.rejectCategorySql('multi-base missing B domain', (tx) =>
          f.rawCategoryPreparation(
            tx,
            f.admin,
            hostile,
            (candidate, actual) => {
              assert(
                candidate.sourceIssues.some((source) =>
                  source.scopeKeys.includes(`campus:${f.campusB}`),
                ),
              );
              candidate.sourceIssues = candidate.sourceIssues.filter((source) =>
                source.scopeKeys.every((key) => key === selected),
              );
              const retained = new Set(
                candidate.sourceIssues.map((source) => source.id),
              );
              candidate.envelopes = candidate.envelopes.filter((envelope) =>
                retained.has(envelope.sourceId),
              );
              candidate.changes = candidate.changes
                .filter((change) => change.scopeKeys.includes(selected))
                .map((change) => ({
                  ...change,
                  scopeKeys: [selected],
                  ...(change.field === 'scope'
                    ? { before: canonicalJson([selected]) }
                    : {}),
                }));
              categoryPlanBefore(candidate, actual, [selected]);
              assert(
                candidate.sourceIssues.every((source) =>
                  source.scopeKeys.every((key) => key === selected),
                ),
              );
              reachedSql = true;
            },
          ),
        );
        assert(reachedSql);
      },
    );
    const decisions = await f.approveManagement(f.admin, input);
    assert.equal(decisions.length, 3);
    const response = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(response.body).outcome,
      'applied',
    );
    const currentPlacement = (
      await f.pool.query<{
        source_id: string;
        base_source_id: string;
        scope_keys: string[];
      }>(
        `SELECT p.source_id,p.base_source_id,p.scope_keys
    FROM whaleu_ratings.category_scope_placements p JOIN whaleu_ratings.scoped_source_heads h ON (h.source_id,h.source_revision)=(p.source_id,p.source_revision)
    WHERE p.category_id=$1`,
        [consistent.a.categoryId],
      )
    ).rows;
    assert.equal(
      currentPlacement.length,
      1,
      'both prior placements retire under one exact replacement placement',
    );
    assert.equal(currentPlacement[0]!.base_source_id, base.id);
    assert.deepEqual(currentPlacement[0]!.scope_keys, [selected]);
    const views = (
      await f.pool.query<{ scope_key: string; base_source_id: string }>(
        `SELECT h.scope_key,l.base_source_id FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id WHERE l.category_id=$1 ORDER BY h.scope_key`,
        [consistent.a.categoryId],
      )
    ).rows;
    assert.deepEqual(views, [{ scope_key: selected, base_source_id: base.id }]);
    assert.deepEqual(
      await originalBytes(),
      old,
      'all independent original source bytes remain immutable',
    );
    const replay = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, response.body);
  },
);

test(
  'M3C-owned absence declarations still permit exact genuine M3A legacy category bridge succession',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      equalViews: true,
      legacyBridge: true,
    });
    t.after(() => f.close());
    const edit = f.managementIntent(
      await f.managementContext(f.admin),
      'edit_category_base_scoped',
      {
        categoryId: f.data.local.categoryId,
        name: 'C-edited shared category before legacy bridge',
        description: 'Both campuses stay equal',
      },
    );
    await f.executeManagement(f.admin, edit);
    const cAbsence = (
      await f.pool.query<{
        id: string;
        revision: string;
        scope_keys: string[];
        payload: Record<string, unknown>;
      }>(`SELECT s.id,s.revision,s.scope_keys,s.payload FROM whaleu_ratings.scoped_source_heads h
    JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
    WHERE s.source_kind='scope_absence' AND s.issuer='ratings-category-management' ORDER BY s.source_key`)
    ).rows;
    assert.equal(cAbsence.length, 2);
    const before = (
      await f.pool.query<{ value: unknown }>(
        'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=ANY($1::uuid[]) ORDER BY id',
        [cAbsence.map((row) => row.id)],
      )
    ).rows;
    const legacy = await f.createCategories(f.admin, null, {
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Legacy category after C ownership',
          description: 'Original v4 review remains authoritative',
        },
      ],
    });
    const cause = (
      await f.pool.query<{ artifact_id: string }>(
        "SELECT artifact_id FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2 AND cause_kind='legacy_bridge'",
        [f.admin.accountId, legacy.input.clientRequestId],
      )
    ).rows[0];
    assert(
      cause,
      'actual old command must retain its genuine legacy bridge cause',
    );
    const derivatives = (
      await f.pool.query<{ payload: Record<string, unknown>; issuer: string }>(
        `SELECT s.payload,s.issuer FROM whaleu_ratings.scoped_source_heads h
    JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
    WHERE s.source_kind='scope_absence' AND s.payload->>'previousSourceId'=ANY($1::text[])`,
        [cAbsence.map((row) => row.id)],
      )
    ).rows;
    assert.equal(
      derivatives.length,
      2,
      'both exact C-owned campus absence keys are legitimately succeeded',
    );
    for (const successor of derivatives) {
      assert.equal(successor.issuer, 'ratings-legacy-bridge');
      assert.equal(successor.payload['bridgeId'], cause.artifact_id);
      assert.equal(
        Object.hasOwn(successor.payload, 'management'),
        false,
        'foreign issuer removes C authority marker rather than inheriting it',
      );
    }
    assert.deepEqual(
      (
        await f.pool.query<{ value: unknown }>(
          'SELECT to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=ANY($1::uuid[]) ORDER BY id',
          [cAbsence.map((row) => row.id)],
        )
      ).rows,
      before,
    );
    const cReceipt = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${edit.payload.clientRequestId}`,
      ),
      f.admin,
    );
    assert.equal(cReceipt.status, 200, JSON.stringify(cReceipt.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(cReceipt.body).outcome,
      'applied',
    );
  },
);

test(
  'M3C Review-blocked inherited set text cannot return through fresh or cached preparation previews',
  { timeout: 360000 },
  async (t) => {
    for (const blocked of ['parent-held', 'override-revoked'] as const)
      await t.test(blocked, async () => {
        const f = await ratingCategoryManagementFixture({
          adversarialCatalog: true,
          reviewPreview: true,
        });
        try {
          assert(f.solo && f.child && f.previewOverride);
          const child = f.child,
            override = f.previewOverride;
          const readDetail = async (
            context: Awaited<ReturnType<typeof f.managementContext>>,
          ) => {
            const response = await f
              .auth(
                request(f.http).get(
                  `/v2/ratings/category-management/categories/${child.categoryId}`,
                ),
                f.admin,
              )
              .query({
                contextId: context.commandContext.id,
                contextToken: context.commandContext.token,
              });
            assert.equal(response.status, 200, JSON.stringify(response.body));
            return ratingManagedCategorySchema.parse(response.body);
          };
          const context = await f.managementContext(f.admin),
            visible = await readDetail(context);
          const oldName = 'Previously approved secret set-name',
            oldDescription = 'Previously approved secret set-description';
          assert.equal(visible.name, oldName);
          assert.equal(visible.description, oldDescription);
          const draft = {
            categoryId: child.categoryId,
            name: 'User entered unpublished base draft',
            description: 'User entered unpublished base description',
          };
          const cachedIntent = f.managementIntent(
            context,
            'edit_category_base_scoped',
            draft,
          );
          await f.prepareManagement(f.admin, cachedIntent);
          const cachedPlan = (await f.managementPlan(f.admin, cachedIntent))
            .category_plan;
          assert.equal(cachedPlan.envelopes.length, 2);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_community.rating_approval_decisions WHERE envelope->>'sourceId'=ANY($1::text[])",
                [cachedPlan.envelopes.map((envelope) => envelope.sourceId)],
              )
            ).rowCount,
            0,
            'preparation is not a replacement Review approval',
          );
          const decisionId =
            blocked === 'override-revoked'
              ? override.reviewDecisionId
              : (
                  await f.pool.query<{ decision_id: string }>(
                    'SELECT decision_id FROM whaleu_community.rating_scoped_category_source_bindings WHERE source_id=$1 AND source_revision=$2',
                    [f.solo.source.id, f.solo.source.revision],
                  )
                ).rows[0]!.decision_id;
          await setRatingReviewState(
            f.pool,
            decisionId,
            blocked === 'override-revoked' ? 'revoked' : 'held',
          );
          const ownerState = await f.managementArtifacts();
          const current = await f.managementContext(f.admin),
            detail = await readDetail(current);
          assert.equal(detail.blockedReason, 'CONTENT_REVIEW_UNAVAILABLE');
          for (const field of [
            'name',
            'description',
            'baseName',
            'baseDescription',
          ] as const)
            assert.equal(detail[field], null);
          for (const field of [
            'id',
            'parentId',
            'level',
            'kind',
            'systemKey',
            'revision',
            'baseRevision',
            'placementRevision',
            'lifecycleRevision',
            'overrideRevision',
            'orderRevision',
            'ordinal',
            'businessState',
            'hidden',
            'scopeKeys',
          ] as const)
            assert.deepEqual(
              detail[field],
              visible[field],
              `${field}: blocked metadata remains complete`,
            );
          assert(
            !canonicalJson(detail).includes(oldName) &&
              !canonicalJson(detail).includes(oldDescription),
          );
          const assertSafePreview = (body: unknown) => {
            const preview = ratingCategoryScopedPreparationSchema.parse(body);
            assert.deepEqual(preview.affectedScopeKeys, [
              `campus:${f.campusA}`,
            ]);
            assert(preview.categoryIds.includes(child.categoryId));
            assert(preview.changedSourceCount > 0);
            assert(
              !canonicalJson(preview).includes(oldName) &&
                !canonicalJson(preview).includes(oldDescription),
              'unapproved inherited set text cannot appear anywhere in preview or summary',
            );
            const inherited = preview.changes.find(
              (change) =>
                change.field === 'effective_body' &&
                change.categoryId === child.categoryId,
            );
            assert(inherited);
            assert.equal(inherited.before, null);
            assert.equal(inherited.beforeStatus, 'unavailable');
            assert.equal(inherited.after, null);
            assert.equal(inherited.afterStatus, 'unavailable');
            const base = preview.changes.find(
              (change) =>
                change.field === 'base_body' &&
                change.categoryId === child.categoryId,
            );
            assert(base);
            assert.equal(base.afterStatus, 'available');
            assert.equal(
              base.after,
              canonicalJson({
                name: draft.name,
                description: draft.description,
              }),
              'only explicitly entered draft text may be echoed',
            );
            return preview;
          };
          const fresh = f.managementIntent(
            current,
            'edit_category_base_scoped',
            draft,
          );
          assertSafePreview(await f.prepareManagement(f.admin, fresh));
          const replay = await f.managementPost(
            f.admin,
            'prepare',
            cachedIntent,
          );
          if (replay.status === 200) assertSafePreview(replay.body);
          else
            assert.equal(
              errorCode(replay),
              'RATING_SCOPED_CONTEXT_CHANGED',
              'a stale immutable preview may be refused, never returned with old plaintext',
            );
          assert.deepEqual(
            await f.managementArtifacts(),
            ownerState,
            'detail and unapproved previews cannot issue sources, Review, effects or final heads',
          );
        } finally {
          await f.close();
        }
      });
  },
);

test(
  'M3C complete category transactions cannot carry foreign B child, target-placement or policy sources outside the exact plan vector',
  { timeout: 360000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    const selected = `campus:${f.campusA}`;
    // Retain an actual independently created native target for the placement-only
    // attack: no fake target row, invalid FK or target-origin move can reject it.
    const publicContext = await f.scopedContext(
      f.admin,
      { kind: 'campus', campusId: f.campusA },
      'create_target',
    );
    const category = (
      await f.pool.query<{ effective_revision: string }>(
        'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
        [publicContext.heads[0]!.catalogRevision, f.data.local.categoryId],
      )
    ).rows[0]!;
    const targetIntent = ratingScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'create_target_scoped',
      context: scopedCommandContext(publicContext),
      payload: {
        clientRequestId: randomUUID(),
        categoryId: f.data.local.categoryId,
        expectedCategoryRevision: category.effective_revision,
        name: 'Independent native target for vector isolation',
        description: '',
        assetIds: [],
      },
    });
    const targetPreparedResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/prepare'), f.admin)
      .send(targetIntent);
    assert.equal(
      targetPreparedResponse.status,
      200,
      JSON.stringify(targetPreparedResponse.body),
    );
    const targetPrepared = ratingScopedPreparationSchema.parse(
      targetPreparedResponse.body,
    );
    const targetEnvelope = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [f.admin.accountId, targetIntent.payload.clientRequestId],
      )
    ).rows[0]!.envelope;
    await f.approveScoped(canonicalRatingScopedEnvelope(targetEnvelope));
    const targetResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/targets'), f.admin)
      .send({
        ...targetIntent,
        preparationContextRevision: targetPrepared.contextRevision,
      });
    assert.equal(
      targetResponse.status,
      200,
      JSON.stringify(targetResponse.body),
    );
    const targetId = scopedSuccess(targetResponse.body).result['targetId'];
    assert.equal(typeof targetId, 'string');
    const originalPlacement = (
      await f.pool.query<{ source_key: string; target_id: string }>(
        `SELECT s.source_key,p.target_id FROM whaleu_ratings.target_scope_placements p
    JOIN whaleu_ratings.scoped_source_heads h ON (h.source_id,h.source_revision)=(p.source_id,p.source_revision)
    JOIN whaleu_ratings.scoped_source_attestations s ON s.id=h.source_id WHERE p.target_id=$1`,
        [targetId],
      )
    ).rows[0]!;
    const rootInput = f.managementIntent(
      await f.managementContext(f.admin),
      'create_system_category_scoped',
      {
        systemKey: 'synthetic_no_children',
        name: 'One-level no-children system root',
        description: '',
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        levelCount: 1,
      },
    );
    const root = await f.executeManagement(f.admin, rootInput);
    if (root.receipt.outcome !== 'applied') assert.fail();
    const rootId = root.receipt.result.categoryIds[0]!;
    const rootPlan = (await f.managementPlan(f.admin, rootInput)).category_plan;
    assert.equal(
      rootPlan.sourceIssues.find(
        (source) => source.kind === 'scoped_category_base',
      )?.payload['maximumDepth'],
      1,
    );
    // Positive control completes the exact same raw execution/issuer/publication/
    // receipt pipeline. A missing release or blanket raw-command denial cannot
    // make the subsequent negatives pass.
    const control = f.managementIntent(
      await f.managementContext(f.admin),
      'set_category_visibility_scoped',
      { categoryId: rootId, hidden: true },
    );
    const rawReceipt = await withCommunityScopeWriter(f.pool, async (tx) => {
      const prepared = await f.rawCategoryPreparation(tx, f.admin, control);
      assert.equal(prepared.plan.noop, false);
      await f.rawCategoryExecution(tx, f.admin, control);
      return f.finishRawCategoryExecution(tx, f.admin, control, prepared.plan);
    });
    assert.equal(rawReceipt.outcome, 'applied');
    const childId = randomUUID(),
      baseId = randomUUID(),
      baseRevision = randomUUID(),
      identityId = randomUUID();
    const baseKey = `foreign-b-child:${childId}`,
      placement = { kind: 'campuses' as const, campusIds: [f.campusA] };
    const body = {
      parentId: rootId,
      level: 2 as const,
      kind: 'general',
      systemKey: null,
      name: 'Forbidden foreign child under C system',
      description: '',
    };
    const issuanceDigest = ratingScopedDigest('issuance', {
      id: baseId,
      revision: baseRevision,
      kind: 'scoped_category_base',
      key: baseKey,
      scopeKeys: [selected],
      categoryId: childId,
      identityId,
      body,
      placement,
    });
    const envelope = canonicalRatingScopedEnvelope({
      version: 5,
      purpose: 'publish_rating_category_base_scoped',
      accountId: f.admin.accountId,
      sourceId: baseId,
      sourceRevision: baseRevision,
      categoryId: childId,
      identityId,
      issuanceId: baseId,
      issuanceDigest,
      placement,
      assetIds: [],
      body,
    });
    if (envelope.purpose !== 'publish_rating_category_base_scoped')
      assert.fail();
    const approved = await withCommunityScopeWriter(f.pool, (tx) =>
      writeRatingScopedApproval(tx, envelope),
    );
    const current = await f.managementContext(f.admin);
    for (const attack of [
      'foreign-child',
      'foreign-target-placement',
      'foreign-policy',
    ] as const)
      await t.test(attack, async () => {
        const input = f.managementIntent(
          current,
          'set_category_visibility_scoped',
          { categoryId: rootId, hidden: false },
        );
        const stages: string[] = [];
        await f.rejectCategorySql(
          `compound transaction ${attack}`,
          async (tx) => {
            const prepared = await f.rawCategoryPreparation(
              tx,
              f.admin,
              input,
              (plan) => {
                assert.equal(plan.noop, false);
                assert.equal(plan.envelopes.length, 0);
                if (attack === 'foreign-child') {
                  const absence = plan.sourceIssues.find(
                    (source) =>
                      source.kind === 'scope_absence' &&
                      source.key === selected,
                  );
                  assert(
                    absence && Array.isArray(absence.payload['categoryIds']),
                  );
                  absence.payload['categoryIds'] = [
                    ...absence.payload['categoryIds'],
                    childId,
                  ].sort();
                }
                stages.push('exact candidate with recomputed preview');
              },
            );
            stages.push('prepared');
            await f.rawCategoryExecution(tx, f.admin, input);
            stages.push('execution');
            if (attack === 'foreign-child') {
              const source = await writeRatingScopedSource(tx, {
                id: baseId,
                revision: baseRevision,
                kind: 'scoped_category_base',
                key: baseKey,
                scopeKeys: [selected],
                payload: {
                  reviewEnvelope: envelope,
                  issuanceDigest,
                  active: true,
                  hidden: false,
                  ordinal: '999',
                  originKind: 'regional',
                },
              });
              await tx.query(
                `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
          (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
          VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10)`,
                [
                  approved.decisionId,
                  envelope.accountId,
                  envelope.purpose,
                  approved.digest,
                  canonicalJson(envelope),
                  source.id,
                  source.revision,
                  childId,
                  envelope.issuanceId,
                  envelope.issuanceDigest,
                ],
              );
              const placementRevision = randomUUID();
              const scoped = await writeRatingScopedSource(tx, {
                kind: 'scoped_category_scope',
                key: `foreign-b-placement:${childId}`,
                scopeKeys: [selected],
                payload: {
                  categoryId: childId,
                  baseSourceId: source.id,
                  baseSourceRevision: source.revision,
                  placementRevision,
                  placement,
                  scopeKeys: [selected],
                },
              });
              await tx.query(
                `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
          VALUES($1,$2,$3,$4,$5::text[],$6,$7)`,
                [
                  placementRevision,
                  childId,
                  source.id,
                  source.revision,
                  [selected],
                  scoped.id,
                  scoped.revision,
                ],
              );
            } else if (attack === 'foreign-target-placement') {
              const source = await writeRatingScopedSource(tx, {
                kind: 'scoped_target_placement',
                key: originalPlacement.source_key,
                scopeKeys: [selected],
                payload: { targetId, categoryId: f.data.local.categoryId },
              });
              await tx.query(
                `INSERT INTO whaleu_ratings.target_scope_placements(placement_revision,target_id,scope_keys,source_id,source_revision)
          VALUES($1,$2,$3::text[],$4,$5)`,
                [
                  randomUUID(),
                  targetId,
                  [selected],
                  source.id,
                  source.revision,
                ],
              );
            } else {
              await writeRatingScopedSource(tx, {
                kind: 'native_scoped_create',
                key: `foreign-create-policy:${input.payload.clientRequestId}`,
                scopeKeys: [selected],
                payload: {
                  enabled: true,
                  genericKind: 'general',
                  scopeKeys: [selected],
                },
              });
            }
            stages.push('foreign sources and exact typed placement');
            await f.finishRawCategoryExecution(
              tx,
              f.admin,
              input,
              prepared.plan,
            );
            stages.push('C source/release/receipt');
          },
        );
        assert(
          stages.includes('exact candidate with recomputed preview'),
          'the SQL adversary never stops at a TypeScript planner denial',
        );
        t.diagnostic(`${attack} last completed stage: ${stages.at(-1)}`);
      });
    const recovery = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${targetIntent.payload.clientRequestId}`,
      ),
      f.admin,
    );
    assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
    assert.deepEqual(
      recovery.body,
      targetResponse.body,
      'independent native target history remains usable',
    );
  },
);

test(
  'M3C direct SQL cannot apply restore:true to a category that was never archived',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    assert(f.solo);
    const current = await f.managementContext(f.admin);
    const input = f.managementIntent(current, 'set_category_lifecycle_scoped', {
      categoryId: f.solo.categoryId,
      state: 'disabled',
      restore: true,
    });
    const seed = ratingCategoryScopedIntentSchema.parse({
      ...input,
      payload: { ...input.payload, restore: false },
    });
    let reachedSql = false;
    await f.rejectCategorySql(
      'restore of never-archived enabled category',
      async (tx) => {
        const prepared = await f.rawCategoryPreparation(
          tx,
          f.admin,
          input,
          (plan) => {
            assert.equal(plan.noop, false);
            assert(
              plan.sourceIssues.some(
                (source) =>
                  source.kind === 'scoped_category_lifecycle' &&
                  source.payload['businessState'] === 'disabled',
              ),
            );
            reachedSql = true;
          },
          false,
          { seedIntent: seed },
        );
        await f.rawCategoryExecution(tx, f.admin, input);
        await f.finishRawCategoryExecution(tx, f.admin, input, prepared.plan);
      },
    );
    assert(reachedSql);
    await f.executeManagement(f.admin, seed);
  },
);

test(
  'M3C named foreign-ancestry constraint catches a reviewed B child inserted before its real managed system parent',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({
      adversarialCatalog: true,
    });
    t.after(() => f.close());
    const input = f.managementIntent(
      await f.managementContext(f.admin),
      'create_system_category_scoped',
      {
        systemKey: 'synthetic_no_children',
        name: 'Managed parent issued after foreign child',
        description: '',
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        levelCount: 1,
      },
    );
    const prepared = await f.prepareManagement(f.admin, input);
    await f.approveManagement(f.admin, input);
    const plan = (await f.managementPlan(f.admin, input)).category_plan;
    const parent = plan.sourceIssues.find(
      (source) => source.kind === 'scoped_category_base',
    );
    assert(parent);
    const parentEnvelope = canonicalRatingScopedEnvelope(
      parent.payload['reviewEnvelope'],
    );
    if (parentEnvelope.purpose !== 'publish_rating_category_base_scoped')
      assert.fail();
    const childId = randomUUID(),
      sourceId = randomUUID(),
      sourceRevision = randomUUID(),
      identityId = randomUUID();
    const scopeKeys = [`campus:${f.campusA}`],
      placement = { kind: 'campuses' as const, campusIds: [f.campusA] };
    const key = `child-before-managed-parent:${childId}`;
    const body = {
      parentId: parentEnvelope.categoryId,
      level: 2 as const,
      kind: 'general',
      systemKey: null,
      name: 'Reviewed B-shaped child issued first',
      description: '',
    };
    const issuanceDigest = ratingScopedDigest('issuance', {
      id: sourceId,
      revision: sourceRevision,
      kind: 'scoped_category_base',
      key,
      scopeKeys,
      categoryId: childId,
      identityId,
      body,
      placement,
    });
    const envelope = canonicalRatingScopedEnvelope({
      version: 5,
      purpose: 'publish_rating_category_base_scoped',
      accountId: f.admin.accountId,
      sourceId,
      sourceRevision,
      categoryId: childId,
      identityId,
      issuanceId: sourceId,
      issuanceDigest,
      placement,
      assetIds: [],
      body,
    });
    if (envelope.purpose !== 'publish_rating_category_base_scoped')
      assert.fail();
    const approved = await withCommunityScopeWriter(f.pool, (tx) =>
      writeRatingScopedApproval(tx, envelope),
    );
    const before = {
      artifacts: await f.managementArtifacts(),
      ledger: await f.managementLedger(),
    };
    let forcingNamedConstraint = false;
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        assert.equal(
          (
            await tx.query(
              'SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE id=$1',
              [parent.id],
            )
          ).rowCount,
          0,
          'the managed parent genuinely does not exist when the child enters',
        );
        await f.rawCategoryExecution(tx, f.admin, input);
        const child = await writeRatingScopedSource(tx, {
          id: sourceId,
          revision: sourceRevision,
          kind: 'scoped_category_base',
          key,
          scopeKeys,
          payload: {
            reviewEnvelope: envelope,
            issuanceDigest,
            active: true,
            hidden: false,
            ordinal: '999',
            originKind: 'regional',
          },
        });
        await tx.query(
          `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
      (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
      VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10)`,
          [
            approved.decisionId,
            envelope.accountId,
            envelope.purpose,
            approved.digest,
            canonicalJson(envelope),
            child.id,
            child.revision,
            childId,
            envelope.issuanceId,
            envelope.issuanceDigest,
          ],
        );
        assert.equal(
          (
            await tx.query(
              'SELECT 1 FROM whaleu_ratings.scoped_source_heads WHERE source_id=$1 AND source_revision=$2',
              [child.id, child.revision],
            )
          ).rowCount,
          1,
        );
        await f.app.get(RatingCategorySourceIssuer).issue(plan, tx);
        assert.equal(
          (
            await tx.query(
              "SELECT 1 FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.id=$1 AND s.issuer='ratings-category-management'",
              [parent.id],
            )
          ).rowCount,
          1,
          'the real reviewed management issuer publishes the parent before the deferred ancestry check',
        );
        forcingNamedConstraint = true;
        // Run this one real deferrable owner check before publication. Other guards
        // remain installed and deferred; no missing release can supply the denial.
        await tx.query(
          'SET CONSTRAINTS whaleu_ratings.category_management_foreign_ancestry IMMEDIATE',
        );
        assert.fail(
          'named foreign ancestry constraint accepted an old-shape child under the newly issued C system parent',
        );
      }),
      (error: unknown) =>
        forcingNamedConstraint &&
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23514' &&
        'message' in error &&
        error.message ===
          'Managed system descendants require the exact category registry command owner',
    );
    assert(
      forcingNamedConstraint,
      'the test must actually execute the named constraint, not fail at another preparation/source guard',
    );
    assert.deepEqual(
      {
        artifacts: await f.managementArtifacts(),
        ledger: await f.managementLedger(),
      },
      before,
    );
    const lawful = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(lawful.status, 200, JSON.stringify(lawful.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(lawful.body).outcome,
      'applied',
      'the original exact parent command remains valid after the rejected compound transaction',
    );
  },
);
