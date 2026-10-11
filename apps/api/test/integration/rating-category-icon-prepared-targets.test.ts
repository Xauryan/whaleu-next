/** Real HTTP / PostgreSQL regression for reused original preparations. Run only
 * under the parent's exclusive disposable PostgreSQL lease. Three categories,
 * one real uploaded icon and one original target suffice; no scale fixture,
 * fabricated current flags, derived rows, guard bypasses or public-read mocks. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
} from '../../src/ratings/category-management/scoped-contracts.js';
import { ratingDeletionContextSchema } from '../../src/ratings/deletion/contracts.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  ratingScopedReceiptSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { setCategoryScaleAssetState } from '../support/category-icon-scale-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  scopedCommandContext,
  scopedCommandRoute,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';

type Actor = Awaited<ReturnType<CategoryIconManagementFixture['actor']>>;
type HttpResult = { status: number; body: unknown };
const globalSelector = { kind: 'global' } as const;

function blocked(response: HttpResult, codes: readonly string[]) {
  if (response.status === 200) {
    const scoped = ratingScopedReceiptSchema.safeParse(response.body);
    const receipt = scoped.success
      ? scoped.data
      : ratingCategoryScopedReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'closed', JSON.stringify(receipt));
    if (receipt.outcome !== 'closed')
      assert.fail('Fresh authority cannot be borrowed from a preparation');
    assert.ok(codes.includes(receipt.code), JSON.stringify(receipt));
  } else {
    assert.ok(response.status >= 400, JSON.stringify(response.body));
    const code = (response.body as { error?: { code?: string } }).error?.code;
    assert.ok(codes.includes(code ?? ''), JSON.stringify(response.body));
  }
}

/** A closed request is allowed; no accepted publication, definition, lifecycle,
 * baseline, binding, command cause or effect may escape the failed execution. */
