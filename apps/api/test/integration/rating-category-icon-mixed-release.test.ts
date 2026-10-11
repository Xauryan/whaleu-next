/** Real HTTP/PG regression coverage. Run only under the parent's exclusive
 * disposable PostgreSQL lease. Original source and Review fixtures remain the
 * owners; neither accepted receipts nor Category projections are fabricated. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  categoryIconDigest,
  type CategoryIconReleaseRow,
} from '../../src/ratings/category-management/icon-extension.js';
import type { CategoryManagementPlan } from '../../src/ratings/category-management/plan.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
  type RatingCategoryScopedOperation,
} from '../../src/ratings/category-management/scoped-contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { writeRatingScopedApproval } from '../support/rating-scoped-fixture.js';

const globalSelector = { kind: 'global' } as const;
interface ScopeHead {
  scopeKey: string;
  catalogId: string;
  headRevision: string;
  releaseId: string;
  cause: Record<string, unknown>;
}
interface ScopeExtent {
  scopeKey: string;
  adopted: boolean;
  beforeCatalogId: string | null;
  beforeHeadRevision: string | null;
  beforeReleaseId: string | null;
  beforeAdopted: boolean;
}
const campusKeys = (f: CategoryIconManagementFixture) =>
  [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
const isAdopted = (head: ScopeHead) =>
  head.cause['categoryIconExtension'] === 'ratings-category-icon-v1' &&
  Array.isArray(head.cause['categoryIconScopeKeys']) &&
  head.cause['categoryIconScopeKeys'].includes(head.scopeKey);

async function heads(f: CategoryIconManagementFixture) {
  return (
    await f.pool.query<ScopeHead>(`SELECT h.scope_key "scopeKey",
      h.catalog_id "catalogId",h.head_revision "headRevision",
      h.release_id "releaseId",r.cause FROM whaleu_ratings.scoped_catalog_heads h
      JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id
      ORDER BY h.scope_key COLLATE "C"`)
  ).rows;
}

/** The original v2 routes, original preparation and original Review5 owner.
 * This intentionally uses the ordinary application even if Media DI exists. */
async function strictGlobalCommand(
  f: CategoryIconManagementFixture,
  operation: RatingCategoryScopedOperation,
  payload: Record<string, unknown>,
) {
  const post = (route: string, body: object) =>
    f
      .auth(
        request(f.ordinaryHttp).post(
          `/v2/ratings/category-management/${route}`,
        ),
      )
      .send(body);
  const response = await post('contexts', { selector: globalSelector });
  categoryIconHttpOk(response);
  const context = ratingCategoryManagementContextSchema.parse(response.body);
  const input = ratingCategoryScopedIntentSchema.parse({
    protocolVersion: 2,
    operation,
    context: context.commandContext,
    payload: {
      clientRequestId: randomUUID(),
      expectedSnapshot: context.snapshotRevision,
      ...payload,
    },
  });
  const preparing = await post('prepare', input);
  categoryIconHttpOk(preparing);
  const prepared = ratingCategoryScopedPreparationSchema.parse(preparing.body);
  const persisted = (
    await f.pool.query<{ category_plan: CategoryManagementPlan }>(
      `SELECT category_plan FROM whaleu_ratings.scoped_command_preparations
       WHERE account_id=$1 AND request_id=$2`,
      [f.admin.accountId, input.payload.clientRequestId],
    )
  ).rows[0];
  assert.ok(persisted, 'Review only the exact real original preparation');
  assert.deepEqual(persisted.category_plan.affectedScopeKeys, ['global']);
  await withCommunityScopeWriter(f.pool, async (tx) => {
    for (const envelope of persisted.category_plan.envelopes)
      await writeRatingScopedApproval(
        tx,
        canonicalRatingScopedEnvelope(envelope),
      );
  });
  const committed = await post('commit', {
    intent: input,
    preparationContextRevision: prepared.contextRevision,
  });
  categoryIconHttpOk(committed);
  const receipt = ratingCategoryScopedReceiptSchema.parse(committed.body);
  if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
  return { input, receipt, plan: persisted.category_plan };
}

