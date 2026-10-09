import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
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
import { CommunityExperienceSourceCapture } from '../../src/community/experience-source/capture.js';
import { CommunityExperienceSourceFacade } from '../../src/community/experience-source/facade.js';
import { SavedRepository } from '../../src/community/saved/repository.js';
import {
  ExperienceIngressService,
  lockExperienceOwner,
} from '../../src/experience/ingress.js';
import {
  ExperienceClock,
  ExperienceRepository,
} from '../../src/experience/repository.js';
import { ExperienceSettlementService } from '../../src/experience/settlement.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

import {
  withCommunityScopeWriter,
  seedCommunityScope,
} from '../support/community-scope-fixtures.js';
import {
  writeRatingApproval,
  approveRating,
} from '../support/rating-runtime-fixture.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { createRatingCommentSchema } from '../../src/ratings/contracts.js';
import { createRatingReplySchema } from '../../src/ratings/discussion-contracts.js';
import { RatingsService } from '../../src/ratings/service.js';
import { RatingDiscussionService } from '../../src/ratings/discussion-service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';

async function seedLegacyRatingRoot(pool: Pool) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const accountId = randomUUID(),
      subject = randomUUID(),
      catalogId = randomUUID(),
      categoryId = randomUUID(),
      categoryRevision = randomUUID(),
      targetId = randomUUID(),
      targetRevision = randomUUID(),
      sourceId = randomUUID(),
      rootId = randomUUID(),
      rootRevision = randomUUID(),
      personaId = randomUUID();
    await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
      accountId,
    ]);
    await initializeNativeSafetyAccount(accountId, tx);
    await establishSyntheticExperienceBaseline(tx, accountId, { balance: 0n });
    await tx.query(
      "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-pre-r2a-rating',$1,$2)",
      [subject, accountId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-pre-r2a-catalog','synthetic-pre-r2a-policy',clock_timestamp()-interval '1 second')",
      [catalogId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal) VALUES($1,$2,$3,NULL,1,'global','general',NULL,'Synthetic old category','',true,false,0)",
      [catalogId, categoryId, categoryRevision],
    );
    const targetEnvelope = canonicalRatingEnvelope({
      version: 1,
      accountId,
      purpose: 'publish_rating_target',
      clientRequestId: randomUUID(),
      targetId,
      targetRevision,
      categoryId,
      categoryRevision,
      catalogRevision: catalogId,
      scope: { regionId: null },
      assetIds: [],
      name: 'Synthetic pre-R2A target',
      description: '',
    });
    const targetApproval = await writeRatingApproval(tx, targetEnvelope);
    await tx.query(
      "INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted','synthetic-pre-r2a-target','synthetic-pre-r2a-policy',clock_timestamp())",
      [sourceId, targetId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope) VALUES($1,$2,$3,$4,NULL,$5,'Synthetic pre-R2A target','',true,$6::jsonb)",
      [
        targetId,
        targetRevision,
        categoryId,
        accountId,
        sourceId,
        canonicalJson(targetEnvelope),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,'synthetic-independent-score-baseline','synthetic-independent-score-policy')",
      [targetId, randomUUID(), sourceId],
    );
    await tx.query(
      "INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('target',$1,1,$2,$3,'publish_rating_target',1,$4,$5::jsonb,$6::jsonb)",
      [
        targetId,
        targetApproval.decisionId,
        accountId,
        targetApproval.digest,
        canonicalJson(targetEnvelope),
        canonicalJson(targetEnvelope.scope),
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.target_memberships(catalog_id,target_id,category_id,ordinal) VALUES($1,$2,$3,0)',
      [catalogId, targetId, categoryId],
    );
    await tx.query(
      'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
      [catalogId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES('global',NULL,$1)",
      [catalogId],
    );
    const command = createRatingCommentSchema.parse({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: targetRevision,
      authorMode: 'anonymous',
      body: 'Synthetic root committed before R2A',
      assetIds: [],
    });
    const rootEnvelope = canonicalRatingEnvelope({
      version: 1,
      accountId,
      purpose: 'publish_rating_comment',
      clientRequestId: command.clientRequestId,
      targetId,
      targetRevision,
      categoryId,
      categoryRevision,
      catalogRevision: catalogId,
      scope: { regionId: null },
      authorMode: command.authorMode,
      body: command.body,
      assetIds: [],
    });
    const rootApproval = await writeRatingApproval(tx, rootEnvelope);
    const hash = createHash('sha256')
      .update(
        'whaleu:rating-command:v1\n' +
          canonicalJson({
            operation: 'create_comment',
            intent: { targetId, ...command },
          }),
      )
      .digest('hex');
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_comment',$3)",
      [accountId, command.clientRequestId, hash],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.personas(target_id,account_id,public_id,display_name) VALUES($1,$2,$3,'Synthetic old persona')",
      [targetId, accountId, personaId],
    );
    const occurredAt = (
      await tx.query<{ at: string }>(
        `INSERT INTO whaleu_ratings.comments(id,target_id,account_id,author_mode,persona_id,body,revision,request_id,envelope) VALUES($1,$2,$3,'anonymous',$4,$5,$6,$7,$8::jsonb) RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        [
          rootId,
          targetId,
          accountId,
          personaId,
          command.body,
          rootRevision,
          command.clientRequestId,
          canonicalJson(rootEnvelope),
        ],
      )
    ).rows[0]!.at;
    await tx.query(
      "INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('comment',$1,1,$2,$3,'publish_rating_comment',1,$4,$5::jsonb,$6::jsonb)",
      [
        rootId,
        rootApproval.decisionId,
        accountId,
        rootApproval.digest,
        canonicalJson(rootEnvelope),
        canonicalJson(rootEnvelope.scope),
      ],
    );
    const receipt = {
      requestId: command.clientRequestId,
      operation: 'create_comment',
      outcome: 'applied',
      targetId,
      subjectId: rootId,
      revision: rootRevision,
      occurredAt,
    };
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [accountId, command.clientRequestId, JSON.stringify(receipt)],
    );
    return {
      accountId,
      subject,
      command,
      receipt,
      catalogId,
      categoryId,
      categoryRevision,
      targetId,
      targetRevision,
      rootId,
      rootRevision,
    };
  });
}

const sqlConstraint = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === '23514';

test(
  'typed source migration preserves nonempty settled, pending, blocked and saved community evidence byte-for-byte',
  { timeout: 120000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      urlString,
      'Use the exclusive disposable loopback whaleu_test runner',
    );
    const url = new URL(urlString);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urlString,
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
      const previous = migrations.filter(
        (m) => Number(m.name.slice(0, 4)) <= 44,
      );
      assert.equal(previous.at(-1)!.name.slice(0, 4), '0044');
      await runMigrations(pool, previous, { mode: 'up' });
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass('whaleu_experience.source_units') AS registry",
          )
        ).rows[0]!.registry,
        null,
      );

      const known = [randomUUID(), randomUUID(), randomUUID()],
        unknown = randomUUID(),
        space = randomUUID();
      for (const account of [...known, unknown])
        await pool.query(
          'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
          [account],
        );
      for (const account of known)
        await inTransaction(pool, (tx) =>
          establishSyntheticExperienceBaseline(tx, account, { balance: 0n }),
        );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic pre-registry source',true)",
        [space],
      );
      const capture = new CommunityExperienceSourceCapture(
          new ExperienceIngressService(),
        ),
        source = new CommunityExperienceSourceFacade(),
        repository = new ExperienceRepository(),
        settlement = new ExperienceSettlementService(
          repository,
          new ExperienceClock(),
        ),
        saved = new SavedRepository();
      const event = async (
        key: string,
        kind: string,
        resource: string,
        context: object,
        tx: PoolClient,
      ) => {
        const id = randomUUID();
        await tx.query(
          'INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context) VALUES($1,$2,$3,$4,$5::jsonb)',
          [id, key, kind, resource, JSON.stringify(context)],
        );
        await capture.enroll(id, tx);
        return (
          await tx.query<{ id: string }>(
            'SELECT id FROM whaleu_community.reward_source_units WHERE group_id=(SELECT id FROM whaleu_community.reward_source_groups WHERE event_id=$1) ORDER BY id',
            [id],
          )
        ).rows.map((r) => r.id);
      };
      const post = async (owner: string, enroll = true) =>
        inTransaction(pool, async (tx) => {
          const id = randomUUID();
          await tx.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','Synthetic pre-registry content','named','open','2026-09-01 01:02:03.123456+00')",
            [id, space, owner],
          );
          const ids = enroll
            ? await event(
                `post:${id}:created`,
                'post_created',
                id,
                {
                  experienceSourceVersion: 1,
                  actorAccountId: owner,
                  actorAuthorMode: 'named',
                  resourceAuthorMode: 'named',
                },
                tx,
              )
            : [];
          return { id, ids };
        });
      const save = async (actor: string, owner: string, postId: string) =>
        inTransaction(pool, async (tx) => {
          await tx.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
            [postId],
          );
          const transition = await saved.setSaved(actor, postId, true, tx);
          assert.ok(transition);
          const rewardObligationIds = await saved.obligations(
            transition.epochId,
            actor,
            owner,
            true,
            tx,
          );
          const ids = await event(
            `save:${transition.epochId}:started`,
            'post_saved',
            transition.epochId,
            {
              experienceSourceVersion: 1,
              actorAccountId: actor,
              actorAuthorMode: null,
              resourceAuthorMode: 'named',
              postId,
              saveEpochId: transition.epochId,
              desired: true,
              rewardObligationIds,
            },
            tx,
          );
          return { ids, rewardObligationIds };
        });
      const applyPrevious = async (ids: string[]) => {
        for (const id of ids)
          await inTransaction(pool, async (tx) => {
            const unit = await source.loadUnit(id, tx);
            assert.ok(unit);
            await lockExperienceOwner(tx, unit.beneficiaryId);
            const state = await repository.state(unit.beneficiaryId, tx);
            assert.ok(state);
            assert.equal(
              (await repository.first(unit.beneficiaryId, tx))?.unit_id,
              id,
            );
            const applied = await settlement.source(unit, state, tx);
            await source.acknowledge(id, applied.settlementId, tx);
            await tx.query(
              "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp(),error_code=NULL WHERE unit_id=$1",
              [id],
            );
          });
      };
      const settledPost = await post(known[0]!);
      await applyPrevious(settledPost.ids);
      const savedPost = await post(known[1]!, false),
        settledSave = await save(known[0]!, known[1]!, savedPost.id);
      await applyPrevious(settledSave.ids);
      const pendingPost = await post(known[0]!),
        blockedPost = await post(unknown);
      await inTransaction(pool, async (tx) => {
        await lockExperienceOwner(tx, unknown);
        assert.equal(await repository.state(unknown, tx), null);
        await tx.query(
          "UPDATE whaleu_experience.work SET state='blocked_baseline',error_code='baseline_unknown' WHERE unit_id=$1",
          [blockedPost.ids[0]],
        );
      });
      const pendingSavedPost = await post(known[1]!, false),
        pendingSave = await save(known[2]!, known[1]!, pendingSavedPost.id);

      const legacy = await seedLegacyRatingRoot(pool);
      const tables = (
        await pool.query<{ schema: string; name: string }>(
          `SELECT table_schema AS schema,table_name AS name FROM information_schema.tables WHERE table_type='BASE TABLE' AND (table_schema='whaleu_experience' OR (table_schema='whaleu_community' AND table_name IN ('reward_source_groups','reward_source_units','outbox','saved_posts','saved_epochs','saved_obligations'))) ORDER BY table_schema,table_name`,
        )
      ).rows;
      const snapshot = async () => {
        const result: Record<string, string[]> = {};
        for (const row of tables) {
          assert.match(row.schema, /^[a-z_]+$/);
          assert.match(row.name, /^[a-z_]+$/);
          result[`${row.schema}.${row.name}`] = (
            await pool.query<{ bytes: string }>(
              `SELECT to_jsonb(t)::text AS bytes FROM ${row.schema}.${row.name} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows.map((r) => r.bytes);
        }
        result['enrollment-sequence'] = (
          await pool.query<{ bytes: string }>(
            "SELECT jsonb_build_object('last_value',last_value::text,'log_cnt',log_cnt::text,'is_called',is_called)::text AS bytes FROM whaleu_experience.enrollment_order",
          )
        ).rows.map((r) => r.bytes);
        return result;
      };
      const before = await snapshot();
      const statuses = (
        await pool.query<{ state: string; count: string }>(
          'SELECT state,count(*)::text FROM whaleu_experience.work GROUP BY state ORDER BY state',
        )
      ).rows;
      assert.deepEqual(statuses, [
        { state: 'blocked_baseline', count: '1' },
        { state: 'completed', count: '3' },
        { state: 'pending', count: '3' },
      ]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::text AS count FROM whaleu_community.saved_obligations WHERE action IN ('saver_reward','author_reward') AND status='completed'",
          )
        ).rows[0]!.count,
        '2',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::text AS count FROM whaleu_community.saved_obligations WHERE action IN ('saver_reward','author_reward') AND status='pending'",
          )
        ).rows[0]!.count,
        '2',
      );

      await t.test(
        'validated FK migration backfills only immutable bridges and preserves every original row and sequence',
        async () => {
          await runMigrations(pool, migrations, { mode: 'up' });
          assert.deepEqual(await snapshot(), before);
          assert.equal(
            (
              await pool.query(
                `SELECT 1 FROM whaleu_experience.source_groups b FULL JOIN whaleu_community.reward_source_groups g ON b.group_id=g.id WHERE b.source_domain IS DISTINCT FROM 'community' OR (b.group_id,b.source_version,b.enrollment_order,b.creation_transaction,b.community_group_id,b.rating_group_id) IS DISTINCT FROM (g.id,g.source_version,g.enrollment_order,g.creation_transaction,g.id,NULL::uuid)`,
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                `SELECT 1 FROM whaleu_experience.source_units b FULL JOIN whaleu_community.reward_source_units u ON b.unit_id=u.id WHERE b.source_domain IS DISTINCT FROM 'community' OR (b.unit_id,b.group_id,b.beneficiary_id,b.action,b.enrollment_order,b.community_unit_id,b.rating_unit_id) IS DISTINCT FROM (u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order,u.id,NULL::uuid)`,
              )
            ).rowCount,
            0,
          );
          const fks = (
            await pool.query<{ target: string; valid: boolean }>(
              "SELECT confrelid::regclass::text AS target,convalidated AS valid FROM pg_constraint WHERE conrelid='whaleu_experience.work'::regclass AND confrelid IN ('whaleu_experience.source_units'::regclass,'whaleu_community.reward_source_units'::regclass)",
            )
          ).rows;
          assert.deepEqual(fks, [
            { target: 'whaleu_experience.source_units', valid: true },
          ]);
          assert.equal(
            (await pool.query('SELECT 1 FROM whaleu_ratings.reward_groups'))
              .rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.baselines WHERE owner_id=$1',
                [unknown],
              )
            ).rowCount,
            0,
          );
        },
      );

      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      await app.init();
      const worker = app.get(ExperienceWorker),
        router = app.get(ExperienceSourceRouter);
      await t.test(
        'old R1 root replay grants nothing while a fresh reply to that same root settles both real units',
        async () => {
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          const session = await app!.get(IdentityRepository).createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-pre-r2a-rating',
              subject: legacy.subject,
            },
            {
              access: hashToken(accessToken),
              refresh: hashToken(refreshToken),
            },
          );
          assert.equal(session.accountId, legacy.accountId);
          const existingSource = async () =>
            (
              await pool.query(
                `SELECT
          (SELECT count(*)::text FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2) AS events,
          (SELECT count(*)::text FROM whaleu_experience.work WHERE beneficiary_id=$1) AS work,
          (SELECT count(*)::text FROM whaleu_experience.records WHERE owner_id=$1) AS records,
          (SELECT balance::text FROM whaleu_experience.account_states WHERE owner_id=$1) AS balance`,
                [legacy.accountId, legacy.command.clientRequestId],
              )
            ).rows[0];
          assert.deepEqual(await existingSource(), {
            events: '0',
            work: '0',
            records: '0',
            balance: '0',
          });
          assert.deepEqual(
            await app!
              .get(RatingsService)
              .createComment(accessToken, legacy.targetId, legacy.command),
            legacy.receipt,
          );
          assert.deepEqual(
            await app!
              .get(RatingsService)
              .receipt(accessToken, legacy.command.clientRequestId),
            legacy.receipt,
          );
          assert.deepEqual(await existingSource(), {
            events: '0',
            work: '0',
            records: '0',
            balance: '0',
          });
          const scope = await seedCommunityScope(pool),
            actor = await createRuntimeActor(app!);
          await setRuntimeVerification(
            pool,
            actor.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          const command = createRatingReplySchema.parse({
            clientRequestId: randomUUID(),
            regionId: null,
            targetId: legacy.targetId,
            expectedTargetRevision: legacy.targetRevision,
            expectedRootRevision: legacy.rootRevision,
            replyTo: null,
            authorMode: 'named',
            body: 'Synthetic fresh reply to retained R1 root',
            assetIds: [],
          });
          await approveRating(
            pool,
            canonicalRatingEnvelope({
              version: 2,
              purpose: 'publish_rating_reply',
              accountId: actor.accountId,
              clientRequestId: command.clientRequestId,
              targetId: legacy.targetId,
              targetRevision: legacy.targetRevision,
              rootId: legacy.rootId,
              rootRevision: legacy.rootRevision,
              replyTo: null,
              categoryId: legacy.categoryId,
              categoryRevision: legacy.categoryRevision,
              catalogRevision: legacy.catalogId,
              scope: { regionId: null },
              assetIds: [],
              authorMode: command.authorMode,
              body: command.body,
            }),
          );
          const receipt = await app!
            .get(RatingDiscussionService)
            .createReply(actor.accessToken, legacy.rootId, command);
          assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
          const newUnits = (
            await pool.query<{
              id: string;
              beneficiary_id: string;
              action: string;
            }>(
              'SELECT u.id,u.beneficiary_id,u.action FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.effect_events e ON e.id=u.event_id WHERE e.actor_account_id=$1 AND e.request_id=$2 ORDER BY u.id',
              [actor.accountId, command.clientRequestId],
            )
          ).rows;
          assert.deepEqual(
            newUnits.map((u) => `${u.beneficiary_id}:${u.action}`).sort(),
            [
              `${actor.accountId}:comment`,
              `${legacy.accountId}:received_comment`,
            ].sort(),
          );
          const settled = await worker.run({
            mode: 'apply',
            unitIds: newUnits.map((u) => u.id),
          });
          assert.equal(settled.settled, 2, JSON.stringify(settled));
          const results = (
            await pool.query<{
              owner_id: string;
              action: string;
              applied_delta: string;
            }>(
              'SELECT owner_id,action,applied_delta::text FROM whaleu_experience.settlements WHERE unit_id=ANY($1::uuid[]) ORDER BY owner_id',
              [newUnits.map((u) => u.id)],
            )
          ).rows;
          assert.equal(results.length, 2);
          assert.ok(results.every((r) => r.applied_delta === '3'));
          assert.equal(
            (await existingSource()).events,
            '0',
            'The old root request must remain outside the fresh event history',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_ratings.comment_transitions WHERE comment_id=$1',
                [legacy.rootId],
              )
            ).rowCount,
            1,
          );
          assert.deepEqual(
            await app!
              .get(RatingsService)
              .createComment(accessToken, legacy.targetId, legacy.command),
            legacy.receipt,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.settlements WHERE unit_id=ANY($1::uuid[])',
                [newUnits.map((u) => u.id)],
              )
            ).rowCount,
            2,
          );
        },
      );

      await t.test(
        'old completed, pending and blocked work resume through the typed router without replay',
        async () => {
          const completed = await worker.run({
            mode: 'apply',
            unitIds: [...settledPost.ids, ...settledSave.ids],
          });
          assert.equal(completed.completed, 3, JSON.stringify(completed));
          const pending = await worker.run({
            mode: 'apply',
            unitIds: [
              ...pendingPost.ids,
              ...pendingSave.ids,
              ...blockedPost.ids,
            ],
          });
          assert.equal(pending.settled, 3, JSON.stringify(pending));
          assert.equal(pending.blockedBaseline, 1, JSON.stringify(pending));
          assert.equal(pending.failed, 0, JSON.stringify(pending));
          for (const id of [...settledSave.ids, ...pendingSave.ids]) {
            const unit = await inTransaction(pool, (tx) =>
              router.loadUnit(id, tx),
            );
            assert.equal(unit?.sourceDomain, 'community');
            assert.equal(unit?.sourceKind, 'saved_obligation');
          }
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM whaleu_community.saved_obligations WHERE action IN ('saver_reward','author_reward') AND status<>'completed'",
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.records WHERE owner_id=$1',
                [unknown],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.baselines WHERE owner_id=$1',
                [unknown],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'fresh post-migration community enrollment uses the same bridge without changing historical evidence',
        async () => {
          const fresh = await post(known[2]!);
          const coordinates: string[] = [];
          for (const timezone of ['UTC', 'America/Los_Angeles']) {
            await inTransaction(pool, async (tx) => {
              await tx.query("SELECT set_config('TimeZone',$1,true)", [
                timezone,
              ]);
              const unit = await router.loadUnit(fresh.ids[0]!, tx);
              assert.equal(unit?.sourceKind, 'community_outbox');
              assert.equal(unit?.sourceDomain, 'community');
              assert.ok(unit?.occurredAt);
              coordinates.push(unit.occurredAt);
              assert.equal(
                (
                  await tx.query<{ exact: boolean }>(
                    "SELECT $1::timestamptz = '2026-09-01 01:02:03.123456+00'::timestamptz AS exact",
                    [unit.occurredAt],
                  )
                ).rows[0]!.exact,
                true,
              );
            });
          }
          assert.notEqual(coordinates[0], coordinates[1]);
          assert.equal(
            (
              await pool.query<{ exact: boolean }>(
                'SELECT $1::timestamptz = $2::timestamptz AS exact',
                coordinates,
              )
            ).rows[0]!.exact,
            true,
          );
          const result = await worker.run({
            mode: 'apply',
            unitIds: fresh.ids,
          });
          assert.equal(result.settled, 1, JSON.stringify(result));
          const records = await pool.query<{ exact: boolean }>(
            `SELECT r.occurred_at=g.occurred_at
               AND r.occurred_at='2026-09-01 01:02:03.123456+00'::timestamptz AS exact
             FROM whaleu_experience.records r
             JOIN whaleu_experience.settlements s ON s.id=r.settlement_id
             JOIN whaleu_community.reward_source_units u ON u.id=s.unit_id
             JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id
             WHERE u.id=$1`,
            [fresh.ids[0]],
          );
          assert.equal(records.rowCount, 1);
          assert.equal(records.rows[0]!.exact, true);
        },
      );

      await t.test(
        'registry domain, beneficiary and enrollment fields cannot be relabeled, removed or independently forged',
        async () => {
          const id = pendingPost.ids[0]!;
          for (const query of [
            "UPDATE whaleu_experience.source_units SET source_domain='ratings',rating_unit_id=unit_id,community_unit_id=NULL WHERE unit_id=$1",
            'UPDATE whaleu_experience.source_units SET beneficiary_id=gen_random_uuid() WHERE unit_id=$1',
            'UPDATE whaleu_experience.source_units SET enrollment_order=enrollment_order+1 WHERE unit_id=$1',
            'DELETE FROM whaleu_experience.source_units WHERE unit_id=$1',
            "INSERT INTO whaleu_experience.source_units SELECT unit_id,'ratings',group_id,beneficiary_id,action,enrollment_order,NULL,unit_id FROM whaleu_experience.source_units WHERE unit_id=$1",
          ])
            await assert.rejects(
              inTransaction(pool, (tx) => tx.query(query, [id])),
              sqlConstraint,
            );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query('TRUNCATE whaleu_experience.source_units CASCADE'),
            ),
            sqlConstraint,
          );
          assert.equal(
            (await inTransaction(pool, (tx) => router.loadUnit(id, tx)))
              ?.sourceDomain,
            'community',
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
