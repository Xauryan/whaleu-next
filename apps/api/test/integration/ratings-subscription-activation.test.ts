import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { createRatingCommentSchema } from '../../src/ratings/contracts.js';
import { createRatingReplySchema } from '../../src/ratings/discussion-contracts.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  withCommunityScopeWriter,
  seedCommunityScope,
} from '../support/community-scope-fixtures.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import { writeRatingApproval } from '../support/rating-runtime-fixture.js';

interface SourceCase {
  name: string;
  origin: 'new_native' | 'historical' | 'unknown';
  coverage: 'complete' | 'missing' | 'conflicting';
  provenance: 'accepted' | 'unknown' | 'conflicting';
  score?: boolean;
  future?: boolean;
  split?: boolean;
  damaged?: boolean;
  expected: boolean;
}
const cases: readonly SourceCase[] = [
  {
    name: 'native-with-score',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'accepted',
    score: true,
    expected: true,
  },
  {
    name: 'native-without-score',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'accepted',
    expected: true,
  },
  {
    name: 'historical',
    origin: 'historical',
    coverage: 'complete',
    provenance: 'accepted',
    expected: false,
  },
  {
    name: 'missing-coverage',
    origin: 'new_native',
    coverage: 'missing',
    provenance: 'accepted',
    expected: false,
  },
  {
    name: 'conflicting-coverage',
    origin: 'new_native',
    coverage: 'conflicting',
    provenance: 'accepted',
    expected: false,
  },
  {
    name: 'unknown-provenance',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'unknown',
    expected: false,
  },
  {
    name: 'conflicting-provenance',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'conflicting',
    expected: false,
  },
  {
    name: 'future-source',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'accepted',
    future: true,
    expected: false,
  },
  {
    name: 'split-transaction-source',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'accepted',
    split: true,
    expected: false,
  },
  {
    name: 'damaged-source-with-score',
    origin: 'new_native',
    coverage: 'complete',
    provenance: 'accepted',
    score: true,
    damaged: true,
    expected: false,
  },
];

