import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
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
import { IdentityService } from '../../src/identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { PublicationRepository } from '../../src/community/publication.repository.js';
import { FeedService } from '../../src/community/feed.service.js';
import { DeletionService } from '../../src/community/deletion.service.js';
import { ReplyPublicationService } from '../../src/community/discussion/publication.service.js';
import { DiscussionReadService } from '../../src/community/discussion/read.service.js';
import { DiscussionMutationService } from '../../src/community/discussion/mutation.service.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type {
  PublicationReceipt,
  AuthorMode,
  PublishPost,
} from '../../src/community/contracts.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approveReply,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';
const code = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;
function created(receipt: PublicationReceipt) {
  assert.ok(receipt.outcome === 'created', JSON.stringify(receipt));
  return receipt;
}
function rejected(
  receipt: { outcome: string; code?: string },
  expected: string,
) {
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(receipt.code, expected);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test(
  'real PostgreSQL discussion authority, integrity, privacy, receipts and concurrent transitions',
  { timeout: 120000 },
  async (t) => {
    const url = process.env['TEST_DATABASE_URL'];
    assert.ok(url, 'Set TEST_DATABASE_URL; no skips');
    const target = new URL(url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
    assert.equal(target.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let owns = false,
      locked = false;
    const authorization = new FixtureAuthorization(),
      visibility = new FixtureVisibility(),
      content = new FixtureContent();
    const schemas = [
      'whaleu_notifications',
      'whaleu_community_test',
      'whaleu_verification',
      'whaleu_authorization',
      'whaleu_community',
      'whaleu_profile',
      'whaleu_campus',
      'whaleu_identity',
      'whaleu_meta',
    ];
    const region = randomUUID(),
      space = randomUUID(),
      global = randomUUID();
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
      await runMigrations(pool, migrations.slice(0, 8), { mode: 'up' });
      const priorActor = randomUUID(),
        priorSpace = randomUUID(),
        priorPost = randomUUID(),
        olderRoot = randomUUID(),
        newerRoot = randomUUID(),
        priorRequest = randomUUID();
      await pool.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
        priorActor,
      ]);
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name) VALUES($1,'global','Prior synthetic')",
        [priorSpace],
      );
      await pool.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','prior','named','open')",
        [priorPost, priorSpace, priorActor],
      );
      await pool.query(
        "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,created_at) VALUES($1,$3,$4,'newer','named','2020-01-01'),($2,$3,$4,'older','anonymous','2010-01-01')",
        [newerRoot, olderRoot, priorPost, priorActor],
      );
      const priorReceipt = {
        requestId: priorRequest,
        operation: 'publish_comment',
        outcome: 'created',
        resourceId: newerRoot,
        createdAt: '2020-01-01T00:00:00.000Z',
      };
      await pool.query(
        "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,'publish_comment',$4::jsonb)",
        [
          priorActor,
          priorRequest,
          'a'.repeat(64),
          JSON.stringify(priorReceipt),
        ],
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'forward migration preserves old receipts and deterministically sequences existing C1 roots',
        async () => {
          assert.deepEqual(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.root_comments WHERE post_id=$1 ORDER BY interaction_sequence',
                [priorPost],
              )
            ).rows.map((row) => row.id),
            [olderRoot, newerRoot],
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT payload_hash,receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                [priorActor, priorRequest],
              )
            ).rows[0],
            { payload_hash: 'a'.repeat(64), receipt: priorReceipt },
          );
        },
      );
      await fixtureSchema(pool);
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-discussion',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(authorization)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(visibility)
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(content)
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService),
        publications = app.get(PublicationService),
        receipts = app.get(PublicationRepository),
        feeds = app.get(FeedService),
        deletions = app.get(DeletionService),
        replies = app.get(ReplyPublicationService),
        reads = app.get(DiscussionReadService),
        mutations = app.get(DiscussionMutationService);
      const author = await identity.login('author'),
        other = await identity.login('other'),
        third = await identity.login('third');
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,'regional',$2,'Synthetic',true),($3,'global',NULL,'Global',true)",
        [space, region, global],
      );
      for (const person of [author, other, third])
        for (const id of [space, global])
          await grant(pool, person.accountId, id, verified(region));
      const post = async (extra: Partial<PublishPost> = {}) => {
        const text = `post ${randomUUID()}`;
        await approve(pool, author.accountId, text);
        return created(
          await publications.post(author.accessToken, {
            clientRequestId: randomUUID(),
            spaceId: space,
            category: 'discussion',
            text,
            imageAssetIds: [],
            authorMode: 'named',
            commentsPolicy: 'open',
            ...extra,
          }),
        ).resourceId;
      };
      const root = async (
        postId: string,
        person = other,
        mode: AuthorMode = 'named',
      ) => {
        const text = `root ${randomUUID()}`;
        await approve(pool, person.accountId, text, 'publish_comment');
        return created(
          await publications.comment(person.accessToken, postId, {
            clientRequestId: randomUUID(),
            text,
            imageAssetIds: [],
            authorMode: mode,
          }),
        ).resourceId;
      };
      const intent = (extra: Partial<PublishReply> = {}): PublishReply => ({
        clientRequestId: randomUUID(),
        text: `reply ${randomUUID()}`,
        imageAssetIds: [],
        authorMode: 'named',
        targetReplyId: null,
        ...extra,
      });
      const reply = async (
        postId: string,
        rootId: string,
        person = third,
        extra: Partial<PublishReply> = {},
      ) => {
        const body = intent(extra);
        await approveReply(pool, person.accountId, postId, rootId, body);
        return created(await replies.create(person.accessToken, rootId, body))
          .resourceId;
      };
      await t.test(
        'new discussion tables start empty with no fake actors, pins, reactions or providers',
        async () => {
          for (const table of [
            'replies',
            'reply_likes',
            'comment_likes',
            'comment_pins',
            'discussion_requests',
          ])
            assert.equal(
              (await pool.query(`SELECT * FROM whaleu_community.${table}`))
                .rowCount,
              0,
            );
        },
      );
      await t.test(
        'region-wide unverified roots and replies are independent from post allowlist; capabilities agree',
        async () => {
          const p = await post({ category: 'pets' }),
            r = await root(p);
          const facts = {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
            unverifiedCategories: [],
            unverifiedCommentsAllowed: true,
          };
          await grant(pool, third.accountId, space, facts);
          const c = await root(p, third);
          await reply(p, c, third);
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .availability,
            'allowed',
          );
          assert.equal(
            (await feeds.capabilities(third.accessToken, space, 'pets')).publish
              .availability,
            'denied',
          );
          await grant(pool, third.accountId, space, {
            ...facts,
            unverifiedCommentsAllowed: false,
            unverifiedCategories: ['pets'],
          });
          rejected(
            await replies.create(third.accessToken, r, intent()),
            'STUDENT_VERIFICATION_REQUIRED',
          );
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p)).reason,
            'STUDENT_VERIFICATION_REQUIRED',
          );
          // Liking remains phone/action-only when commenting is unavailable.
          assert.equal(
            (
              await mutations.set(
                third.accessToken,
                randomUUID(),
                'set_comment_like',
                r,
                true,
              )
            ).outcome,
            'applied',
          );
          await grant(pool, third.accountId, space, verified(region));
        },
      );
      await t.test(
        'approval binds post/root/target/effective mode and rejects cross-root injection',
        async () => {
          const p = await post(),
            r = await root(p),
            r2 = await root(p),
            targetId = await reply(p, r),
            foreign = await reply(p, r2);
          const body = intent({ targetReplyId: targetId });
          await approveReply(pool, third.accountId, p, r, body);
          rejected(
            await replies.create(third.accessToken, r, {
              ...body,
              targetReplyId: null,
            }),
            'CONTENT_REJECTED',
          );
          rejected(
            await replies.create(
              third.accessToken,
              r,
              intent({ targetReplyId: foreign }),
            ),
            'REPLY_NOT_FOUND',
          );
          rejected(
            await replies.create(third.accessToken, r2, {
              ...body,
              clientRequestId: randomUUID(),
              targetReplyId: null,
            }),
            'CONTENT_REJECTED',
          );
          const changed = intent({ authorMode: 'anonymous' });
          await approveReply(pool, third.accountId, p, r, changed, 'named');
          rejected(
            await replies.create(third.accessToken, r, changed),
            'CONTENT_REJECTED',
          );
          const p2 = await post({ authorMode: 'anonymous' }),
            r3 = await root(p2);
          const forced = intent();
          await approveReply(
            pool,
            author.accountId,
            p2,
            r3,
            forced,
            'anonymous',
          );
          const id = created(
            await replies.create(author.accessToken, r3, forced),
          ).resourceId;
          const view = await reads.reply(other.accessToken, id);
          assert.equal(view.author.kind, 'anonymous');
          assert.ok(view.author.kind === 'anonymous');
          assert.equal(view.author.isPostAuthor, true);
          assert.ok(!JSON.stringify(view).includes(author.accountId));
        },
      );
      await t.test(
        'reply receipt deduplicates equal concurrent intent, rejects changed target and survives removal/permission loss',
        async () => {
          const p = await post(),
            r = await root(p),
            body = intent({ authorMode: 'anonymous' });
          await approveReply(pool, third.accountId, p, r, body);
          const [a, b] = await Promise.all([
            replies.create(third.accessToken, r, body),
            replies.create(third.accessToken, r, body),
          ]);
          assert.deepEqual(a, b);
          const id = created(a).resourceId;
          await assert.rejects(
            replies.create(third.accessToken, r, { ...body, text: 'changed' }),
            code('REQUEST_CONFLICT'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.replies WHERE id=$1',
                [id],
              )
            ).rowCount,
            1,
          );
          const events = (
            await pool.query<{
              context: { recipientAccountIds: string[]; obligations: string[] };
            }>(
              "SELECT context FROM whaleu_community.outbox WHERE event_type='reply_created' AND resource_id=$1",
              [id],
            )
          ).rows;
          assert.equal(events.length, 1);
          assert.deepEqual(events[0]!.context.recipientAccountIds, [
            other.accountId,
          ]);
          assert.ok(
            !events[0]!.context.obligations.includes(
              'eligible_saved_subscriber_notification',
            ),
          );
          await deletions.comment(other.accessToken, r);
          await grant(pool, third.accountId, space, {
            ...verified(region),
            phoneVerified: false,
          });
          assert.deepEqual(await replies.create(third.accessToken, r, body), a);
          assert.deepEqual(
            await receipts.receipt(third.accessToken, body.clientRequestId),
            a,
          );
          await assert.rejects(
            receipts.receipt(other.accessToken, body.clientRequestId),
            code('REQUEST_NOT_FOUND'),
          );
          await grant(pool, third.accountId, space, verified(region));
        },
      );
      await t.test(
        'transient review and failed commit leave no reply, persona, receipt or outbox; terminal rejection stays frozen',
        async () => {
          const p = await post(),
            r = await root(p),
            body = intent({ authorMode: 'anonymous' });
          await approveReply(pool, third.accountId, p, r, body);
          content.unavailable = true;
          await assert.rejects(
            replies.create(third.accessToken, r, body),
            code('CONTENT_REVIEW_UNAVAILABLE'),
          );
          content.unavailable = false;
          await assert.rejects(
            receipts.receipt(third.accessToken, body.clientRequestId),
            code('REQUEST_NOT_FOUND'),
          );
          await pool.query(
            "CREATE FUNCTION whaleu_community_test.fail_reply_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic commit failure'; END $$; CREATE CONSTRAINT TRIGGER synthetic_reply_commit AFTER INSERT ON whaleu_community.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_reply_commit()",
          );
          try {
            await assert.rejects(replies.create(third.accessToken, r, body));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_reply_commit ON whaleu_community.replies',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.replies WHERE text=$1',
                [body.text],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2',
                [p, third.accountId],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            receipts.receipt(third.accessToken, body.clientRequestId),
            code('REQUEST_NOT_FOUND'),
          );
          created(await replies.create(third.accessToken, r, body));
          const rejectedBody = intent();
          rejected(
            await replies.create(third.accessToken, r, rejectedBody),
            'CONTENT_REJECTED',
          );
          await approveReply(pool, third.accountId, p, r, rejectedBody);
          rejected(
            await replies.create(third.accessToken, r, rejectedBody),
            'CONTENT_REJECTED',
          );
        },
      );
      await t.test(
        'flat targets, status-only tombstones and visible counts survive target deletion without sibling cascade',
        async () => {
          const p = await post(),
            r = await root(p),
            targetId = await reply(p, r),
            sibling = await reply(p, r, author, {
              targetReplyId: targetId,
              authorMode: 'anonymous',
            });
          const before = await reads.reply(other.accessToken, sibling);
          assert.equal(before.author.kind, 'anonymous');
          assert.ok(before.author.kind === 'anonymous');
          assert.equal(before.author.isPostAuthor, false);
          await Promise.all([
            mutations.deleteReply(third.accessToken, targetId),
            mutations.deleteReply(third.accessToken, targetId),
          ]);
          assert.deepEqual(
            (await reads.reply(other.accessToken, sibling)).target,
            { status: 'unavailable' },
          );
          assert.equal(
            (await reads.comment(other.accessToken, r)).replyCount,
            1,
          );
          const detail = await feeds.detail(other.accessToken, p);
          assert.equal(detail.commentCount, 1);
          assert.equal(detail.replyCount, 1);
          assert.equal(detail.discussionCount, 2);
          rejected(
            await replies.create(
              author.accessToken,
              r,
              intent({ targetReplyId: targetId }),
            ),
            'REPLY_NOT_FOUND',
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='reply_deleted'",
                [targetId],
              )
            ).rowCount,
            1,
          );
          await deletions.comment(other.accessToken, r);
          await assert.rejects(
            reads.reply(author.accessToken, sibling),
            code('COMMENT_NOT_FOUND'),
          );
          assert.equal(
            (await feeds.detail(author.accessToken, p)).discussionCount,
            0,
          );
        },
      );
      await t.test(
        'pin is author-only, singleton under concurrent roots and old receipts never reverse a newer transition',
        async () => {
          const p = await post(),
            r = await root(p),
            r2 = await root(p);
          await grant(pool, other.accountId, space, {
            ...verified(region),
            canManage: true,
          });
          rejected(
            await mutations.set(
              other.accessToken,
              randomUUID(),
              'set_comment_pin',
              r,
              true,
            ),
            'COMMENT_NOT_FOUND',
          );
          const [a, b] = await Promise.all([
            mutations.set(
              author.accessToken,
              randomUUID(),
              'set_comment_pin',
              r,
              true,
            ),
            mutations.set(
              author.accessToken,
              randomUUID(),
              'set_comment_pin',
              r2,
              true,
            ),
          ]);
          assert.equal([a, b].filter((x) => x.outcome === 'applied').length, 1);
          assert.equal(
            [a, b].filter(
              (x) =>
                x.outcome === 'rejected' && x.code === 'COMMENT_PIN_CONFLICT',
            ).length,
            1,
          );
          const winner = a.outcome === 'applied' ? a : b;
          assert.ok(winner.outcome === 'applied');
          await mutations.set(
            author.accessToken,
            randomUUID(),
            'set_comment_pin',
            winner.resourceId,
            false,
          );
          assert.deepEqual(
            await mutations.set(
              author.accessToken,
              winner.requestId,
              'set_comment_pin',
              winner.resourceId,
              true,
            ),
            winner,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=$1',
                [p],
              )
            ).rowCount,
            0,
          );
          const key = randomUUID();
          const like = await mutations.set(
            third.accessToken,
            key,
            'set_comment_like',
            r,
            true,
          );
          await mutations.set(
            third.accessToken,
            randomUUID(),
            'set_comment_like',
            r,
            false,
          );
          assert.deepEqual(
            await mutations.set(
              third.accessToken,
              key,
              'set_comment_like',
              r,
              true,
            ),
            like,
          );
          assert.equal(
            (await reads.comment(third.accessToken, r)).likeCount,
            0,
          );
          await assert.rejects(
            mutations.set(third.accessToken, key, 'set_comment_like', r, false),
            code('REQUEST_CONFLICT'),
          );
          await mutations.set(
            author.accessToken,
            randomUUID(),
            'set_comment_pin',
            r,
            true,
          );
          await deletions.comment(other.accessToken, r);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=$1',
                [p],
              )
            ).rowCount,
            0,
          );
          await grant(pool, other.accountId, space, verified(region));
        },
      );
      await t.test(
        'parent lock serializes reply publication then root deletion without dropping either event',
        async () => {
          const p = await post(),
            r = await root(p),
            body = intent();
          await approveReply(pool, third.accountId, p, r, body);
          const reached = deferred(),
            resume = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            reached.resolve();
            await resume.promise;
          };
          const pending = replies.create(third.accessToken, r, body);
          await reached.promise;
          const deletion = deletions.comment(other.accessToken, r);
          resume.resolve();
          const receipt = created(await pending);
          await deletion;
          await assert.rejects(
            reads.reply(author.accessToken, receipt.resourceId),
            code('COMMENT_NOT_FOUND'),
          );
          assert.deepEqual(
            await receipts.receipt(third.accessToken, body.clientRequestId),
            receipt,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN ('reply_created','comment_deleted')",
                [[r, receipt.resourceId]],
              )
            ).rowCount,
            2,
          );
        },
      );
      await t.test(
        'database guards cross-root targets, future/cyclic targets, mutable reply relations and unfinished/rewritten receipts',
        async () => {
          const p = await post(),
            r = await root(p),
            r2 = await root(p),
            targetId = await reply(p, r),
            id = await reply(p, r, third, { targetReplyId: targetId });
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5,'invalid','named')",
              [randomUUID(), p, r2, targetId, third.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.replies SET target_reply_id=NULL WHERE id=$1',
              [id],
            ),
          );
          const a = randomUUID(),
            b = randomUUID();
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode) VALUES($1,$3,$4,$2,$5,'future','named'),($2,$3,$4,$1,$5,'cycle','named')",
              [a, b, p, r, third.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.discussion_requests(account_id,client_request_id,payload_hash,operation) VALUES($1,$2,$3,'set_comment_like')",
              [third.accountId, randomUUID(), 'a'.repeat(64)],
            ),
          );
          const key = randomUUID();
          await mutations.set(
            third.accessToken,
            key,
            'set_comment_like',
            r,
            true,
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.discussion_requests SET receipt='{}'::jsonb WHERE account_id=$1 AND client_request_id=$2",
              [third.accountId, key],
            ),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.discussion_requests WHERE account_id=$1 AND client_request_id=$2',
              [third.accountId, key],
            ),
          );
          const body = intent();
          await approveReply(pool, third.accountId, p, r, body);
          await replies.create(third.accessToken, r, body);
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.publication_requests SET receipt='{}'::jsonb WHERE account_id=$1 AND client_request_id=$2",
              [third.accountId, body.clientRequestId],
            ),
          );
        },
      );
      await t.test(
        'last-author-mode is account-only, spans roots/replies and excludes deleted participation',
        async () => {
          const p = await post();
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .lastAuthorMode,
            null,
          );
          const r = await root(p, third, 'anonymous');
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .lastAuthorMode,
            'anonymous',
          );
          const id = await reply(p, r, third);
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .lastAuthorMode,
            'named',
          );
          assert.equal(
            (await feeds.commentCapabilities(author.accessToken, p))
              .lastAuthorMode,
            null,
          );
          await mutations.deleteReply(third.accessToken, id);
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .lastAuthorMode,
            'anonymous',
          );
          await deletions.comment(third.accessToken, r);
          assert.equal(
            (await feeds.commentCapabilities(third.accessToken, p))
              .lastAuthorMode,
            null,
          );
        },
      );
      await t.test(
        'HTTP rejects unknown identity/target fields, limits and absent durable mutation keys',
        async () => {
          const p = await post(),
            r = await root(p);
          const http = app!.getHttpServer(),
            auth = `Bearer ${author.accessToken}`;
          for (const payload of [
            { ...intent(), accountId: third.accountId },
            { ...intent(), rootCommentId: r },
            { ...intent(), text: '🐳'.repeat(501) },
            { ...intent(), text: ' ' },
          ])
            await request(http)
              .post(`/v1/community/comments/${r}/replies`)
              .set('Authorization', auth)
              .send(payload)
              .expect(400);
          await request(http)
            .put(`/v1/community/comments/${r}/like`)
            .set('Authorization', auth)
            .send({})
            .expect(400);
          await request(http)
            .get(`/v1/community/comments/${r}/replies?limit=51`)
            .set('Authorization', auth)
            .expect(400);
          await request(http)
            .get(`/v1/community/posts/${p}/comments?sort=time&sort=likes`)
            .set('Authorization', auth)
            .expect(400);
        },
      );
    } finally {
      authorization.afterResolve = null;
      await app?.close();
      if (owns) {
        // Reuse the exact refusal/ownership set, including new module schemas.
        for (const schema of schemas)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        assert.equal(
          (
            await pool.query(
              'SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])',
              [schemas],
            )
          ).rowCount,
          0,
          'Owned fixture schemas must not leak to the next suite',
        );
      }
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