async function createGlobalText(f: CategoryIconManagementFixture) {
  return strictGlobalCommand(f, 'create_categories_scoped', {
    parentId: null,
    placement: { kind: 'global' },
    nodes: [
      {
        key: 'global_text',
        parentKey: null,
        name: 'Unextended original global text',
        description: 'Strict v2 creation with no Category icon adoption',
      },
    ],
  });
}

async function createCampusAbsence(f: CategoryIconManagementFixture) {
  return f.execute(
    f.intent(
      await f.context({ kind: 'campus', campusId: f.campusA }),
      'create_categories_scoped',
      {
        parentId: null,
        placement: {
          kind: 'campuses',
          campusIds: [f.campusA, f.campusB].sort(),
        },
        nodes: [
          {
            key: 'campus_icon',
            parentKey: null,
            name: 'Explicitly adopted campus absence',
            description: 'Exact Review5 and Review8 without a Media runtime',
            icon: { mode: 'clear' },
          },
        ],
      },
    ),
  );
}

async function currentIconRows(f: CategoryIconManagementFixture) {
  return (
    await f.pool.query(`SELECT h.scope_key,p.category_id,p.appearance_id,
      p.review_binding_id,p.projection->'content' content,p.projection->'review' review
      FROM whaleu_ratings.scoped_catalog_heads h
      JOIN whaleu_ratings.category_icon_projections p
        ON (p.catalog_id,p.release_id)=(h.catalog_id,h.release_id)
      ORDER BY h.scope_key COLLATE "C",p.category_id`)
  ).rows;
}

