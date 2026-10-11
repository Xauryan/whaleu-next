/** Real HTTP / PostgreSQL authority transitions. Run only under the parent's
 * exclusive disposable PostgreSQL lease. Synthetic facts enter the original
 * owners; no currentness booleans, derived rows or receipt shortcuts are mocked. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { ratingCategoryIconReceiptSchema } from '../../src/ratings/category-management/icon-contracts.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
} from '../../src/ratings/category-management/scoped-contracts.js';
import type { CategoryManagementPlan } from '../../src/ratings/category-management/plan.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
} from '../../src/ratings/scoped/contracts.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import {
  appendTopologyRevision,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { writeRatingScopedApproval } from '../support/rating-scoped-fixture.js';

type Actor = Awaited<ReturnType<CategoryIconManagementFixture['actor']>>;
const globalSelector = { kind: 'global' } as const;
const campus = (campusId: string) => ({ kind: 'campus' as const, campusId });
function denied(response: { status: number; body: unknown }, code: string) {
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.deepEqual(
    (response.body as { error?: { code?: string } }).error?.code,
    code,
    JSON.stringify(response.body),
  );
}
function closed(response: { status: number; body: unknown }, code: string) {
  categoryIconHttpOk(response);
  const receipt = ratingCategoryIconReceiptSchema.parse(response.body);
  assert.equal(receipt.outcome, 'closed', JSON.stringify(receipt));
  if (receipt.outcome !== 'closed') assert.fail('Expected a terminal denial');
  assert.equal(receipt.code, code);
  return receipt;
}
async function exactGrant(
  f: CategoryIconManagementFixture,
  actor: Actor,
  campusId: string,
  expiresAt?: Date,
) {
  const id = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_authorization.rating_category_campus_grants
       (id,account_id,campus_id,approved_by_account_id,approval_reference,valid_from,expires_at)
       VALUES($1,$2,$3,$4,'synthetic-c1-exact-authority',clock_timestamp()-interval '1 second',$5)`,
      [id, actor.accountId, campusId, f.admin.accountId, expiresAt ?? null],
    ),
  );
  return id;
}
async function revokeGrant(f: CategoryIconManagementFixture, id: string) {
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'UPDATE whaleu_authorization.rating_category_campus_grants SET revoked_at=clock_timestamp() WHERE id=$1',
      [id],
    ),
  );
}
async function pngFixture() {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 43, height: 37, channels: 3, background: '#315d83' },
  })
    .png()
    .toBuffer();
  const f = await categoryIconManagementFixture([
    { sha256: sha256(bytes), verdict: 'allow' },
  ]);
  return { f, bytes };
}
async function createIntent(
  f: CategoryIconManagementFixture,
  actor: Actor = f.admin,
  campusIds?: string[],
) {
  return f.intent(
    await f.context(campusIds ? campus(campusIds[0]!) : globalSelector, actor),
    'create_categories_scoped',
    {
      parentId: null,
      placement: campusIds
        ? { kind: 'campuses', campusIds: [...campusIds].sort() }
        : { kind: 'global' },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: `Authority ${randomUUID()}`,
          description: 'Exact owner authority regression',
          icon: { mode: 'clear' },
        },
      ],
    },
  );
}
async function baseEdit(
  f: CategoryIconManagementFixture,
  actor: Actor,
  id: string,
) {
  return f.intent(
    await f.context(campus(f.campusA), actor),
    'edit_category_base_scoped',
    {
      categoryId: id,
      name: 'All current and dormant campus roots',
      description: 'The removed campus remains an authority obligation',
      icon: { mode: 'clear' },
    },
  );
}
/** Closed denial receipts are allowed, but not any accepted effect, Review
 * binding, upload scope, media binding, source or published catalog mutation. */