async function seedPreSubscriptionTargets(pool: Pool, accountId: string) {
  const catalogId = randomUUID(),
    categoryId = randomUUID(),
    categoryRevision = randomUUID();
  const targets = cases.map((fixture) => ({
    ...fixture,
    id: randomUUID(),
    revision: randomUUID(),
    sourceId: randomUUID(),
  }));
  const source = async (tx: PoolClient, target: (typeof targets)[number]) => {
    await tx.query(
      `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at)
       VALUES($1,$2,$3,$4,$5,'synthetic-subscription-cutover-source','synthetic-independent-native-target-policy',clock_timestamp()+CASE WHEN $6 THEN interval '1 day' ELSE interval '-1 second' END)`,
      [
        target.sourceId,
        target.id,
        target.origin,
        target.coverage,
        target.provenance,
        target.future ?? false,
      ],
    );
  };
  for (const target of targets.filter((item) => item.split))
    await withCommunityScopeWriter(pool, (tx) => source(tx, target));
  await withCommunityScopeWriter(pool, async (tx) => {
    await tx.query(
      "INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-cutover-catalog','synthetic-cutover-catalog-policy',clock_timestamp()-interval '1 second')",
      [catalogId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal) VALUES($1,$2,$3,NULL,1,'global','general',NULL,'Synthetic subscription cutover','',true,false,0)",
      [catalogId, categoryId, categoryRevision],
    );
    for (const [index, target] of targets.entries()) {
      if (!target.split) await source(tx, target);
      const envelope = canonicalRatingEnvelope({
        version: 1,
        accountId,
        purpose: 'publish_rating_target',
        clientRequestId: randomUUID(),
        targetId: target.id,
        targetRevision: target.revision,
        categoryId,
        categoryRevision,
        catalogRevision: catalogId,
        scope: { regionId: null },
        assetIds: [],
        name: target.name,
        description: '',
      });
      const approval = await writeRatingApproval(tx, envelope);
      await tx.query(
        "INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope) VALUES($1,$2,$3,$4,NULL,$5,$6,'',true,$7::jsonb)",
        [
          target.id,
          target.revision,
          categoryId,
          accountId,
          target.sourceId,
          target.name,
          canonicalJson(envelope),
        ],
      );
      if (target.score)
        await tx.query(
          "INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,'synthetic-independent-score-baseline','synthetic-score-policy')",
          [target.id, randomUUID(), target.sourceId],
        );
      await tx.query(
        "INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('target',$1,1,$2,$3,'publish_rating_target',1,$4,$5::jsonb,$6::jsonb)",
        [
          target.id,
          approval.decisionId,
          accountId,
          approval.digest,
          canonicalJson(envelope),
          canonicalJson(envelope.scope),
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.target_memberships(catalog_id,target_id,category_id,ordinal) VALUES($1,$2,$3,$4)',
        [catalogId, target.id, categoryId, index],
      );
    }
    await tx.query(
      'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
      [catalogId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES('global',NULL,$1)",
      [catalogId],
    );
  });
  // Explicit damaged legacy-history fixture. Valid 0050 writers cannot create a
  // score baseline with a mismatched source xid. Change only that old source xid,
  // then restore its immutable guard before activation or any runtime command.
  await withCommunityScopeWriter(pool, async (tx) => {
    await tx.query(
      'ALTER TABLE whaleu_ratings.target_sources DISABLE TRIGGER rating_immutable',
    );
    await tx.query(
      'UPDATE whaleu_ratings.target_sources SET source_transaction=pg_current_xact_id() WHERE id=$1',
      [targets.find((target) => target.damaged)!.sourceId],
    );
    await tx.query(
      'ALTER TABLE whaleu_ratings.target_sources ENABLE TRIGGER rating_immutable',
    );
  });
  return { catalogId, categoryId, categoryRevision, targets };
}

// A genuinely nonempty 0050 prefix and a real publication in the deliberate
// 0051 -> 0052 deployment gap. No current all-migration fixture is reused.
test(
  'subscription activation proves independent native coverage and captures only publications after fanout cutover',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Use the exclusive disposable loopback whaleu_test runner',
    );
    const url = new URL(database);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '15000',
      EXPERIENCE_PROCESSING: 'manual_only',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run PostgreSQL acceptance serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer AS version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rowCount,
        0,
        'Refusing preexisting application schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const through = (version: number) =>
        migrations.filter(
          (migration) => Number(migration.name.slice(0, 4)) <= version,
        );
      assert.equal(through(50).at(-1)!.name.slice(0, 4), '0050');
      assert.equal(through(51).at(-1)!.name.slice(0, 4), '0051');
      assert.equal(through(52).at(-1)!.name.slice(0, 4), '0052');
      await runMigrations(pool, through(50), { mode: 'up' });
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass('whaleu_ratings.subscription_baselines') AS subscriptions",
          )
        ).rows[0]!.subscriptions,
        null,
      );
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const runtime = app,
        http = runtime.getHttpServer(),
        scope = await seedCommunityScope(pool);
      const actor = await createRuntimeActor(runtime),
        replyActor = await createRuntimeActor(runtime);
      for (const account of [actor, replyActor])
        await setRuntimeVerification(
          pool,
          account.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
      const catalog = await seedPreSubscriptionTargets(pool, actor.accountId);
      type Target = (typeof catalog.targets)[number];
      const target = catalog.targets.find(
        (item) => item.name === 'native-without-score',
      )!;
      const snapshotTargets = async () => {
        const result: Record<string, unknown> = {};
        for (const table of [
          'catalogs',
          'catalog_heads',
          'categories',
          'target_sources',
          'targets',
          'target_creations',
          'target_memberships',
          'score_baselines',
          'score_summaries',
        ])
          result[table] = (
            await pool.query(
              `SELECT to_jsonb(t)::text AS bytes FROM whaleu_ratings.${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
        return result;
      };
      const before = await snapshotTargets();
      await t.test(
        '0051 enrolls only exact native source/creation evidence and never borrows score coverage',
        async () => {
          await runMigrations(pool, through(51), { mode: 'up' });
          assert.deepEqual(await snapshotTargets(), before);
          const baselines = (
            await pool.query<{
              target_id: string;
              source_id: string;
              kind: string;
              coverage: string;
              count: number;
              target_order: string;
              exact_activation: boolean;
              exact_native_source: boolean;
            }>(
              `SELECT b.target_id,b.source_id,b.kind,b.coverage,s.count,s.target_order::text,
         b.creation_transaction=a.activation_transaction AND b.baseline_at=a.activated_at AS exact_activation,
         ROW(b.source_id,b.target_creation_transaction) IS NOT DISTINCT FROM ROW(c.source_id,c.creation_transaction)
          AND c.creation_transaction=t.source_transaction AND ROW(t.origin,t.coverage,t.provenance)=ROW('new_native','complete','accepted') AS exact_native_source
         FROM whaleu_ratings.subscription_baselines b JOIN whaleu_ratings.subscription_states s ON (s.target_id,s.baseline_id)=(b.target_id,b.id)
         JOIN whaleu_ratings.subscription_activations a ON a.id=b.activation_id JOIN whaleu_ratings.target_creations c ON c.target_id=b.target_id
         JOIN whaleu_ratings.target_sources t ON t.id=b.source_id ORDER BY b.target_id`,
            )
          ).rows;
          assert.deepEqual(
            baselines,
            catalog.targets
              .filter((item) => item.expected)
              .map((item) => ({
                target_id: item.id,
                source_id: item.sourceId,
                kind: 'native-activation',
                coverage: 'complete',
                count: 0,
                target_order: '0',
                exact_activation: true,
                exact_native_source: true,
              }))
              .sort((a, b) => a.target_id.localeCompare(b.target_id)),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.subscription_streams WHERE last_order=0 AND last_entry_id IS NULL',
              )
            ).rowCount,
            catalog.targets.length,
          );
          for (const item of catalog.targets) {
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_ratings.subscription_baselines WHERE target_id=$1',
                  [item.id],
                )
              ).rowCount,
              item.expected ? 1 : 0,
              item.name,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_ratings.score_baselines WHERE target_id=$1',
                  [item.id],
                )
              ).rowCount,
              item.score ? 1 : 0,
              item.name,
            );
          }
          for (const table of [
            'subscription_memberships',
            'subscription_transitions',
            'subscription_stream_entries',
            'effect_events',
            'reward_groups',
          ])
            assert.equal(
              (await pool.query(`SELECT 1 FROM whaleu_ratings.${table}`))
                .rowCount,
              0,
            );
          const response = await request(http)
            .get(`/v1/ratings/targets/${target.id}/subscription`)
            .set('Authorization', `Bearer ${actor.accessToken}`);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.status, 'known');
          assert.equal(response.body.count, 0);
          assert.equal(response.body.subscribed, false);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.score_baselines WHERE target_id=$1',
                [target.id],
              )
            ).rowCount,
            0,
          );
        },
      );

      const publishRoot = async (subject: Target, body: string) => {
        const command = createRatingCommentSchema.parse({
          clientRequestId: randomUUID(),
          regionId: null,
          expectedTargetRevision: subject.revision,
          authorMode: 'named',
          body,
          assetIds: [],
        });
        const envelope = canonicalRatingEnvelope({
          version: 1,
          accountId: actor.accountId,
          purpose: 'publish_rating_comment',
          clientRequestId: command.clientRequestId,
          targetId: subject.id,
          targetRevision: subject.revision,
          categoryId: catalog.categoryId,
          categoryRevision: catalog.categoryRevision,
          catalogRevision: catalog.catalogId,
          scope: { regionId: null },
          authorMode: command.authorMode,
          body: command.body,
          assetIds: [],
        });
        await withCommunityScopeWriter(pool, (tx) =>
          writeRatingApproval(tx, envelope),
        );
        const result = await request(http)
          .post(`/v1/ratings/targets/${subject.id}/comments`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(command);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.outcome, 'applied');
        const event = (
          await pool.query<{ id: string; mutation_transaction: string }>(
            'SELECT id,mutation_transaction::text FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
            [actor.accountId, command.clientRequestId],
          )
        ).rows[0]!;
        assert.ok(event);
        return {
          id: result.body.subjectId as string,
          revision: result.body.revision as string,
          command,
          receipt: result.body,
          event,
        };
      };
      let gap: Awaited<ReturnType<typeof publishRoot>> | undefined;
      let gapSnapshot: unknown;
      await t.test(
        'ordinary root publication during the 0051-to-0052 gap keeps a genuine v1 source and real XP capture',
        async () => {
          assert.equal(
            (
              await pool.query(
                "SELECT to_regclass('whaleu_ratings.subscription_fanout_sources') AS sources",
              )
            ).rows[0]!.sources,
            null,
          );
          gap = await publishRoot(
            target,
            'Synthetic root during subscription fanout deployment gap',
          );
          const captured = (
            await pool.query<{
              unit_id: string;
              source_version: number;
              exact_capture: boolean;
            }>(
              `SELECT u.id AS unit_id,g.source_version,g.creation_transaction=e.mutation_transaction AND g.event_id=e.id
         AND ROW(g.target_id,g.root_id,g.actor_account_id) IS NOT DISTINCT FROM ROW(e.target_id,e.root_id,e.actor_account_id) AS exact_capture
         FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.reward_groups g ON g.event_id=e.id JOIN whaleu_ratings.reward_units u ON u.group_id=g.id
         JOIN whaleu_experience.work w ON w.unit_id=u.id WHERE e.id=$1`,
              [gap.event.id],
            )
          ).rows;
          assert.equal(captured.length, 1);
          assert.equal(captured[0]!.source_version, 1);
          assert.equal(captured[0]!.exact_capture, true);
          assert.equal(
            (
              await pool.query(
                'SELECT last_order::text FROM whaleu_ratings.subscription_streams WHERE target_id=$1',
                [target.id],
              )
            ).rows[0]!.last_order,
            '0',
          );
          const settled = await runtime.get(ExperienceWorker).run({
            mode: 'apply',
            unitIds: captured.map((row) => row.unit_id),
          });
          assert.equal(settled.settled, 1, JSON.stringify(settled));
          assert.equal(settled.failed, 0);
          gapSnapshot = (
            await pool.query(
              `SELECT to_jsonb(e) AS effect,to_jsonb(g) AS reward_group,to_jsonb(u) AS reward_unit,to_jsonb(w) AS work,to_jsonb(s) AS settlement
         FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.reward_groups g ON g.event_id=e.id JOIN whaleu_ratings.reward_units u ON u.group_id=g.id
         JOIN whaleu_experience.work w ON w.unit_id=u.id JOIN whaleu_experience.settlements s ON s.unit_id=u.id WHERE e.id=$1`,
              [gap.event.id],
            )
          ).rows;
        },
      );

      await t.test(
        '0052 does not replay the gap publication or reset either immutable activation',
        async () => {
          assert.ok(gap);
          const activation = (
            await pool.query(
              'SELECT to_jsonb(a) AS row FROM whaleu_ratings.subscription_activations a',
            )
          ).rows;
          await runMigrations(pool, through(52), { mode: 'up' });
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(a) AS row FROM whaleu_ratings.subscription_activations a',
              )
            ).rows,
            activation,
          );
          for (const table of [
            'whaleu_ratings.subscription_fanout_sources',
            'whaleu_notifications.rating_subscription_fanout_jobs',
            'whaleu_notifications.rating_subscription_notices',
          ])
            assert.equal(
              (await pool.query(`SELECT 1 FROM ${table}`)).rowCount,
              0,
            );
          assert.deepEqual(
            (
              await pool.query(
                `SELECT to_jsonb(e) AS effect,to_jsonb(g) AS reward_group,to_jsonb(u) AS reward_unit,to_jsonb(w) AS work,to_jsonb(s) AS settlement
         FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.reward_groups g ON g.event_id=e.id JOIN whaleu_ratings.reward_units u ON u.group_id=g.id
         JOIN whaleu_experience.work w ON w.unit_id=u.id JOIN whaleu_experience.settlements s ON s.unit_id=u.id WHERE e.id=$1`,
                [gap.event.id],
              )
            ).rows,
            gapSnapshot,
          );
          const fanoutActivation = (
            await pool.query(
              'SELECT to_jsonb(a) AS row FROM whaleu_ratings.subscription_fanout_activations a',
            )
          ).rows;
          assert.equal(fanoutActivation.length, 1);
          await runMigrations(pool, through(52), { mode: 'up' });
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(a) AS row FROM whaleu_ratings.subscription_fanout_activations a',
              )
            ).rows,
            fanoutActivation,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(a) AS row FROM whaleu_ratings.subscription_activations a',
              )
            ).rows,
            activation,
          );
        },
      );

      await t.test(
        'new root and reply capture exact publication-xid sources, initial jobs and a contiguous target stream',
        async () => {
          assert.ok(gap);
          const root = await publishRoot(
            target,
            'Synthetic root after subscription fanout cutover',
          );
          const input = createRatingReplySchema.parse({
            clientRequestId: randomUUID(),
            regionId: null,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRootRevision: root.revision,
            replyTo: null,
            authorMode: 'named',
            body: 'Synthetic reply after subscription fanout cutover',
            assetIds: [],
          });
          const envelope = canonicalRatingEnvelope({
            version: 2,
            purpose: 'publish_rating_reply',
            accountId: replyActor.accountId,
            clientRequestId: input.clientRequestId,
            targetId: target.id,
            targetRevision: target.revision,
            rootId: root.id,
            rootRevision: root.revision,
            replyTo: null,
            categoryId: catalog.categoryId,
            categoryRevision: catalog.categoryRevision,
            catalogRevision: catalog.catalogId,
            scope: { regionId: null },
            authorMode: input.authorMode,
            body: input.body,
            assetIds: [],
          });
          await withCommunityScopeWriter(pool, (tx) =>
            writeRatingApproval(tx, envelope),
          );
          const response = await request(http)
            .post(`/v1/ratings/comments/${root.id}/replies`)
            .set('Authorization', `Bearer ${replyActor.accessToken}`)
            .send(input);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.outcome, 'applied');
          const sources = (
            await pool.query<{
              event_id: string;
              event_kind: string;
              source_version: number;
              rule_version: string;
              target_id: string;
              root_id: string;
              reply_id: string | null;
              actor_id: string;
              target_order: string;
              captured_coverage: string;
              exact_publication: boolean;
              exact_stream: boolean;
              last_page: number;
              cursor_order: string | null;
              scan_finished: boolean;
              job_after_source: boolean;
              job_same_transaction: boolean;
            }>(
              `SELECT s.event_id,e.event_kind,e.source_version,e.rule_version,s.target_id,s.root_id,s.reply_id,s.actor_id,s.target_order::text,s.captured_coverage,
         s.source_transaction=e.mutation_transaction AND s.source_transaction=coalesce(r.publication_transaction,c.publication_transaction) AS exact_publication,
         ROW(o.target_id,o.target_order,o.kind,o.source_id,o.mutation_transaction) IS NOT DISTINCT FROM ROW(s.target_id,s.target_order,'publication'::text,s.event_id,s.source_transaction) AS exact_stream,
         j.last_page,j.cursor_order::text,j.scan_finished,j.created_at>=e.occurred_at AS job_after_source,
         j.xmin=e.xmin AND s.xmin=e.xmin AS job_same_transaction
         FROM whaleu_ratings.subscription_fanout_sources s JOIN whaleu_ratings.effect_events e ON e.id=s.event_id
         JOIN whaleu_ratings.comments c ON c.id=s.root_id LEFT JOIN whaleu_ratings.replies r ON r.id=s.reply_id
         JOIN whaleu_ratings.subscription_stream_entries o ON (o.target_id,o.target_order)=(s.target_id,s.target_order)
         JOIN whaleu_notifications.rating_subscription_fanout_jobs j ON j.event_id=s.event_id ORDER BY s.target_order`,
            )
          ).rows;
          assert.equal(sources.length, 2);
          assert.deepEqual(
            sources.map((source) => ({ ...source, event_id: undefined })),
            [
              {
                event_id: undefined,
                event_kind: 'root_created',
                source_version: 1,
                rule_version: 'rating-effects-v1',
                target_id: target.id,
                root_id: root.id,
                reply_id: null,
                actor_id: actor.accountId,
                target_order: '1',
                captured_coverage: 'complete',
                exact_publication: true,
                exact_stream: true,
                last_page: 0,
                cursor_order: null,
                scan_finished: false,
                job_after_source: true,
                job_same_transaction: true,
              },
              {
                event_id: undefined,
                event_kind: 'reply_created',
                source_version: 1,
                rule_version: 'rating-effects-v1',
                target_id: target.id,
                root_id: root.id,
                reply_id: response.body.replyId,
                actor_id: replyActor.accountId,
                target_order: '2',
                captured_coverage: 'complete',
                exact_publication: true,
                exact_stream: true,
                last_page: 0,
                cursor_order: null,
                scan_finished: false,
                job_after_source: true,
                job_same_transaction: true,
              },
            ],
          );
          assert.equal(sources[0]!.event_id, root.event.id);
          assert.ok(
            sources.every((source) => source.event_id !== gap!.event.id),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.subscription_stream_entries WHERE source_id=$1',
                [gap.event.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT last_order::text FROM whaleu_ratings.subscription_streams WHERE target_id=$1',
                [target.id],
              )
            ).rows[0]!.last_order,
            '2',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.reward_groups WHERE event_id=ANY($1::uuid[])',
                [sources.map((source) => source.event_id)],
              )
            ).rowCount,
            2,
          );
          const direct = (
            await pool.query(
              'SELECT reason,recipient_account_id FROM whaleu_ratings.notice_obligations WHERE event_id=$1',
              [sources[1]!.event_id],
            )
          ).rows;
          assert.deepEqual(direct, [
            { reason: 'direct_root', recipient_account_id: actor.accountId },
          ]);
        },
      );

      await t.test(
        'expired activation cannot later fabricate a baseline for historical or damaged native evidence',
        async () => {
          for (const subject of catalog.targets.filter(
            (item) => !item.expected,
          ))
            await assert.rejects(
              inTransaction(pool, (tx) =>
                tx.query(
                  `INSERT INTO whaleu_ratings.subscription_baselines(id,target_id,kind,activation_id,source_id,target_creation_transaction,baseline_at,coverage)
           SELECT gen_random_uuid(),c.target_id,'native-activation',a.id,c.source_id,c.creation_transaction,a.activated_at,'complete'
           FROM whaleu_ratings.target_creations c CROSS JOIN whaleu_ratings.subscription_activations a WHERE c.target_id=$1`,
                  [subject.id],
                ),
              ),
              (error: unknown) =>
                error instanceof Error &&
                'code' in error &&
                error.code === '23514',
              subject.name,
            );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.subscription_baselines',
              )
            ).rowCount,
            2,
          );
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (owns) {
            for (const schema of migrationSchemaNames)
              await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
                )
              ).rowCount,
              0,
            );
          }
        } finally {
          if (locked)
            await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
              MIGRATION_LOCK[0],
              2,
            ]);
          suite?.release();
          await pool.end();
        }
      }
    }
  },
);