async function assertMixedRelease(
  f: CategoryIconManagementFixture,
  releaseId: string,
  previous: ScopeHead[],
  expectedRows: Awaited<ReturnType<typeof currentIconRows>>,
) {
  const release = (
    await f.pool.query<{
      cause_kind: string;
      cause: Record<string, unknown>;
      affected_scope_keys: string[];
    }>(
      'SELECT cause_kind,cause,affected_scope_keys FROM whaleu_ratings.scoped_releases WHERE id=$1',
      [releaseId],
    )
  ).rows[0]!;
  assert.equal(release.cause_kind, 'source_release');
  assert.deepEqual(release.affected_scope_keys, f.scopeKeys);
  assert.deepEqual(release.cause['categoryIconScopeKeys'], campusKeys(f));
  const manifest = (
    await f.pool.query<{
      scope_extent: ScopeExtent[];
      digest: string;
      row_count: number;
      root_snapshot: unknown[];
      capabilities: unknown[];
      management_coverage: unknown[];
      serialized_bytes: string;
    }>(
      'SELECT * FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1',
      [releaseId],
    )
  ).rows[0];
  assert.ok(manifest);
  assert.deepEqual(
    manifest.scope_extent,
    previous.map((head) => ({
      scopeKey: head.scopeKey,
      adopted: campusKeys(f).includes(head.scopeKey),
      beforeCatalogId: head.catalogId,
      beforeHeadRevision: head.headRevision,
      beforeReleaseId: head.releaseId,
      beforeAdopted: isAdopted(head),
    })),
  );
  const outputs = (
    await f.pool.query(
      `SELECT s.scope_key,s.before_catalog_id,s.before_head_revision,
      s.after_catalog_id,s.after_head_revision,c.release_id,c.sealed,
      h.catalog_id current_catalog_id,h.head_revision current_head_revision,h.release_id current_release_id
      FROM whaleu_ratings.scoped_release_scopes s
      JOIN whaleu_ratings.scoped_catalogs c ON c.id=s.after_catalog_id
      JOIN whaleu_ratings.scoped_catalog_heads h ON h.scope_key=s.scope_key
      WHERE s.release_id=$1 ORDER BY s.scope_key COLLATE "C"`,
      [releaseId],
    )
  ).rows;
  assert.deepEqual(
    outputs.map((output) => output.scope_key),
    f.scopeKeys,
  );
  for (const output of outputs) {
    const before = previous.find((head) => head.scopeKey === output.scope_key)!;
    assert.equal(output.before_catalog_id, before.catalogId);
    assert.equal(output.before_head_revision, before.headRevision);
    assert.equal(output.release_id, releaseId);
    assert.equal(output.current_release_id, releaseId);
    assert.equal(output.current_catalog_id, output.after_catalog_id);
    assert.equal(output.current_head_revision, output.after_head_revision);
    assert.equal(output.sealed, true);
    assert.notEqual(output.after_catalog_id, before.catalogId);
  }
  const rows = (
    await f.pool.query<{ projection: CategoryIconReleaseRow }>(
      `SELECT p.projection FROM whaleu_ratings.category_icon_projections p
       JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
       WHERE p.release_id=$1 ORDER BY c.scope_key COLLATE "C",p.category_id`,
      [releaseId],
    )
  ).rows.map((row) => row.projection);
  assert.equal(manifest.row_count, expectedRows.length);
  assert.equal(rows.length, expectedRows.length);
  assert.equal(
    manifest.digest,
    categoryIconDigest('release', {
      extent: manifest.scope_extent,
      managementCoverage: manifest.management_coverage,
      rows: rows.map((row) => row.digest),
    }),
  );
  assert.equal(release.cause['categoryIconDigest'], manifest.digest);
  assert.equal(
    Number(manifest.serialized_bytes),
    Buffer.byteLength(
      canonicalJson({
        extent: manifest.scope_extent,
        managementCoverage: manifest.management_coverage,
        roots: manifest.root_snapshot,
        capabilities: manifest.capabilities,
        rows,
      }),
      'utf8',
    ),
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
        [releaseId],
      )
    ).rows[0]!.valid,
    true,
  );
  assert.deepEqual(
    await currentIconRows(f),
    expectedRows,
    'Both exact content and exact Review8 binding carry without reapproval',
  );
  assert.equal(
    (
      await f.pool.query(`SELECT count(*)::int n
    FROM whaleu_ratings.category_icon_capability_sources a
    JOIN whaleu_ratings.scope_protocol_versions v ON v.id=a.protocol_version_id
    WHERE v.logical_scope_key='global'`)
    ).rows[0]!.n,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        `SELECT count(*)::int n
    FROM whaleu_ratings.category_icon_projections p
    JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
    WHERE p.release_id=$1 AND c.scope_key='global'`,
        [releaseId],
      )
    ).rows[0]!.n,
    0,
    'A mixed release cannot manufacture even a null projection for old global text',
  );
}

async function assertUnextendedRelease(
  f: CategoryIconManagementFixture,
  releaseId: string,
) {
  const row = (
    await f.pool.query(
      `SELECT cause,affected_scope_keys,
    EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_release_manifests m WHERE m.release_id=r.id) has_manifest,
    EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_projections p WHERE p.release_id=r.id) has_projection
    FROM whaleu_ratings.scoped_releases r WHERE id=$1`,
      [releaseId],
    )
  ).rows[0]!;
  assert.deepEqual(row.affected_scope_keys, ['global']);
  for (const key of [
    'categoryIconExtension',
    'categoryIconScopeKeys',
    'categoryIconDigest',
  ])
    assert.equal(Object.hasOwn(row.cause, key), false);
  assert.equal(row.has_manifest, false);
  assert.equal(row.has_projection, false);
}