async function wholeGraph(f: CategoryIconManagementFixture) {
  const artifacts = { ...((await f.artifacts()) as Record<string, unknown>) };
  delete artifacts['requests'];
  const tables = [
    'whaleu_ratings.scoped_source_attestations',
    'whaleu_ratings.scoped_source_heads',
    'whaleu_ratings.scoped_source_epoch',
    'whaleu_ratings.scoped_releases',
    'whaleu_ratings.scoped_release_scopes',
    'whaleu_ratings.scoped_catalog_heads',
    'whaleu_ratings.scoped_catalogs',
    'whaleu_ratings.scoped_categories',
    'whaleu_ratings.scoped_category_lineage',
    'whaleu_ratings.scoped_target_memberships',
    'whaleu_ratings.targets',
    'whaleu_ratings.target_sources',
    'whaleu_ratings.target_creations',
    'whaleu_ratings.target_scope_placements',
    'whaleu_ratings.target_definition_versions',
    'whaleu_ratings.target_definition_heads',
    'whaleu_ratings.target_definition_lifecycles',
    'whaleu_ratings.target_state_revisions',
    'whaleu_ratings.score_baselines',
    'whaleu_ratings.subscription_baselines',
    'whaleu_ratings.scores',
    'whaleu_ratings.comments',
    'whaleu_ratings.replies',
    'whaleu_ratings.effect_events',
    'whaleu_ratings.scoped_command_causes',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_community.rating_scoped_target_definition_bindings',
    'whaleu_community.rating_scoped_content_bindings',
  ];
  const owners = (
    await f.pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    ${tables.map((table) => `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM ${table} r)`).join(',')},
    'acceptedOutcomes',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY account_id,request_id),'[]'::jsonb)
      FROM whaleu_ratings.scoped_command_outcomes o WHERE outcome<>'closed')) state`)
  ).rows[0]!.state;
  return { artifacts, owners };
}

test(
  'C1 prepared original targets requalify the middle ancestor while metadata cleanup and receipts remain independent',
  { timeout: 300000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 39, height: 33, channels: 3, background: '#347a91' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const owner = await f.actor(),
      replyOwner = await f.actor();
    const commands = f.app.get(RatingScopedCommands);
    // Do not add a source behind a sealed catalog. Original creation policy and
    // the original all-scope publication advance atomically before any context.
    await f.atomicChange((tx) =>
      f.issueSource(
        {
          kind: 'native_scoped_create',
          key: 'synthetic-native-scoped-create',
          scopeKeys: f.scopeKeys,
          payload: {
            enabled: true,
            genericKind: 'general',
            scopeKeys: [...f.scopeKeys].sort(),
          },
        },
        tx,
      ),
    );
    const tree = f.intent(await f.context(), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'global' },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Prepared root',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'middle',
          parentKey: 'root',
          name: 'Prepared middle',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'leaf',
          parentKey: 'middle',
          name: 'Prepared leaf',
          description: '',
          icon: { mode: 'clear' },
        },
      ],
    });
    const upload = await f.ready(tree, { kind: 'new', key: 'middle' }, bytes);
    await f.execute(upload.input);
    const path = (
      await f.pool.query<{
        id: string;
        parent_id: string | null;
        level: number;
      }>(
        `SELECT c.category_id id,c.parent_id,c.level FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id
       WHERE h.scope_key='global' ORDER BY c.level`,
      )
    ).rows;
    assert.equal(path.length, 3);
    const [root, middle, leaf] = path;
    assert.ok(root && middle && leaf);
    assert.equal(root.parent_id, null);
    assert.equal(middle.parent_id, root.id);
    assert.equal(leaf.parent_id, middle.id);
    assert.deepEqual(
      path.map((row) => row.level),
      [1, 2, 3],
    );
    const middleDecision = async () => {
      const rows = (
        await f.pool.query<{ decision_id: string; appearance_id: string }>(
          `SELECT b.decision_id,p.appearance_id FROM whaleu_ratings.scoped_catalog_heads h
         JOIN whaleu_ratings.category_icon_projections p ON (p.catalog_id,p.release_id)=(h.catalog_id,h.release_id)
         JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id
         WHERE h.scope_key='global' AND p.category_id=$1`,
          [middle.id],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.ok(rows[0]!.appearance_id);
      return rows[0]!.decision_id;
    };
    const prepare = async (
      actor: Actor,
      input: RatingScopedIntent,
      approve = true,
    ) => {
      const response =
        input.operation === 'create_target_scoped' ||
        input.operation === 'edit_target_scoped'
          ? await f
              .auth(
                request(f.http).post(
                  input.operation === 'create_target_scoped'
                    ? '/v2/ratings/management/prepare'
                    : '/v2/ratings/management/owner-edit/prepare',
                ),
                actor,
              )
              .send(input)
          : {
              status: 200,
              body: await commands.prepare(actor.accessToken, input),
            };
      categoryIconHttpOk(response);
      const prepared = ratingScopedPreparationSchema.parse(response.body);
      if (approve) {
        const row = (
          await f.pool.query<{ envelope: unknown }>(
            'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, input.payload.clientRequestId],
          )
        ).rows[0];
        assert.ok(
          row?.envelope,
          'Only the actual persisted envelope is approved',
        );
        await f.approveScoped(canonicalRatingScopedEnvelope(row.envelope));
      }
      return { actor, input, prepared };
    };
    type Pending = Awaited<ReturnType<typeof prepare>>;
    const submit = (item: Pending) => {
      const route = scopedCommandRoute(item.input);
      return f
        .auth(request(f.http)[route.method](route.path), item.actor)
        .send({
          ...item.input,
          ...(item.input.operation === 'create_target_scoped' ||
          item.input.operation === 'edit_target_scoped'
            ? { preparationContextRevision: item.prepared.contextRevision }
            : {}),
        });
    };
    const createIntent = async () => {
      const context = await f.scopedContext(
        owner,
        globalSelector,
        'create_target',
      );
      const row = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [context.heads[0]!.catalogRevision, leaf.id],
        )
      ).rows[0];
      assert.ok(row);
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'create_target_scoped',
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: leaf.id,
          expectedCategoryRevision: row.effective_revision,
          name: 'Original target below a middle icon',
          description: 'Prepared target qualification',
          assetIds: [],
        },
      });
    };
    const original = await prepare(owner, await createIntent());
    const creation = await submit(original);
    categoryIconHttpOk(creation);
    const created = scopedSuccess(creation.body);
    const targetId = String(created.result['targetId']);
    const targetRevision = String(created.result['revision']);
    assert.equal(
      (
        await f.pool.query<{ creator_id: string }>(
          'SELECT creator_id FROM whaleu_ratings.targets WHERE id=$1',
          [targetId],
        )
      ).rows[0]!.creator_id,
      owner.accountId,
    );
    const editIntent = async (change: boolean) => {
      const context = await f.scopedContext(
        owner,
        globalSelector,
        'edit_target',
      );
      const response = await f
        .auth(
          request(f.http).get(
            `/v2/ratings/management/owner-edit/targets/${targetId}/context`,
          ),
          owner,
        )
        .query({ contextId: context.id, contextToken: context.token });
      categoryIconHttpOk(response);
      const current = ratingScopedEditContextSchema.parse(response.body);
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'edit_target_scoped',
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          targetId,
          expectedTargetRevision: current.revision,
          expectedDefinitionRevision: current.definitionRevision,
          expectedContentVersion: current.contentVersion,
          categoryId: current.categoryId,
          expectedCategoryRevision: current.categoryRevision,
          name: change ? 'A prepared changed target' : current.name,
          description: current.description,
          assetIds: [],
        },
      });
    };
    const pendingTargets = async () => [
      await prepare(owner, await createIntent()),
      await prepare(owner, await editIntent(true)),
      await prepare(owner, await editIntent(false), false),
    ];
    const recoverCreation = async () => {
      const replay = await submit(original);
      categoryIconHttpOk(replay);
      assert.equal(canonicalJson(replay.body), canonicalJson(creation.body));
      const status = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${original.input.payload.clientRequestId}`,
        ),
        owner,
      );
      categoryIconHttpOk(status);
      assert.equal(canonicalJson(status.body), canonicalJson(creation.body));
    };
    for (const change of ['held-review8', 'unknown-media8'] as const) {
      await t.test(
        `${change} after prepare blocks create, changed edit and genuine edit noop before any effect`,
        async () => {
          const pending = await pendingTargets(),
            decision = await middleDecision();
          if (change === 'held-review8')
            await setRatingReviewState(f.pool, decision, 'held');
          else
            await setCategoryScaleAssetState(
              f,
              upload.status.assetId,
              'unknown',
            );
          try {
            // The original source/head/CAS still agrees. Only this exact middle
            // ancestor's external Review8/Media8 fact changed after preparation.
            for (const item of pending) {
              const row = (
                await f.pool.query<{ current: boolean }>(
                  'SELECT whaleu_ratings.scoped_context_current($1,$2,$3,clock_timestamp()) current',
                  [item.input.context.id, owner.accountId, owner.sessionId],
                )
              ).rows[0];
              assert.equal(row?.current, true);
            }
            const before = await wholeGraph(f);
            for (const item of pending)
              blocked(
                await submit(item),
                change === 'held-review8'
                  ? ['RATING_NOT_FOUND', 'CONTENT_REVIEW_UNAVAILABLE']
                  : ['MEDIA_UNAVAILABLE'],
              );
            await recoverCreation();
            assert.deepEqual(await wholeGraph(f), before);
          } finally {
            if (change === 'held-review8')
              await setRatingReviewState(f.pool, decision, 'allow');
            else
              await setCategoryScaleAssetState(
                f,
                upload.status.assetId,
                'allow',
              );
          }
          if (change === 'unknown-media8') {
            const retried = await submit(pending[2]!);
            categoryIconHttpOk(retried);
            const receipt = scopedSuccess(retried.body, 'noop');
            assert.equal(
              receipt.requestId,
              pending[2]!.input.payload.clientRequestId,
              'Unknown media preserves the original preparation and key until real recovery',
            );
          }
        },
      );
    }

    await t.test(
      'a genuine unchanged edit still returns noop once the same ancestor is available',
      async () => {
        const pending = await prepare(owner, await editIntent(false), false);
        const response = await submit(pending);
        categoryIconHttpOk(response);
        const receipt = scopedSuccess(response.body, 'noop');
        assert.equal(receipt.result['revision'], targetRevision);
        assert.equal(receipt.result['contentVersion'], 1);
      },
    );

    await t.test(
      'a real middle source successor with keep invalidates every old target preparation by original context CAS',
      async () => {
        const pending = await pendingTargets();
        const current = await f.detail(middle.id);
        const changed = await f.execute(
          f.intent(await f.context(), 'edit_category_base_scoped', {
            categoryId: middle.id,
            name: `${current.baseName} successor`,
            description: current.baseDescription,
            icon: { mode: 'keep' },
          }),
        );
        assert.equal(changed.receipt.outcome, 'applied');
        assert.equal(changed.prepared.changedIconCount, 0);
        const before = await wholeGraph(f);
        for (const item of pending)
          blocked(await submit(item), ['RATING_SCOPED_CONTEXT_CHANGED']);
        await recoverCreation();
        assert.deepEqual(await wholeGraph(f), before);
      },
    );

    await t.test(
      'original Category metadata noop needs current management authority but no public image qualification',
      async () => {
        const manager = await f.actor(),
          grant = await f.grant(manager, 'super_admin');
        const post = (route: string, body: object) =>
          f
            .auth(
              request(f.ordinaryHttp).post(
                `/v2/ratings/category-management/${route}`,
              ),
              manager,
            )
            .send(body);
        const metadataIntent = async (hidden: boolean) => {
          const response = await post('contexts', { selector: globalSelector });
          categoryIconHttpOk(response);
          const context = ratingCategoryManagementContextSchema.parse(
            response.body,
          );
          const input = ratingCategoryScopedIntentSchema.parse({
            protocolVersion: 2,
            operation: 'set_category_visibility_scoped',
            context: context.commandContext,
            payload: {
              clientRequestId: randomUUID(),
              expectedSnapshot: context.snapshotRevision,
              categoryId: leaf.id,
              hidden,
            },
          });
          const preparation = await post('prepare', input);
          categoryIconHttpOk(preparation);
          return {
            input,
            prepared: ratingCategoryScopedPreparationSchema.parse(
              preparation.body,
            ),
          };
        };
        const allowed = await metadataIntent(false),
          revoked = await metadataIntent(false),
          publishing = await metadataIntent(true);
        assert.equal(allowed.prepared.changedSourceCount, 0);
        assert.equal(revoked.prepared.changedSourceCount, 0);
        assert.ok(publishing.prepared.changedSourceCount > 0);
        const textPlan = (
          await f.pool.query<{ category_plan: { envelopes: unknown[] } }>(
            'SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [manager.accountId, publishing.input.payload.clientRequestId],
          )
        ).rows[0]!.category_plan;
        for (const envelope of textPlan.envelopes)
          await f.approveScoped(canonicalRatingScopedEnvelope(envelope));
        const commit = (item: typeof allowed) =>
          post('commit', {
            intent: item.input,
            preparationContextRevision: item.prepared.contextRevision,
          });
        const decision = await middleDecision();
        await setRatingReviewState(f.pool, decision, 'held');
        try {
          const noop = await commit(allowed);
          categoryIconHttpOk(noop);
          const receipt = ratingCategoryScopedReceiptSchema.parse(noop.body);
          assert.equal(receipt.outcome, 'noop', JSON.stringify(receipt));
          assert.equal(receipt.result.releaseId, null);
          const before = await wholeGraph(f);
          blocked(await commit(publishing), [
            'RATING_SCOPE_UNAVAILABLE',
            'CONTENT_REVIEW_UNAVAILABLE',
          ]);
          assert.deepEqual(
            await wholeGraph(f),
            before,
            'A non-noop original publisher must carry exact current C1 authority',
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
              [grant, f.admin.accountId],
            ),
          );
          const afterRevocation = await wholeGraph(f);
          blocked(await commit(revoked), [
            'RATING_SCOPE_UNAVAILABLE',
            'RATING_SCOPED_CONTEXT_CHANGED',
          ]);
          assert.deepEqual(await wholeGraph(f), afterRevocation);
          const replay = await commit(allowed);
          categoryIconHttpOk(replay);
          assert.deepEqual(
            replay.body,
            noop.body,
            'The actor-owned original receipt survives both later public hold and authority loss',
          );
        } finally {
          await setRatingReviewState(f.pool, decision, 'allow');
        }
      },
    );

    await t.test(
      'owner comment, reply and target cleanup use metadata during a held middle image and replay exact receipts',
      async () => {
        const discussionIntent = async (
          actor: Actor,
          operation: 'create_comment_scoped' | 'create_reply_scoped',
          payload: Record<string, unknown>,
        ) => {
          const context = await f.scopedContext(
            actor,
            globalSelector,
            'interact',
          );
          const category = (
            await f.pool.query<{ effective_revision: string }>(
              'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
              [context.heads[0]!.catalogRevision, leaf.id],
            )
          ).rows[0];
          assert.ok(category);
          return ratingScopedIntentSchema.parse({
            protocolVersion: 2,
            operation,
            context: scopedCommandContext(context),
            payload: {
              clientRequestId: randomUUID(),
              categoryId: leaf.id,
              expectedCategoryRevision: category.effective_revision,
              targetId,
              expectedTargetRevision: targetRevision,
              authorMode: 'named',
              body: 'Real discussion owner cleanup beneath a C1 middle ancestor',
              assetIds: [],
              ...payload,
            },
          });
        };
        const comment = await submit(
          await prepare(
            owner,
            await discussionIntent(owner, 'create_comment_scoped', {}),
          ),
        );
        categoryIconHttpOk(comment);
        const rootReceipt = scopedSuccess(comment.body);
        const rootId = String(rootReceipt.result['subjectId']);
        const reply = await submit(
          await prepare(
            replyOwner,
            await discussionIntent(replyOwner, 'create_reply_scoped', {
              rootId,
              expectedRootRevision: rootReceipt.result['revision'],
              replyTo: null,
            }),
          ),
        );
        categoryIconHttpOk(reply);
        const replyId = String(scopedSuccess(reply.body).result['replyId']);
        const decision = await middleDecision();
        await setRatingReviewState(f.pool, decision, 'held');
        try {
          // Root deletion first also proves that reply owner cleanup is legal
          // beneath a tombstoned root, using freshly obtained metadata CAS.
          for (const item of [
            { kind: 'comments', id: rootId, actor: owner },
            { kind: 'replies', id: replyId, actor: replyOwner },
          ] as const) {
            const endpoint = `/v1/ratings/${item.kind}/${item.id}`;
            const context = await f.auth(
              request(f.http).get(`${endpoint}/deletion-context`),
              item.actor,
            );
            categoryIconHttpOk(context);
            const metadata = ratingDeletionContextSchema.parse(context.body);
            assert.equal(metadata.targetId, targetId);
            assert.doesNotMatch(
              canonicalJson(context.body),
              /"(?:body|name|icon|appearanceId|manifest|url)"/,
            );
            const input = {
              clientRequestId: randomUUID(),
              regionId: metadata.regionId,
              targetId,
              expectedTargetRevision: metadata.targetRevision,
              expectedRevision: metadata.revision,
              ...(item.kind === 'replies'
                ? { rootId, expectedRootRevision: metadata.rootRevision }
                : {}),
            };
            const remove = () =>
              f.auth(request(f.http).delete(endpoint), item.actor).send(input);
            const deleted = await remove();
            categoryIconHttpOk(deleted);
            assert.equal(
              deleted.body.outcome,
              'applied',
              JSON.stringify(deleted.body),
            );
            const replay = await remove();
            categoryIconHttpOk(replay);
            assert.deepEqual(replay.body, deleted.body);
            const receipt = await f.auth(
              request(f.http).get(
                `/v1/ratings/${item.kind === 'replies' ? 'reply-requests' : 'requests'}/${input.clientRequestId}`,
              ),
              item.actor,
            );
            categoryIconHttpOk(receipt);
            assert.deepEqual(receipt.body, deleted.body);
          }
          const prefix = '/v1/ratings/management/owner-deletion';
          const context = await f.auth(
            request(f.http).get(`${prefix}/targets/${targetId}/context`),
            owner,
          );
          categoryIconHttpOk(context);
          assert.deepEqual(context.body, {
            targetId,
            revision: targetRevision,
            deletion: { kind: 'not_owner_deleted' },
          });
          const input = {
            clientRequestId: randomUUID(),
            expectedTargetRevision: context.body.revision,
          };
          const remove = () =>
            f
              .auth(
                request(f.http).post(`${prefix}/targets/${targetId}`),
                owner,
              )
              .send(input);
          const deleted = await remove();
          categoryIconHttpOk(deleted);
          assert.equal(
            deleted.body.outcome,
            'applied',
            JSON.stringify(deleted.body),
          );
          const replay = await remove();
          categoryIconHttpOk(replay);
          assert.deepEqual(replay.body, deleted.body);
          const receipt = await f.auth(
            request(f.http).get(`${prefix}/requests/${input.clientRequestId}`),
            owner,
          );
          categoryIconHttpOk(receipt);
          assert.deepEqual(receipt.body, deleted.body);
          await recoverCreation();
        } finally {
          await setRatingReviewState(f.pool, decision, 'allow');
        }
      },
    );
  },
);
