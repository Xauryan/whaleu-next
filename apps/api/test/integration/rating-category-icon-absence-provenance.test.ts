/** Real original Category commands and immutable lineage, with isolated source /
 * Review fixtures only. Run under the parent's exclusive PostgreSQL lease.
 * Missing image fields, accepted legacy adoption and empty Review assetIds do
 * not manufacture absence. No catalog, receipt or icon projection is seeded. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { ratingCategoryIconIntentSchema } from '../../src/ratings/category-management/icon-contracts.js';
import { planCategoryIconManagement } from '../../src/ratings/category-management/icon-plan.js';
import { RatingCategoryIconRepository } from '../../src/ratings/category-management/icon-repository.js';
import type { CategoryIconRoot } from '../../src/ratings/category-management/icon-references.js';
import type { CategoryManagementPlan } from '../../src/ratings/category-management/plan.js';
import { RatingCategoryManagementReader } from '../../src/ratings/category-management/scoped-reader.repository.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
  type RatingCategoryScopedOperation,
} from '../../src/ratings/category-management/scoped-contracts.js';
import { RatingScopedCompilationBudget } from '../../src/ratings/scoped/compiler.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ratingCategoryManagementFixture } from '../support/rating-category-management-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticNativeBridge,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import {
  ratingScopedFixture,
  writeRatingScopedApproval,
  type RatingScopedFixture,
} from '../support/rating-scoped-fixture.js';

const globalSelector = { kind: 'global' } as const;
const constraintViolation = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23514';
type Absence = { kind: 'absent'; evidenceId: string; evidenceDigest: string };
type CoverageEntry = {
  catalogId: string;
  scopeKey: string;
  categoryId: string;
  identityId: string;
  baseSource: { id: string; revision: string };
  overrideSource: unknown;
  baseEvidence: Absence;
  overrideEvidence: unknown;
};

async function strictCommand(
  f: Pick<RatingScopedFixture, 'pool' | 'http' | 'auth'>,
  actor: RatingScopedFixture['creator'],
  operation: RatingCategoryScopedOperation,
  payload: Record<string, unknown>,
  selector: RatingNavigationSelector = globalSelector,
) {
  const post = (route: string, body: object) =>
    f
      .auth(
        request(f.http).post(`/v2/ratings/category-management/${route}`),
        actor,
      )
      .send(body);
  const response = await post('contexts', { selector });
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
      `SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2`,
      [actor.accountId, input.payload.clientRequestId],
    )
  ).rows[0]!;
  assert.ok(
    persisted,
    'Approve only envelopes from the real original preparation',
  );
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
  return { input, prepared, receipt, plan: persisted.category_plan };
}
const createPayload = (name = 'Original strict text category') => ({
  parentId: null,
  placement: { kind: 'global' },
  nodes: [
    {
      key: 'root',
      parentKey: null,
      name,
      description: 'Created through original Category v2',
    },
  ],
});
async function absence(
  pool: Pool,
  source: { id: string; revision: string },
  categoryId: string,
  identityId = categoryId,
) {
  return (
    await pool.query<{ proof: Absence | null }>(
      'SELECT whaleu_ratings.category_icon_strict_text_absence($1,$2,$3,$4) proof',
      [source.id, source.revision, categoryId, identityId],
    )
  ).rows[0]!.proof;
}
async function roots(pool: Pool) {
  return (
    await pool.query<{ roots: CategoryIconRoot[] }>(
      'SELECT whaleu_ratings.category_icon_complete_roots() roots',
    )
  ).rows[0]!.roots;
}
async function protocols(pool: Pool) {
  return (
    await pool.query<{ id: string; inventory: CoverageEntry[] | null }>(
      `SELECT v.id,whaleu_ratings.category_icon_coverage_inventory(v.id) inventory
      FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
      WHERE v.phase='adopted' ORDER BY v.id`,
    )
  ).rows;
}

/** Exercise the real registration guard with internally consistent digests.
 * The helper never decides that a root is absent; SQL must derive every item
 * from its complete original adopted catalog and immutable creation lineage. */