async function publication(f: CategoryIconManagementFixture) {
  const artifacts = { ...((await f.artifacts()) as Record<string, unknown>) };
  delete artifacts['requests'];
  // Each newly committed exact v5 receipt now contributes one mandatory
  // immediate epoch event. Preserve the epoch assertion after accounting for
  // precisely those immutable receipts, rather than dropping it wholesale.
  const receipts = (
    await f.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whaleu_ratings.requests WHERE receipt->>'protocolVersion'='5'",
    )
  ).rows[0]!.count;
  assert.equal(typeof artifacts['ownerEpoch'], 'number');
  artifacts['ownerEpoch'] = Number(artifacts['ownerEpoch']) - receipts;
  const owners = (
    await f.pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM whaleu_ratings.scoped_source_attestations s),
    'sourceHeads',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY source_kind,source_key),'[]') FROM whaleu_ratings.scoped_source_heads s),
    'heads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY scope_key),'[]') FROM whaleu_ratings.scoped_catalog_heads h),
    'releases',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM whaleu_ratings.scoped_releases r),
    'reviewBindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_review_bindings b),
    'uploadScopes',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_upload_scopes u),
    'acceptedOutcomes',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY account_id,request_id),'[]') FROM whaleu_ratings.scoped_command_outcomes o WHERE outcome<>'closed')) state`)
  ).rows[0]!.state;
  return { artifacts, owners };
}
async function readyAndPrepared(
  f: CategoryIconManagementFixture,
  actor: Actor,
  bytes: Buffer,
) {
  const upload = await f.ready(
    await createIntent(f, actor, [f.campusA]),
    { kind: 'new', key: 'root' },
    bytes,
    'image/png',
    actor,
  );
  assert.equal(upload.status.status, 'ready_unbound');
  const prepared = await f.prepare(upload.input, actor);
  await f.approveText(upload.input, actor);
  await f.approveIcons(upload.input, actor);
  return { upload, prepared };
}
async function authorTarget(
  f: CategoryIconManagementFixture,
  actor: Actor,
  categoryId: string,
) {
  const context = await f.scopedContext(
    actor,
    campus(f.campusA),
    'create_target',
  );
  const category = (
    await f.pool.query<{ effective_revision: string }>(
      'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
      [context.heads[0]!.catalogRevision, categoryId],
    )
  ).rows[0];
  assert.ok(category);
  const input = ratingScopedIntentSchema.parse({
    protocolVersion: 2,
    operation: 'create_target_scoped',
    context: scopedCommandContext(context),
    payload: {
      clientRequestId: randomUUID(),
      categoryId,
      expectedCategoryRevision: category.effective_revision,
      name: 'A genuine target author still cannot manage its category',
      description: '',
      assetIds: [],
    },
  });
  const response = await f
    .auth(request(f.http).post('/v2/ratings/management/prepare'), actor)
    .send(input);
  categoryIconHttpOk(response);
  const prepared = ratingScopedPreparationSchema.parse(response.body);
  const row = (
    await f.pool.query<{ envelope: unknown }>(
      'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
      [actor.accountId, input.payload.clientRequestId],
    )
  ).rows[0];
  assert.ok(row);
  await f.approveScoped(canonicalRatingScopedEnvelope(row.envelope));
  const committed = await f
    .auth(request(f.http).post('/v2/ratings/management/targets'), actor)
    .send({ ...input, preparationContextRevision: prepared.contextRevision });
  categoryIconHttpOk(committed);
  const targetId = scopedSuccess(committed.body).result['targetId'];
  assert.equal(
    (
      await f.pool.query<{ creator_id: string }>(
        'SELECT creator_id FROM whaleu_ratings.targets WHERE id=$1',
        [targetId],
      )
    ).rows[0]?.creator_id,
    actor.accountId,
  );
}

test(
  'C1 ordinary and target-author denial, exact A isolation, and removed dormant B all-of authority',
  { timeout: 360000 },
  async (t) => {
    const { f, bytes } = await pngFixture();
    t.after(() => f.close());
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await f.issueSource(
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
      );
      await f.publish({}, tx);
    });
    const created = await f.execute(
      await createIntent(f, f.admin, [f.campusA, f.campusB]),
    );
    const id = created.receipt.result.categoryIds[0]!;
    await f.execute(
      f.intent(
        await f.context(campus(f.campusB)),
        'set_category_override_scoped',
        {
          categoryId: id,
          name: { mode: 'set', value: 'Dormant campus B name' },
          description: { mode: 'inherit' },
          icon: { mode: 'set', value: null },
        },
      ),
    );
    await f.execute(
      f.intent(
        await f.context(campus(f.campusA)),
        'set_category_scope_scoped',
        {
          categoryId: id,
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          propagation: 'self',
        },
      ),
    );
    const dormant = (
      await f.pool.query<{ retention: string; scope_keys: string[] }>(
        `SELECT h.retention,h.scope_keys FROM whaleu_ratings.category_icon_definition_heads h
       JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id
       WHERE d.category_id=$1 AND d.kind='override' AND d.campus_id=$2`,
        [id, f.campusB],
      )
    ).rows[0];
    assert.deepEqual(dormant, {
      retention: 'dormant',
      scope_keys: [`campus:${f.campusB}`],
    });
    const ordinary = await f.actor(),
      author = await f.actor();
    await authorTarget(f, author, id);

    await t.test(
      'a real target author and an ordinary actor cannot borrow a management context or preparation',
      async () => {
        const input = await baseEdit(f, f.admin, id),
          prepared = await f.prepare(input);
        await f.approveText(input);
        await f.approveIcons(input);
        const before = await publication(f);
        for (const actor of [ordinary, author]) {
          denied(
            await f.post('contexts', { selector: campus(f.campusA) }, actor),
            'RATING_SCOPE_UNAVAILABLE',
          );
          denied(
            await f.post(
              'upload-scopes',
              f.scopeInput(input, { kind: 'base', categoryId: id }, bytes),
              actor,
            ),
            'RATING_SCOPE_UNAVAILABLE',
          );
          denied(
            await f.post('prepare', input, actor),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          closed(
            await f.commit(input, prepared.contextRevision, actor),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
        }
        assert.deepEqual(await publication(f), before);
      },
    );

    await exactGrant(f, author, f.campusA);
    await t.test(
      'an exact campus A grant neither authorizes sibling B nor global management',
      async () => {
        const current = await f.context(campus(f.campusA), author);
        assert.deepEqual(current.campusIds, [f.campusA]);
        assert.equal(current.canManageGlobal, false);
        for (const selector of [campus(f.campusB), globalSelector])
          denied(
            await f.post('contexts', { selector }, author),
            'RATING_SCOPE_UNAVAILABLE',
          );
        const input = f.intent(current, 'create_categories_scoped', {
          parentId: null,
          placement: { kind: 'campuses', campusIds: [f.campusB] },
          nodes: [
            {
              key: 'root',
              parentKey: null,
              name: 'Same-region B is not A',
              description: '',
              icon: { mode: 'clear' },
            },
          ],
        });
        const before = await publication(f);
        denied(
          await f.post(
            'upload-scopes',
            f.scopeInput(input, { kind: 'new', key: 'root' }, bytes),
            author,
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        denied(
          await f.post('prepare', input, author),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.deepEqual(await publication(f), before);
        assert.equal(
          (await f.execute(await createIntent(f, author, [f.campusA]), author))
            .receipt.outcome,
          'applied',
        );
      },
    );

    await t.test(
      'a base edit includes removed B, even though only A currently displays the category',
      async () => {
        const input = await baseEdit(f, author, id),
          before = await publication(f);
        denied(
          await f.post(
            'upload-scopes',
            f.scopeInput(input, { kind: 'base', categoryId: id }, bytes),
            author,
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        denied(
          await f.post('prepare', input, author),
          'RATING_SCOPE_UNAVAILABLE',
        );
        assert.deepEqual(await publication(f), before);
        const grantB = await exactGrant(f, author, f.campusB);
        const upload = await f.ready(
          await baseEdit(f, author, id),
          { kind: 'base', categoryId: id },
          bytes,
          'image/png',
          author,
        );
        const prepared = await f.prepare(upload.input, author);
        assert.deepEqual(
          prepared.affectedScopeKeys,
          [`campus:${f.campusA}`, `campus:${f.campusB}`].sort(),
        );
        await f.approveText(upload.input, author);
        await f.approveIcons(upload.input, author);
        await revokeGrant(f, grantB);
        const revoked = await publication(f);
        denied(
          await f.post(
            'upload-scopes',
            f.scopeInput(upload.input, { kind: 'base', categoryId: id }, bytes),
            author,
          ),
          'RATING_SCOPE_UNAVAILABLE',
        );
        denied(
          await f.post('prepare', upload.input, author),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        closed(
          await f.commit(upload.input, prepared.contextRevision, author),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        assert.deepEqual(await publication(f), revoked);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [upload.status.assetId],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);

test(
  'C1 ready uploads and prepared Review never substitute for current grant, phone, Safety or topology facts',
  { timeout: 480000 },
  async (t) => {
    const { f, bytes } = await pngFixture();
    t.after(() => f.close());
    for (const kind of [
      'grant-revoked',
      'phone-revoked',
      'phone-expired',
      'safety-restricted',
      'safety-expired',
      'topology-revoked',
      'topology-expired',
      'grant-expired',
    ] as const) {
      await t.test(kind, async () => {
        const actor = await f.actor();
        const now = (
          await f.pool.query<{ now: Date }>('SELECT clock_timestamp() now')
        ).rows[0]!.now;
        const expiry =
          kind === 'grant-expired'
            ? new Date(now.getTime() + 30000)
            : undefined;
        const grant = await exactGrant(f, actor, f.campusA, expiry);
        const { upload, prepared } = await readyAndPrepared(f, actor, bytes);
        let code: string;
        switch (kind) {
          case 'grant-revoked':
            await revokeGrant(f, grant);
            code = 'RATING_SCOPE_UNAVAILABLE';
            break;
          case 'grant-expired': {
            const remaining = (
              await f.pool.query<{ remaining: number }>(
                'SELECT extract(epoch FROM (expires_at-clock_timestamp()))::double precision*1000 remaining FROM whaleu_authorization.rating_category_campus_grants WHERE id=$1',
                [grant],
              )
            ).rows[0]!.remaining;
            assert.ok(
              remaining > 0,
              'The genuine upload and preparation must finish while this exact grant is still current',
            );
            await delay(Math.ceil(remaining) + 25);
            assert.equal(
              (
                await f.pool.query<{ expired: boolean }>(
                  'SELECT expires_at<=clock_timestamp() expired FROM whaleu_authorization.rating_category_campus_grants WHERE id=$1',
                  [grant],
                )
              ).rows[0]!.expired,
              true,
            );
            code = 'RATING_SCOPED_CONTEXT_CHANGED';
            break;
          }
          case 'phone-revoked':
          case 'phone-expired':
            await f.certify(
              actor.accountId,
              kind === 'phone-revoked'
                ? { phone: 'unverified' }
                : { expiresAt: new Date(Date.now() - 1000) },
            );
            code = 'PHONE_VERIFICATION_REQUIRED';
            break;
          case 'safety-restricted':
          case 'safety-expired':
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                kind === 'safety-restricted'
                  ? 'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1'
                  : "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()-interval '1 second' WHERE account_id=$1",
                [actor.accountId],
              ),
            );
            code =
              kind === 'safety-restricted'
                ? 'SAFETY_ACTION_RESTRICTED'
                : 'SAFETY_UNAVAILABLE';
            break;
          case 'topology-revoked':
          case 'topology-expired':
            await appendTopologyRevision(
              f.pool,
              f.scope.topology,
              kind === 'topology-revoked'
                ? { coverageState: 'missing' }
                : { validUntil: Date.now() - 1000 },
            );
            code = 'RATING_SCOPED_CONTEXT_CHANGED';
            break;
        }
        const before = await publication(f);
        denied(
          await f.post('contexts', { selector: campus(f.campusA) }, actor),
          kind.startsWith('topology-')
            ? 'IDENTITY_CAMPUS_UNAVAILABLE'
            : kind === 'grant-expired'
              ? 'RATING_SCOPE_UNAVAILABLE'
              : code,
        );
        denied(
          await f.post(
            'upload-scopes',
            f.scopeInput(upload.input, { kind: 'new', key: 'root' }, bytes),
            actor,
          ),
          kind === 'grant-expired' || kind.startsWith('topology-')
            ? 'RATING_SCOPE_UNAVAILABLE'
            : code,
        );
        denied(await f.post('prepare', upload.input, actor), code);
        const result = await f.commit(
          upload.input,
          prepared.contextRevision,
          actor,
        );
        if (
          [
            'RATING_SCOPED_CONTEXT_CHANGED',
            'PHONE_VERIFICATION_REQUIRED',
            'SAFETY_ACTION_RESTRICTED',
          ].includes(code)
        ) {
          const receipt = closed(result, code);
          assert.deepEqual(
            (await f.commit(upload.input, prepared.contextRevision, actor))
              .body,
            receipt,
          );
        } else denied(result, code);
        assert.deepEqual(await publication(f), before);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [upload.status.assetId],
            )
          ).rowCount,
          0,
        );
        if (kind.startsWith('topology-'))
          f.scope.topologySnapshotId = await appendTopologyRevision(
            f.pool,
            f.scope.topology,
          );
      });
    }
  },
);

/** The original owner forbids an adopted source hold without an atomic
 * publication. Missing coverage cannot be compiled into that publication, so
 * preserve the real rejection instead of inventing a committed held state. */
async function assertSourceHoldRejected(f: CategoryIconManagementFixture) {
  const before = await publication(f);
  await assert.rejects(
    withCommunityScopeWriter(f.pool, async (tx) => {
      const source = (
        await tx.query<{ id: string; revision: string; source_key: string }>(
          `SELECT s.id,s.revision,s.source_key FROM whaleu_ratings.scoped_source_heads h
       JOIN whaleu_ratings.scoped_source_attestations s ON(s.id,s.revision)=(h.source_id,h.source_revision)
       WHERE h.source_kind='scope_capabilities' FOR UPDATE OF h`,
        )
      ).rows[0];
      assert.ok(source);
      const id = randomUUID(),
        revision = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_attestations
       (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
       SELECT $1,$2,s.source_kind,s.source_key,s.scope_keys,s.payload,
         whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',s.source_kind,'key',s.source_key,'scopeKeys',s.scope_keys,'payload',s.payload)),
         'missing','accepted',s.issuer,'synthetic-c1-authority-capability-hold',s.policy_reference,
         greatest(s.effective_at+interval '1 microsecond',clock_timestamp()),s.valid_until
       FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=$3`,
        [id, revision, source.id],
      );
      assert.equal(
        (
          await tx.query(
            `UPDATE whaleu_ratings.scoped_source_heads SET source_id=$1,source_revision=$2
       WHERE source_kind='scope_capabilities' AND source_key=$3 AND source_id=$4 AND source_revision=$5`,
            [id, revision, source.source_key, source.id, source.revision],
          )
        ).rowCount,
        1,
      );
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    }),
    {
      code: '23514',
      message:
        'Adopted source change requires complete atomic scoped publication',
    },
  );
  assert.deepEqual(await publication(f), before);
}

