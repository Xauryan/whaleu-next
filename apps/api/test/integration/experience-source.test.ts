import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { ReplyPublicationService } from '../../src/community/discussion/publication.service.js';
import { DiscussionMutationService } from '../../src/community/discussion/mutation.service.js';
import { ReactionsService } from '../../src/community/reactions.service.js';
import { DeletionService } from '../../src/community/deletion.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityExperienceSourceCapture } from '../../src/community/experience-source/capture.js';
import { CommunityExperienceSourceFacade } from '../../src/community/experience-source/facade.js';
import { SavedMutationService } from '../../src/community/saved/mutation.service.js';
import { ExperienceIngressService } from '../../src/experience/ingress.js';
import { ExperienceClock } from '../../src/experience/repository.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import {
  publishPostSchema,
  publishCommentSchema,
} from '../../src/community/contracts.js';
import type { PublicationReceipt } from '../../src/community/contracts.js';
import { publishReplySchema } from '../../src/community/discussion/contracts.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approveReply,
  approvePoll,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const codeIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const sqlCode = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;
function created(receipt: PublicationReceipt) {
  assert.equal(receipt.outcome, 'created', JSON.stringify(receipt));
  if (receipt.outcome !== 'created') throw new Error();
  return receipt.resourceId;
}

test(
  'real PostgreSQL fresh community reward sources, atomic enrollment and durable post-like intents',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Use a new disposable loopback whaleu_test database',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      locked = false,
      owns = false;
    const schemas = ['whaleu_community_test', ...migrationSchemaNames];
    const oldOwner = randomUUID(),
      oldActor = randomUUID(),
      oldPost = randomUUID(),
      oldEvent = randomUUID(),
      oldEpoch = randomUUID(),
      oldObligation = randomUUID(),
      spaceId = randomUUID(),
      region = randomUUID();
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run integration serially');
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
            'SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [schemas],
          )
        ).rowCount,
        0,
        'Refusing existing schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const experienceIndex = migrations.findIndex(
        (migration) => migration.name === '0022_local_experience.sql',
      );
      assert.ok(experienceIndex > 0);
      await runMigrations(pool, migrations.slice(0, experienceIndex), {
        mode: 'up',
      });
      // Explicit synthetic pre-migration history. No fixture claims a real person's balance.
      await pool.query(
        'INSERT INTO whaleu_identity.accounts(id) VALUES($1),($2)',
        [oldOwner, oldActor],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic source region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic source space',true,$2)",
        [spaceId, region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic historical content','anonymous','open')",
        [oldPost, spaceId, oldOwner],
      );
      await pool.query(
        'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
        [oldPost, oldActor],
      );
      await pool.query(
        "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id) VALUES($1,$2,'post_liked',$3)",
        [oldEvent, `historical:${oldEvent}`, oldPost],
      );
      const prior = await pool.connect();
      try {
        await prior.query('BEGIN');
        await prior.query(
          'INSERT INTO whaleu_community.saved_posts(account_id,post_id) VALUES($1,$2)',
          [oldActor, oldPost],
        );
        const timing = (
          await prior.query<{ at: Date; sequence: string }>(
            "SELECT date_trunc('milliseconds',clock_timestamp()) AS at,nextval('whaleu_community.discussion_sequence') AS sequence",
          )
        ).rows[0]!;
        await prior.query(
          'INSERT INTO whaleu_community.saved_epochs(id,account_id,post_id,started_at,started_sequence) VALUES($1,$2,$3,$4,$5)',
          [oldEpoch, oldActor, oldPost, timing.at, timing.sequence],
        );
        await prior.query(
          'UPDATE whaleu_community.saved_posts SET epoch_id=$3,saved_at=$4,revision=$5 WHERE account_id=$1 AND post_id=$2',
          [oldActor, oldPost, oldEpoch, timing.at, timing.sequence],
        );
        await prior.query(
          "INSERT INTO whaleu_community.saved_obligations(id,epoch_id,transition,action,recipient_account_id,delta) VALUES($1,$2,'saved','saver_reward',$3,1)",
          [oldObligation, oldEpoch, oldActor],
        );
        await prior.query('COMMIT');
      } finally {
        await prior.query('ROLLBACK');
        prior.release();
      }
      await runMigrations(pool, migrations, { mode: 'up' });
      await fixtureSchema(pool);
      const authorization = new FixtureAuthorization();
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (subject: string) => ({
            provider: 'wechat',
            appId: 'synthetic-experience-source',
            subject,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(authorization)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(new FixtureVisibility())
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(new FixtureContent())
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService),
        publications = app.get(PublicationService),
        replies = app.get(ReplyPublicationService),
        discussion = app.get(DiscussionMutationService),
        reactions = app.get(ReactionsService),
        deletions = app.get(DeletionService),
        saved = app.get(SavedMutationService),
        ingress = app.get(ExperienceIngressService),
        capture = app.get(CommunityExperienceSourceCapture),
        facade = app.get(CommunityExperienceSourceFacade),
        database = app.get(DatabaseService),
        community = app.get(CommunityRepository);
      const author = await identity.login('source-author'),
        actor = await identity.login('source-actor'),
        other = await identity.login('source-other'),
        fourth = await identity.login('source-fourth');
      for (const account of [author, actor, other, fourth])
        await grant(pool, account.accountId, spaceId, {
          ...verified(region),
          canManage: true,
        });
      const http = app.getHttpServer(),
        auth = (account = actor) => `Bearer ${account.accessToken}`;
      async function publish(
        account = author,
        mode: 'named' | 'anonymous' = 'named',
      ) {
        const body = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          text: `Synthetic source ${randomUUID()}`,
          authorMode: mode,
        });
        await approve(pool, account.accountId, body.text);
        return {
          id: created(await publications.post(account.accessToken, body)),
          body,
        };
      }
      async function comment(
        postId: string,
        account = actor,
        mode: 'named' | 'anonymous' = 'named',
      ) {
        const body = publishCommentSchema.parse({
          clientRequestId: randomUUID(),
          text: `Synthetic comment ${randomUUID()}`,
          authorMode: mode,
        });
        await approve(pool, account.accountId, body.text, 'publish_comment');
        return created(
          await publications.comment(account.accessToken, postId, body),
        );
      }
      async function reply(
        postId: string,
        rootId: string,
        account: SessionCredentials,
        targetReplyId: string | null = null,
        mode: 'named' | 'anonymous' = 'named',
      ) {
        const body = publishReplySchema.parse({
          clientRequestId: randomUUID(),
          text: `Synthetic reply ${randomUUID()}`,
          authorMode: mode,
          targetReplyId,
        });
        await approveReply(pool, account.accountId, postId, rootId, body, mode);
        return created(await replies.create(account.accessToken, rootId, body));
      }
      const like = (
        postId: string,
        liked: boolean,
        account = actor,
        requestId = randomUUID(),
      ) => reactions.setLike(account.accessToken, postId, { requestId, liked });
      const save = (
        postId: string,
        desired: boolean,
        account = actor,
        requestId = randomUUID(),
      ) =>
        saved.set(account.accessToken, requestId, {
          operation: 'set_post_saved',
          postId,
          desired,
          channel: null,
        });
      const groups = async (id: string) =>
        (
          await pool.query<{
            id: string;
            event_type: string;
            actor_account_id: string;
            actor_author_mode: string | null;
            resource_author_mode: string;
            expected_unit_count: number;
          }>(
            'SELECT * FROM whaleu_community.reward_source_groups WHERE post_id=$1 OR root_comment_id=$1 OR reply_id=$1 ORDER BY enrollment_order',
            [id],
          )
        ).rows;
      const units = async (groupId: string) =>
        (
          await pool.query<{
            id: string;
            beneficiary_id: string;
            action: string;
            outbox_event_id: string | null;
            saved_obligation_id: string | null;
          }>(
            'SELECT * FROM whaleu_community.reward_source_units WHERE group_id=$1 ORDER BY beneficiary_id,action',
            [groupId],
          )
        ).rows;
      const shape = (rows: Awaited<ReturnType<typeof units>>) =>
        rows.map((row) => `${row.beneficiary_id}:${row.action}`).sort();
      async function count(table: string) {
        return Number(
          (
            await pool.query<{ count: string }>(
              `SELECT count(*) AS count FROM ${table}`,
            )
          ).rows[0]!.count,
        );
      }
      async function rawTransaction(fn: (tx: PoolClient) => Promise<void>) {
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          await fn(tx);
          await tx.query('COMMIT');
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      }

      await t.test(
        'migration adopts no historical outbox, like membership, Saved obligation, balance or registration title',
        async () => {
          assert.equal(await count('whaleu_community.reward_source_groups'), 0);
          assert.equal(await count('whaleu_community.reward_source_units'), 0);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.baselines WHERE owner_id=ANY($1::uuid[])',
                [[oldOwner, oldActor]],
              )
            ).rowCount,
            0,
          );
          const old = (
            await pool.query(
              'SELECT local_creation_transaction FROM whaleu_community.posts WHERE id=$1',
              [oldPost],
            )
          ).rows[0];
          assert.equal(old.local_creation_transaction, null);
          assert.equal(
            (
              await pool.query(
                'SELECT local_creation_transaction FROM whaleu_community.saved_obligations WHERE id=$1',
                [oldObligation],
              )
            ).rows[0].local_creation_transaction,
            null,
          );
          await assert.rejects(
            database.transaction((tx) => capture.enroll(oldEvent, tx)),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          const result = await like(oldPost, true);
          assert.equal(result.outcome, 'applied');
          const group = (await groups(oldPost)).find(
            (item) => item.event_type === 'post_liked',
          )!;
          assert.deepEqual(
            shape(await units(group.id)),
            [
              `${actor.accountId}:like_save`,
              `${oldOwner}:received_like_save`,
            ].sort(),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.account_states WHERE owner_id=$1',
                [oldOwner],
              )
            ).rowCount,
            0,
            'Unknown recipient remains unknown',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                [oldObligation],
              )
            ).rows[0].status,
            'pending',
          );
        },
      );
      await t.test(
        'exact source microseconds survive capture and settlement without weakening source proof',
        async () => {
          const precise = await identity.login('source-precise-owner');
          await grant(pool, precise.accountId, spaceId, verified(region));
          let post: Awaited<ReturnType<typeof publish>>;
          await pool.query(
            "ALTER TABLE whaleu_community.posts ALTER COLUMN published_at SET DEFAULT '2001-01-01T00:00:00.123456Z'::timestamptz",
          );
          try {
            post = await publish(precise);
          } finally {
            await pool.query(
              "ALTER TABLE whaleu_community.posts ALTER COLUMN published_at SET DEFAULT date_trunc('milliseconds',clock_timestamp())",
            );
          }
          const group = (await groups(post.id)).find(
            (item) => item.event_type === 'post_created',
          )!;
          const unit = (await units(group.id))[0]!;
          assert.equal(
            (
              await pool.query<{ same: boolean }>(
                'SELECT g.occurred_at=p.published_at AND g.occurred_at=$2::timestamptz AS same FROM whaleu_community.reward_source_groups g JOIN whaleu_community.posts p ON p.id=g.post_id WHERE g.id=$1',
                [group.id, '2001-01-01T00:00:00.123456Z'],
              )
            ).rows[0]!.same,
            true,
          );
          const source = await database.transaction((tx) =>
            facade.loadUnit(unit.id, tx),
          );
          assert.match(source!.occurredAt!, /\.123456(?:[+-]|Z)/);
          assert.equal(
            (
              await app!
                .get(ExperienceWorker)
                .run({ mode: 'apply', unitIds: [unit.id] })
            ).settled,
            1,
          );
          assert.equal(
            (
              await pool.query<{ same: boolean }>(
                'SELECT r.occurred_at=g.occurred_at AND r.occurred_at=$2::timestamptz AS same FROM whaleu_experience.records r JOIN whaleu_experience.settlements s ON s.id=r.settlement_id JOIN whaleu_community.reward_source_units u ON u.id=s.unit_id JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id WHERE u.id=$1',
                [unit.id, '2001-01-01T00:00:00.123456Z'],
              )
            ).rows[0]!.same,
            true,
          );
        },
      );
      await t.test(
        'publication snapshots preserve real anonymous mode and exact root/reply recipient matrix',
        async () => {
          const post = await publish(author, 'anonymous'),
            root = await comment(post.id, actor),
            first = await reply(post.id, root, other),
            second = await reply(post.id, root, fourth, first, 'anonymous');
          const all = await groups(post.id),
            publication = all.find(
              (item) => item.event_type === 'post_created',
            )!;
          assert.equal(publication.actor_account_id, author.accountId);
          assert.equal(publication.actor_author_mode, 'anonymous');
          assert.deepEqual(shape(await units(publication.id)), [
            `${author.accountId}:publish`,
          ]);
          const rootGroup = (await groups(root)).find(
            (item) => item.event_type === 'comment_created',
          )!;
          assert.deepEqual(
            shape(await units(rootGroup.id)),
            [
              `${actor.accountId}:comment`,
              `${author.accountId}:received_comment`,
            ].sort(),
          );
          const replyGroup = (await groups(second)).find(
            (item) => item.event_type === 'reply_created',
          )!;
          assert.equal(replyGroup.actor_author_mode, 'anonymous');
          assert.deepEqual(
            shape(await units(replyGroup.id)),
            [
              `${fourth.accountId}:comment`,
              `${actor.accountId}:received_comment`,
              `${other.accountId}:received_comment`,
            ].sort(),
          );
          const selfTarget = await reply(post.id, root, actor, first);
          const selfGroup = (await groups(selfTarget)).find(
            (item) => item.event_type === 'reply_created',
          )!;
          assert.deepEqual(
            shape(await units(selfGroup.id)),
            [
              `${actor.accountId}:comment`,
              `${other.accountId}:received_comment`,
            ].sort(),
          );
          const duplicateTarget = await reply(post.id, root, actor);
          const deduplicated = await reply(
            post.id,
            root,
            fourth,
            duplicateTarget,
          );
          const duplicateGroup = (await groups(deduplicated)).find(
            (item) => item.event_type === 'reply_created',
          )!;
          assert.deepEqual(
            shape(await units(duplicateGroup.id)),
            [
              `${fourth.accountId}:comment`,
              `${actor.accountId}:received_comment`,
            ].sort(),
          );
          const unit = (await units(replyGroup.id))[0]!;
          const source = await database.transaction((tx) =>
            facade.loadUnit(unit.id, tx),
          );
          assert.ok(source);
          assert.deepEqual(
            Object.keys(source).sort(),
            [
              'unitId',
              'groupId',
              'beneficiaryId',
              'action',
              'occurredAt',
              'sourceKind',
              'sourceId',
            ].sort(),
          );
          assert.equal(JSON.stringify(source).includes('Synthetic'), false);
        },
      );
      await t.test(
        'post-like exact retries, no-op requests, lost response recovery and new re-likes use immutable intent receipts',
        async () => {
          const post = await publish(),
            intent = { requestId: randomUUID(), liked: true };
          assert.equal(
            (
              await request(http)
                .put(`/v1/community/posts/${post.id}/like`)
                .set('Authorization', auth())
            ).status,
            400,
          );
          assert.equal(
            (
              await request(http)
                .delete(`/v1/community/posts/${post.id}/like`)
                .set('Authorization', auth())
                .send({ requestId: randomUUID() })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(http)
                .put(`/v1/community/posts/${post.id}/like`)
                .set('Authorization', auth())
                .send({ ...intent, ownerId: author.accountId })
            ).status,
            400,
          );
          const original = await Promise.all(
            Array.from({ length: 4 }, () =>
              reactions.setLike(actor.accessToken, post.id, intent),
            ),
          );
          for (const receipt of original)
            assert.deepEqual(receipt, original[0]);
          assert.deepEqual(original[0], {
            ...intent,
            operation: 'set_post_like',
            postId: post.id,
            outcome: 'applied',
          });
          const noOp = await like(post.id, true);
          assert.equal(noOp.outcome, 'applied');
          assert.equal(
            (await groups(post.id)).filter(
              (group) => group.event_type === 'post_liked',
            ).length,
            1,
          );
          await like(post.id, false);
          assert.deepEqual(
            await reactions.setLike(actor.accessToken, post.id, intent),
            original[0],
          );
          assert.deepEqual(
            await reactions.receipt(actor.accessToken, intent.requestId),
            original[0],
          );
          await reactions.setLike(actor.accessToken, post.id, {
            requestId: noOp.requestId,
            liked: true,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
                [post.id, actor.accountId],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            reactions.setLike(actor.accessToken, post.id, {
              ...intent,
              liked: false,
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          await assert.rejects(
            reactions.receipt(other.accessToken, intent.requestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await like(post.id, true);
          const rewarded = (await groups(post.id)).filter(
            (group) => group.event_type === 'post_liked',
          );
          assert.equal(rewarded.length, 2);
          for (const group of rewarded)
            assert.deepEqual(
              shape(await units(group.id)),
              [
                `${actor.accountId}:like_save`,
                `${author.accountId}:received_like_save`,
              ].sort(),
            );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [post.id],
          );
          assert.deepEqual(
            await reactions.receipt(actor.accessToken, intent.requestId),
            original[0],
          );
          assert.deepEqual(
            await reactions.setLike(actor.accessToken, post.id, intent),
            original[0],
          );
          const blocked = await like(post.id, false);
          assert.equal(blocked.outcome, 'rejected');
          if (blocked.outcome === 'rejected')
            assert.equal(blocked.code, 'POST_NOT_FOUND');
          const recovered = await request(http)
            .get(`/v1/me/community/post-like-requests/${intent.requestId}`)
            .set('Authorization', auth());
          assert.equal(recovered.status, 200);
          assert.deepEqual(recovered.body, original[0]);
        },
      );
      await t.test(
        'discussion likes preserve exact fresh membership, self exclusion and old receipt replay',
        async () => {
          const post = await publish(),
            root = await comment(post.id, actor),
            replyId = await reply(post.id, root, other);
          const requestId = randomUUID();
          await discussion.set(
            fourth.accessToken,
            requestId,
            'set_reply_like',
            replyId,
            true,
          );
          await discussion.set(
            fourth.accessToken,
            randomUUID(),
            'set_reply_like',
            replyId,
            false,
          );
          await discussion.set(
            fourth.accessToken,
            requestId,
            'set_reply_like',
            replyId,
            true,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.reply_likes WHERE reply_id=$1',
                [replyId],
              )
            ).rowCount,
            0,
          );
          const group = (await groups(replyId)).find(
            (item) => item.event_type === 'reply_liked',
          )!;
          assert.equal(group.actor_author_mode, null);
          assert.deepEqual(
            shape(await units(group.id)),
            [
              `${fourth.accountId}:like_save`,
              `${other.accountId}:received_like_save`,
            ].sort(),
          );
          await discussion.set(
            actor.accessToken,
            randomUUID(),
            'set_comment_like',
            root,
            true,
          );
          const self = (await groups(root)).find(
            (item) => item.event_type === 'comment_liked',
          )!;
          assert.deepEqual(shape(await units(self.id)), [
            `${actor.accountId}:like_save`,
          ]);
          await discussion.set(
            author.accessToken,
            randomUUID(),
            'set_comment_pin',
            root,
            true,
          );
          assert.equal(
            (await groups(root)).filter((item) =>
              item.event_type.includes('pin'),
            ).length,
            0,
          );
        },
      );
      await t.test(
        'Saved obligations are canonical; envelope, self-save, no-op, preference and unsave cannot double-credit',
        async () => {
          const post = await publish(),
            requestId = randomUUID();
          await save(post.id, true, actor, requestId);
          await save(post.id, true, actor, requestId);
          await save(post.id, true);
          let enrolled = (await groups(post.id)).filter(
            (group) => group.event_type === 'post_saved',
          );
          assert.equal(enrolled.length, 1);
          const first = await units(enrolled[0]!.id);
          assert.deepEqual(
            shape(first),
            [
              `${actor.accountId}:like_save`,
              `${author.accountId}:received_like_save`,
            ].sort(),
          );
          assert.ok(
            first.every(
              (unit) => unit.saved_obligation_id && !unit.outbox_event_id,
            ),
          );
          const obligation = (
            await pool.query(
              'SELECT action,status FROM whaleu_community.saved_obligations WHERE epoch_id=(SELECT save_epoch_id FROM whaleu_community.reward_source_groups WHERE id=$1)',
              [enrolled[0]!.id],
            )
          ).rows;
          assert.equal(obligation.length, 4);
          assert.ok(obligation.every((item) => item.status === 'pending'));
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1",
              [first[0]!.saved_obligation_id],
            ),
            sqlCode('23514'),
          );
          await save(post.id, false);
          await saved.set(actor.accessToken, randomUUID(), {
            operation: 'set_post_update_preference',
            postId: post.id,
            desired: false,
            channel: 'saved',
          });
          assert.equal(
            (await groups(post.id)).filter(
              (group) => group.event_type === 'post_saved',
            ).length,
            1,
          );
          await save(post.id, true);
          await save(post.id, true, author);
          enrolled = (await groups(post.id)).filter(
            (group) => group.event_type === 'post_saved',
          );
          assert.equal(enrolled.length, 3);
          const self = enrolled.find(
            (group) => group.actor_account_id === author.accountId,
          )!;
          assert.deepEqual(shape(await units(self.id)), [
            `${author.accountId}:like_save`,
          ]);
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM whaleu_community.saved_obligations WHERE action IN ('author_interactions','save_ranking') AND status<>'pending'",
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'own deletion produces only owner penalty, including old uncredited content; unlikes and moderation do not',
        async () => {
          const post = await publish(),
            root = await comment(post.id, actor),
            replyId = await reply(post.id, root, other);
          await deletions.post(author.accessToken, post.id);
          await deletions.post(author.accessToken, post.id);
          let deleted = (await groups(post.id)).filter((group) =>
            group.event_type.endsWith('_deleted'),
          );
          assert.equal(deleted.length, 1);
          assert.deepEqual(shape(await units(deleted[0]!.id)), [
            `${author.accountId}:delete_post`,
          ]);
          assert.equal(
            (
              await pool.query(
                'SELECT deleted_at FROM whaleu_community.root_comments WHERE id=$1',
                [root],
              )
            ).rows[0].deleted_at,
            null,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT deleted_at FROM whaleu_community.replies WHERE id=$1',
                [replyId],
              )
            ).rows[0].deleted_at,
            null,
          );
          const live = await publish(),
            liveRoot = await comment(live.id, actor),
            liveReply = await reply(live.id, liveRoot, other);
          await discussion.deleteReply(other.accessToken, liveReply);
          await deletions.comment(actor.accessToken, liveRoot);
          deleted = (await groups(live.id)).filter((group) =>
            group.event_type.endsWith('_deleted'),
          );
          assert.equal(deleted.length, 2);
          assert.deepEqual(
            (await Promise.all(deleted.map((group) => units(group.id))))
              .flat()
              .map((unit) => unit.action)
              .sort(),
            ['delete_comment', 'delete_reply'],
          );
          // Existing account logs in without a new-baseline hook; new own deletion is still a fresh source.
          await pool.query(
            "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-experience-source','old-source-owner',$1)",
            [oldOwner],
          );
          const existing = await identity.login('old-source-owner');
          await grant(pool, existing.accountId, spaceId, verified(region));
          await deletions.post(existing.accessToken, oldPost);
          const oldDelete = (await groups(oldPost)).find(
            (group) => group.event_type === 'post_deleted',
          )!;
          assert.deepEqual(shape(await units(oldDelete.id)), [
            `${oldOwner}:delete_post`,
          ]);
          const moderation = await publish();
          await database.transaction(async (tx) => {
            await tx.query(
              "UPDATE whaleu_community.posts SET deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
              [moderation.id],
            );
            await community.event(
              `moderation:${randomUUID()}`,
              'moderation_removed',
              moderation.id,
              tx,
              { cause: 'post_jury', kind: 'post' },
            );
          });
          assert.equal(
            (await groups(moderation.id)).filter((group) =>
              group.event_type.endsWith('_deleted'),
            ).length,
            0,
          );
        },
      );
      await t.test(
        'derived deletion provenance follows existing immutability guards and cannot be forged',
        async () => {
          for (const [table, protectedNames] of [
            [
              'posts',
              [
                'approved_post_immutable',
                'formation_parent_immutable',
                'trading_parent_immutable',
              ],
            ],
            [
              'root_comments',
              ['approved_comment_immutable', 'root_identity_immutable'],
            ],
            [
              'replies',
              ['approved_reply_immutable', 'reply_identity_immutable'],
            ],
          ] as const) {
            const names = (
              await pool.query<{ tgname: string }>(
                'SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND (tgtype&2)=2 AND (tgtype&16)=16 ORDER BY tgname',
                [`whaleu_community.${table}`],
              )
            ).rows.map((row) => row.tgname);
            const stamp = names.indexOf('z_reward_content_provenance');
            assert.ok(stamp >= 0);
            for (const name of protectedNames)
              assert.ok(
                names.indexOf(name) >= 0 && names.indexOf(name) < stamp,
                `${name} must inspect caller changes before the derived provenance stamp`,
              );
          }
          const unbound = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic unbound provenance guard','named','open')",
            [unbound, spaceId, author.accountId],
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET local_deletion_transaction=pg_current_xact_id() WHERE id=$1',
              [unbound],
            ),
            (error: unknown) =>
              sqlCode('23514')(error) &&
              error instanceof Error &&
              error.message === 'Deletion proof requires an actual transition',
          );
          for (const kind of ['trading', 'formation'] as const) {
            const body = publishPostSchema.parse({
              clientRequestId: randomUUID(),
              spaceId,
              category: kind === 'trading' ? 'trading' : 'discussion',
              text: `Synthetic ${kind} source deletion`,
              authorMode: 'named',
              ...(kind === 'trading'
                ? {
                    trading: {
                      subtype: 'shuma',
                      price: '1',
                      urgency: 'normal',
                      location: 'Synthetic',
                      contacts: { wechat: 'synthetic', qq: '', phone: '' },
                    },
                  }
                : {
                    component: {
                      kind: 'formation',
                      capacity: 2,
                      theme: 'Synthetic',
                      contacts: { wechat: 'synthetic', qq: '', phone: '' },
                      contactSharing: 'members_v1',
                    },
                  }),
            });
            await approvePoll(pool, author.accountId, body);
            const id = created(
              await publications.post(author.accessToken, body),
            );
            await assert.rejects(
              pool.query(
                "UPDATE whaleu_community.posts SET text='forged',local_deletion_transaction=pg_current_xact_id() WHERE id=$1",
                [id],
              ),
              sqlCode('23514'),
            );
            await assert.rejects(
              pool.query(
                'UPDATE whaleu_community.posts SET local_deletion_transaction=pg_current_xact_id() WHERE id=$1',
                [id],
              ),
              sqlCode('23514'),
            );
            await deletions.post(author.accessToken, id);
            const deleted = (await groups(id)).filter(
              (group) => group.event_type === 'post_deleted',
            );
            assert.equal(deleted.length, 1);
            assert.deepEqual(shape(await units(deleted[0]!.id)), [
              `${author.accountId}:delete_post`,
            ]);
            assert.equal(
              (
                await pool.query<{ proven: boolean }>(
                  'SELECT deleted_at IS NOT NULL AND local_deletion_transaction IS NOT NULL AS proven FROM whaleu_community.posts WHERE id=$1',
                  [id],
                )
              ).rows[0]!.proven,
              true,
            );
          }
        },
      );
      await t.test(
        'source group, complete beneficiary units and work roll back together on enqueue failure',
        async () => {
          const before = await Promise.all(
            [
              'whaleu_community.posts',
              'whaleu_community.outbox',
              'whaleu_community.reward_source_groups',
              'whaleu_community.reward_source_units',
              'whaleu_experience.work',
              'whaleu_experience.enrollments',
            ].map(count),
          );
          const original = ingress.enqueue;
          ingress.enqueue = async () => {};
          try {
            await assert.rejects(publish(), sqlCode('23514'));
          } finally {
            ingress.enqueue = original;
          }
          const after = await Promise.all(
            [
              'whaleu_community.posts',
              'whaleu_community.outbox',
              'whaleu_community.reward_source_groups',
              'whaleu_community.reward_source_units',
              'whaleu_experience.work',
              'whaleu_experience.enrollments',
            ].map(count),
          );
          assert.deepEqual(after, before);
        },
      );
      await t.test(
        'Saved settlement cannot deadlock with a fresh source holding the parent lock and waiting for the same owner',
        async () => {
          const concurrent = await identity.login('source-concurrent-saver');
          await grant(pool, concurrent.accountId, spaceId, verified(region));
          const post = await publish();
          await save(post.id, true, concurrent);
          const savedGroup = (await groups(post.id)).find(
            (group) => group.event_type === 'post_saved',
          )!;
          const saverUnit = (await units(savedGroup.id)).find(
            (unit) => unit.beneficiary_id === concurrent.accountId,
          )!;
          const clock = app!.get(ExperienceClock),
            worker = app!.get(ExperienceWorker);
          const originalNow = clock.now.bind(clock);
          let reached!: () => void, release!: () => void;
          const started = new Promise<void>((resolve) => {
            reached = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          clock.now = async (tx) => {
            reached();
            await held;
            return originalNow(tx);
          };
          let processing: ReturnType<ExperienceWorker['run']> | undefined;
          let writing: ReturnType<typeof like> | undefined;
          try {
            processing = worker.run({ mode: 'apply', unitIds: [saverUnit.id] });
            await Promise.race([
              started,
              sleep(5000).then(() => {
                throw new Error('Worker did not reach owner-held clock');
              }),
            ]);
            writing = like(post.id, true, concurrent);
            let waiting = false;
            for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
              waiting = !!(
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%whaleu_experience.owners%'",
                )
              ).rowCount;
              if (!waiting) await sleep(10);
            }
            assert.equal(
              waiting,
              true,
              'New source waits behind the worker owner guard while retaining parent authorization locks',
            );
            release();
            assert.equal((await processing).settled, 1);
            assert.equal((await writing).outcome, 'applied');
            assert.equal(
              (
                await pool.query(
                  'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                  [saverUnit.saved_obligation_id],
                )
              ).rows[0].status,
              'completed',
            );
          } finally {
            release();
            clock.now = originalNow;
            await Promise.allSettled(
              [processing, writing].filter((value) => value !== undefined),
            );
          }
        },
      );
      await t.test(
        'SQL rejects omitted source enrollment, immutable retargeting and fresh-event relabeling of old transitions',
        async () => {
          const post = await publish(),
            group = (await groups(post.id))[0]!,
            unit = (await units(group.id))[0]!;
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.reward_source_units SET beneficiary_id=$2 WHERE id=$1',
              [unit.id, actor.accountId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.reward_source_groups WHERE id=$1',
              [group.id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.outbox SET context='{}'::jsonb WHERE id=(SELECT event_id FROM whaleu_community.reward_source_groups WHERE id=$1)",
              [group.id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            rawTransaction(async (tx) => {
              const id = randomUUID();
              await tx.query(
                "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context) VALUES($1,$2,'post_created',$3,$4::jsonb)",
                [
                  id,
                  `forged:${id}`,
                  oldPost,
                  JSON.stringify({
                    experienceSourceVersion: 1,
                    actorAccountId: oldOwner,
                    actorAuthorMode: 'anonymous',
                    resourceAuthorMode: 'anonymous',
                  }),
                ],
              );
            }),
            sqlCode('23514'),
          );
          await assert.rejects(
            database.transaction(async (tx) => {
              const id = randomUUID();
              await tx.query(
                "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context) VALUES($1,$2,'post_created',$3,$4::jsonb)",
                [
                  id,
                  `post:${oldPost}:created`,
                  oldPost,
                  JSON.stringify({
                    experienceSourceVersion: 1,
                    actorAccountId: oldOwner,
                    actorAuthorMode: 'anonymous',
                    resourceAuthorMode: 'anonymous',
                  }),
                ],
              );
              await capture.enroll(id, tx);
            }),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            rawTransaction(async (tx) => {
              // Even a genuine fresh like cannot commit only its actor while
              // omitting the nonself recipient from the same enrolled source.
              const postId = randomUUID(),
                eventId = randomUUID(),
                groupId = randomUUID(),
                unitId = randomUUID();
              await tx.query(
                "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic incomplete source','named','open')",
                [postId, spaceId, author.accountId],
              );
              const membership = (
                await tx.query<{ like_id: string; liked_at: Date }>(
                  'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2) RETURNING like_id,liked_at',
                  [postId, actor.accountId],
                )
              ).rows[0]!;
              await tx.query(
                "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context) VALUES($1,$2,'post_liked',$3,$4::jsonb)",
                [
                  eventId,
                  `post:like:${membership.like_id}`,
                  postId,
                  JSON.stringify({
                    experienceSourceVersion: 1,
                    actorAccountId: actor.accountId,
                    actorAuthorMode: null,
                    resourceAuthorMode: 'named',
                    likeId: membership.like_id,
                    recipientAccountId: author.accountId,
                  }),
                ],
              );
              const { enrollmentOrder } = await ingress.reserve(tx, [
                actor.accountId,
                author.accountId,
              ]);
              await tx.query(
                "INSERT INTO whaleu_community.reward_source_groups(id,event_id,event_type,resource_kind,post_id,like_id,actor_account_id,actor_author_mode,resource_author_id,resource_author_mode,post_author_id,occurred_at,enrollment_order,expected_unit_count) VALUES($1,$2,'post_liked','post',$3,$4,$5,NULL,$6,'named',$6,$7,$8,2)",
                [
                  groupId,
                  eventId,
                  postId,
                  membership.like_id,
                  actor.accountId,
                  author.accountId,
                  membership.liked_at,
                  enrollmentOrder,
                ],
              );
              await tx.query(
                "INSERT INTO whaleu_community.reward_source_units(id,group_id,beneficiary_id,action,enrollment_order,outbox_event_id) VALUES($1,$2,$3,'like_save',$4,$5)",
                [unitId, groupId, actor.accountId, enrollmentOrder, eventId],
              );
              await ingress.enqueue(tx, [
                {
                  unitId,
                  groupId,
                  beneficiaryId: actor.accountId,
                  action: 'like_save',
                  enrollmentOrder,
                },
              ]);
            }),
            sqlCode('23514'),
          );
          const root = await comment(post.id),
            replyId = await reply(post.id, root, other);
          for (const [table, id] of [
            ['posts', post.id],
            ['root_comments', root],
            ['replies', replyId],
          ]) {
            await assert.rejects(
              pool.query(
                `UPDATE whaleu_community.${table} SET local_deletion_transaction=pg_current_xact_id() WHERE id=$1`,
                [id],
              ),
              sqlCode('23514'),
            );
            assert.equal(
              (
                await pool.query(
                  `SELECT deleted_at,local_deletion_transaction FROM whaleu_community.${table} WHERE id=$1`,
                  [id],
                )
              ).rows[0].local_deletion_transaction,
              null,
            );
          }
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET local_creation_transaction=pg_current_xact_id() WHERE id=$1',
              [oldPost],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.saved_obligations SET local_creation_transaction=pg_current_xact_id() WHERE id=$1',
              [oldObligation],
            ),
            sqlCode('23514'),
          );
        },
      );
    } finally {
      try {
        await app?.close();
        if (owns)
          for (const schema of schemas)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
  },
);
