/** Real HTTP / PostgreSQL recoverable-root regressions. Source-only until run
 * under the parent's exclusive disposable PostgreSQL lease. Synthetic Media
 * supplies bytes/verdicts; original Category, Review5/8 and SQL owners are real. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import type { RatingCategoryIconEnvelope } from '../../src/community/content-review/rating-category-icon-contracts.js';
import {
  categoryIconMediaDescriptorSchema,
  type CategoryIconMediaDescriptor,
} from '../../src/media/contracts-category-icon.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { ratingCategoryIconReceiptSchema } from '../../src/ratings/category-management/icon-contracts.js';
import {
  categoryIconDigest,
  type CategoryIconReleaseCoverage,
  type CategoryIconReleaseRow,
} from '../../src/ratings/category-management/icon-extension.js';
import type { CategoryIconRoot } from '../../src/ratings/category-management/icon-references.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const campus = (campusId: string) => ({ kind: 'campus' as const, campusId });
type Context = { contextId: string; contextToken: string };
type Manifest = {
  digest: string;
  row_count: number;
  root_snapshot: CategoryIconRoot[];
  scope_extent: unknown[];
  capabilities: unknown[];
  management_coverage: CategoryIconReleaseCoverage[];
  serialized_bytes: string;
};
function denied(response: { status: number; body: unknown }, label: string) {
  assert.ok(
    response.status >= 400,
    `${label}: ${JSON.stringify(response.body)}`,
  );
  assert.equal(
    typeof (response.body as { error?: { code?: unknown } }).error?.code,
    'string',
  );
  assert.equal(
    categoryIconMediaDescriptorSchema.safeParse(response.body).success,
    false,
  );
}
function mediaGet(
  f: CategoryIconManagementFixture,
  categoryId: string,
  appearanceId: string,
  context: Context,
  suffix: 'descriptor' | 'display-v1',
  purpose?: 'management-preview',
) {
  return f
    .auth(
      request(f.http).get(
        `/v3/media/ratings-category-icon/categories/${categoryId}/appearances/${appearanceId}/${suffix}`,
      ),
    )
    .query({ ...context, ...(purpose ? { purpose } : {}) });
}
function descriptorContext(icon: CategoryIconMediaDescriptor): Context {
  return { contextId: icon.contextId, contextToken: icon.contextToken };
}
async function preview(
  f: CategoryIconManagementFixture,
  categoryId: string,
  appearanceId: string,
  selector: RatingNavigationSelector,
) {
  const management = await f.context(selector);
  const context = {
    contextId: management.commandContext.id,
    contextToken: management.commandContext.token,
  };
  const response = await mediaGet(
    f,
    categoryId,
    appearanceId,
    context,
    'descriptor',
    'management-preview',
  );
  categoryIconHttpOk(response);
  const icon = categoryIconMediaDescriptorSchema.parse(response.body);
  assert.equal(icon.appearanceId, appearanceId);
  assert.deepEqual(descriptorContext(icon), context);
  const delivered = await mediaGet(
    f,
    categoryId,
    appearanceId,
    context,
    'display-v1',
    'management-preview',
  );
  categoryIconHttpOk(delivered);
  assert.ok(Buffer.isBuffer(delivered.body) && delivered.body.length > 0);
  assert.equal(delivered.headers['cache-control'], 'private, no-store');
  assert.equal(delivered.headers['accept-ranges'], 'none');
  return icon;
}
async function publicIcon(
  f: CategoryIconManagementFixture,
  categoryId: string,
  selector: RatingNavigationSelector,
) {
  const page = await f.publicPage(selector);
  const category = page.page.items.find((item) => item.id === categoryId);
  assert.ok(
    category?.icon,
    'The current public category must expose its exact override image',
  );
  return {
    category,
    icon: category.icon,
    context: {
      contextId: page.context.id,
      contextToken: page.context.token,
    },
  };
}
async function attachments(
  f: CategoryIconManagementFixture,
  categoryId: string,
) {
  return (
    await f.pool.query(
      `SELECT a.*,to_jsonb(b) binding FROM whaleu_ratings.category_icon_appearances a
     JOIN whaleu_media.bindings b ON b.id=a.media_binding_id
     WHERE a.category_id=$1 ORDER BY a.id`,
      [categoryId],
    )
  ).rows;
}
async function sealed(f: CategoryIconManagementFixture, releaseId: string) {
  const manifest = (
    await f.pool.query<Manifest>(
      'SELECT * FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1',
      [releaseId],
    )
  ).rows[0];
  assert.ok(manifest);
  const projections = (
    await f.pool.query<{ projection: CategoryIconReleaseRow }>(
      `SELECT projection FROM whaleu_ratings.category_icon_projections WHERE release_id=$1
     ORDER BY (projection->>'scopeKey') COLLATE "C",category_id`,
      [releaseId],
    )
  ).rows.map((row) => row.projection);
  assert.equal(manifest.row_count, projections.length);
  assert.equal(
    manifest.digest,
    categoryIconDigest('release', {
      extent: manifest.scope_extent,
      rows: projections.map((row) => row.digest),
      managementCoverage: manifest.management_coverage,
    }),
  );
  const bytes = Buffer.byteLength(
    canonicalJson({
      extent: manifest.scope_extent,
      roots: manifest.root_snapshot,
      capabilities: manifest.capabilities,
      rows: projections,
      managementCoverage: manifest.management_coverage,
    }),
    'utf8',
  );
  assert.equal(Number(manifest.serialized_bytes), bytes);
  assert.ok(
    bytes >
      Buffer.byteLength(
        canonicalJson({
          extent: manifest.scope_extent,
          roots: manifest.root_snapshot,
          capabilities: manifest.capabilities,
          rows: projections,
          managementCoverage: [],
        }),
        'utf8',
      ),
    'Recoverable-only coverage contributes to the same serialized-byte budget',
  );
  assert.ok(bytes <= 67108864);
  assert.equal(
    (
      await f.pool.query<{ valid: boolean }>(
        'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
        [releaseId],
      )
    ).rows[0]!.valid,
    true,
  );
  const pointers = (
    await f.pool.query<{
      root_definition_id: string;
      selector: RatingNavigationSelector;
      review_binding_id: string;
      envelope: RatingCategoryIconEnvelope;
    }>(
      `SELECT h.root_definition_id,h.selector,h.review_binding_id,b.envelope
     FROM whaleu_ratings.category_icon_management_review_heads h
     JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=h.review_binding_id
     WHERE h.root_definition_id=ANY($1::uuid[]) ORDER BY h.root_key`,
      [manifest.root_snapshot.map((root) => root.definitionId)],
    )
  ).rows;
  for (const item of manifest.management_coverage) {
    assert.equal(item.content.icon.kind, 'image');
    const exact = pointers.filter(
      (pointer) =>
        pointer.root_definition_id === item.content.icon.definitionId &&
        canonicalJson(pointer.selector) ===
          canonicalJson(item.content.selector),
    );
    assert.equal(
      exact.length,
      1,
      'Every recoverable root/selector has one exact management pointer',
    );
    assert.equal(exact[0]!.review_binding_id, item.review.id);
    assert.deepEqual(exact[0]!.envelope.content, item.content);
  }
  return { manifest, projections, pointers };
}
async function publicationState(f: CategoryIconManagementFixture) {
  const owner = (
    await f.pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM whaleu_ratings.scoped_source_attestations s),
    'sourceHeads',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY source_kind,source_key),'[]') FROM whaleu_ratings.scoped_source_heads s),
    'catalogs',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM whaleu_ratings.scoped_catalogs c),
    'catalogHeads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY scope_key),'[]') FROM whaleu_ratings.scoped_catalog_heads h),
    'catalogRows',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY catalog_id,category_id),'[]') FROM whaleu_ratings.scoped_categories c),
    'releases',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM whaleu_ratings.scoped_releases r),
    'releaseScopes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY release_id,scope_key),'[]') FROM whaleu_ratings.scoped_release_scopes s),
    'review',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_review_bindings b),
    'managementPointers',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY root_key),'[]') FROM whaleu_ratings.category_icon_management_review_heads h),
    'compatHeads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY to_jsonb(h)::text),'[]') FROM whaleu_ratings.compat_heads h),
    'compatCatalogs',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM whaleu_ratings.catalogs c),
    'compatRows',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text),'[]') FROM whaleu_ratings.categories c)
  ) state`)
  ).rows[0]!.state;
  return { owner, artifacts: await f.artifacts() };
}
async function reviewState(
  f: CategoryIconManagementFixture,
  bindingId: string,
  state: 'held' | 'allow',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const binding = (
      await tx.query<{ decision_id: string }>(
        'SELECT decision_id FROM whaleu_ratings.category_icon_review_bindings WHERE id=$1',
        [bindingId],
      )
    ).rows[0];
    assert.ok(binding);
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_events
       (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
       VALUES($1,$2,$3,'complete','accepted','synthetic-management-root-review','synthetic-exact-root-review-state',clock_timestamp())`,
      [eventId, binding.decision_id, state],
    );
    await tx.query(
      'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
      [binding.decision_id, eventId],
    );
  });
}

test(
  'Category hidden base and dormant override retain exact management Review without acquiring public placement',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const images = await Promise.all(
      ['#235c81', '#a56231', '#41885a'].map((background) =>
        sharp({ create: { width: 52, height: 44, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const f = await categoryIconManagementFixture(
      images.map((bytes) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    t.after(() => f.close());
    const a = campus(f.campusA),
      b = campus(f.campusB);
    const allKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const create = f.intent(await f.context(a), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'campuses', campusIds: [f.campusA, f.campusB].sort() },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Original direct base',
          description: 'Original inherited description',
          icon: { mode: 'clear' },
        },
      ],
    });
    const baseUpload = await f.ready(
      create,
      { kind: 'new', key: 'root' },
      images[0]!,
    );
    const created = await f.execute(baseUpload.input);
    const id = created.receipt.result.categoryIds[0]!;
    const baseAppearance = (await publicIcon(f, id, a)).icon.appearanceId;
    const appearances = new Map([
      [f.campusA, ''],
      [f.campusB, ''],
    ]);
    for (const [index, selector] of [a, b].entries()) {
      const input = f.intent(
        await f.context(selector),
        'set_category_override_scoped',
        {
          categoryId: id,
          name: {
            mode: 'set',
            value: `Exact override ${index === 0 ? 'A' : 'B'}`,
          },
          description: { mode: 'inherit' },
          icon: { mode: 'set', value: null },
        },
      );
      const uploaded = await f.ready(
        input,
        {
          kind: 'override',
          categoryId: id,
          campusId: selector.campusId,
        },
        images[index + 1]!,
      );
      await f.execute(uploaded.input);
      appearances.set(
        selector.campusId,
        (await publicIcon(f, id, selector)).icon.appearanceId,
      );
    }
    const originalAttachments = await attachments(f, id);
    assert.equal(originalAttachments.length, 3);
    assert.equal(
      new Set(originalAttachments.map((row) => row.asset_id)).size,
      3,
    );
    assert.ok(
      originalAttachments.every((row) => row.binding.detached_at === null),
    );

    await t.test(
      'a base hidden by every campus override is previewable only through its actual base selectors',
      async () => {
        // A genuine foreign publisher must carry both current public bodies and
        // every hidden direct-root proof; it cannot rebuild pointers from public rows.
        const published = await f.publish();
        const current = await sealed(f, published.releaseId);
        assert.equal(current.projections.length, 2);
        assert.equal(current.manifest.management_coverage.length, 4);
        const baseSlots = current.manifest.management_coverage.filter(
          (item) => item.content.icon.origin === 'base',
        );
        assert.deepEqual(
          baseSlots.map((item) => item.scopeKey).sort(),
          allKeys,
        );
        for (const slot of baseSlots) {
          assert.equal(slot.content.name, 'Original direct base');
          assert.equal(slot.content.overrideSource, null);
          assert.equal(slot.content.overrideDefinitionId, null);
        }
        for (const selector of [a, b]) {
          const managed = await f.detail(id, selector);
          assert.deepEqual(managed.icon.base, {
            state: 'image',
            appearanceId: baseAppearance,
          });
          assert.equal(
            managed.icon.effective.appearanceId,
            appearances.get(selector.campusId),
          );
          const directBase = await preview(f, id, baseAppearance, selector);
          const currentPublic = await publicIcon(f, id, selector);
          assert.equal(
            currentPublic.icon.appearanceId,
            appearances.get(selector.campusId),
          );
          categoryIconHttpOk(
            await mediaGet(
              f,
              id,
              currentPublic.icon.appearanceId,
              currentPublic.context,
              'display-v1',
            ),
          );
          denied(
            await mediaGet(
              f,
              id,
              baseAppearance,
              currentPublic.context,
              'descriptor',
            ),
            'Public override cannot expose the hidden base',
          );
          denied(
            await mediaGet(
              f,
              id,
              baseAppearance,
              descriptorContext(directBase),
              'display-v1',
            ),
            'Management context is not download authority',
          );
        }
        const globalContext = await f.context({ kind: 'global' });
        denied(
          await mediaGet(
            f,
            id,
            baseAppearance,
            {
              contextId: globalContext.commandContext.id,
              contextToken: globalContext.commandContext.token,
            },
            'descriptor',
            'management-preview',
          ),
          'A campus-only base cannot invent a global management slot',
        );
        assert.deepEqual(await attachments(f, id), originalAttachments);
      },
    );

    let dormantPreview: CategoryIconMediaDescriptor;
    let dormantBeforeEdit: CategoryIconReleaseCoverage;
    await t.test(
      'removed B keeps a management-only image root and full A+B recovery scope while public B denies it',
      async () => {
        const removed = await f.execute(
          f.intent(await f.context(a), 'set_category_scope_scoped', {
            categoryId: id,
            placement: { kind: 'campuses', campusIds: [f.campusA] },
            propagation: 'self',
          }),
        );
        assert.deepEqual(removed.prepared.affectedScopeKeys, allKeys);
        const current = await sealed(f, removed.receipt.result.releaseId!);
        assert.equal(current.manifest.management_coverage.length, 3);
        assert.equal(current.projections.length, 1);
        assert.equal(current.projections[0]!.scopeKey, `campus:${f.campusA}`);
        const dormant = current.manifest.root_snapshot.filter(
          (root) => root.kind === 'override' && root.campusId === f.campusB,
        );
        assert.equal(dormant.length, 1);
        assert.equal(dormant[0]!.retention, 'dormant');
        assert.equal(dormant[0]!.value.kind, 'image');
        dormantBeforeEdit = current.manifest.management_coverage.find(
          (item) => item.scopeKey === `campus:${f.campusB}`,
        )!;
        assert.ok(dormantBeforeEdit);
        assert.equal(dormantBeforeEdit.content.name, 'Exact override B');
        const authority = await f.context(b);
        assert.ok(
          [f.campusA, f.campusB].every((campusId) =>
            authority.campusIds.includes(campusId),
          ),
        );
        dormantPreview = await preview(f, id, appearances.get(f.campusB)!, b);
        const publicB = await f.publicPage(b);
        assert.ok(!publicB.page.items.some((item) => item.id === id));
        const publicContext = {
          contextId: publicB.context.id,
          contextToken: publicB.context.token,
        };
        for (const suffix of ['descriptor', 'display-v1'] as const)
          denied(
            await mediaGet(
              f,
              id,
              appearances.get(f.campusB)!,
              publicContext,
              suffix,
            ),
            `Removed B public ${suffix}`,
          );
        denied(
          await mediaGet(
            f,
            id,
            appearances.get(f.campusB)!,
            publicContext,
            'descriptor',
            'management-preview',
          ),
          'A public context cannot acquire dormant management authority by changing purpose',
        );
        assert.deepEqual(await attachments(f, id), originalAttachments);
      },
    );

    let editedRelease = '';
    await t.test(
      'source-only keep issues new original Review5 and composite Review8 for dormant B without rebinding Media',
      async () => {
        const edit = f.intent(await f.context(a), 'edit_category_base_scoped', {
          categoryId: id,
          name: 'Successor direct base',
          description: 'Successor description reaches dormant B',
          icon: { mode: 'keep' },
        });
        const prepared = await f.prepare(edit),
          stored = await f.stored(edit);
        assert.equal(prepared.changedIconCount, 0);
        assert.deepEqual(prepared.affectedScopeKeys, allKeys);
        assert.equal(stored.media_plan.plan.newAppearances.length, 0);
        const original = stored.category_plan.envelopes;
        assert.equal(
          original.length,
          3,
          'The original owner reissues base, visible A and dormant B Review5',
        );
        const dormantText = original.find(
          (envelope) =>
            envelope.purpose === 'publish_rating_category_override_scoped' &&
            envelope.scope.campusId === f.campusB,
        );
        assert.ok(dormantText);
        if (dormantText.purpose !== 'publish_rating_category_override_scoped')
          assert.fail();
        assert.equal(dormantText.version, 5);
        assert.equal(dormantText.body.name, 'Exact override B');
        assert.equal(
          dormantText.body.description,
          'Successor description reaches dormant B',
        );
        assert.notEqual(
          dormantText.baseSourceId,
          dormantBeforeEdit.content.baseSource.id,
        );
        const fresh = stored.media_plan.reviewEnvelopes;
        assert.equal(
          fresh.length,
          3,
          'Public A, hidden base A and dormant B are the deduplicated Review8 union',
        );
        const dormantReview = fresh.find(
          (envelope) =>
            envelope.content.selector.kind === 'campus' &&
            envelope.content.selector.campusId === f.campusB,
        );
        assert.ok(dormantReview);
        assert.equal(dormantReview.version, 8);
        assert.equal(dormantReview.content.name, dormantText.body.name);
        assert.equal(
          dormantReview.content.description,
          dormantText.body.description,
        );
        assert.deepEqual(dormantReview.content.baseSource, {
          id: dormantText.baseSourceId,
          revision: dormantText.baseSourceRevision,
        });
        assert.deepEqual(dormantReview.content.overrideSource, {
          id: dormantText.sourceId,
          revision: dormantText.sourceRevision,
        });
        assert.equal(dormantReview.content.icon.kind, 'image');
        if (dormantReview.content.icon.kind !== 'image') assert.fail();
        assert.equal(
          dormantReview.content.icon.appearance.appearanceId,
          appearances.get(f.campusB),
        );
        assert.notEqual(
          dormantReview.definitionDigest,
          dormantBeforeEdit.review.definitionDigest,
        );
        assert.equal(
          (await f.commit(edit, prepared.contextRevision)).body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
        );
        await f.approveIcons(edit);
        assert.equal(
          (await f.commit(edit, prepared.contextRevision)).body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
          'Exact new Review8 cannot substitute for the newly reissued original Review5',
        );
        await f.approveText(edit);
        const committed = await f.commit(edit, prepared.contextRevision);
        categoryIconHttpOk(committed);
        const receipt = ratingCategoryIconReceiptSchema.parse(committed.body);
        if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
        editedRelease = receipt.result.releaseId!;
        const current = await sealed(f, editedRelease);
        const exactDormant = current.manifest.management_coverage.find(
          (item) => item.scopeKey === `campus:${f.campusB}`,
        )!;
        assert.deepEqual(exactDormant.content, dormantReview.content);
        assert.equal(current.projections.length, 1);
        for (const suffix of ['descriptor', 'display-v1'] as const)
          denied(
            await mediaGet(
              f,
              id,
              dormantPreview.appearanceId,
              descriptorContext(dormantPreview),
              suffix,
              'management-preview',
            ),
            `Old source/release management ${suffix} stays stale`,
          );
        await preview(f, id, appearances.get(f.campusB)!, b);
        await preview(f, id, baseAppearance, a);
        assert.ok(
          !(await f.publicPage(b)).page.items.some((item) => item.id === id),
        );
        assert.deepEqual(await attachments(f, id), originalAttachments);
      },
    );

    await t.test(
      'holding a hidden direct-base Review8 does not revoke the independent public override Review',
      async () => {
        const current = await sealed(f, editedRelease);
        const base = current.manifest.management_coverage.find(
          (item) => item.content.icon.origin === 'base',
        )!;
        assert.ok(base);
        await reviewState(f, base.review.id, 'held');
        const context = await f.context(a);
        const response = await mediaGet(
          f,
          id,
          baseAppearance,
          {
            contextId: context.commandContext.id,
            contextToken: context.commandContext.token,
          },
          'descriptor',
          'management-preview',
        );
        denied(response, 'Hidden base requires its own current Review8');
        assert.equal(response.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
        const visible = await publicIcon(f, id, a);
        assert.equal(visible.icon.appearanceId, appearances.get(f.campusA));
        categoryIconHttpOk(
          await mediaGet(
            f,
            id,
            visible.icon.appearanceId,
            visible.context,
            'display-v1',
          ),
        );
        await reviewState(f, base.review.id, 'allow');
        await preview(f, id, baseAppearance, a);
      },
    );

    await t.test(
      'named SQL publication boundary rolls back missing, extra and wrong-purpose recoverable coverage',
      async (subtest) => {
        const before = await publicationState(f);
        for (const attack of [
          'missing-base',
          'missing-dormant',
          'extra-root-slot',
          'public-review-for-base',
        ] as const) {
          await subtest.test(attack, async () => {
            let changed = false,
              published = false,
              boundaryReached = false;
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                const query = tx.query.bind(tx);
                // Alter only a new manifest INSERT emitted by the genuine source
                // publisher. No accepted roots, decisions, qualifications or heads
                // are fabricated and every PostgreSQL guard remains enabled.
                tx.query = (async (sql: string, values?: unknown[]) => {
                  const parameters = values ? [...values] : undefined;
                  if (
                    sql.startsWith(
                      'INSERT INTO whaleu_ratings.category_icon_release_manifests(',
                    )
                  ) {
                    assert.ok(parameters);
                    let coverage = JSON.parse(
                      String(parameters[7]),
                    ) as CategoryIconReleaseCoverage[];
                    assert.equal(coverage.length, 3);
                    const base = coverage.find(
                      (item) => item.content.icon.origin === 'base',
                    )!;
                    const visible = coverage.find(
                      (item) =>
                        item.content.icon.origin === 'override' &&
                        item.scopeKey === `campus:${f.campusA}`,
                    )!;
                    assert.ok(base && visible);
                    if (attack === 'missing-base')
                      coverage = coverage.filter((item) => item !== base);
                    else if (attack === 'missing-dormant')
                      coverage = coverage.filter(
                        (item) => item.scopeKey !== `campus:${f.campusB}`,
                      );
                    else if (attack === 'extra-root-slot')
                      coverage.push(structuredClone(base));
                    else
                      coverage = coverage.map((item) =>
                        item === base
                          ? { ...item, review: visible.review }
                          : item,
                      );
                    parameters[7] = canonicalJson(coverage);
                    changed = true;
                  }
                  return query(sql, parameters);
                }) as typeof tx.query;
                try {
                  const release = await f.publish({}, tx);
                  published = true;
                  assert.equal(changed, true);
                  assert.equal(
                    (
                      await tx.query<{ n: number }>(
                        'SELECT count(*)::int n FROM whaleu_ratings.scoped_release_scopes WHERE release_id=$1',
                        [release.releaseId],
                      )
                    ).rows[0]!.n,
                    f.scopeKeys.length,
                  );
                  boundaryReached = true;
                  await tx.query(
                    'SET CONSTRAINTS whaleu_ratings.category_icon_release_row_causal IMMEDIATE',
                  );
                  assert.fail(`Named publication boundary accepted ${attack}`);
                } finally {
                  tx.query = query;
                }
              }),
              (error: unknown) =>
                changed &&
                published &&
                boundaryReached &&
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === '23514' &&
                'message' in error &&
                error.message ===
                  'Category icon manifest lacks its exact immutable release payload',
            );
            assert.equal(boundaryReached, true);
            assert.deepEqual(
              await publicationState(f),
              before,
              'The entire real publication rolls back',
            );
          });
        }
      },
    );

    await t.test(
      'named management pointer boundary rejects a valid public binding assigned to the wrong root',
      async () => {
        const current = await sealed(f, editedRelease);
        const base = current.manifest.management_coverage.find(
          (item) => item.content.icon.origin === 'base',
        )!;
        const visible = current.manifest.management_coverage.find(
          (item) =>
            item.content.icon.origin === 'override' &&
            item.scopeKey === `campus:${f.campusA}`,
        )!;
        assert.ok(base && visible);
        const before = await publicationState(f);
        let mutated = false,
          boundaryReached = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx: PoolClient) => {
            const result = await tx.query(
              `UPDATE whaleu_ratings.category_icon_management_review_heads
           SET review_binding_id=$3,mutation_transaction=pg_current_xact_id()
           WHERE root_definition_id=$1 AND selector=$2::jsonb`,
              [
                base.content.icon.definitionId,
                canonicalJson(base.content.selector),
                visible.review.id,
              ],
            );
            assert.equal(result.rowCount, 1);
            mutated = true;
            boundaryReached = true;
            await tx.query(
              'SET CONSTRAINTS whaleu_ratings.category_icon_management_review_head_causal IMMEDIATE',
            );
            assert.fail(
              'A public override binding cannot become direct-base management proof',
            );
          }),
          (error: unknown) =>
            mutated &&
            boundaryReached &&
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514' &&
            'message' in error &&
            error.message ===
              'Category icon management pointer lacks one exact current-root same-release publication',
        );
        assert.deepEqual(await publicationState(f), before);
        await preview(f, id, baseAppearance, a);
      },
    );

    await t.test(
      'restoring B republishes the exact same appearance and binding with the successor text',
      async () => {
        const restored = await f.execute(
          f.intent(await f.context(a), 'set_category_scope_scoped', {
            categoryId: id,
            placement: {
              kind: 'campuses',
              campusIds: [f.campusA, f.campusB].sort(),
            },
            propagation: 'self',
          }),
        );
        const current = await sealed(f, restored.receipt.result.releaseId!);
        assert.equal(current.projections.length, 2);
        assert.equal(current.manifest.management_coverage.length, 4);
        const restoredB = await publicIcon(f, id, b);
        assert.equal(restoredB.icon.appearanceId, appearances.get(f.campusB));
        assert.equal(restoredB.icon.bindingId, dormantPreview.bindingId);
        assert.equal(restoredB.category.name, 'Exact override B');
        assert.equal(
          restoredB.category.description,
          'Successor description reaches dormant B',
        );
        categoryIconHttpOk(
          await mediaGet(
            f,
            id,
            restoredB.icon.appearanceId,
            restoredB.context,
            'display-v1',
          ),
        );
        await preview(f, id, baseAppearance, b);
        assert.deepEqual(
          await attachments(f, id),
          originalAttachments,
          'No upload, appearance or Media rebind is required for restore',
        );
      },
    );
  },
);