for (const withGlobalText of [false, true]) {
  test(
    `Mixed foreign releases preserve adopted campus icons and ${withGlobalText ? 'strict-v2 global text' : 'empty unadopted global'} across later old publishers`,
    { timeout: 300000 },
    async (t) => {
      const f = await categoryIconManagementFixture([], {
        runtime: false,
        iconGlobal: false,
      });
      t.after(() => f.close());
      const global = withGlobalText ? await createGlobalText(f) : null;
      const campus = await createCampusAbsence(f);
      assert.equal(campus.receipt.outcome, 'applied');
      const adopted = (await heads(f)).filter(isAdopted);
      assert.deepEqual(
        adopted.map((head) => head.scopeKey),
        campusKeys(f),
      );
      const content = await currentIconRows(f);
      assert.equal(content.length, 2);
      for (const row of content) assert.equal(row.content.icon.kind, 'absent');
      const before = await heads(f);
      const mixed = await f.publish();
      await assertMixedRelease(f, mixed.releaseId, before, content);
      const globalMixed = (await heads(f)).find(
        (head) => head.scopeKey === 'global',
      )!;
      assert.equal(
        globalMixed.cause['categoryIconExtension'],
        'ratings-category-icon-v1',
      );
      assert.equal(
        isAdopted(globalMixed),
        false,
        'A release marker alone cannot adopt every catalog carried by that release',
      );
      const denied = await f.post('contexts', { selector: globalSelector });
      assert.equal(denied.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
      const campusHeads = (await heads(f)).filter(
        (head) => head.scopeKey !== 'global',
      );
      if (global) {
        const categoryId = global.receipt.result.categoryIds[0]!;
        const edited = await strictGlobalCommand(
          f,
          'edit_category_base_scoped',
          {
            categoryId,
            name: 'Original global text still editable after a mixed release',
            description:
              'No Category capability or synthetic absence is needed',
          },
        );
        assert.ok(edited.receipt.result.releaseId);
        await assertUnextendedRelease(f, edited.receipt.result.releaseId);
        const current = (await heads(f)).find(
          (head) => head.scopeKey === 'global',
        )!;
        const category = (
          await f.pool.query(
            'SELECT name FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
            [current.catalogId, categoryId],
          )
        ).rows[0];
        assert.equal(
          category?.name,
          'Original global text still editable after a mixed release',
        );
        const recovered = await f.auth(
          request(f.ordinaryHttp).get(
            `/v2/ratings/requests/${global.input.payload.clientRequestId}`,
          ),
        );
        categoryIconHttpOk(recovered);
        assert.deepEqual(recovered.body, global.receipt);
      }
      const oldOnly = await f.publish({ domain: { kind: 'global_compat' } });
      await assertUnextendedRelease(f, oldOnly.releaseId);
      assert.deepEqual(
        (await heads(f)).filter((head) => head.scopeKey !== 'global'),
        campusHeads,
        'A global-only original publication cannot advance any campus head',
      );
      assert.deepEqual(await currentIconRows(f), content);
      const beforeAgain = await heads(f);
      const carriedAgain = await f.publish();
      await assertMixedRelease(f, carriedAgain.releaseId, beforeAgain, content);
      for (const campusId of [f.campusA, f.campusB]) {
        const page = await f.publicPage({ kind: 'campus', campusId });
        assert.equal(
          page.page.items.find(
            (item) => item.id === campus.receipt.result.categoryIds[0],
          )?.icon,
          null,
        );
      }
      assert.equal(
        (await f.pool.query('SELECT count(*)::int n FROM whaleu_media.assets'))
          .rows[0]!.n,
        0,
      );
    },
  );
}

/** Include original source, release, compatibility and legacy projections, not
 * just the extension rows. Failure must undo the complete original publication. */
async function publicationState(f: CategoryIconManagementFixture) {
  const tables = [
    'scoped_releases',
    'scoped_release_scopes',
    'scoped_catalogs',
    'scoped_catalog_heads',
    'scoped_categories',
    'scoped_category_lineage',
    'scoped_target_memberships',
    'scoped_source_attestations',
    'scoped_source_heads',
    'scoped_source_epoch',
    'scope_protocol_versions',
    'scope_protocol_heads',
    'scope_protocol_epoch',
    'compat_versions',
    'compat_heads',
    'compat_projection_manifests',
    'catalogs',
    'catalog_heads',
    'categories',
    'catalog_category_lineage',
    'scoped_command_preparations',
    'scoped_command_outcomes',
    'scoped_command_causes',
    'category_icon_capability_sources',
    'category_icon_review_bindings',
    'category_icon_management_review_heads',
    'navigation_epoch',
    'random_pool_epoch',
  ];
  const original = (
    await f.pool.query<{ state: unknown }>(
      `SELECT jsonb_build_object(${tables
        .map(
          (table) =>
            `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM whaleu_ratings.${table} r)`,
        )
        .join(',')}) state`,
    )
  ).rows[0]!.state;
  return { original, extensionAndMedia: await f.artifacts() };
}