async function registerCapability(
  tx: PoolClient,
  protocol: string,
  patch: {
    inventory?: unknown[];
    issuer?: string;
    provenance?: string;
    routes?: string;
    native?: string;
    sourceDigest?: string;
  } = {},
) {
  const id = randomUUID();
  await tx.query(
    `WITH facts AS (
    SELECT v.*,s.digest source_digest,s.valid_until source_until,
      coalesce($3::jsonb,whaleu_ratings.category_icon_coverage_inventory(v.id)) inventory,
      coalesce($6::text,whaleu_ratings.category_icon_route_contract()) routes,
      coalesce($7::text,whaleu_ratings.category_icon_native_contract()) native,
      coalesce($8::text,s.digest) declared_source_digest
    FROM whaleu_ratings.scope_protocol_versions v JOIN whaleu_ratings.scoped_source_attestations s
      ON (s.id,s.revision)=(v.capability_source_id,v.capability_source_revision) WHERE v.id=$1
  ), digests AS (
    SELECT facts.*,whaleu_ratings.category_icon_digest('coverage-inventory',inventory) coverage,
      whaleu_ratings.category_icon_digest('compatibility',jsonb_build_object(
        'protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,
        'extensionVersion','ratings-category-icon-v1','slots',ARRAY['icon'],
        'sourceId',capability_source_id,'sourceRevision',capability_source_revision,'sourceDigest',declared_source_digest,
        'routesDigest',routes,'nativeDigest',native)) compatibility FROM facts
  ) INSERT INTO whaleu_ratings.category_icon_capability_sources
    (id,protocol_version_id,source_id,source_revision,source_digest,protocol_version,review_version,media_version,journal_version,
      extension_version,slots,routes_digest,native_digest,compatibility_digest,adoption_digest,coverage_digest,coverage_inventory,
      issuer,provenance_ref,valid_from,valid_until)
    SELECT $2,id,capability_source_id,capability_source_revision,declared_source_digest,5,8,8,13,
      'ratings-category-icon-v1',ARRAY['icon'],routes,native,compatibility,
      whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',id,'generation',generation,
        'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility,'coverageDigest',coverage)),
      coverage,inventory,coalesce($4::text,'ratings-category-icon-capability-owner'),
      coalesce($5::text,'rating-category-icon-adoption:'||id::text||':'||capability_source_id::text||':'||capability_source_revision::text),
      clock_timestamp(),least(source_until,clock_timestamp()+interval '20 minutes') FROM digests`,
    [
      protocol,
      id,
      patch.inventory === undefined ? null : canonicalJson(patch.inventory),
      patch.issuer ?? null,
      patch.provenance ?? null,
      patch.routes ?? null,
      patch.native ?? null,
      patch.sourceDigest ?? null,
    ],
  );
  return id;
}
async function extensionState(pool: Pool) {
  return (
    await pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'capabilities',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_capability_sources c),
    'definitions',(SELECT count(*) FROM whaleu_ratings.category_icon_definitions),
    'appearances',(SELECT count(*) FROM whaleu_ratings.category_icon_appearances),
    'projections',(SELECT count(*) FROM whaleu_ratings.category_icon_projections),
    'releases',(SELECT count(*) FROM whaleu_ratings.category_icon_release_manifests),
    'epoch',(SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton)) state`)
  ).rows[0]!.state;
}
async function nativeAdoptionFixture() {
  const f = await ratingScopedFixture();
  try {
    await f.grant(f.creator, 'super_admin');
    const native = await f.createCategories(f.creator, f.regionId, {
      nodes: [
        {
          key: 'native',
          parentKey: null,
          name: 'Original Next native category',
          description: 'Real create_categories receipt',
        },
      ],
    });
    const category = native.receipt.categories[0]!;
    const catalog = native.receipt.catalogs.find(
      (row) => row.regionId === f.regionId,
    )!;
    assert.ok(catalog);
    const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const { bridge } = await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticNativeBridge(tx, {
        legacyCatalogId: catalog.catalogRevision,
        categoryId: category.id,
        categoryRevision: category.revision,
        scopeKeys,
      }),
    );
    await f.declareAll();
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [category.id],
        targetIds: [],
        legacyCatalogIds: [catalog.catalogRevision],
      });
    await f.capability();
    await f.publish({
      activate: true,
      domain: { kind: 'region_compat', regionId: f.regionId },
    });
    return {
      ...f,
      native,
      category,
      catalog,
      bridge,
      nativeScopeKeys: scopeKeys,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test(
  'Category strict v2 creation and source succession prove absence from real immutable receipts',
  { timeout: 240000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], {
      runtime: false,
      capabilities: false,
    });
    t.after(() => f.close());
    const created = await strictCommand(
      f,
      f.admin,
      'create_categories_scoped',
      createPayload(),
    );
    const categoryId = created.receipt.result.categoryIds[0]!;
    const first = created.plan.sourceIssues.find(
      (issue) => issue.kind === 'scoped_category_base',
    )!;
    assert.equal(first.payload['identityId'], categoryId);
    const firstProof = await absence(f.pool, first, categoryId);
    assert.ok(firstProof);
    assert.equal(firstProof.kind, 'absent');
    assert.equal(firstProof.evidenceId, created.input.payload.clientRequestId);
    assert.match(firstProof.evidenceDigest, /^[a-f0-9]{64}$/);
    const persisted = (
      await f.pool.query<{
        receipt: unknown;
        source_matches: boolean;
        same_transaction: boolean;
        claimed: boolean;
      }>(
        `SELECT q.receipt,s.payload=$3::jsonb source_matches,s.publication_transaction=o.mutation_transaction same_transaction,
      EXISTS(SELECT 1 FROM whaleu_ratings.command_claims c WHERE (c.account_id,c.request_id,c.operation,c.intent_hash)=
        (q.account_id,q.request_id,q.operation,q.intent_hash)) claimed
      FROM whaleu_ratings.requests q JOIN whaleu_ratings.scoped_command_outcomes o USING(account_id,request_id)
      JOIN whaleu_ratings.scoped_source_attestations s ON s.id=$4
      WHERE q.account_id=$1 AND q.request_id=$2`,
        [
          f.admin.accountId,
          created.input.payload.clientRequestId,
          canonicalJson(first.payload),
          first.id,
        ],
      )
    ).rows[0]!;
    assert.deepEqual(persisted, {
      receipt: created.receipt,
      source_matches: true,
      same_transaction: true,
      claimed: true,
    });
    assert.equal(await absence(f.pool, first, categoryId, randomUUID()), null);
    assert.equal(
      await absence(f.pool, { ...first, revision: randomUUID() }, categoryId),
      null,
    );
    const edited = await strictCommand(
      f,
      f.admin,
      'edit_category_base_scoped',
      {
        categoryId,
        name: 'A real strict-text successor',
        description: 'The original source stays immutable',
      },
    );
    const successor = edited.plan.sourceIssues.find(
      (issue) => issue.kind === 'scoped_category_base',
    )!;
    assert.equal(successor.payload['previousBaseSourceId'], first.id);
    const nextProof = await absence(f.pool, successor, categoryId);
    assert.ok(nextProof);
    assert.equal(
      nextProof.evidenceId,
      firstProof.evidenceId,
      'The original creation, not missing successor metadata, anchors absence',
    );
    assert.notEqual(
      nextProof.evidenceDigest,
      firstProof.evidenceDigest,
      'The exact successor chain participates in the evidence',
    );
    assert.deepEqual(await absence(f.pool, first, categoryId), firstProof);
    assert.deepEqual(
      (await roots(f.pool)).find(
        (root) => root.kind === 'base' && root.source.id === successor.id,
      )?.value,
      nextProof,
    );
    const recovered = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${created.input.payload.clientRequestId}`,
      ),
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(recovered.body, created.receipt);
    await f.rejectSql(
      'A retained creation receipt cannot be rewritten into an absence assertion',
      (tx) =>
        tx.query(
          `UPDATE whaleu_ratings.requests SET receipt=jsonb_set(receipt,'{result,occurredAt}','"2000-01-01T00:00:00.000Z"')
      WHERE account_id=$1 AND request_id=$2`,
          [f.admin.accountId, created.input.payload.clientRequestId],
        ),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_preparations',
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_definitions',
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_release_manifests',
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'Category v5 adopts proven strict-v2 absence through exact Review8 while ordinary unextended paths stay intact',
  { timeout: 240000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], {
      runtime: false,
      capabilities: false,
    });
    t.after(() => f.close());
    const created = await strictCommand(
      f,
      f.admin,
      'create_categories_scoped',
      createPayload(),
    );
    const categoryId = created.receipt.result.categoryIds[0]!;
    const original = created.plan.sourceIssues.find(
      (issue) => issue.kind === 'scoped_category_base',
    )!;
    const proof = await absence(f.pool, original, categoryId);
    assert.ok(proof);
    assert.equal(
      (await f.post('contexts', { selector: globalSelector })).body.error.code,
      'RATING_SCOPE_UNAVAILABLE',
    );
    for (const version of await protocols(f.pool)) {
      assert.deepEqual(
        version.inventory,
        [],
        'This fixture adopted genuinely empty catalogs before the later v2 command',
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        registerCapability(tx, version.id),
      );
    }
    const ordinary = await f
      .auth(request(f.http).post('/v2/ratings/category-management/contexts'))
      .send({ selector: globalSelector });
    categoryIconHttpOk(ordinary);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_definitions',
        )
      ).rowCount,
      0,
      'Capability registration never synthesizes a Category definition',
    );
    const input = f.intent(await f.context(), 'edit_category_base_scoped', {
      categoryId,
      name: 'Now explicitly covered by composite Review8',
      description: 'Retains exact strict-text absence',
      icon: { mode: 'keep' },
    });
    const prepared = await f.prepare(input);
    const stored = await f.stored(input);
    assert.equal(stored.media_plan.plan.adoptionRequired, true);
    assert.equal(stored.media_plan.plan.newAppearances.length, 0);
    assert.deepEqual(
      stored.media_plan.plan.beforeRoots.find(
        (root) => root.categoryId === categoryId,
      )?.value,
      proof,
    );
    assert.ok(stored.media_plan.reviewEnvelopes.length > 0);
    assert.ok(
      stored.media_plan.reviewEnvelopes.every(
        (envelope) => envelope.content.icon.kind === 'absent',
      ),
    );
    await f.approveText(input);
    assert.equal(
      (await f.commit(input, prepared.contextRevision)).body.error.code,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    await f.approveIcons(input);
    categoryIconHttpOk(await f.commit(input, prepared.contextRevision));
    const published = await f.publicPage();
    assert.equal(
      published.page.items.find((item) => item.id === categoryId)?.icon,
      null,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_appearances',
        )
      ).rowCount,
      0,
    );
    const recovered = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${created.input.payload.clientRequestId}`,
      ),
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(
      recovered.body,
      created.receipt,
      'Extension adoption cannot rewrite the original v2 receipt',
    );
  },
);

test(
  'Original Next create_categories receipts distinguish m3a native text from opaque legacy and cover every adopted campus',
  { timeout: 240000 },
  async (t) => {
    const f = await nativeAdoptionFixture();
    t.after(() => f.close());
    const origin = (
      await f.pool.query<{ origin: Record<string, unknown> | null }>(
        'SELECT whaleu_ratings.category_icon_native_text_origin($1,$2,$3,$3) origin',
        [f.bridge.id, f.bridge.revision, f.category.id],
      )
    ).rows[0]!.origin;
    assert.ok(origin);
    assert.equal(origin['kind'], 'next-native-strict-text');
    assert.equal(origin['requestId'], f.native.input.clientRequestId);
    assert.equal(origin['releaseId'], f.native.receipt.releaseId);
    assert.equal(origin['baseRevision'], f.category.revision);
    const proof = await absence(f.pool, f.bridge, f.category.id);
    assert.ok(proof);
    assert.equal(proof.evidenceId, f.native.input.clientRequestId);
    const versions = await protocols(f.pool);
    assert.equal(versions.length, 1);
    const version = versions[0]!;
    assert.ok(version.inventory);
    assert.equal(
      version.inventory.length,
      2,
      'Complete inventory includes both campuses of the native region',
    );
    assert.deepEqual(
      version.inventory.map((entry) => entry.scopeKey),
      f.nativeScopeKeys,
    );
    for (const entry of version.inventory) {
      assert.equal(entry.categoryId, f.category.id);
      assert.equal(entry.identityId, f.category.id);
      assert.deepEqual(entry.baseSource, {
        id: f.bridge.id,
        revision: f.bridge.revision,
      });
      assert.deepEqual(entry.baseEvidence, proof);
      assert.equal(entry.overrideSource, null);
      assert.equal(entry.overrideEvidence, null);
    }
    const id = await withCommunityScopeWriter(f.pool, (tx) =>
      registerCapability(tx, version.id),
    );
    const registered = (
      await f.pool.query<{
        inventory: unknown;
        current: boolean;
        issuer: string;
        provenance_ref: string;
        expected_provenance: string;
      }>(
        `SELECT coverage_inventory inventory,whaleu_ratings.category_icon_capability_current(id,clock_timestamp()) current,
      issuer,provenance_ref,'rating-category-icon-adoption:'||protocol_version_id::text||':'||source_id::text||':'||source_revision::text expected_provenance
      FROM whaleu_ratings.category_icon_capability_sources WHERE id=$1`,
        [id],
      )
    ).rows[0]!;
    assert.deepEqual(registered.inventory, version.inventory);
    assert.equal(registered.current, true);
    assert.equal(registered.issuer, 'ratings-category-icon-capability-owner');
    assert.equal(registered.provenance_ref, registered.expected_provenance);
    const recovered = await f.auth(
      request(f.http).get(
        `/v1/ratings/category-management/requests/${f.native.input.clientRequestId}`,
      ),
      f.creator,
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(recovered.body, f.native.receipt);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_definitions',
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'Category icon capability rejects partial coverage and self-consistent forged issuer, provenance, routes and native contracts',
  { timeout: 240000 },
  async (t) => {
    const f = await nativeAdoptionFixture();
    t.after(() => f.close());
    const version = (await protocols(f.pool))[0]!;
    assert.ok(version.inventory);
    const before = await extensionState(f.pool);
    const attacks: {
      label: string;
      patch: Parameters<typeof registerCapability>[2];
    }[] = [
      {
        label:
          'an empty-array flag cannot hide an existing adopted native category',
        patch: { inventory: [] },
      },
      {
        label: 'one surviving campus is incomplete coverage',
        patch: { inventory: version.inventory.slice(0, 1) },
      },
      {
        label: 'copied evidence cannot be relabeled to another category',
        patch: {
          inventory: version.inventory.map((entry) => ({
            ...entry,
            categoryId: randomUUID(),
          })),
        },
      },
      {
        label:
          'a generic accepted issuer is not the Category icon capability owner',
        patch: { issuer: 'synthetic-scoped-issuer' },
      },
      {
        label: 'the exact original source revision is bound into provenance',
        patch: {
          provenance: `rating-category-icon-adoption:${version.id}:${randomUUID()}:${randomUUID()}`,
        },
      },
      {
        label:
          'self-consistent compatibility does not authorize an arbitrary route contract',
        patch: { routes: 'a'.repeat(64) },
      },
      {
        label:
          'self-consistent compatibility does not authorize an arbitrary native contract',
        patch: { native: 'b'.repeat(64) },
      },
      {
        label:
          'capability source digest must match its original immutable source',
        patch: { sourceDigest: 'c'.repeat(64) },
      },
    ];
    for (const attack of attacks) {
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          registerCapability(tx, version.id, attack.patch),
        ),
        constraintViolation,
        attack.label,
      );
      assert.deepEqual(
        await extensionState(f.pool),
        before,
        `${attack.label}: registration and epoch roll back together`,
      );
    }
    await withCommunityScopeWriter(f.pool, (tx) =>
      registerCapability(tx, version.id),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_capability_sources',
        )
      ).rowCount,
      1,
    );
  },
);

test(
  'Seeded old-production-shaped text and empty assetIds remain unknown even after a real v2 edit',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const seeded = f.data.global;
    assert.deepEqual(seeded.envelope.assetIds, []);
    const source = (
      await f.pool.query<{ payload: Record<string, unknown>; issuer: string }>(
        'SELECT payload,issuer FROM whaleu_ratings.scoped_source_attestations WHERE id=$1',
        [seeded.source.id],
      )
    ).rows[0]!;
    assert.equal(Object.hasOwn(source.payload, 'management'), false);
    assert.equal(Object.hasOwn(source.payload, 'icon'), false);
    assert.notEqual(source.issuer, 'ratings-category-management');
    assert.equal(
      await absence(
        f.pool,
        seeded.source,
        seeded.categoryId,
        seeded.identityId,
      ),
      null,
    );
    assert.deepEqual(
      (await roots(f.pool)).find(
        (root) => root.categoryId === seeded.categoryId,
      )?.value,
      { kind: 'unresolved', reason: 'legacy_unknown' },
    );
    const edited = await strictCommand(
      f,
      f.admin,
      'edit_category_base_scoped',
      {
        categoryId: seeded.categoryId,
        name: 'A reviewed successor of unknown history',
        description: 'A text edit cannot attest to old image absence',
      },
    );
    const successor = edited.plan.sourceIssues.find(
      (issue) => issue.kind === 'scoped_category_base',
    )!;
    assert.equal(successor.payload['previousBaseSourceId'], seeded.source.id);
    assert.equal(
      await absence(f.pool, successor, seeded.categoryId, seeded.identityId),
      null,
    );
    assert.deepEqual(
      (await roots(f.pool)).find(
        (root) => root.kind === 'base' && root.source.id === successor.id,
      )?.value,
      { kind: 'unresolved', reason: 'legacy_unknown' },
    );
    const version = (await protocols(f.pool)).find(
      (row) => row.inventory === null,
    );
    assert.ok(
      version,
      'Unknown adopted roots make coverage unavailable, not an empty inventory',
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        registerCapability(tx, version.id, { inventory: [] }),
      ),
      constraintViolation,
    );
    const closed = await f
      .auth(
        request(f.http).post('/v5/ratings/category-management/contexts'),
        f.admin,
      )
      .send({ selector: globalSelector });
    assert.equal(closed.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    const recovered = await f.auth(
      request(f.http).get(
        `/v2/ratings/requests/${edited.input.payload.clientRequestId}`,
      ),
      f.admin,
    );
    categoryIconHttpOk(recovered);
    assert.deepEqual(
      recovered.body,
      edited.receipt,
      'The original no-extension Category owner remains usable',
    );
  },
);

test(
  'Accepted opaque legacy adoption keeps independent identity and cannot register icon absence',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const original = await f.catalog(f.creator, { regionId: f.regionId });
    const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      original.catalogId,
      original.categoryId,
      scopeKeys,
    );
    const issued = await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticOpaqueAdoption(tx, adoption),
    );
    await f.declareAll();
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [original.categoryId],
        targetIds: original.targets.map((target) => target.id).sort(),
        legacyCatalogIds: [original.catalogId],
      });
    await f.capability();
    await f.publish({
      activate: true,
      domain: { kind: 'region_compat', regionId: f.regionId },
    });
    assert.notEqual(adoption.identityId, original.categoryId);
    assert.equal(
      await absence(
        f.pool,
        issued.source,
        original.categoryId,
        adoption.identityId,
      ),
      null,
    );
    assert.equal(
      (
        await f.pool.query<{ origin: unknown }>(
          'SELECT whaleu_ratings.category_icon_native_text_origin($1,$2,$3,$4) origin',
          [
            issued.source.id,
            issued.source.revision,
            original.categoryId,
            adoption.identityId,
          ],
        )
      ).rows[0]!.origin,
      null,
    );
    const categoryRoots = (await roots(f.pool)).filter(
      (root) => root.categoryId === original.categoryId,
    );
    assert.ok(categoryRoots.length > 0);
    assert.ok(categoryRoots.every((root) => root.value.kind === 'unresolved'));
    const versions = await protocols(f.pool);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.inventory, null);
    const before = await extensionState(f.pool);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        registerCapability(tx, versions[0]!.id, { inventory: [] }),
      ),
      constraintViolation,
    );
    assert.deepEqual(await extensionState(f.pool), before);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_identities WHERE id=ANY($1::uuid[])',
          [[original.categoryId, adoption.identityId]],
        )
      ).rowCount,
      0,
      'Opaque evidence is never relabeled as native creation',
    );
  },
);

test(
  'Equal-body independent bases with unresolved icons cannot merge through the icon planner using a real original snapshot',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture({ multiBases: true });
    t.after(() => f.close());
    const pair = f.multiBaseCases.find((item) => item.mismatch === 'none')!;
    assert.ok(pair);
    assert.deepEqual(pair.a.envelope.body, pair.b.envelope.body);
    const current = await f.managementContext(f.admin);
    const input = f.managementIntent(current, 'set_category_scope_scoped', {
      categoryId: pair.a.categoryId,
      placement: { kind: 'campuses', campusIds: [f.campusA] },
      propagation: 'self',
    });
    await f.prepareManagement(f.admin, input);
    const original = (await f.managementPlan(f.admin, input)).category_plan;
    assert.equal(
      original.sourceIssues.filter(
        (issue) =>
          issue.kind === 'scoped_category_base' &&
          issue.payload['categoryId'] === pair.a.categoryId,
      ).length,
      1,
      'The actual original text planner regards this merge as compatible',
    );
    const before = {
      artifacts: await f.managementArtifacts(),
      ledger: await f.managementLedger(),
      extension: await extensionState(f.pool),
    };
    await inTransaction(f.pool, async (tx) => {
      const budget = new RatingScopedCompilationBudget();
      const snapshot = await f.app
        .get(RatingCategoryManagementReader)
        .snapshot(`campus:${f.campusA}`, tx);
      const actualRoots = await new RatingCategoryIconRepository().roots(
        tx,
        budget,
      );
      const candidates = actualRoots.filter(
        (root) => root.kind === 'base' && root.categoryId === pair.a.categoryId,
      );
      assert.equal(candidates.length, 2);
      assert.ok(candidates.every((root) => root.value.kind === 'unresolved'));
      const revision = (
        await tx.query<{ revision: string }>(
          'SELECT whaleu_ratings.category_icon_snapshot($1::text[]) revision',
          [original.affectedScopeKeys],
        )
      ).rows[0]!.revision;
      const iconInput = ratingCategoryIconIntentSchema.parse({
        ...input,
        protocolVersion: 5,
        mediaSnapshot: revision,
      });
      assert.throws(
        () =>
          planCategoryIconManagement(
            f.admin.accountId,
            iconInput,
            snapshot,
            { revision, roots: actualRoots, markedScopeKeys: [] },
            [],
            budget,
          ),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'RATING_SCOPE_UNAVAILABLE',
        'Text equality cannot select an arbitrary unresolved image predecessor',
      );
    });
    assert.deepEqual(
      {
        artifacts: await f.managementArtifacts(),
        ledger: await f.managementLedger(),
        extension: await extensionState(f.pool),
      },
      before,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [f.admin.accountId, input.payload.clientRequestId],
        )
      ).rowCount,
      0,
      'Rejected merge has no terminal command or partial publication',
    );
  },
);