async function replaceCapabilitySource(f: CategoryIconManagementFixture) {
  const before = (
    await f.pool.query<{ source_id: string; source_revision: string }>(
      "SELECT source_id,source_revision FROM whaleu_ratings.scoped_source_heads WHERE source_kind='scope_capabilities'",
    )
  ).rows[0];
  assert.ok(before);
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const source = await f.capability({}, tx);
    assert.notEqual(source.id, before.source_id);
    await f.publish({ capability: source }, tx);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    const current = (
      await tx.query<{
        current: boolean;
        prior_current: boolean;
        digest_changed: boolean;
      }>(
        `SELECT whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current,
       whaleu_ratings.scoped_source_current(prior.id,prior.revision,clock_timestamp()) prior_current,
       s.digest<>prior.digest digest_changed FROM whaleu_ratings.scoped_source_attestations s
       CROSS JOIN whaleu_ratings.scoped_source_attestations prior WHERE s.id=$1 AND prior.id=$2`,
        [source.id, before.source_id],
      )
    ).rows[0];
    assert.deepEqual(current, {
      current: true,
      prior_current: false,
      digest_changed: true,
    });
  });
}

/** Registrations bind a genuine new activation with exact source, route, native,
 * coverage and adoption digests. Their original validity interval is either
 * future-dated or short-lived; no persisted deadline is later rewritten. */