const attacks = [
  'extent-omitted-scope',
  'extent-duplicate-scope',
  'extent-adopt-unmarked',
  'extent-drop-adopted',
  'extent-before-adopted',
  'extent-before-catalog',
  'extent-before-revision',
  'extent-before-release',
  'cause-add-unadopted',
  'cause-drop-adopted-empty',
  'cause-noncanonical',
  'cause-duplicate',
] as const;
type Attack = (typeof attacks)[number];

/** Alter only fresh INSERT parameters emitted by the actual original source
 * publisher. All SQL still executes normally with every guard enabled. */
async function adversarialPublish(
  f: CategoryIconManagementFixture,
  tx: PoolClient,
  attack: Attack,
) {
  const query = tx.query.bind(tx);
  let changed = false;
  tx.query = (async (sql: string, values?: unknown[]) => {
    const parameters = values ? [...values] : undefined;
    if (
      sql.startsWith('INSERT INTO whaleu_ratings.scoped_releases(') &&
      attack.startsWith('cause-')
    ) {
      assert.ok(parameters);
      const cause = JSON.parse(String(parameters[3])) as Record<
        string,
        unknown
      >;
      const keys = cause['categoryIconScopeKeys'] as string[];
      assert.deepEqual(keys, campusKeys(f));
      switch (attack) {
        case 'cause-add-unadopted':
          cause['categoryIconScopeKeys'] = [...keys, 'global'].sort();
          break;
        case 'cause-drop-adopted-empty':
          cause['categoryIconScopeKeys'] = keys.filter(
            (key) => key !== `campus:${f.campusB}`,
          );
          break;
        case 'cause-noncanonical':
          cause['categoryIconScopeKeys'] = [...keys].reverse();
          break;
        case 'cause-duplicate':
          cause['categoryIconScopeKeys'] = [...keys, keys[0]].sort();
          break;
        default:
          assert.fail(`Unexpected cause attack: ${attack}`);
      }
      parameters[3] = canonicalJson(cause);
      changed = true;
    }
    if (
      sql.startsWith(
        'INSERT INTO whaleu_ratings.category_icon_release_manifests(',
      ) &&
      attack.startsWith('extent-')
    ) {
      assert.ok(parameters);
      let extent = JSON.parse(String(parameters[6])) as ScopeExtent[];
      const global = extent.find((scope) => scope.scopeKey === 'global')!;
      const campus = extent.find(
        (scope) => scope.scopeKey === `campus:${f.campusA}`,
      )!;
      assert.equal(global.adopted, false);
      assert.equal(campus.adopted, true);
      switch (attack) {
        case 'extent-omitted-scope':
          extent = extent.filter((scope) => scope.scopeKey !== 'global');
          break;
        case 'extent-duplicate-scope':
          extent.push({ ...global });
          break;
        case 'extent-adopt-unmarked':
          global.adopted = true;
          break;
        case 'extent-drop-adopted':
          campus.adopted = false;
          break;
        case 'extent-before-adopted':
          global.beforeAdopted = true;
          break;
        case 'extent-before-catalog':
          global.beforeCatalogId = campus.beforeCatalogId;
          break;
        case 'extent-before-revision':
          global.beforeHeadRevision = campus.beforeHeadRevision;
          break;
        case 'extent-before-release':
          global.beforeReleaseId = randomUUID();
          break;
        default:
          assert.fail(`Unexpected extent attack: ${attack}`);
      }
      parameters[6] = canonicalJson(extent);
      changed = true;
    }
    return query(sql, parameters);
  }) as typeof tx.query;
  try {
    const result = await f.publish({}, tx);
    assert.equal(
      changed,
      true,
      'The hostile value must reach the actual INSERT',
    );
    return result;
  } finally {
    tx.query = query;
  }
}

