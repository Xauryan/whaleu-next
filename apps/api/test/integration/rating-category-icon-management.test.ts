/** STATIC acceptance source. Run only under the parent's exclusive disposable
 * PostgreSQL lease. All approval/storage facts are closed synthetic fixtures;
 * commands, source issuance, compilation, release seals and guards are real. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  categoryIconManagementFixture,
  categoryIconHttpOk,
  issueEmptyCategoryIconCapabilities,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  categoryIconTextHash,
  ratingCategoryIconIntentHash,
  ratingCategoryIconReceiptSchema,
  ratingCategoryIconUploadScopeResultSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import type { CategoryIconMediaDescriptor } from '../../src/media/contracts-category-icon.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';

const globalSelector = { kind: 'global' } as const;
const node = (key = 'root') => ({
  key,
  parentKey: null,
  name: `Synthetic icon category ${key}`,
  description: 'Exact synthetic category body',
  icon: { mode: 'clear' as const },
});
async function createIntent(
  f: CategoryIconManagementFixture,
  selector: RatingNavigationSelector = globalSelector,
  count = 1,
  campusIds?: string[],
) {
  return f.intent(await f.context(selector), 'create_categories_scoped', {
    parentId: null,
    placement: campusIds
      ? { kind: 'campuses', campusIds: [...campusIds].sort() }
      : { kind: 'global' },
    nodes: Array.from({ length: count }, (_, index) => ({
      ...node(index === 0 ? 'root' : `node_${index}`),
      parentKey: index === 0 ? null : 'root',
    })),
  });
}
async function images() {
  const sharp = (await import('sharp')).default;
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#235c81' },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp({
    create: { width: 72, height: 52, channels: 3, background: '#a56231' },
  })
    .jpeg()
    .toBuffer();
  return {
    png,
    jpeg,
    fixtures: [
      { sha256: sha256(png), verdict: 'allow' as const },
      { sha256: sha256(jpeg), verdict: 'allow' as const },
    ],
  };
}
function imageGet(
  f: CategoryIconManagementFixture,
  icon: CategoryIconMediaDescriptor,
) {
  return f
    .auth(
      request(f.http).get(
        `/v3/media/ratings-category-icon/categories/${icon.categoryId}/appearances/${icon.appearanceId}/display-v1`,
      ),
    )
    .query({ contextId: icon.contextId, contextToken: icon.contextToken });
}
async function publicIcon(
  f: CategoryIconManagementFixture,
  id: string,
  selector: RatingNavigationSelector = globalSelector,
) {
  const page = await f.publicPage(selector);
  const category = page.page.items.find((item) => item.id === id);
  assert.ok(category, 'The complete current Category DTO must exist');
  return category.icon;
}
async function activeBindings(
  f: CategoryIconManagementFixture,
  categoryId: string,
) {
  return (
    await f.pool.query<{
      id: string;
      asset_id: string;
      media_binding_id: string;
      detached_at: Date | null;
    }>(
      `SELECT a.id,a.asset_id,a.media_binding_id,b.detached_at FROM whaleu_ratings.category_icon_appearances a
      JOIN whaleu_media.bindings b ON b.id=a.media_binding_id WHERE a.category_id=$1 ORDER BY a.id`,
      [categoryId],
    )
  ).rows;
}
async function assertNoTerminal(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
) {
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
        [f.admin.accountId, input.payload.clientRequestId],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
        [f.admin.accountId, input.payload.clientRequestId],
      )
    ).rowCount,
    0,
  );
}

test(
  'Category icon capability is explicit on a genuinely empty original adoption; Media remains unavailable by default',
  { timeout: 180000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], {
      runtime: false,
      capabilities: false,
    });
    t.after(() => f.close());
    const denied = await f.post('contexts', { selector: globalSelector });
    assert.equal(denied.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_capability_sources',
        )
      ).rowCount,
      0,
    );
    await issueEmptyCategoryIconCapabilities(f.pool);
    const c = await f.context();
    assert.deepEqual(c.capabilities, ['category_icon']);
    assert.equal(c.protocolVersion, 5);
    assert.deepEqual((await f.list()).page.items, []);
    const capabilities = (
      await f.pool
        .query(`SELECT protocol_version,review_version,media_version,journal_version,
      extension_version,slots,coverage_inventory FROM whaleu_ratings.category_icon_capability_sources`)
    ).rows;
    assert.equal(capabilities.length, f.logicalScopeKeys.length);
    for (const row of capabilities)
      assert.deepEqual(row, {
        protocol_version: 5,
        review_version: 8,
        media_version: 8,
        journal_version: 13,
        extension_version: 'ratings-category-icon-v1',
        slots: ['icon'],
        coverage_inventory: [],
      });
    const input = await createIntent(f);
    const bytes = Buffer.from('synthetic declaration only; no ready asset');
    const scopeInput = f.scopeInput(input, { kind: 'new', key: 'root' }, bytes);
    const scoped = await f.post('upload-scopes', scopeInput);
    categoryIconHttpOk(scoped);
    const scope = ratingCategoryIconUploadScopeResultSchema.parse(scoped.body);
    const response = await f
      .auth(
        request(f.http).post('/v3/media/ratings-category-icon/upload-scopes'),
      )
      .send({
        protocol: 'ratings-category-icon-media-v1',
        clientRequestId: scopeInput.clientRequestId,
        editScopeId: scope.editScopeId,
        scopeRevision: scope.scopeRevision,
        slot: 'icon',
        declaration: scopeInput.declaration,
      });
    assert.equal(response.body.error.code, 'MEDIA_UNAVAILABLE');
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_media.assets')).rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_media.upload_intents'))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_appearances',
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'Category icon protocol5 creates 32 exact explicit-absence slots through original Review5 plus composite Review8',
  { timeout: 300000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    const input = await createIntent(f, globalSelector, 32);
    const prepared = await f.prepare(input);
    assert.equal(prepared.categoryIds.length, 32);
    assert.equal(prepared.changedIconCount, 32);
    assert.ok(
      prepared.iconChanges.every(
        (change) =>
          change.before.state === 'unavailable' &&
          change.after.state === 'absent',
      ),
    );
    assert.deepEqual((await f.post('prepare', input)).body, prepared);
    const persisted = await f.stored(input);
    assert.equal(persisted.outer_hash, ratingCategoryIconIntentHash(input));
    assert.equal(persisted.text_hash, categoryIconTextHash(input));
    assert.notEqual(persisted.outer_hash, persisted.text_hash);
    assert.equal(persisted.category_plan.envelopes.length, 32);
    assert.equal(persisted.media_plan.reviewEnvelopes.length, 32);
    assert.equal(persisted.media_plan.plan.newAppearances.length, 0);
    assert.ok(
      persisted.media_plan.reviewEnvelopes.every(
        (envelope) =>
          envelope.version === 8 &&
          envelope.assetIds.length === 0 &&
          envelope.content.icon.kind === 'absent',
      ),
    );
    assert.equal(
      (await f.commit(input, prepared.contextRevision)).body.error.code,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    await assertNoTerminal(f, input);
    // Even exact composite approval cannot replace the frozen source owner's Review5.
    await f.approveIcons(input);
    assert.equal(
      (await f.commit(input, prepared.contextRevision)).body.error.code,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    await assertNoTerminal(f, input);
    const text = await f.approveText(input);
    assert.equal(text.length, 32);
    const committed = await f.commit(input, prepared.contextRevision);
    categoryIconHttpOk(committed);
    const receipt = ratingCategoryIconReceiptSchema.parse(committed.body);
    if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
    assert.equal(receipt.result.categoryIds.length, 32);
    assert.ok(receipt.result.releaseId && receipt.result.mediaReleaseDigest);
    assert.deepEqual(
      (await f.post('prepare', input)).body,
      receipt,
      'Receipt recovery precedes the now-stale context',
    );
    assert.deepEqual(
      (await f.commit(input, prepared.contextRevision)).body,
      receipt,
    );
    const recovered = await f.auth(
      request(f.http).get(
        `/v5/ratings/requests/${input.payload.clientRequestId}`,
      ),
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(recovered.body, receipt);
    assert.doesNotMatch(
      JSON.stringify(recovered.body),
      /"(?:descriptor|contextToken|manifest|url|bucket)"/,
    );
    const rows = (
      await f.pool.query(
        `SELECT p.category_id,p.appearance_id,p.projection->'content'->'icon' icon,
      p.release_id,c.release_id original_release,b.envelope->>'version' review_version
      FROM whaleu_ratings.category_icon_projections p JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
      JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id WHERE p.release_id=$1`,
        [receipt.result.releaseId],
      )
    ).rows;
    assert.equal(rows.length, 32);
    for (const row of rows) {
      assert.equal(row.release_id, row.original_release);
      assert.equal(row.appearance_id, null);
      assert.equal(row.icon.kind, 'absent');
      assert.match(row.icon.evidenceDigest, /^[a-f0-9]{64}$/);
      assert.equal(row.review_version, '8');
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings',
        )
      ).rowCount,
      32,
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_media.bindings')).rowCount,
      0,
    );
    const page = await f.publicPage();
    assert.equal(page.page.items.length, 1);
    const children = await f.publicPage(
      globalSelector,
      f.admin,
      page.page.items[0]!.id,
    );
    assert.equal(children.page.items.length, 31);
    assert.ok(
      [...page.page.items, ...children.page.items].every(
        (category) => category.icon === null,
      ),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2 AND intent_hash=$3',
          [
            f.admin.accountId,
            input.payload.clientRequestId,
            persisted.outer_hash,
          ],
        )
      ).rowCount,
      1,
    );
    if (input.operation !== 'create_categories_scoped') assert.fail();
    const changedImage = {
      ...input,
      payload: {
        ...input.payload,
        nodes: input.payload.nodes.map((n, index) =>
          index === 0
            ? {
                ...n,
                icon: {
                  mode: 'replace',
                  assetId: randomUUID(),
                  uploadScopeId: randomUUID(),
                },
              }
            : n,
        ),
      },
    };
    assert.equal(
      (await f.post('prepare', changedImage)).body.error.code,
      'REQUEST_CONFLICT',
    );
  },
);

test(
  'Category single image, source-only keep, campus inherit/null/image, dormant retention and archive/restore use exact owner releases',
  { timeout: 360000 },
  async (t) => {
    const { png, jpeg, fixtures } = await images();
    const f = await categoryIconManagementFixture(fixtures, {
      iconGlobal: false,
    });
    t.after(() => f.close());
    const a = { kind: 'campus', campusId: f.campusA } as const;
    const b = { kind: 'campus', campusId: f.campusB } as const;
    const upload = await f.ready(
      await createIntent(f, a, 1, [f.campusA, f.campusB]),
      { kind: 'new', key: 'root' },
      png,
    );
    const created = await f.execute(upload.input);
    assert.equal(created.receipt.outcome, 'applied');
    const id = created.receipt.result.categoryIds[0]!;
    assert.equal(id, upload.scope.categoryId);
    const initial = await publicIcon(f, id, a);
    assert.ok(initial);
    assert.equal(
      (await publicIcon(f, id, b))?.appearanceId,
      initial.appearanceId,
    );
    await t.test(
      'another original publisher carries the complete exact icon extension on its new release',
      async () => {
        const prior = created.receipt.result.releaseId;
        const republished = await f.publish();
        const manifest = (
          await f.pool.query(
            'SELECT scope_extent FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1',
            [republished.releaseId],
          )
        ).rows[0]!;
        const excluded = manifest.scope_extent.find(
          (row: { scopeKey: string }) => row.scopeKey === 'global',
        );
        assert.equal(excluded.adopted, false);
        assert.equal(excluded.beforeAdopted, false);
        assert.ok(
          excluded.beforeCatalogId &&
            excluded.beforeHeadRevision &&
            excluded.beforeReleaseId,
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.category_icon_capability_sources a JOIN whaleu_ratings.scope_protocol_versions v ON v.id=a.protocol_version_id WHERE v.logical_scope_key='global'`,
            )
          ).rows[0]!.n,
          0,
          'Unadopted global requires no Category capability',
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.category_icon_projections WHERE release_id=$1 AND projection->>'scopeKey'='global'`,
              [republished.releaseId],
            )
          ).rows[0]!.n,
          0,
        );

        const carried = await publicIcon(f, id, a);
        assert.ok(carried);
        assert.equal(carried.appearanceId, initial.appearanceId);
        assert.notEqual(republished.releaseId, prior);
        assert.equal(
          (
            await f.pool.query(
              `SELECT appearance_id FROM whaleu_ratings.category_icon_projections WHERE release_id=$1 AND category_id=$2 AND projection->>'scopeKey'=$3`,
              [republished.releaseId, id, `campus:${f.campusA}`],
            )
          ).rows[0]!.appearance_id,
          initial.appearanceId,
        );
        categoryIconHttpOk(await imageGet(f, carried));
      },
    );
    const delivered = await imageGet(f, (await publicIcon(f, id, a))!);
    categoryIconHttpOk(delivered);
    assert.equal(delivered.headers['cache-control'], 'private, no-store');
    assert.equal(delivered.headers['accept-ranges'], 'none');
    assert.ok(Buffer.isBuffer(delivered.body));
    const beforeBindings = await activeBindings(f, id);
    assert.equal(beforeBindings.length, 1);
    assert.equal(beforeBindings[0]!.detached_at, null);
    const media = (
      await f.pool.query(
        `SELECT i.protocol_version,a.resource_kind,a.slot,a.ordinal
      FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1`,
        [upload.status.assetId],
      )
    ).rows[0]!;
    assert.deepEqual(media, {
      protocol_version: 8,
      resource_kind: 'category_icon',
      slot: 'icon',
      ordinal: 0,
    });

    await t.test(
      'source-only keep preserves appearance and requires a new composite Review8',
      async () => {
        const edit = f.intent(await f.context(a), 'edit_category_base_scoped', {
          categoryId: id,
          name: 'Changed exact source body',
          description: 'Same immutable appearance',
          icon: { mode: 'keep' },
        });
        const prepared = await f.prepare(edit);
        assert.equal(prepared.changedIconCount, 0);
        const stored = await f.stored(edit);
        assert.equal(stored.media_plan.plan.newAppearances.length, 0);
        assert.equal(stored.media_plan.reviewEnvelopes.length, 2);
        assert.ok(
          stored.media_plan.reviewEnvelopes.every(
            (envelope) =>
              envelope.content.icon.kind === 'image' &&
              envelope.content.icon.appearance.appearanceId ===
                initial.appearanceId &&
              envelope.content.name === 'Changed exact source body' &&
              !created.icons.some(
                (prior) =>
                  prior.envelope.definitionId === envelope.definitionId,
              ),
          ),
        );
        await f.approveText(edit);
        assert.equal(
          (await f.commit(edit, prepared.contextRevision)).body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
        );
        await assertNoTerminal(f, edit);
        await f.approveIcons(edit);
        categoryIconHttpOk(await f.commit(edit, prepared.contextRevision));
        assert.deepEqual(await activeBindings(f, id), beforeBindings);
        assert.equal(
          (await publicIcon(f, id, a))?.appearanceId,
          initial.appearanceId,
        );
        assert.notEqual(
          (await imageGet(f, initial)).status,
          200,
          'Old descriptor cannot silently acquire the new source/release',
        );
        const oldReceipt = await f.commit(
          upload.input,
          created.prepared.contextRevision,
        );
        categoryIconHttpOk(oldReceipt);
        assert.deepEqual(oldReceipt.body, created.receipt);
      },
    );

    let overrideAppearance = '';
    await t.test(
      'campus explicit null, inherit and image remain three distinct states',
      async () => {
        const override = async (icon: unknown) =>
          f.intent(await f.context(b), 'set_category_override_scoped', {
            categoryId: id,
            name: { mode: 'inherit' },
            description: { mode: 'inherit' },
            icon,
          });
        const absent = await f.execute(
          await override({ mode: 'set', value: null }),
        );
        assert.equal(absent.receipt.outcome, 'applied');
        assert.equal(await publicIcon(f, id, b), null);
        assert.equal(
          (await publicIcon(f, id, a))?.appearanceId,
          initial.appearanceId,
        );
        const managed = await f.detail(id, b);
        assert.equal(managed.icon.override.mode, 'set');
        assert.equal(managed.icon.override.state.state, 'absent');
        await f.execute(await override({ mode: 'inherit' }));
        assert.equal(
          (await publicIcon(f, id, b))?.appearanceId,
          initial.appearanceId,
        );
        const inherited = await f.detail(id, b);
        assert.equal(inherited.icon.override.mode, 'inherit');
        assert.equal(inherited.icon.override.state.state, 'inherit');
        const replacement = await f.ready(
          await override({ mode: 'set', value: null }),
          { kind: 'override', categoryId: id, campusId: f.campusB },
          jpeg,
          'image/jpeg',
        );
        const replaced = await f.execute(replacement.input);
        assert.equal(replaced.receipt.outcome, 'applied');
        const current = await publicIcon(f, id, b);
        assert.ok(current);
        overrideAppearance = current.appearanceId;
        assert.notEqual(overrideAppearance, initial.appearanceId);
        assert.equal(
          (await publicIcon(f, id, a))?.appearanceId,
          initial.appearanceId,
        );
        assert.equal((await activeBindings(f, id)).length, 2);
        const before = await f.artifacts();
        const retry = await f.commit(
          replacement.input,
          replaced.prepared.contextRevision,
        );
        categoryIconHttpOk(retry);
        assert.deepEqual(retry.body, replaced.receipt);
        assert.deepEqual(
          await f.artifacts(),
          before,
          'Receipt replay must not mint or bind a second appearance',
        );
        if (replacement.input.operation !== 'set_category_override_scoped')
          assert.fail();
        const changed = {
          ...replacement.input,
          payload: {
            ...replacement.input.payload,
            icon: {
              mode: 'set',
              value: {
                mode: 'replace',
                assetId: upload.status.assetId,
                uploadScopeId: upload.scope.editScopeId,
              },
            },
          },
        };
        assert.equal(
          (await f.post('prepare', changed)).body.error.code,
          'REQUEST_CONFLICT',
        );
      },
    );

    await t.test(
      'removed campus retains its dormant override and restore reuses the same image',
      async () => {
        assert.ok(overrideAppearance, 'Previous campus image must exist');
        const before = await activeBindings(f, id);
        const move = (campusIds: string[]) => ({
          categoryId: id,
          placement: { kind: 'campuses', campusIds: [...campusIds].sort() },
          propagation: 'self',
        });
        await f.execute(
          f.intent(
            await f.context(a),
            'set_category_scope_scoped',
            move([f.campusA]),
          ),
        );
        const dormant = (
          await f.pool.query<{ retention: string; appearance_id: string }>(
            `SELECT h.retention,d.appearance_id FROM whaleu_ratings.category_icon_definition_heads h
          JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id
          WHERE d.category_id=$1 AND d.kind='override' AND d.campus_id=$2`,
            [id, f.campusB],
          )
        ).rows;
        assert.equal(dormant.length, 1);
        assert.deepEqual(dormant[0], {
          retention: 'dormant',
          appearance_id: overrideAppearance,
        });
        assert.deepEqual(await activeBindings(f, id), before);
        assert.ok(
          !(await f.publicPage(b)).page.items.some((item) => item.id === id),
        );
        await f.execute(
          f.intent(
            await f.context(a),
            'set_category_scope_scoped',
            move([f.campusA, f.campusB]),
          ),
        );
        assert.equal(
          (await publicIcon(f, id, b))?.appearanceId,
          overrideAppearance,
        );
        assert.deepEqual(await activeBindings(f, id), before);
      },
    );

    await t.test(
      'archive and restore preserve recoverable roots, bindings and content Review',
      async () => {
        const before = await activeBindings(f, id);
        const definitions = (
          await f.pool.query(
            `SELECT id,value,definition_digest FROM whaleu_ratings.category_icon_definitions WHERE category_id=$1 ORDER BY id`,
            [id],
          )
        ).rows;
        const reviewCount = (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_ratings.category_icon_review_bindings`,
          )
        ).rows[0]!.n;
        for (const [state, restore] of [
          ['disabled', false],
          ['archived', false],
          ['disabled', true],
          ['enabled', false],
        ] as const) {
          const changed = await f.execute(
            f.intent(await f.context(a), 'set_category_lifecycle_scoped', {
              categoryId: id,
              state,
              restore,
            }),
          );
          assert.equal(
            changed.icons.length,
            0,
            'Visibility/lifecycle metadata is not a new body or image definition',
          );
          assert.deepEqual(await activeBindings(f, id), before);
          assert.equal((await f.detail(id, a)).businessState, state);
          assert.equal(
            (await f.publicPage(a)).page.items.some((item) => item.id === id),
            state === 'enabled',
          );
        }
        assert.deepEqual(
          (
            await f.pool.query(
              `SELECT id,value,definition_digest FROM whaleu_ratings.category_icon_definitions WHERE category_id=$1 ORDER BY id`,
              [id],
            )
          ).rows,
          definitions,
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.category_icon_review_bindings`,
            )
          ).rows[0]!.n,
          reviewCount,
        );
        assert.equal(
          (await publicIcon(f, id, b))?.appearanceId,
          overrideAppearance,
        );
      },
    );
  },
);

test(
  'Category held-image clear repair and hostile SQL preserve exact causal closure',
  { timeout: 300000 },
  async (t) => {
    const { png, fixtures } = await images();
    const f = await categoryIconManagementFixture(fixtures);
    t.after(() => f.close());
    const upload = await f.ready(
      await createIntent(f),
      { kind: 'new', key: 'root' },
      png,
    );
    const created = await f.execute(upload.input);
    const id = created.receipt.result.categoryIds[0]!;
    const icon = await publicIcon(f, id);
    assert.ok(icon);
    const definition = (
      await f.pool.query<{ id: string; root_key: string }>(
        `SELECT d.id,h.root_key
    FROM whaleu_ratings.category_icon_definitions d JOIN whaleu_ratings.category_icon_definition_heads h ON h.definition_id=d.id
    WHERE d.category_id=$1 AND d.kind='base'`,
        [id],
      )
    ).rows[0]!;

    await t.test(
      'raw SQL cannot relabel assets, replace sealed content or move a root without an outer command',
      async () => {
        await f.rejectSql('immutable appearance identity', (tx) =>
          tx.query(
            'UPDATE whaleu_ratings.category_icon_appearances SET manifest_digest=$2 WHERE id=$1',
            [icon.appearanceId, 'f'.repeat(64)],
          ),
        );
        await f.rejectSql('immutable composite review envelope', (tx) =>
          tx.query(
            `UPDATE whaleu_ratings.category_icon_review_bindings SET envelope=jsonb_set(envelope,'{content,name}','"Unreviewed replacement"') WHERE account_id=$1`,
            [f.admin.accountId],
          ),
        );
        await f.rejectSql('sealed same-release Category projection', (tx) =>
          tx.query(
            `UPDATE whaleu_ratings.category_icon_projections SET projection=jsonb_set(projection,'{content,icon,appearance,assetId}',to_jsonb($2::text)) WHERE category_id=$1`,
            [id, randomUUID()],
          ),
        );
        await f.rejectSql('uncaused retention change', (tx) =>
          tx.query(
            `UPDATE whaleu_ratings.category_icon_definition_heads SET retention='dormant',mutation_transaction=pg_current_xact_id() WHERE root_key=$1`,
            [definition.root_key],
          ),
        );
        await f.rejectSql('uncaused root deletion', (tx) =>
          tx.query(
            'DELETE FROM whaleu_ratings.category_icon_definition_heads WHERE root_key=$1',
            [definition.root_key],
          ),
        );
        await f.rejectSql('live immutable definition cannot disappear', (tx) =>
          tx.query(
            'DELETE FROM whaleu_ratings.category_icon_definitions WHERE id=$1',
            [definition.id],
          ),
        );
        await f.rejectSql(
          'reachable image cannot acquire a fabricated terminal retirement',
          (tx) =>
            tx.query(
              `INSERT INTO whaleu_ratings.category_icon_terminal_retirements
        (appearance_id,asset_id,binding_id,actor_id,manifest_digest,closure_revision,causing_actor_id,causing_request_id)
        SELECT id,asset_id,media_binding_id,actor_id,manifest_digest,$2,actor_id,$3
        FROM whaleu_ratings.category_icon_appearances WHERE id=$1`,
              [
                icon.appearanceId,
                'a'.repeat(64),
                upload.input.payload.clientRequestId,
              ],
            ),
        );
        categoryIconHttpOk(await imageGet(f, icon));
      },
    );

    await t.test(
      'an unsafe image gates the complete public definition; explicit clear repairs without fetching old bytes',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const row = (
            await tx.query<{
              revision: string;
              manifest_digest: string;
              policy_revision: string;
            }>(
              `SELECT h.revision::text,a.manifest_digest,a.policy_revision FROM whaleu_media.assets a
          JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$1 FOR UPDATE OF a,h`,
              [upload.status.assetId],
            )
          ).rows[0]!;
          const event = randomUUID(),
            revision = String(BigInt(row.revision) + 1n);
          await tx.query(
            `INSERT INTO whaleu_media.asset_safety_events
        (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        VALUES($1::uuid,$2,$3,'held',$4,$5,'synthetic-category-icon-hold',$1::uuid::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
            [
              event,
              upload.status.assetId,
              revision,
              row.manifest_digest,
              row.policy_revision,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [upload.status.assetId, revision, event],
          );
        });
        assert.notEqual((await imageGet(f, icon)).status, 200);
        const publicContext = await f
          .auth(request(f.http).post('/v5/ratings/contexts'))
          .send({ selector: globalSelector, purpose: 'read', mode: 'public' });
        categoryIconHttpOk(publicContext);
        const read = await f
          .auth(request(f.http).get(`/v5/ratings/categories/${id}`))
          .query({
            contextId: publicContext.body.id,
            contextToken: publicContext.body.token,
          });
        assert.notEqual(
          read.status,
          200,
          'Held must never become an apparently complete text-only Category',
        );
        const current = await f.detail(id);
        const repaired = await f.execute(
          f.intent(await f.context(), 'edit_category_base_scoped', {
            categoryId: id,
            name: current.baseName,
            description: current.baseDescription,
            icon: { mode: 'clear' },
          }),
        );
        assert.equal(repaired.receipt.outcome, 'applied');
        assert.equal(repaired.prepared.changedIconCount, 1);
        assert.equal(
          repaired.text.length,
          0,
          'Image-only repair does not replace the existing exact text source',
        );
        assert.equal(repaired.icons.length, 1);
        assert.equal(repaired.icons[0]!.envelope.content.icon.kind, 'absent');
        assert.equal(await publicIcon(f, id), null);
        const retained = await activeBindings(f, id);
        assert.equal(
          retained.length,
          1,
          'Repair retains immutable appearance history',
        );
        assert.notEqual((await imageGet(f, icon)).status, 200);
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.category_icon_definition_heads h
      JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id WHERE d.category_id=$1 AND d.appearance_id=$2`,
              [id, icon.appearanceId],
            )
          ).rows[0]!.n,
          0,
        );
      },
    );
  },
);

test(
  'Category 32-node tree publishes a distinct single icon per node in one original atomic release',
  { timeout: 300000 },
  async (t) => {
    const { png, fixtures } = await images();
    const f = await categoryIconManagementFixture(fixtures);
    t.after(() => f.close());
    let input = await createIntent(f, globalSelector, 32);
    const originalContext = structuredClone(input.context);
    const originalTextHash = categoryIconTextHash(input);
    const assets: string[] = [],
      scopes: string[] = [];
    let batchStarted = Date.now();
    for (let index = 0; index < 32; index++) {
      // Respect the unchanged shared Media 10/minute fence. No clock rewrite,
      // new context, upload-key replacement or rolling scope renewal is used.
      if (index > 0 && index % 10 === 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, 61000 - (Date.now() - batchStarted))),
        );
        batchStarted = Date.now();
      }
      const uploaded = await f.ready(
        input,
        { kind: 'new', key: index === 0 ? 'root' : `node_${index}` },
        png,
      );
      input = uploaded.input;
      assert.deepEqual(input.context, originalContext);
      assert.equal(categoryIconTextHash(input), originalTextHash);
      assert.ok(Date.parse(uploaded.scope.expiresAt) > Date.now());
      assets.push(uploaded.status.assetId);
      scopes.push(uploaded.scope.editScopeId);
    }
    assert.equal(new Set(assets).size, 32);
    assert.equal(new Set(scopes).size, 32);
    const originalDrafts = (
      await f.pool.query(
        `SELECT count(DISTINCT input->>'draftRevision')::int drafts,count(DISTINCT context_id)::int contexts FROM whaleu_ratings.category_icon_upload_scopes WHERE id=ANY($1::uuid[])`,
        [scopes],
      )
    ).rows[0]!;
    assert.deepEqual(originalDrafts, { drafts: 1, contexts: 1 });
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.category_icon_appearances',
        )
      ).rows[0]!.n,
      0,
      'Uploads never publish a partial tree',
    );
    const published = await f.execute(input);
    assert.equal(published.receipt.outcome, 'applied');
    assert.equal(published.receipt.result.categoryIds.length, 32);
    assert.equal(published.text.length, 32);
    assert.equal(published.icons.length, 32);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.category_icon_appearances',
        )
      ).rows[0]!.n,
      32,
    );
    const rows = (
      await f.pool.query<{
        release_id: string;
        asset_id: string;
        appearance_id: string;
      }>(
        `SELECT p.release_id,a.asset_id,p.appearance_id
    FROM whaleu_ratings.category_icon_projections p JOIN whaleu_ratings.category_icon_appearances a ON a.id=p.appearance_id WHERE p.release_id=$1`,
        [published.receipt.result.releaseId],
      )
    ).rows;
    assert.equal(rows.length, 32);
    assert.deepEqual(rows.map((row) => row.asset_id).sort(), assets.sort());
    assert.equal(new Set(rows.map((row) => row.appearance_id)).size, 32);
    const repeat = await f.commit(input, published.prepared.contextRevision);
    categoryIconHttpOk(repeat);
    assert.deepEqual(repeat.body, published.receipt);
  },
);

test(
  'Category system creation and atomic child batch retain per-node icons across visibility, ordering and scope operations',
  { timeout: 180000 },
  async (t) => {
    const { png, fixtures } = await images();
    const f = await categoryIconManagementFixture(fixtures, {
      systemRegistry: true,
    });
    t.after(() => f.close());
    const selector = { kind: 'campus', campusId: f.campusA } as const;
    const placement = {
      kind: 'campuses',
      campusIds: [f.campusA, f.campusB].sort(),
    } as const;
    const systemUpload = await f.ready(
      f.intent(await f.context(selector), 'create_system_category_scoped', {
        systemKey: 'synthetic_icon_general',
        name: 'System with exact icon',
        description: '',
        placement,
        levelCount: 3,
        icon: { mode: 'clear' },
      }),
      { kind: 'new', key: 'root' },
      png,
    );
    const system = await f.execute(systemUpload.input),
      parentId = system.receipt.result.categoryIds[0]!;
    await assertPublishedAsset(
      f,
      parentId,
      selector,
      systemUpload.status.assetId,
    );
    let batch = f.intent(
      await f.context(selector),
      'batch_update_subcategories_scoped',
      {
        parentId,
        addNodes: [node('first'), node('second')],
        disableIds: [],
        restoreIds: [],
        enableIds: [],
        orderedChildren: [
          { kind: 'new', key: 'first' },
          { kind: 'new', key: 'second' },
        ],
      },
    );
    const expected = new Map<string, string>();
    for (const key of ['first', 'second']) {
      const upload = await f.ready(batch, { kind: 'new', key }, png);
      batch = upload.input;
      expected.set(upload.scope.categoryId, upload.status.assetId);
    }
    const created = await f.execute(batch);
    assert.equal(created.receipt.result.categoryIds.length, 2);
    assert.equal(
      created.icons.length,
      2,
      'Each new child has exact composite review in its original selected-campus batch scope',
    );
    const ids = [...expected.keys()],
      before = await activeBindings(f, parentId);
    for (const [id, asset] of expected)
      await assertPublishedAsset(f, id, selector, asset);
    for (const hidden of [true, false]) {
      await f.execute(
        f.intent(await f.context(selector), 'set_category_visibility_scoped', {
          categoryId: ids[0]!,
          hidden,
        }),
      );
      assert.equal((await f.detail(ids[0]!, selector)).hidden, hidden);
    }
    await f.execute(
      f.intent(await f.context(selector), 'reorder_categories_scoped', {
        parentId,
        action: 'set',
        orderedIds: [...ids].reverse(),
      }),
    );
    for (const campusIds of [[f.campusA], [f.campusA, f.campusB].sort()]) {
      await f.execute(
        f.intent(await f.context(selector), 'set_category_scope_scoped', {
          categoryId: ids[0]!,
          placement: { kind: 'campuses', campusIds },
          propagation: 'self',
        }),
      );
      await assertPublishedAsset(f, ids[0]!, selector, expected.get(ids[0]!)!);
    }
    assert.deepEqual(await activeBindings(f, parentId), before);
    for (const [id, asset] of expected)
      await assertPublishedAsset(f, id, selector, asset);
  },
);

async function assertPublishedAsset(
  f: CategoryIconManagementFixture,
  id: string,
  selector: RatingNavigationSelector,
  assetId: string,
) {
  const detail = await f.detail(id, selector);
  const page = await f.publicPage(
    selector,
    f.admin,
    detail.parentId ?? undefined,
  );
  const icon = page.page.items.find((item) => item.id === id)?.icon;
  assert.ok(icon);
  const row = (
    await f.pool.query(
      'SELECT asset_id FROM whaleu_ratings.category_icon_appearances WHERE id=$1',
      [icon.appearanceId],
    )
  ).rows[0];
  assert.equal(row?.asset_id, assetId);
}
