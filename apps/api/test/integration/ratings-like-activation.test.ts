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
import {
  ExperienceIngressService,
  lockExperienceOwner,
} from '../../src/experience/ingress.js';
import {
  ExperienceClock,
  ExperienceRepository,
} from '../../src/experience/repository.js';
import { ExperienceSettlementService } from '../../src/experience/settlement.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  withCommunityScopeWriter,
  seedCommunityScope,
} from '../support/community-scope-fixtures.js';
import { writeRatingApproval } from '../support/rating-runtime-fixture.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { createRatingCommentSchema } from '../../src/ratings/contracts.js';
import { createRatingReplySchema } from '../../src/ratings/discussion-contracts.js';
import { RatingLikesService } from '../../src/ratings/likes/service.js';
import { RatingRootOrderRepository } from '../../src/ratings/like-order-repository.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';

// Explicit 0047 capture shape: current production capture correctly requires
// 0048 columns, so the historical fixture writes only the original v1 tuple.
async function capturePreLikeCreated(
  tx: PoolClient,
  actor: string,
  request: string,
) {
  const event = (
    await tx.query<{ id: string }>(
      'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2 AND source_version=1',
      [actor, request],
    )
  ).rows[0]!.id;
  const expected = (
    await tx.query<{
      beneficiary_id: string;
      action: 'comment' | 'received_comment';
    }>(
      'SELECT * FROM whaleu_ratings.expected_reward_units($1) ORDER BY beneficiary_id,action',
      [event],
    )
  ).rows;
  const ingress = new ExperienceIngressService();
  const { enrollmentOrder } = await ingress.reserve(
    tx,
    expected.map((r) => r.beneficiary_id),
  );
  const group = randomUUID();
  await tx.query(
    'INSERT INTO whaleu_ratings.reward_groups(id,event_id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,occurred_at,enrollment_order,expected_unit_count) SELECT $1,id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,occurred_at,$3,expected_experience_units FROM whaleu_ratings.effect_events WHERE id=$2',
    [group, event, enrollmentOrder],
  );
  for (const row of expected) {
    const unit = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_ratings.reward_units(id,group_id,event_id,beneficiary_id,action,enrollment_order) VALUES($1,$2,$3,$4,$5,$6)',
      [unit, group, event, row.beneficiary_id, row.action, enrollmentOrder],
    );
    await ingress.enqueue(tx, [
      {
        unitId: unit,
        groupId: group,
        beneficiaryId: row.beneficiary_id,
        action: row.action,
        enrollmentOrder,
      },
    ]);
  }
  return event;
}
async function seedPreLikeRoot(pool: Pool) {
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
      "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-pre-like-rating',$1,$2)",
      [subject, accountId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-pre-like-catalog','synthetic-pre-like-policy',clock_timestamp()-interval '1 second')",
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
      name: 'Synthetic pre-like target',
      description: '',
    });
    const targetApproval = await writeRatingApproval(tx, targetEnvelope);
    await tx.query(
      "INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted','synthetic-pre-like-target','synthetic-pre-like-policy',clock_timestamp())",
      [sourceId, targetId],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope) VALUES($1,$2,$3,$4,NULL,$5,'Synthetic pre-like target','',true,$6::jsonb)",
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
      "INSERT INTO whaleu_ratings.catalog_heads(scope_key,region_id,catalog_id) VALUES('global',NULL,$1) ON CONFLICT(scope_key) DO UPDATE SET catalog_id=EXCLUDED.catalog_id",
      [catalogId],
    );
    const command = createRatingCommentSchema.parse({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: targetRevision,
      authorMode: 'anonymous',
      body: 'Synthetic root committed before like activation',
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
    await capturePreLikeCreated(tx, accountId, command.clientRequestId);
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

async function seedPreLikeReply(
  pool: Pool,
  root: Awaited<ReturnType<typeof seedPreLikeRoot>>,
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const actor = randomUUID(),
      id = randomUUID(),
      revision = randomUUID(),
      persona = randomUUID();
    await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
      actor,
    ]);
    await initializeNativeSafetyAccount(actor, tx);
    await establishSyntheticExperienceBaseline(tx, actor, { balance: 0n });
    const input = createRatingReplySchema.parse({
      clientRequestId: randomUUID(),
      regionId: null,
      targetId: root.targetId,
      expectedTargetRevision: root.targetRevision,
      expectedRootRevision: root.rootRevision,
      replyTo: null,
      authorMode: 'anonymous',
      body: 'Synthetic reply before like activation',
      assetIds: [],
    });
    const envelope = canonicalRatingEnvelope({
      version: 2,
      purpose: 'publish_rating_reply',
      accountId: actor,
      clientRequestId: input.clientRequestId,
      targetId: root.targetId,
      targetRevision: root.targetRevision,
      rootId: root.rootId,
      rootRevision: root.rootRevision,
      replyTo: null,
      categoryId: root.categoryId,
      categoryRevision: root.categoryRevision,
      catalogRevision: root.catalogId,
      scope: { regionId: null },
      authorMode: input.authorMode,
      body: input.body,
      assetIds: [],
    });
    const approval = await writeRatingApproval(tx, envelope);
    const hash = createHash('sha256')
      .update(
        'whaleu:rating-reply-command:v1\n' +
          canonicalJson({
            operation: 'create_reply',
            intent: { rootId: root.rootId, ...input },
          }),
      )
      .digest('hex');
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_reply',$3)",
      [actor, input.clientRequestId, hash],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.personas(target_id,account_id,public_id,display_name) VALUES($1,$2,$3,'Synthetic pre-like reply persona')",
      [root.targetId, actor, persona],
    );
    const occurredAt = (
      await tx.query<{ at: string }>(
        `INSERT INTO whaleu_ratings.replies(id,target_id,root_id,reply_to_id,account_id,author_mode,persona_id,body,revision,request_id,envelope) VALUES($1,$2,$3,NULL,$4,'anonymous',$5,$6,$7,$8,$9::jsonb) RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
        [
          id,
          root.targetId,
          root.rootId,
          actor,
          persona,
          input.body,
          revision,
          input.clientRequestId,
          canonicalJson(envelope),
        ],
      )
    ).rows[0]!.at;
    await tx.query(
      "INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES('reply',$1,1,$2,$3,'publish_rating_reply',2,$4,$5::jsonb,$6::jsonb)",
      [
        id,
        approval.decisionId,
        actor,
        approval.digest,
        canonicalJson(envelope),
        canonicalJson(envelope.scope),
      ],
    );
    const eventId = await capturePreLikeCreated(
      tx,
      actor,
      input.clientRequestId,
    );
    const receipt = {
      requestId: input.clientRequestId,
      operation: 'create_reply',
      outcome: 'applied',
      targetId: root.targetId,
      rootId: root.rootId,
      replyId: id,
      revision,
      occurredAt,
    };
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [actor, input.clientRequestId, JSON.stringify(receipt)],
    );
    return { id, actor, input, receipt, eventId };
  });
}
async function settlePreLikeRoot(
  pool: Pool,
  root: Awaited<ReturnType<typeof seedPreLikeRoot>>,
) {
  await inTransaction(pool, async (tx) => {
    const unit = (
      await tx.query<{
        unitId: string;
        beneficiaryId: string;
        action: 'comment';
        occurredAt: string;
      }>(
        `SELECT u.id "unitId",u.beneficiary_id "beneficiaryId",u.action,g.occurred_at::text "occurredAt" FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id WHERE g.root_id=$1 AND g.event_kind='root_created'`,
        [root.rootId],
      )
    ).rows[0]!;
    await lockExperienceOwner(tx, unit.beneficiaryId);
    const records = new ExperienceRepository(),
      state = await records.state(unit.beneficiaryId, tx);
    assert.ok(state);
    await new ExperienceSettlementService(
      records,
      new ExperienceClock(),
    ).source(unit, state, tx);
    await tx.query(
      "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp(),error_code=NULL WHERE unit_id=$1",
      [unit.unitId],
    );
  });
}

/** A genuinely nonempty 0047 prefix, not an empty-schema activation smoke. */
test(
  'rating likes activation preserves existing source, reward, receipt and notice history and fails closed for incomplete native evidence',
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
        (m) => Number(m.name.slice(0, 4)) <= 47,
      );
      assert.equal(previous.at(-1)!.name.slice(0, 4), '0047');
      await runMigrations(pool, previous, { mode: 'up' });
      assert.equal(
        (
          await pool.query(
            "SELECT to_regclass('whaleu_ratings.like_subjects') AS likes",
          )
        ).rows[0]!.likes,
        null,
      );
      const root = await seedPreLikeRoot(pool),
        reply = await seedPreLikeReply(pool, root);
      await settlePreLikeRoot(pool, root);
      const noticeId = randomUUID();
      await inTransaction(pool, async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_notifications.owners(account_id) VALUES($1)',
          [root.accountId],
        );
        await tx.query(
          'SELECT account_id FROM whaleu_notifications.owners WHERE account_id=$1 FOR UPDATE',
          [root.accountId],
        );
        await tx.query(
          "INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome) VALUES($1,$2,'direct_root','materialized')",
          [reply.eventId, root.accountId],
        );
        await tx.query(
          "INSERT INTO whaleu_notifications.rating_notices(id,event_id,recipient_account_id,kind,reason,region_id,target_id,root_id,reply_id,occurred_at,event_sequence) SELECT $1,e.id,$2,'reply','direct_root',e.region_id,e.target_id,e.root_id,e.reply_id,e.occurred_at,e.event_sequence FROM whaleu_ratings.effect_events e WHERE e.id=$3",
          [noticeId, root.accountId, reply.eventId],
        );
        await tx.query(
          "INSERT INTO whaleu_notifications.rating_event_receipts(event_id,outcome) VALUES($1,'processed')",
          [reply.eventId],
        );
        await tx.query(
          'UPDATE whaleu_notifications.rating_notices SET read_at=clock_timestamp() WHERE id=$1',
          [noticeId],
        );
      });
      const incomplete = await seedPreLikeRoot(pool);
      // Isolated imported/damaged-history fixture: 0047 writers cannot naturally
      // produce a partial source. Only this legacy source xid is changed, then the
      // exact immutable guard is restored before either migration or assertions.
      await withCommunityScopeWriter(pool, async (tx) => {
        await tx.query(
          'ALTER TABLE whaleu_ratings.comment_transitions DISABLE TRIGGER rating_immutable',
        );
        await tx.query(
          'UPDATE whaleu_ratings.comment_transitions SET mutation_transaction=pg_current_xact_id() WHERE comment_id=$1',
          [incomplete.rootId],
        );
        await tx.query(
          'ALTER TABLE whaleu_ratings.comment_transitions ENABLE TRIGGER rating_immutable',
        );
      });
      const tables = (
        await pool.query<{ schema: string; name: string; columns: string[] }>(
          `SELECT table_schema AS schema,table_name AS name,array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema IN ('whaleu_ratings','whaleu_experience','whaleu_notifications') GROUP BY table_schema,table_name ORDER BY table_schema,table_name`,
        )
      ).rows;
      const snapshot = async () => {
        const result: Record<string, string[]> = {};
        for (const table of tables) {
          for (const name of [table.schema, table.name, ...table.columns])
            assert.match(name, /^[a-z_][a-z0-9_]*$/);
          result[`${table.schema}.${table.name}`] = (
            await pool.query<{ bytes: string }>(
              `SELECT to_jsonb(original)::text AS bytes FROM (SELECT ${table.columns.map((c) => '"' + c + '"').join(',')} FROM ${table.schema}.${table.name}) original ORDER BY to_jsonb(original)::text`,
            )
          ).rows.map((r) => r.bytes);
        }
        for (const sequence of [
          'whaleu_experience.enrollment_order',
          'whaleu_notifications.rating_notices_ordinal_seq',
          'whaleu_ratings.effect_events_event_sequence_seq',
        ])
          result[sequence] = (
            await pool.query<{ bytes: string }>(
              `SELECT jsonb_build_object('last_value',last_value::text,'is_called',is_called)::text AS bytes FROM ${sequence}`,
            )
          ).rows.map((r) => r.bytes);
        return result;
      };
      const before = await snapshot();
      await t.test(
        'activation enrolls exact native root/reply once and preserves every original row/field plus XP and notice sequences',
        async () => {
          await runMigrations(pool, migrations, { mode: 'up' });
          assert.deepEqual(await snapshot(), before);
          const enrolled = (
            await pool.query<{
              id: string;
              kind: string;
              exact_cutover: boolean;
              exact_publication: boolean;
              count: number;
            }>(
              `SELECT s.id,s.kind,s.baseline_at=a.activated_at AND s.provenance='native-activation' AND s.creation_transaction=a.activation_transaction AS exact_cutover,s.publication_transaction=coalesce(c.publication_transaction,r.publication_transaction) AS exact_publication,st.count FROM whaleu_ratings.like_subjects s JOIN whaleu_ratings.like_activations a ON a.id=s.activation_id JOIN whaleu_ratings.like_states st ON st.subject_id=s.id LEFT JOIN whaleu_ratings.comments c ON s.kind='comment' AND c.id=s.id LEFT JOIN whaleu_ratings.replies r ON s.kind='reply' AND r.id=s.id ORDER BY s.kind`,
            )
          ).rows;
          assert.deepEqual(enrolled, [
            {
              id: root.rootId,
              kind: 'comment',
              exact_cutover: true,
              exact_publication: true,
              count: 0,
            },
            {
              id: reply.id,
              kind: 'reply',
              exact_cutover: true,
              exact_publication: true,
              count: 0,
            },
          ]);
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_ratings.like_transitions'))
              .rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_ratings.like_memberships'))
              .rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_ratings.effect_events WHERE source_version=2',
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT notice_id FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1',
                [reply.eventId],
              )
            ).rows,
            [{ notice_id: noticeId }],
          );
          const activation = (
            await pool.query(
              'SELECT to_jsonb(a)::text AS bytes FROM whaleu_ratings.like_activations a',
            )
          ).rows;
          await runMigrations(pool, migrations, { mode: 'up' });
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(a)::text AS bytes FROM whaleu_ratings.like_activations a',
              )
            ).rows,
            activation,
          );
          assert.deepEqual(await snapshot(), before);
        },
      );
      await t.test(
        'accepted catalog and independent score zero do not enroll damaged native publication or synthesize a sortable zero',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_ratings.like_subjects WHERE id=$1',
                [incomplete.rootId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_ratings.score_baselines WHERE target_id=$1',
                [incomplete.targetId],
              )
            ).rowCount,
            1,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT known,count FROM whaleu_ratings.root_order_entries WHERE root_id=$1',
                [incomplete.rootId],
              )
            ).rows,
            [{ known: false, count: null }],
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT missing FROM whaleu_ratings.root_order_heads WHERE target_id=$1',
                [incomplete.targetId],
              )
            ).rows,
            [{ missing: 1 }],
          );
          await assert.rejects(
            () =>
              inTransaction(pool, (tx) =>
                new RatingRootOrderRepository().head(
                  incomplete.targetId,
                  'likes',
                  tx,
                ),
              ),
            (e: unknown) =>
              e instanceof ApplicationError && e.code === 'RATING_UNAVAILABLE',
          );
          await inTransaction(pool, (tx) =>
            new RatingRootOrderRepository().head(
              incomplete.targetId,
              'time',
              tx,
            ),
          );
          app = await NestFactory.create(AppModule.register(config), {
            logger: false,
          });
          await app.init();
          const scope = await seedCommunityScope(pool),
            actor = await createRuntimeActor(app);
          await setRuntimeVerification(
            pool,
            actor.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          assert.deepEqual(
            await app
              .get(RatingLikesService)
              .state(actor.accessToken, 'comment', incomplete.rootId, null),
            { status: 'unavailable' },
          );
        },
      );
      await t.test(
        'old publication cannot claim a late fresh baseline or replay the consumed cutover',
        async () => {
          for (const provenance of ['native-publication', 'native-activation'])
            await assert.rejects(
              () =>
                inTransaction(pool, (tx) =>
                  tx.query(
                    `INSERT INTO whaleu_ratings.like_subjects(id,kind,target_id,root_id,baseline_id,baseline_at,provenance,activation_id,comment_transition_id,publication_transaction) SELECT c.id,'comment',c.target_id,c.id,gen_random_uuid(),CASE WHEN $2='native-publication' THEN c.created_at ELSE a.activated_at END,$2,CASE WHEN $2='native-activation' THEN a.id END,t.id,c.publication_transaction FROM whaleu_ratings.comments c JOIN whaleu_ratings.comment_transitions t ON t.comment_id=c.id AND t.operation='create_comment' CROSS JOIN whaleu_ratings.like_activations a WHERE c.id=$1`,
                    [root.rootId, provenance],
                  ),
                ),
              (e: unknown) =>
                !!e &&
                typeof e === 'object' &&
                'code' in e &&
                e.code === '23514' &&
                e instanceof Error &&
                (provenance === 'native-publication'
                  ? /Old publication cannot claim fresh baseline/.test(
                      e.message,
                    )
                  : /Like cutover publication receipt mismatch/.test(
                      e.message,
                    )),
            );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_ratings.like_subjects WHERE id=$1',
                [incomplete.rootId],
              )
            ).rowCount,
            0,
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