test(
  'Mixed release exact named SQL boundaries reject extent, adoption-set and predecessor forgeries atomically',
  { timeout: 360000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], {
      runtime: false,
      iconGlobal: false,
    });
    t.after(() => f.close());
    await createGlobalText(f);
    const campus = await createCampusAbsence(f);
    // A legitimate original scope move leaves B adopted but empty. Dropping B
    // must therefore reach the final set seal, not an earlier projection guard.
    await f.execute(
      f.intent(
        await f.context({ kind: 'campus', campusId: f.campusA }),
        'set_category_scope_scoped',
        {
          categoryId: campus.receipt.result.categoryIds[0]!,
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          propagation: 'self',
        },
      ),
    );
    assert.deepEqual(
      (await heads(f)).filter(isAdopted).map((head) => head.scopeKey),
      campusKeys(f),
    );
    const exactRows = await currentIconRows(f);
    assert.equal(exactRows.length, 1);
    assert.equal(exactRows[0]!.scope_key, `campus:${f.campusA}`);
    const baseline = await heads(f);
    const valid = await f.publish();
    await assertMixedRelease(f, valid.releaseId, baseline, exactRows);
    const before = await publicationState(f);
    const boundaries = [
      'whaleu_ratings.scoped_catalog_causal',
      'whaleu_ratings.category_icon_release_row_causal',
      'whaleu_ratings.category_icon_final_generation',
    ] as const;
    for (const [index, attack] of attacks.entries()) {
      // Each named boundary is exercised repeatedly; assertions cannot be
      // satisfied by immediate SQL guards, HTTP closure or application proofs.
      const boundary = boundaries[index % boundaries.length]!;
      await t.test(`${attack} at ${boundary}`, async () => {
        let publicationCompleted = false;
        let namedBoundaryReached = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            const published = await adversarialPublish(f, tx, attack);
            publicationCompleted = true;
            assert.equal(
              (
                await tx.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.scoped_release_scopes WHERE release_id=$1',
                  [published.releaseId],
                )
              ).rows[0]!.n,
              f.scopeKeys.length,
              'Every original affected scope is staged before the exact final rejection',
            );
            namedBoundaryReached = true;
            await tx.query(`SET CONSTRAINTS ${boundary} IMMEDIATE`);
            assert.fail(`Named boundary accepted ${attack}`);
          }),
          (error: unknown) =>
            publicationCompleted &&
            namedBoundaryReached &&
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514' &&
            'message' in error &&
            error.message ===
              (boundary === 'whaleu_ratings.category_icon_release_row_causal'
                ? 'Category icon manifest lacks its exact immutable release payload'
                : 'Category icon full same-release seal mismatch'),
          `${attack} must fail at ${boundary}, after the complete real publication`,
        );
        assert.equal(publicationCompleted, true);
        assert.equal(namedBoundaryReached, true);
        assert.deepEqual(
          await publicationState(f),
          before,
          'Every source, original/compat catalog, head, request and icon/Media artifact rolls back together',
        );
      });
    }
    const afterAttacks = await heads(f);
    const recovered = await f.publish();
    await assertMixedRelease(f, recovered.releaseId, afterAttacks, exactRows);
  },
);
