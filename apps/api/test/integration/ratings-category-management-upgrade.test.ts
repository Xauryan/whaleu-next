/** Real version-boundary tests. Fixtures start at 0065, before any C schema,
 * then use the ordinary migration runner, source publishers and HTTP owners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import request from 'supertest';
import {
  ratingScopedFixture,
  writeRatingScopedApproval,
} from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { ratingCategoryManagementFixture } from '../support/rating-category-management-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
} from '../../src/ratings/category-management/scoped-contracts.js';

interface OriginalTable {
  table_schema: string;
  table_name: string;
  columns: string[];
}
const migrationsThrough = async (maximum: number) =>
  (
    await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    )
  ).filter((migration) => Number(migration.name.slice(0, 4)) <= maximum);
async function originalTables(pool: Pool): Promise<OriginalTable[]> {
  return (
    await pool.query<OriginalTable>(`SELECT c.table_schema,c.table_name,array_agg(c.column_name::text ORDER BY c.ordinal_position) columns
    FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema LIKE 'whaleu_%' AND t.table_type='BASE TABLE' AND c.table_name<>'schema_migrations'
    GROUP BY c.table_schema,c.table_name ORDER BY 1,2`)
  ).rows;
}
async function oldColumnBytes(pool: Pool, tables: readonly OriginalTable[]) {
  const values: Record<string, unknown> = {};
  for (const table of tables) {
    for (const identifier of [
      table.table_schema,
      table.table_name,
      ...table.columns,
    ])
      assert.match(identifier, /^[a-z_][a-z_0-9]*$/);
    const projection = table.columns.map((column) => `"${column}"`).join(',');
    values[`${table.table_schema}.${table.table_name}`] = (
      await pool.query(`SELECT to_jsonb(original) value FROM
      (SELECT ${projection} FROM ${table.table_schema}.${table.table_name}) original ORDER BY to_jsonb(original)::text`)
    ).rows;
  }
  return values;
}
async function schemaInventory(pool: Pool) {
  return (
    await pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu_%'),
    'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_schema,c.table_name,c.ordinal_position) FROM information_schema.columns c WHERE c.table_schema LIKE 'whaleu_%'),
    'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.proname,p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'whaleu_%'),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.conname,pg_get_constraintdef(c.oid)) ORDER BY n.nspname,c.conname,c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname LIKE 'whaleu_%'),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu_%'),
    'migrations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM whaleu_meta.schema_migrations m)
  ) value`)
  ).rows[0]!.value;
}

test(
  'M3C actual 0065 to 0069 upgrade preserves every old column and receipt, stays closed without policy, then supports real management',
  { timeout: 360000 },
  async (t) => {
    const f = await ratingScopedFixture(65);
    t.after(() => f.close());
    const actor = f.creator;
    await f.grant(actor, 'super_admin');
    const data = await f.seedScopedCatalogs({ different: false });
    const oldLife = [
      await f.lifecycle(data.local, f.campusA, false, true),
      await f.lifecycle(data.local, f.campusB, true, true),
    ];
    await f.issueSource({
      kind: 'native_scoped_create',
      key: 'synthetic-native-scoped-create',
      scopeKeys: f.scopeKeys,
      payload: {
        enabled: true,
        genericKind: 'general',
        scopeKeys: [...f.scopeKeys],
      },
    });
    await f.publish({ activate: true });
    const oldVersion = (
      await f.pool.query<{ name: string }>(
        'SELECT name FROM whaleu_meta.schema_migrations ORDER BY name DESC LIMIT 1',
      )
    ).rows[0]!;
    assert(oldVersion.name.startsWith('0065_'));
    assert.equal(
      (
        await f.pool.query<{ name: string | null }>(
          "SELECT to_regclass('whaleu_authorization.rating_category_campus_grants')::text name",
        )
      ).rows[0]!.name,
      null,
    );
    for (const lifecycle of oldLife) {
      const payload = (
        await f.pool.query<{ payload: Record<string, unknown> }>(
          'SELECT payload FROM whaleu_ratings.scoped_source_attestations WHERE id=$1',
          [lifecycle.id],
        )
      ).rows[0]!.payload;
      assert(
        !Object.hasOwn(payload, 'management') &&
          !Object.hasOwn(payload, 'businessState'),
      );
    }
    // A real pre-C v2 command supplies original preparation, Review and receipt
    // bytes. No request/receipt or final projection is inserted by the test.
    const oldContext = await f.scopedContext(
      actor,
      { kind: 'global' },
      'create_target',
    );
    const oldCategory = (
      await f.pool.query<{ effective_revision: string }>(
        'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
        [oldContext.heads[0]!.catalogRevision, data.global.categoryId],
      )
    ).rows[0]!;
    const oldIntent = ratingScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'create_target_scoped',
      context: scopedCommandContext(oldContext),
      payload: {
        clientRequestId: randomUUID(),
        categoryId: data.global.categoryId,
        expectedCategoryRevision: oldCategory.effective_revision,
        name: 'Genuine 0065 target',
        description: 'Historical v5 receipt',
        assetIds: [],
      },
    });
    const oldPreparedResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/prepare'), actor)
      .send(oldIntent);
    assert.equal(
      oldPreparedResponse.status,
      200,
      JSON.stringify(oldPreparedResponse.body),
    );
    const oldPrepared = ratingScopedPreparationSchema.parse(
      oldPreparedResponse.body,
    );
    const envelope = (
      await f.pool.query<{ envelope: unknown }>(
        'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, oldIntent.payload.clientRequestId],
      )
    ).rows[0]!.envelope;
    await f.approveScoped(canonicalRatingScopedEnvelope(envelope));
    const oldResponse = await f
      .auth(request(f.http).post('/v2/ratings/management/targets'), actor)
      .send({
        ...oldIntent,
        preparationContextRevision: oldPrepared.contextRevision,
      });
    assert.equal(oldResponse.status, 200, JSON.stringify(oldResponse.body));
    const oldReceipt = scopedSuccess(oldResponse.body);
    const tables = await originalTables(f.pool),
      before = await oldColumnBytes(f.pool, tables);
    await runMigrations(f.pool, await migrationsThrough(69), { mode: 'up' });
    assert.deepEqual(
      await oldColumnBytes(f.pool, tables),
      before,
      '0066–0069 cannot rewrite any preexisting field, including original Review, receipt, lifecycle and source bytes',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_authorization.rating_category_campus_grants',
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_ratings.scoped_source_attestations WHERE source_kind IN ('native_scoped_category_management','scoped_category_system_registry')",
        )
      ).rowCount,
      0,
      'migration does not invent authority or policy ingress',
    );
    const requestContext = () =>
      f
        .auth(
          request(f.http).post('/v2/ratings/category-management/contexts'),
          actor,
        )
        .send({ selector: { kind: 'campus', campusId: f.campusA } });
    const denied = await requestContext();
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    const recovery = () =>
      f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${oldIntent.payload.clientRequestId}`,
        ),
        actor,
      );
    const preserved = await recovery();
    assert.equal(preserved.status, 200, JSON.stringify(preserved.body));
    assert.deepEqual(preserved.body, oldReceipt);
    const historicalSources = (
      await f.pool.query<{ id: string; value: unknown }>(
        'SELECT id,to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s ORDER BY id',
      )
    ).rows;
    // Post-upgrade issuance is a normal accepted source/head and one full atomic
    // source_release in the already adopted domain, rather than seed activation.
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID(),
        revision = randomUUID(),
        scopeKeys = [...f.scopeKeys].sort();
      const payload = {
        enabled: true,
        operations: [...ratingCategoryScopedOperations],
      };
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_attestations
      (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
      VALUES($1,$2,'native_scoped_category_management','synthetic-upgrade-management',$3::text[],$4::jsonb,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind','native_scoped_category_management','key','synthetic-upgrade-management','scopeKeys',$3::text[],'payload',$4::jsonb)),
      'complete','accepted','synthetic-scoped-issuer','synthetic-upgrade-management-source','synthetic-upgrade-management-policy',clock_timestamp(),clock_timestamp()+interval '30 minutes')`,
        [id, revision, scopeKeys, canonicalJson(payload)],
      );
      await tx.query(
        "INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES('native_scoped_category_management','synthetic-upgrade-management',$1,$2)",
        [id, revision],
      );
      await f.publish({}, tx);
    });
    const contextResponse = await requestContext();
    assert.equal(
      contextResponse.status,
      200,
      JSON.stringify(contextResponse.body),
    );
    const context = ratingCategoryManagementContextSchema.parse(
      contextResponse.body,
    );
    const input = ratingCategoryScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'edit_category_base_scoped',
      context: context.commandContext,
      payload: {
        clientRequestId: randomUUID(),
        expectedSnapshot: context.snapshotRevision,
        categoryId: data.local.categoryId,
        name: 'Upgraded through genuine C command',
        description: 'Preserve both original lifecycle views',
      },
    });
    const preparedResponse = await f
      .auth(
        request(f.http).post('/v2/ratings/category-management/prepare'),
        actor,
      )
      .send(input);
    assert.equal(
      preparedResponse.status,
      200,
      JSON.stringify(preparedResponse.body),
    );
    const prepared = ratingCategoryScopedPreparationSchema.parse(
      preparedResponse.body,
    );
    const pending = (
      await f.pool.query<{ category_plan: { envelopes: unknown[] } }>(
        'SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, input.payload.clientRequestId],
      )
    ).rows[0]!;
    assert.equal(pending.category_plan.envelopes.length, 1);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const value of pending.category_plan.envelopes)
        await writeRatingScopedApproval(
          tx,
          canonicalRatingScopedEnvelope(value),
        );
    });
    const committed = await f
      .auth(
        request(f.http).post('/v2/ratings/category-management/commit'),
        actor,
      )
      .send({
        intent: input,
        preparationContextRevision: prepared.contextRevision,
      });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(
      ratingCategoryScopedReceiptSchema.parse(committed.body).outcome,
      'applied',
    );
    const successors = (
      await f.pool.query<{
        scope_keys: string[];
        payload: Record<string, unknown>;
      }>(
        `SELECT s.scope_keys,s.payload FROM whaleu_ratings.scoped_source_heads h
    JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
    WHERE s.source_kind='scoped_category_lifecycle' AND s.payload->>'categoryId'=$1`,
        [data.local.categoryId],
      )
    ).rows;
    assert.equal(successors.length, 2);
    for (const row of successors) {
      assert.equal(row.payload['businessState'], 'enabled');
      assert.equal(row.payload['active'], true);
      assert.equal(
        row.payload['hidden'],
        row.scope_keys[0] === `campus:${f.campusB}`,
      );
    }
    assert.deepEqual(
      (
        await f.pool.query<{ id: string; value: unknown }>(
          'SELECT id,to_jsonb(s) value FROM whaleu_ratings.scoped_source_attestations s WHERE id=ANY($1::uuid[]) ORDER BY id',
          [historicalSources.map((row) => row.id)],
        )
      ).rows,
      historicalSources,
    );
    const finalRecovery = await recovery();
    assert.equal(finalRecovery.status, 200, JSON.stringify(finalRecovery.body));
    assert.deepEqual(finalRecovery.body, oldReceipt);
  },
);

test(
  'M3C 0066 fingerprint rejects an unrecognized 0065 owner body with exact 23514 and no partial schema',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture(65);
    t.after(() => f.close());
    const target = (
      await f.pool.query<{
        definition: string;
        prosrc: string;
      }>(`SELECT pg_get_functiondef(p.oid) definition,p.prosrc FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_ratings' AND p.proname='legacy_bridge_source_causal'`)
    ).rows;
    assert.equal(target.length, 1);
    const definition = target[0]!.definition;
    assert(definition.includes('AS $function$'));
    const changed = definition.replace(
      'AS $function$',
      'AS $function$\n-- synthetic unrecognized owner body: same behavior, different fingerprint\n',
    );
    assert.notEqual(changed, definition);
    await f.pool.query(changed);
    const altered = (
      await f.pool.query<{
        prosrc: string;
      }>(`SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='whaleu_ratings' AND p.proname='legacy_bridge_source_causal'`)
    ).rows[0]!;
    assert.notEqual(altered.prosrc, target[0]!.prosrc);
    const schemaBefore = await schemaInventory(f.pool),
      tables = await originalTables(f.pool),
      rowsBefore = await oldColumnBytes(f.pool, tables);
    await assert.rejects(
      runMigrations(f.pool, await migrationsThrough(69), { mode: 'up' }),
      (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23514' &&
        'message' in error &&
        typeof error.message === 'string' &&
        error.message.includes(
          'Unexpected M3B function fingerprint: whaleu_ratings.legacy_bridge_source_causal',
        ),
    );
    assert.deepEqual(
      await schemaInventory(f.pool),
      schemaBefore,
      'the rejected 0066 transaction cannot leave tables, columns, functions, triggers, constraints or migration records',
    );
    assert.deepEqual(await oldColumnBytes(f.pool, tables), rowsBefore);
    assert.equal(
      (
        await f.pool.query<{ value: string | null }>(
          "SELECT to_regclass('whaleu_authorization.rating_category_campus_grants')::text value",
        )
      ).rows[0]!.value,
      null,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='whaleu_ratings' AND table_name='scoped_command_preparations' AND column_name IN ('command_family','category_plan')",
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'M3C system base text edit cannot smuggle changed maximumDepth or originKind through a correctly rehashed source envelope',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const create = f.managementIntent(
      await f.managementContext(f.admin),
      'create_system_category_scoped',
      {
        systemKey: 'synthetic_general',
        name: 'System with immutable structural metadata',
        description: '',
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        levelCount: 2,
      },
    );
    const result = await f.executeManagement(f.admin, create);
    if (result.receipt.outcome !== 'applied') assert.fail();
    const categoryId = result.receipt.result.categoryIds[0]!;
    const context = await f.managementContext(f.admin);
    const edit = () =>
      f.managementIntent(context, 'edit_category_base_scoped', {
        categoryId,
        name: 'Only the system base text is edited',
        description: '',
      });
    const control = edit();
    const valid = await withCommunityScopeWriter(f.pool, (tx) =>
      f.rawCategoryPreparation(tx, f.admin, control),
    );
    assert.equal(
      valid.plan.noop,
      false,
      'a legal system text edit is accepted before testing structural forgeries',
    );
    for (const field of ['maximumDepth', 'originKind'] as const)
      await t.test(field, async () => {
        const input = edit();
        let reachedSql = false;
        await f.rejectCategorySql(`system text edit changes ${field}`, (tx) =>
          f.rawCategoryPreparation(tx, f.admin, input, (plan) => {
            const base = plan.sourceIssues.find(
              (source) => source.kind === 'scoped_category_base',
            );
            assert(base);
            assert.equal(base.payload['maximumDepth'], 2);
            assert.equal(base.payload['originKind'], 'system');
            const reviewed = canonicalRatingScopedEnvelope(
              base.payload['reviewEnvelope'],
            );
            if (reviewed.purpose !== 'publish_rating_category_base_scoped')
              assert.fail();
            const payload = { ...base.payload };
            delete payload['reviewEnvelope'];
            delete payload['issuanceDigest'];
            payload[field] = field === 'maximumDepth' ? 3 : 'regional';
            const issuanceDigest = ratingScopedDigest('category-issuance', {
              accountId: plan.accountId,
              requestId: plan.requestId,
              intentHash: plan.intentHash,
              kind: base.kind,
              key: base.key,
              scopeKeys: base.scopeKeys,
              payload,
            });
            const envelope = canonicalRatingScopedEnvelope({
              ...reviewed,
              issuanceDigest,
            });
            if (envelope.purpose !== 'publish_rating_category_base_scoped')
              assert.fail();
            base.payload = {
              ...payload,
              issuanceDigest,
              reviewEnvelope: envelope,
            };
            plan.envelopes = plan.envelopes.map((original) =>
              original.sourceId === base.id ? envelope : original,
            );
            reachedSql = true;
          }),
        );
        assert(
          reachedSql,
          'the exact hostile intent/source reaches SQL with fresh issuance and preview digests',
        );
      });
  },
);

test(
  'M3C global-only registry deadline fences campus preparation and expired commit while cancellation and receipts remain usable',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const registry = await withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID(),
        revision = randomUUID(),
        scopeKeys = ['global'];
      const payload = {
        enabled: true,
        systemKey: 'synthetic_deadline',
        kind: 'general',
        consumer: 'ratings_general_v1',
        maximumDepth: 3,
        allowChildren: true,
        allowDisable: true,
        allowCampusOverride: true,
      };
      const inserted = (
        await tx.query<{ valid_until: Date }>(
          `INSERT INTO whaleu_ratings.scoped_source_attestations
      (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
      VALUES($1,$2,'scoped_category_system_registry','synthetic-global-deadline-registry',$3::text[],$4::jsonb,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind','scoped_category_system_registry','key','synthetic-global-deadline-registry','scopeKeys',$3::text[],'payload',$4::jsonb)),
      'complete','accepted','synthetic-scoped-issuer','synthetic-global-registry-source','synthetic-global-registry-policy',clock_timestamp(),clock_timestamp()+interval '8 seconds') RETURNING valid_until`,
          [id, revision, scopeKeys, canonicalJson(payload)],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES('scoped_category_system_registry','synthetic-global-deadline-registry',$1,$2)",
        [id, revision],
      );
      await f.publish({}, tx);
      return { id, revision, deadline: inserted.valid_until };
    });
    const context = await f.managementContext(f.admin);
    const make = (name: string) =>
      f.managementIntent(context, 'create_system_category_scoped', {
        systemKey: 'synthetic_deadline',
        name,
        description: '',
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        levelCount: 1,
      });
    const input = make('Must not publish after registry deadline'),
      pendingCancel = make('Cancellation still works after registry deadline');
    const prepared = await f.prepareManagement(f.admin, input),
      cancellationPreparation = await f.prepareManagement(
        f.admin,
        pendingCancel,
      );
    const plan = (await f.managementPlan(f.admin, input)).category_plan;
    const persisted = (
      await f.pool.query<{ valid_until: Date }>(
        'SELECT valid_until FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [f.admin.accountId, input.payload.clientRequestId],
      )
    ).rows[0]!;
    assert.deepEqual(
      plan.affectedScopeKeys,
      [`campus:${f.campusA}`],
      'registry coverage alone is not a requested publication scope',
    );
    assert.deepEqual(plan.registrySourceIds, [registry.id]);
    assert(Date.parse(plan.validUntil) <= registry.deadline.getTime());
    assert(persisted.valid_until.getTime() <= registry.deadline.getTime());
    assert(Date.parse(prepared.expiresAt) <= registry.deadline.getTime());
    assert(
      Date.parse(cancellationPreparation.expiresAt) <=
        registry.deadline.getTime(),
    );
    await f.approveManagement(f.admin, input);
    const before = await f.managementArtifacts();
    const remaining = (
      await f.pool.query<{ milliseconds: number }>(
        'SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::double precision milliseconds',
        [registry.deadline],
      )
    ).rows[0]!.milliseconds;
    await delay(Math.ceil(remaining) + 50);
    assert.equal(
      (
        await f.pool.query<{ expired: boolean }>(
          'SELECT clock_timestamp()>=$1::timestamptz expired',
          [registry.deadline],
        )
      ).rows[0]!.expired,
      true,
    );
    const committed = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    const closed = ratingCategoryScopedReceiptSchema.parse(committed.body);
    if (closed.outcome !== 'closed') assert.fail(JSON.stringify(closed));
    assert.equal(closed.code, 'RATING_SCOPED_CONTEXT_CHANGED');
    const cancelled = await f.managementPost(f.admin, 'cancel', pendingCancel);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const cancelledReceipt = ratingCategoryScopedReceiptSchema.parse(
      cancelled.body,
    );
    if (cancelledReceipt.outcome !== 'closed')
      assert.fail(JSON.stringify(cancelledReceipt));
    assert.equal(cancelledReceipt.code, 'RATING_CATEGORY_CANCELLED');
    assert.deepEqual(
      await f.managementArtifacts(),
      before,
      'expired registry cannot publish any source, head, release, binding or effect',
    );
    for (const [command, receipt] of [
      [input, closed],
      [pendingCancel, cancelledReceipt],
    ] as const) {
      const recovered = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${command.payload.clientRequestId}`,
        ),
        f.admin,
      );
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.deepEqual(recovered.body, receipt);
      const replay = await f.managementPost(f.admin, 'cancel', command);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body, receipt);
    }
  },
);

test(
  'M3C shared base waits for all exact A/B override reviews atomically and resumes the same intent after missing approvals arrive',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const localA = f.managementIntent(
      await f.managementContext(f.admin),
      'set_category_override_scoped',
      {
        categoryId: f.data.local.categoryId,
        name: { mode: 'set', value: 'Existing exact A override' },
        description: { mode: 'set', value: 'A description' },
      },
    );
    await f.executeManagement(f.admin, localA);
    const input = f.managementIntent(
      await f.managementContext(f.admin),
      'edit_category_base_scoped',
      {
        categoryId: f.data.local.categoryId,
        name: 'Shared base requiring every exact review',
        description: 'Both override envelopes must be re-approved',
      },
    );
    const prepared = await f.prepareManagement(f.admin, input),
      plan = (await f.managementPlan(f.admin, input)).category_plan;
    assert.equal(plan.envelopes.length, 3);
    const base = plan.envelopes.find(
      (envelope) => envelope.purpose === 'publish_rating_category_base_scoped',
    );
    assert(base);
    const overrides = plan.envelopes.filter(
      (envelope) =>
        envelope.purpose === 'publish_rating_category_override_scoped',
    );
    assert.equal(overrides.length, 2);
    assert.deepEqual(
      overrides.map((envelope) => envelope.scope.campusId).sort(),
      [f.campusA, f.campusB].sort(),
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      writeRatingScopedApproval(tx, base),
    );
    const before = {
      artifacts: await f.managementArtifacts(),
      ledger: await f.managementLedger(),
    };
    const unavailable = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
    assert.deepEqual(
      {
        artifacts: await f.managementArtifacts(),
        ledger: await f.managementLedger(),
      },
      before,
      'partial approvals cannot leave source, head, release, request or receipt artifacts',
    );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const envelope of overrides)
        await writeRatingScopedApproval(tx, envelope);
    });
    const successful = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(successful.status, 200, JSON.stringify(successful.body));
    const receipt = ratingCategoryScopedReceiptSchema.parse(successful.body);
    assert.equal(receipt.outcome, 'applied');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.rating_scoped_category_source_bindings WHERE source_id=ANY($1::uuid[])',
          [plan.envelopes.map((envelope) => envelope.sourceId)],
        )
      ).rowCount,
      3,
    );
    const replay = await f.commitManagement(
      f.admin,
      input,
      prepared.contextRevision,
    );
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, receipt);
  },
);

test(
  'M3C statement-local category eligibility stays exact across campuses, subtree scope changes and current parent Review changes',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingCategoryManagementFixture();
    t.after(() => f.close());
    const keyA = `campus:${f.campusA}`,
      keyB = `campus:${f.campusB}`;
    const actorA = await f.actor({ campusId: f.campusA }),
      actorB = await f.actor({ campusId: f.campusB });
    const childCommand = f.managementIntent(
      await f.managementContext(f.admin),
      'create_categories_scoped',
      {
        parentId: f.data.local.categoryId,
        placement: {
          kind: 'campuses',
          campusIds: [f.campusA, f.campusB].sort(),
        },
        nodes: [
          {
            key: 'child',
            parentKey: null,
            name: 'Same stable child in two eligibility domains',
            description: '',
          },
        ],
      },
    );
    const created = await f.executeManagement(f.admin, childCommand);
    if (created.receipt.outcome !== 'applied') assert.fail();
    const childId = created.receipt.result.categoryIds[0]!;
    const createTarget = async (
      actor: Awaited<ReturnType<typeof f.actor>>,
      campusId: string,
    ) => {
      const context = await f.scopedContext(
        actor,
        { kind: 'campus', campusId },
        'create_target',
      );
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [context.heads[0]!.catalogRevision, childId],
        )
      ).rows[0]!;
      const input = ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'create_target_scoped',
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: childId,
          expectedCategoryRevision: category.effective_revision,
          name: `Native target in ${campusId}`,
          description: '',
          assetIds: [],
        },
      });
      const prepResponse = await f
        .auth(request(f.http).post('/v2/ratings/management/prepare'), actor)
        .send(input);
      assert.equal(prepResponse.status, 200, JSON.stringify(prepResponse.body));
      const prep = ratingScopedPreparationSchema.parse(prepResponse.body);
      const envelope = (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0]!.envelope;
      await f.approveScoped(canonicalRatingScopedEnvelope(envelope));
      const committed = await f
        .auth(request(f.http).post('/v2/ratings/management/targets'), actor)
        .send({ ...input, preparationContextRevision: prep.contextRevision });
      assert.equal(committed.status, 200, JSON.stringify(committed.body));
      const targetId = scopedSuccess(committed.body).result['targetId'];
      assert(typeof targetId === 'string');
      return targetId;
    };
    const targetA = await createTarget(actorA, f.campusA),
      targetB = await createTarget(actorB, f.campusB);
    const placementBytes = async () =>
      (
        await f.pool.query<{ value: unknown }>(
          'SELECT to_jsonb(p) value FROM whaleu_ratings.target_scope_placements p WHERE target_id=ANY($1::uuid[]) ORDER BY target_id,placement_revision',
          [[targetA, targetB]],
        )
      ).rows;
    const originalPlacements = await placementBytes();
    assert.equal(originalPlacements.length, 2);
    const eligibility = async () =>
      Object.fromEntries(
        (
          await f.pool.query<{ scope: string; eligible: boolean }>(
            `SELECT scope,whaleu_ratings.category_scope_eligible($1,scope) eligible
    FROM unnest($2::text[]) scope ORDER BY scope`,
            [childId, [keyA, keyB]],
          )
        ).rows.map((row) => [row.scope, row.eligible]),
      );
    const memberships = async () =>
      (
        await f.pool.query<{ scope_key: string; target_id: string }>(
          `SELECT h.scope_key,m.target_id FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_target_memberships m ON m.catalog_id=h.catalog_id WHERE m.category_id=$1 ORDER BY h.scope_key,m.target_id`,
          [childId],
        )
      ).rows;
    const both = [
      { scope_key: keyA, target_id: targetA },
      { scope_key: keyB, target_id: targetB },
    ].sort((a, b) => a.scope_key.localeCompare(b.scope_key));
    assert.deepEqual(await eligibility(), { [keyA]: true, [keyB]: true });
    assert.deepEqual(await memberships(), both);
    const changeScope = async (campusIds: string[]) =>
      f.executeManagement(
        f.admin,
        f.managementIntent(
          await f.managementContext(f.admin),
          'set_category_scope_scoped',
          {
            categoryId: f.data.local.categoryId,
            placement: { kind: 'campuses', campusIds: [...campusIds].sort() },
            propagation: 'subtree',
          },
        ),
      );
    await changeScope([f.campusA]);
    assert.deepEqual(
      await eligibility(),
      { [keyA]: true, [keyB]: false },
      'same stable category ID cannot reuse A eligibility for B after parent subtree exit',
    );
    assert.deepEqual(await memberships(), [
      { scope_key: keyA, target_id: targetA },
    ]);
    assert.deepEqual(
      await placementBytes(),
      originalPlacements,
      'scope exit affects compiled membership, not original target placement',
    );
    await changeScope([f.campusA, f.campusB]);
    assert.deepEqual(await eligibility(), { [keyA]: true, [keyB]: true });
    assert.deepEqual(
      await memberships(),
      both,
      're-add must freshly recompute B eligibility and restore its original target',
    );
    assert.deepEqual(await placementBytes(), originalPlacements);
    const parentDecision = (
      await f.pool.query<{ decision_id: string }>(
        `SELECT b.decision_id FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id
    JOIN whaleu_community.rating_scoped_category_source_bindings b ON (b.source_id,b.source_revision)=(l.base_source_id,l.base_source_revision)
    WHERE h.scope_key=$1 AND l.category_id=$2`,
        [keyA, f.data.local.categoryId],
      )
    ).rows[0]!.decision_id;
    for (const state of ['held', 'revoked'] as const)
      await t.test(
        `fresh SQL verification observes parent ${state}`,
        async () => {
          const before = {
            artifacts: await f.managementArtifacts(),
            ledger: await f.managementLedger(),
          };
          let verifiedFreshCatalog = false,
            reachedChangedReview = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const fresh = await f.publish({}, tx);
              const catalog = fresh.outputs.find(
                (output) => output.scopeKey === keyA,
              );
              assert(catalog);
              await tx.query(
                'SELECT whaleu_ratings.verify_scoped_catalog($1)',
                [catalog.id],
              );
              verifiedFreshCatalog = true;
              const event = randomUUID();
              await tx.query(
                `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
        VALUES($1,$2,$3,'complete','accepted','synthetic-rating-review','synthetic-current-parent-eligibility',clock_timestamp())`,
                [event, parentDecision, state],
              );
              await tx.query(
                'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
                [parentDecision, event],
              );
              const changed = (
                await tx.query<{ scope: string; eligible: boolean }>(
                  `SELECT scope,whaleu_ratings.category_scope_eligible($1,scope) eligible
        FROM unnest($2::text[]) scope`,
                  [childId, [keyA, keyB]],
                )
              ).rows;
              assert.equal(changed.length, 2);
              assert(
                changed.every((row) => row.eligible === false),
                'current parent Review applies independently to both domain paths',
              );
              reachedChangedReview = true;
              await tx.query(
                'SELECT whaleu_ratings.verify_scoped_catalog($1)',
                [catalog.id],
              );
              assert.fail(
                'a fresh same-transaction catalog cannot reuse parent Review eligibility from the prior statement',
              );
            }),
            (error: unknown) =>
              verifiedFreshCatalog &&
              reachedChangedReview &&
              error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === '23514' &&
              'message' in error &&
              error.message ===
                'Scoped effective row lacks exact composed lineage',
          );
          assert(
            verifiedFreshCatalog && reachedChangedReview,
            'denial must follow a successful exact fresh catalog verifier, never a missing publication/cause',
          );
          assert.deepEqual(
            {
              artifacts: await f.managementArtifacts(),
              ledger: await f.managementLedger(),
            },
            before,
          );
          assert.deepEqual(await placementBytes(), originalPlacements);
        },
      );
    await setRatingReviewState(f.pool, parentDecision, 'revoked');
    assert.deepEqual(await eligibility(), { [keyA]: false, [keyB]: false });
    const deniedState = await f.managementArtifacts();
    await assert.rejects(
      f.publish(),
      (error: unknown) =>
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'CONTENT_REVIEW_UNAVAILABLE',
    );
    assert.deepEqual(
      await f.managementArtifacts(),
      deniedState,
      'real publication also fails closed after the owner revocation commits',
    );
    assert.deepEqual(await placementBytes(), originalPlacements);
  },
);