async function advanceProtocol(
  f: CategoryIconManagementFixture,
  registration: 'future' | 'expiring' | 'absent',
) {
  const generation = randomUUID();
  const published = await withCommunityScopeWriter(f.pool, async (tx) => {
    const release = await f.publish({ activate: true, generation }, tx);
    if (registration !== 'absent') {
      const inserted = await tx.query(
        `INSERT INTO whaleu_ratings.category_icon_capability_sources
         (id,protocol_version_id,source_id,source_revision,source_digest,protocol_version,review_version,media_version,journal_version,
          extension_version,slots,routes_digest,native_digest,compatibility_digest,adoption_digest,coverage_digest,coverage_inventory,
          issuer,provenance_ref,valid_from,valid_until)
         SELECT gen_random_uuid(),v.id,c.source_id,c.source_revision,c.source_digest,c.protocol_version,c.review_version,c.media_version,c.journal_version,
          c.extension_version,c.slots,c.routes_digest,c.native_digest,c.compatibility_digest,
          whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',v.id,'generation',v.generation,
            'releaseId',v.release_id,'manifest',v.manifest,'compatibilityDigest',c.compatibility_digest,'coverageDigest',c.coverage_digest)),
          c.coverage_digest,c.coverage_inventory,c.issuer,
          'rating-category-icon-adoption:'||v.id::text||':'||c.source_id::text||':'||c.source_revision::text,
          CASE WHEN $1::boolean THEN clock_timestamp()+interval '1 minute' ELSE c.valid_from END,
          CASE WHEN $1::boolean THEN c.valid_until ELSE least(c.valid_until,clock_timestamp()+interval '30 seconds') END
         FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
         JOIN whaleu_ratings.category_icon_capability_sources c ON c.protocol_version_id=v.previous_version_id`,
        [registration === 'future'],
      );
      assert.equal(inserted.rowCount, f.logicalScopeKeys.length);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    }
    return release;
  });
  if (registration === 'future') {
    const registrations = (
      await f.pool.query<{
        future: boolean;
        current: boolean;
        source_current: boolean;
        at_activation: boolean;
      }>(
        `SELECT c.valid_from>clock_timestamp() future,
         whaleu_ratings.category_icon_capability_current(c.id,clock_timestamp()) current,
         whaleu_ratings.scoped_source_current(c.source_id,c.source_revision,clock_timestamp()) source_current,
         whaleu_ratings.category_icon_capability_current(c.id,c.valid_from+interval '1 microsecond') at_activation
       FROM whaleu_ratings.category_icon_capability_sources c JOIN whaleu_ratings.scope_protocol_heads h ON h.version_id=c.protocol_version_id`,
      )
    ).rows;
    assert.equal(registrations.length, f.logicalScopeKeys.length);
    for (const row of registrations)
      assert.deepEqual(row, {
        future: true,
        current: false,
        source_current: true,
        at_activation: true,
      });
  }
  return { generation, published };
}

/** Exercise the strict original owner after a new, genuine protocol generation
 * leaves Category-only registrations stale. True absence of the new tables is
 * separately covered by rating-category-icon-old-schema.test.ts on schema87. */
async function originalTextStillWorks(f: CategoryIconManagementFixture) {
  const post = (route: string, body: object) =>
    f
      .auth(
        request(f.ordinaryHttp).post(
          `/v2/ratings/category-management/${route}`,
        ),
      )
      .send(body);
  const result = await post('contexts', { selector: globalSelector });
  categoryIconHttpOk(result);
  const context = ratingCategoryManagementContextSchema.parse(result.body);
  const input = ratingCategoryScopedIntentSchema.parse({
    protocolVersion: 2,
    operation: 'create_categories_scoped',
    context: context.commandContext,
    payload: {
      clientRequestId: randomUUID(),
      expectedSnapshot: context.snapshotRevision,
      parentId: null,
      placement: { kind: 'global' },
      nodes: [
        {
          key: 'text_only',
          parentKey: null,
          name: 'Original v2 remains independent',
          description: 'No Category media claim',
        },
      ],
    },
  });
  const response = await post('prepare', input);
  categoryIconHttpOk(response);
  const prepared = ratingCategoryScopedPreparationSchema.parse(response.body);
  const stored = (
    await f.pool.query<{ category_plan: CategoryManagementPlan }>(
      'SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
      [f.admin.accountId, input.payload.clientRequestId],
    )
  ).rows[0];
  assert.ok(stored);
  await withCommunityScopeWriter(f.pool, async (tx) => {
    for (const envelope of stored.category_plan.envelopes)
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
  assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
  const next = await post('contexts', { selector: globalSelector });
  categoryIconHttpOk(next);
  const after = ratingCategoryManagementContextSchema.parse(next.body);
  categoryIconHttpOk(
    await f
      .auth(
        request(f.ordinaryHttp).get(
          `/v2/ratings/category-management/categories/${receipt.result.categoryIds[0]}`,
        ),
      )
      .query({
        contextId: after.commandContext.id,
        contextToken: after.commandContext.token,
      }),
  );
  const recovery = await f.auth(
    request(f.ordinaryHttp).get(
      `/v2/ratings/requests/${input.payload.clientRequestId}`,
    ),
  );
  categoryIconHttpOk(recovery);
  assert.deepEqual(recovery.body, receipt);
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.category_icon_definition_heads',
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
}

test(
  'C1 rejects illegal source holds and rechecks expired, future and stale source or protocol capabilities',
  { timeout: 600000 },
  async (t) => {
    for (const state of [
      'expired',
      'future',
      'stale-source',
      'stale-protocol',
    ] as const) {
      await t.test(state, async () => {
        const f = await categoryIconManagementFixture([], { runtime: false });
        try {
          if (state === 'expired') {
            await assertSourceHoldRejected(f);
            await advanceProtocol(f, 'expiring');
          }
          const input = await createIntent(f),
            prepared = await f.prepare(input);
          await f.approveText(input);
          await f.approveIcons(input);
          const declaration = Buffer.from(
            'Synthetic declaration; Media is not enabled',
          );
          categoryIconHttpOk(
            await f.post(
              'upload-scopes',
              f.scopeInput(input, { kind: 'new', key: 'root' }, declaration),
            ),
          );
          const publicRead = await f.publicPage();
          const registrations = (
            await f.pool.query<{
              id: string;
              protocol_version_id: string;
              source_digest: string;
              current: boolean;
            }>(
              `SELECT c.id,c.protocol_version_id,c.source_digest,
             whaleu_ratings.category_icon_capability_current(c.id,clock_timestamp()) current
             FROM whaleu_ratings.category_icon_capability_sources c
             JOIN whaleu_ratings.scope_protocol_heads h ON h.version_id=c.protocol_version_id ORDER BY c.id`,
            )
          ).rows;
          assert.ok(registrations.length > 0);
          assert.ok(registrations.every((row) => row.current));
          if (state === 'stale-protocol' || state === 'future') {
            const { generation, published } = await advanceProtocol(
              f,
              state === 'future' ? 'future' : 'absent',
            );
            assert.notEqual(published.releaseId, f.adopted.releaseId);
            const heads = (
              await f.pool.query<{
                generation: string;
                version_id: string;
                previous_version_id: string;
              }>(
                `SELECT v.generation,h.version_id,v.previous_version_id FROM whaleu_ratings.scope_protocol_heads h
               JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id ORDER BY h.logical_scope_key`,
              )
            ).rows;
            assert.equal(heads.length, registrations.length);
            for (const head of heads) {
              assert.equal(head.generation, generation);
              assert.ok(
                registrations.some(
                  (row) => row.protocol_version_id === head.previous_version_id,
                ),
              );
              assert.ok(
                registrations.every(
                  (row) => row.protocol_version_id !== head.version_id,
                ),
              );
            }
          } else if (state === 'stale-source') await replaceCapabilitySource(f);
          else {
            const remaining = (
              await f.pool.query<{ remaining: number }>(
                `SELECT extract(epoch FROM (max(valid_until)-clock_timestamp()))::double precision*1000 remaining
               FROM whaleu_ratings.category_icon_capability_sources WHERE id=ANY($1::uuid[])`,
                [registrations.map((row) => row.id)],
              )
            ).rows[0]!.remaining;
            assert.ok(
              remaining > 0,
              'Real prepare and read must finish before the original registration deadline',
            );
            await delay(Math.ceil(remaining) + 25);
            const expiration = (
              await f.pool.query<{ expired: boolean; source_current: boolean }>(
                `SELECT c.valid_until<=clock_timestamp() expired,
               whaleu_ratings.scoped_source_current(c.source_id,c.source_revision,clock_timestamp()) source_current
               FROM whaleu_ratings.category_icon_capability_sources c WHERE id=ANY($1::uuid[])`,
                [registrations.map((row) => row.id)],
              )
            ).rows;
            assert.equal(expiration.length, registrations.length);
            for (const row of expiration)
              assert.deepEqual(row, { expired: true, source_current: true });
          }
          const changed = (
            await f.pool.query<{
              id: string;
              protocol_version_id: string;
              source_digest: string;
              current: boolean;
            }>(
              `SELECT id,protocol_version_id,source_digest,
             whaleu_ratings.category_icon_capability_current(id,clock_timestamp()) current
             FROM whaleu_ratings.category_icon_capability_sources WHERE id=ANY($1::uuid[]) ORDER BY id`,
              [registrations.map((row) => row.id)],
            )
          ).rows;
          assert.deepEqual(
            changed,
            registrations.map((row) => ({ ...row, current: false })),
            'The immutable exact registrations remain present, but their real owner dependencies no longer authorize C1',
          );
          const before = await publication(f);
          denied(
            await f.post('contexts', { selector: globalSelector }),
            'RATING_SCOPE_UNAVAILABLE',
          );
          denied(
            await f.post(
              'upload-scopes',
              f.scopeInput(input, { kind: 'new', key: 'root' }, declaration),
            ),
            'RATING_SCOPE_UNAVAILABLE',
          );
          denied(
            await f.post('prepare', input),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          denied(
            await f
              .auth(
                request(f.http).get(
                  '/v5/ratings/category-management/categories',
                ),
              )
              .query({
                contextId: input.context.id,
                contextToken: input.context.token,
              }),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          denied(
            await f.auth(request(f.http).get('/v5/ratings/categories')).query({
              contextId: publicRead.context.id,
              contextToken: publicRead.context.token,
              limit: 50,
            }),
            'RATING_SCOPE_UNAVAILABLE',
          );
          closed(
            await f.commit(input, prepared.contextRevision),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          assert.deepEqual(await publication(f), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.category_icon_appearances',
              )
            ).rowCount,
            0,
          );
          if (state === 'stale-protocol') await originalTextStillWorks(f);
        } finally {
          await f.close();
        }
      });
    }
  },
);
