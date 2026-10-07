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
import type { Authority } from '../../src/community/community-policy.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { PublicationRepository } from '../../src/community/publication.repository.js';
import { FeedService } from '../../src/community/feed.service.js';
import { ReactionsService } from '../../src/community/reactions.service.js';
import { DeletionService } from '../../src/community/deletion.service.js';
import type {
  PublishPost,
  PublicationReceipt,
} from '../../src/community/contracts.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  digest,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';
const codeIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function created(
  receipt: PublicationReceipt,
): Extract<PublicationReceipt, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  return receipt;
}
function rejected(receipt: PublicationReceipt, code: string) {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: receipt.operation,
    outcome: 'rejected',
    code,
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test(
  'real PostgreSQL community policy, privacy, receipts and transaction races',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(connectionString, 'Set TEST_DATABASE_URL; no skips');
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
    let suite: PoolClient | undefined;
    let locked = false;
    let owns = false;
    let app: INestApplication | undefined;
    let ordinary: INestApplication | undefined;
    const authorization = new FixtureAuthorization();
    const visibility = new FixtureVisibility();
    const content = new FixtureContent();
    const region = randomUUID(),
      otherRegion = randomUUID(),
      spaceId = randomUUID(),
      otherSpace = randomUUID(),
      globalId = randomUUID(),
      campusA = randomUUID(),
      campusB = randomUUID(),
      campusC = randomUUID(),
      unmapped = randomUUID(),
      institution = randomUUID();
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
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity','whaleu_campus','whaleu_profile','whaleu_community','whaleu_authorization','whaleu_verification','whaleu_community_test')",
          )
        ).rows[0]!.count,
        0,
        'Refusing existing schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      await fixtureSchema(pool);
      const provider = {
        exchange: async (code: string) => ({
          provider: 'wechat',
          appId: 'synthetic-community',
          subject: code,
        }),
      };
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue(provider)
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
        reactions = app.get(ReactionsService),
        deletions = app.get(DeletionService);
      const http = app.getHttpServer();
      const first = await identity.login('first'),
        second = await identity.login('second'),
        third = await identity.login('third');
      const auth = `Bearer ${first.accessToken}`;
      await t.test(
        'new migration has no fictional spaces or grants',
        async () => {
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.spaces'))
              .rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.operating_regions'))
              .rowCount,
            0,
          );
        },
      );
      await pool.query(
        'INSERT INTO whaleu_campus.institutions(id,name) VALUES ($1,$2)',
        [institution, 'Synthetic University'],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) SELECT x,$1,'Synthetic Campus','Test',true FROM unnest($2::uuid[]) x",
        [institution, [campusA, campusB, campusC, unmapped]],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic Region',true),($2,'Other Region',true)",
        [region, otherRegion],
      );
      await pool.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES ($1,$4),($2,$4),($3,$5)',
        [campusA, campusB, campusC, region, otherRegion],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES ($1,'regional','Synthetic Regional',true,$4),($2,'regional','Other Regional',true,$5),($3,'global','Synthetic Global',true,NULL)",
        [spaceId, otherSpace, globalId, region, otherRegion],
      );
      for (const actor of [first.accountId, second.accountId, third.accountId])
        for (const space of [spaceId, otherSpace, globalId])
          await grant(pool, actor, space, verified(region));
      const body = (
        text: string,
        extra: Partial<PublishPost> = {},
      ): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        ...extra,
      });
      const publish = async (
        text: string,
        extra: Partial<PublishPost> = {},
        token = first.accessToken,
        actor = first.accountId,
      ) => {
        await approve(pool, actor, text);
        return created(await publications.post(token, body(text, extra)));
      };

      await t.test(
        'mapping is explicit many-to-one, same-institution regions remain separate, absent mapping stays absent',
        async () => {
          const a = await feeds.spaces(campusA),
            b = await feeds.spaces(campusB),
            c = await feeds.spaces(campusC);
          assert.equal(a.regional?.id, spaceId);
          assert.deepEqual(a, b);
          assert.equal(c.regional?.id, otherSpace);
          assert.equal((await feeds.spaces(unmapped)).regional, null);
          assert.equal(a.global[0]?.id, globalId);
          await request(http)
            .get(`/v1/operating-regions?campusId=${campusA}`)
            .expect(200)
            .expect(({ body }) => assert.equal(body.items[0].id, region));
          await request(http)
            .get(`/v1/operating-regions?campusId=${randomUUID()}`)
            .expect(404);
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          assert.equal((await feeds.spaces(campusA)).regional, null);
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );

      let main: ReturnType<typeof created>;
      let anonymous: ReturnType<typeof created>;
      await t.test(
        'concurrent equal intent commits exactly one resource, persona and outbox; hashes and account keys isolate',
        async () => {
          const intent = body('deduplicated');
          await approve(pool, first.accountId, intent.text);
          const results = await Promise.all(
            Array.from({ length: 5 }, () =>
              publications.post(first.accessToken, intent),
            ),
          );
          main = created(results[0]!);
          for (const result of results) assert.deepEqual(result, main);
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.posts WHERE id=$1',
                [main.resourceId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.outbox WHERE resource_id=$1',
                [main.resourceId],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            publications.post(first.accessToken, {
              ...intent,
              text: 'changed',
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          await assert.rejects(
            publications.comment(first.accessToken, main.resourceId, {
              clientRequestId: intent.clientRequestId,
              text: intent.text,
              imageAssetIds: [],
              authorMode: 'named',
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          await approve(pool, second.accountId, intent.text);
          const separate = created(
            await publications.post(second.accessToken, intent),
          );
          assert.notEqual(separate.resourceId, main.resourceId);
          assert.deepEqual(
            await receipts.receipt(first.accessToken, intent.clientRequestId),
            main,
          );
        },
      );

      await t.test(
        'anonymous projections never expose underlying identity; stable persona per thread and forced own comments',
        async () => {
          anonymous = await publish('anonymous post', {
            authorMode: 'anonymous',
          });
          const detail = await feeds.detail(
            first.accessToken,
            anonymous.resourceId,
          );
          assert.equal(detail.author.kind, 'anonymous');
          assert.equal(detail.viewer.isSelf, true);
          await approve(
            pool,
            first.accountId,
            'own anonymous root',
            'publish_comment',
          );
          const comment = created(
            await publications.comment(
              first.accessToken,
              anonymous.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'own anonymous root',
                imageAssetIds: [],
                authorMode: 'named',
              },
            ),
          );
          const list = await feeds.comments(
            first.accessToken,
            anonymous.resourceId,
            { limit: 10 },
          );
          assert.equal(list.items[0]?.id, comment.resourceId);
          assert.deepEqual(list.items[0]?.author, detail.author);
          const serial = JSON.stringify({ detail, list });
          for (const secret of [
            first.accountId,
            first.sessionId,
            'accountId',
            'profileId',
            'selectedCampus',
            'institutionId',
          ])
            assert.equal(serial.includes(secret), false, secret);
          assert.ok(
            visibility.seen
              .filter((subject) => subject.authorMode === 'anonymous')
              .every((subject) => !('namedAccountId' in subject)),
          );
          const caps = await feeds.commentCapabilities(
            first.accessToken,
            anonymous.resourceId,
          );
          assert.deepEqual(caps.authorModes, ['anonymous']);
          assert.equal(caps.forcedAuthorMode, 'anonymous');
          const named = await feeds.detail(first.accessToken, main.resourceId);
          assert.equal(named.author.kind, 'named');
          if (named.author.kind === 'named')
            assert.notEqual(named.author.profileId, first.accountId);
        },
      );

      await t.test(
        'anonymous comments on named own posts do not reveal named-author linkage',
        async () => {
          await approve(
            pool,
            first.accountId,
            'anonymous on named parent',
            'publish_comment',
          );
          const receipt = created(
            await publications.comment(first.accessToken, main.resourceId, {
              clientRequestId: randomUUID(),
              text: 'anonymous on named parent',
              imageAssetIds: [],
              authorMode: 'anonymous',
            }),
          );
          const page = await feeds.comments(
            second.accessToken,
            main.resourceId,
            { limit: 10 },
          );
          const comment = page.items.find(
            (item) => item.id === receipt.resourceId,
          )!;
          assert.equal(comment.author.kind, 'anonymous');
          if (comment.author.kind === 'anonymous')
            assert.equal(comment.author.isPostAuthor, false);
          assert.equal(
            JSON.stringify(comment).includes(first.accountId),
            false,
          );
          assert.equal('profileId' in comment.author, false);
        },
      );

      await t.test(
        'named blocks do not identify anonymous authors; hidden parents gate detail, comments and likes',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
            [second.accountId, first.accountId],
          );
          await assert.rejects(
            feeds.detail(second.accessToken, main.resourceId),
            codeIs('POST_NOT_FOUND'),
          );
          assert.equal(
            (await feeds.detail(second.accessToken, anonymous.resourceId))
              .author.kind,
            'anonymous',
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [anonymous.resourceId],
          );
          await assert.rejects(
            feeds.detail(first.accessToken, anonymous.resourceId),
            codeIs('POST_NOT_FOUND'),
          );
          await assert.rejects(
            feeds.comments(first.accessToken, anonymous.resourceId, {
              limit: 10,
            }),
            codeIs('POST_NOT_FOUND'),
          );
          await assert.rejects(
            reactions.setLike(first.accessToken, anonymous.resourceId, true),
            codeIs('POST_NOT_FOUND'),
          );
          const own = await feeds.own(first.accessToken, { limit: 10 });
          assert.equal(
            own.items.find((item) => item.id === anonymous.resourceId)?.status,
            'hidden',
          );
          assert.equal(JSON.stringify(own).includes('anonymous post'), false);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [anonymous.resourceId],
          );
          await pool.query('DELETE FROM whaleu_community_test.blocks');
        },
      );

      await t.test(
        'terminal rejections persist; unavailable review rolls back ledger and content completely',
        async () => {
          const denied = body('no approval');
          rejected(
            await publications.post(first.accessToken, denied),
            'CONTENT_REJECTED',
          );
          await approve(pool, first.accountId, denied.text);
          rejected(
            await publications.post(first.accessToken, denied),
            'CONTENT_REJECTED',
          );
          const transient = body('review unavailable');
          content.unavailable = true;
          await assert.rejects(
            publications.post(first.accessToken, transient),
            codeIs('CONTENT_REVIEW_UNAVAILABLE'),
          );
          content.unavailable = false;
          await assert.rejects(
            receipts.receipt(first.accessToken, transient.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.posts WHERE text=$1',
                [transient.text],
              )
            ).rowCount,
            0,
          );
          await approve(pool, first.accountId, transient.text);
          created(await publications.post(first.accessToken, transient));
        },
      );

      await t.test(
        'phone, student, identity-region, cross-region and scoped comment rules re-evaluate current authority',
        async () => {
          const attempt = async (
            authority: Authority,
            extra: Partial<PublishPost> = {},
            expected: string,
          ) => {
            await grant(
              pool,
              third.accountId,
              extra.spaceId ?? spaceId,
              authority,
            );
            const intent = body('policy rejection', extra);
            rejected(
              await publications.post(third.accessToken, intent),
              expected,
            );
          };
          await attempt(
            { ...verified(region), phoneVerified: false },
            {},
            'PHONE_VERIFICATION_REQUIRED',
          );
          await attempt(
            { ...verified(region), studentVerified: false },
            {},
            'STUDENT_VERIFICATION_REQUIRED',
          );
          await attempt(
            { ...verified(region), identityRegionId: null },
            {},
            'IDENTITY_CAMPUS_REQUIRED',
          );
          await attempt(
            verified(region),
            { spaceId: otherSpace, authorMode: 'anonymous' },
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          await attempt(
            verified(region),
            { commentsPolicy: 'restricted' },
            'COMMUNITY_ACTION_RESTRICTED',
          );
          await grant(pool, third.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            unverifiedCategories: ['discussion'],
            unverifiedCommentsAllowed: true,
          });
          await approve(pool, third.accountId, 'unverified named');
          created(
            await publications.post(
              third.accessToken,
              body('unverified named'),
            ),
          );
          rejected(
            await publications.comment(
              third.accessToken,
              anonymous.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'unsafe anonymous-parent comment',
                imageAssetIds: [],
                authorMode: 'named',
              },
            ),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          await grant(pool, first.accountId, spaceId, {
            ...verified(region),
            canManage: true,
          });
          const restricted = await publish('restricted post', {
            commentsPolicy: 'restricted',
          });
          await grant(pool, first.accountId, spaceId, verified(region));
          rejected(
            await publications.comment(
              second.accessToken,
              restricted.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'disabled',
                imageAssetIds: [],
                authorMode: 'named',
              },
            ),
            'COMMENTS_DISABLED',
          );
          await approve(
            pool,
            first.accountId,
            'author exception',
            'publish_comment',
          );
          created(
            await publications.comment(
              first.accessToken,
              restricted.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'author exception',
                imageAssetIds: [],
                authorMode: 'named',
              },
            ),
          );
          await grant(pool, third.accountId, spaceId, verified(region));
        },
      );

      await t.test(
        'media requires owned complete assets and exact text/digest approval; references are not an upload flow',
        async () => {
          const asset = randomUUID();
          const original = digest('synthetic image');
          await pool.query(
            'INSERT INTO whaleu_community_test.assets VALUES ($1,$2,$3,$4,true)',
            [asset, first.accountId, 'publish_post', original],
          );
          await approve(pool, first.accountId, 'image post', 'publish_post', [
            { assetId: asset, digest: original },
          ]);
          const imagePost = created(
            await publications.post(
              first.accessToken,
              body('image post', { imageAssetIds: [asset] }),
            ),
          );
          assert.equal(
            (await feeds.detail(first.accessToken, imagePost.resourceId))
              .images[0]?.assetId,
            asset,
          );
          rejected(
            await publications.post(
              second.accessToken,
              body('foreign asset', { imageAssetIds: [asset] }),
            ),
            'MEDIA_NOT_READY',
          );
          await pool.query(
            'UPDATE whaleu_community_test.assets SET digest=$2 WHERE id=$1',
            [asset, digest('changed bytes')],
          );
          rejected(
            await publications.post(
              first.accessToken,
              body('image post', { imageAssetIds: [asset] }),
            ),
            'CONTENT_REJECTED',
          );
          await assert.rejects(
            feeds.detail(first.accessToken, imagePost.resourceId),
            codeIs('MEDIA_UNAVAILABLE'),
          );
          await pool.query(
            'UPDATE whaleu_community_test.assets SET digest=$2 WHERE id=$1',
            [asset, original],
          );
        },
      );

      await t.test(
        'preview/seek pagination cannot bypass session or phone checks and respects bound scopes',
        async () => {
          for (let index = 0; index < 12; index++)
            await publish(`feed item ${index}`);
          const guest = await feeds.feed(null, { spaceId, limit: 10 });
          assert.equal(guest.items.length, 10);
          assert.equal(guest.continuation, 'login_required');
          assert.equal(guest.nextCursor, null);
          const page = await feeds.feed(first.accessToken, {
            spaceId,
            limit: 3,
          });
          assert.ok(page.nextCursor);
          const next = await feeds.feed(first.accessToken, {
            spaceId,
            limit: 3,
            cursor: page.nextCursor,
          });
          assert.equal(
            next.items.some((item) =>
              page.items.some((other) => other.id === item.id),
            ),
            false,
          );
          await assert.rejects(
            feeds.feed(null, { spaceId, limit: 3, cursor: page.nextCursor }),
            codeIs('AUTHENTICATION_REQUIRED'),
          );
          await grant(pool, third.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          await assert.rejects(
            feeds.feed(third.accessToken, {
              spaceId,
              limit: 3,
              cursor: page.nextCursor,
            }),
            codeIs('PHONE_VERIFICATION_REQUIRED'),
          );
          await assert.rejects(
            feeds.feed(first.accessToken, {
              spaceId: globalId,
              limit: 3,
              cursor: page.nextCursor,
            }),
          );
          await assert.rejects(
            feeds.feed(first.accessToken, {
              spaceId,
              limit: 4,
              cursor: page.nextCursor,
            }),
          );
          await request(http)
            .get(`/v1/community/posts?spaceId=${spaceId}&limit=11`)
            .expect(400);
          await request(http)
            .get(`/v1/community/posts?spaceId=${spaceId}&spaceId=${spaceId}`)
            .expect(400);
          await request(http)
            .get(`/v1/community/posts?spaceId=${spaceId}`)
            .set('Authorization', 'Bearer invalid')
            .expect(401);
          await grant(pool, third.accountId, spaceId, verified(region));
        },
      );

      await t.test(
        'copied own-publication cursors never expose another account or encode its identity',
        async () => {
          const own = await feeds.own(first.accessToken, { limit: 1 });
          assert.ok(own.nextCursor);
          assert.equal(
            Buffer.from(own.nextCursor, 'base64url')
              .toString('utf8')
              .includes(first.accountId),
            false,
          );
          const copied = await feeds.own(second.accessToken, {
            limit: 1,
            cursor: own.nextCursor,
          });
          for (const item of copied.items) {
            const row = await pool.query<{ account_id: string }>(
              'SELECT account_id FROM whaleu_community.posts WHERE id=$1',
              [item.id],
            );
            assert.equal(row.rows[0]!.account_id, second.accountId);
          }
        },
      );

      await t.test(
        'like desired-state retries produce only transitions; like/unlike serializes against deletion',
        async () => {
          const post = await publish('like races');
          const liked = await Promise.all(
            Array.from({ length: 4 }, () =>
              reactions.setLike(second.accessToken, post.resourceId, true),
            ),
          );
          assert.ok(
            liked.every((result) => result.isLiked && result.likeCount === 1),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='post_liked'",
                [post.resourceId],
              )
            ).rowCount,
            1,
          );
          await Promise.all([
            reactions.setLike(second.accessToken, post.resourceId, true),
            reactions.setLike(second.accessToken, post.resourceId, false),
          ]);
          const count = (
            await pool.query(
              'SELECT * FROM whaleu_community.post_likes WHERE post_id=$1',
              [post.resourceId],
            )
          ).rowCount;
          assert.ok(count === 0 || count === 1);
          await deletions.post(first.accessToken, post.resourceId);
          await assert.rejects(
            reactions.setLike(second.accessToken, post.resourceId, true),
            codeIs('POST_NOT_FOUND'),
          );
        },
      );

      await t.test(
        'delete and replay preserve original receipts through changed privileges and response loss',
        async () => {
          const intent = body('lost response');
          await approve(pool, first.accountId, intent.text);
          const original = created(
            await publications.post(first.accessToken, intent),
          );
          await deletions.post(first.accessToken, original.resourceId);
          await deletions.post(first.accessToken, original.resourceId);
          await grant(pool, first.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
            studentVerified: false,
          });
          assert.deepEqual(
            await publications.post(first.accessToken, intent),
            original,
          );
          assert.deepEqual(
            await receipts.receipt(first.accessToken, intent.clientRequestId),
            original,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.posts WHERE text=$1',
                [intent.text],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='post_deleted'",
                [original.resourceId],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            feeds.detail(first.accessToken, original.resourceId),
            codeIs('POST_NOT_FOUND'),
          );
          await assert.rejects(
            receipts.receipt(second.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await grant(pool, first.accountId, spaceId, verified(region));
        },
      );

      await t.test(
        'real commit failure rolls back post/persona/outbox/ledger instead of exposing a false success',
        async () => {
          await pool.query(
            `CREATE FUNCTION whaleu_community_test.fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$; CREATE CONSTRAINT TRIGGER synthetic_commit_failure AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_commit()`,
          );
          const intent = body('commit failure', { authorMode: 'anonymous' });
          await approve(pool, first.accountId, intent.text);
          try {
            await assert.rejects(publications.post(first.accessToken, intent));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_commit_failure ON whaleu_community.posts',
            );
          }
          await assert.rejects(
            receipts.receipt(first.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.posts WHERE text=$1',
                [intent.text],
              )
            ).rowCount,
            0,
          );
          created(await publications.post(first.accessToken, intent));
        },
      );

      await t.test(
        'permission revocation wins before authoritative lock; held authority/scope/session locks block mid-write revocation',
        async () => {
          const reached = deferred(),
            resume = deferred();
          authorization.beforeResolve = async () => {
            authorization.beforeResolve = null;
            reached.resolve();
            await resume.promise;
          };
          const intent = body('permission race');
          await approve(pool, third.accountId, intent.text);
          const pending = publications.post(third.accessToken, intent);
          await reached.promise;
          await grant(pool, third.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          resume.resolve();
          rejected(await pending, 'PHONE_VERIFICATION_REQUIRED');
          await grant(pool, third.accountId, spaceId, verified(region));
          const held = deferred(),
            finish = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            held.resolve();
            await finish.promise;
          };
          const intent2 = body('locks race');
          await approve(pool, first.accountId, intent2.text);
          const writing = publications.post(first.accessToken, intent2);
          await held.promise;
          const contender = await pool.connect();
          try {
            for (const [sql, values] of [
              [
                'UPDATE whaleu_community_test.grants SET authority=$3 WHERE account_id=$1 AND space_id=$2',
                [
                  first.accountId,
                  spaceId,
                  JSON.stringify({ ...verified(region), phoneVerified: false }),
                ],
              ],
              [
                'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                [spaceId],
              ],
              [
                'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
                [region],
              ],
              [
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [first.sessionId],
              ],
              [
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [first.accountId],
              ],
            ] as const) {
              await contender.query('BEGIN');
              await contender.query("SET LOCAL lock_timeout='60ms'");
              await assert.rejects(
                contender.query(sql, [...values]),
                (error: unknown) =>
                  !!error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === '55P03',
              );
              await contender.query('ROLLBACK');
            }
          } finally {
            await contender.query('ROLLBACK');
            contender.release();
            finish.resolve();
          }
          created(await writing);
        },
      );

      await t.test(
        'delete winning the parent lock makes simultaneous comments and likes fail without children',
        async () => {
          const post = await publish('delete target');
          const holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [post.resourceId],
            );
            const comment = publications.comment(
              second.accessToken,
              post.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'too late',
                imageAssetIds: [],
                authorMode: 'named',
              },
            );
            const like = reactions.setLike(
              second.accessToken,
              post.resourceId,
              true,
            );
            const handledLike = assert.rejects(like, codeIs('POST_NOT_FOUND'));
            await holder.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [post.resourceId],
            );
            await holder.query('COMMIT');
            rejected(await comment, 'POST_NOT_FOUND');
            await handledLike;
            assert.equal(
              (
                await pool.query(
                  'SELECT id FROM whaleu_community.root_comments WHERE post_id=$1',
                  [post.resourceId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );

      await t.test(
        'read scan and visible-comment counting budgets fail safely instead of unbounded locking',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
            [first.accountId, second.accountId],
          );
          await pool.query(
            `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy)
          SELECT gen_random_uuid(),$1,$2,'discussion','budget fixture','named','open' FROM generate_series(1,1025)`,
            [otherSpace, second.accountId],
          );
          await assert.rejects(
            feeds.feed(first.accessToken, { spaceId: otherSpace, limit: 10 }),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await pool.query('DELETE FROM whaleu_community_test.blocks');
          const post = await publish('comment count budget');
          await pool.query(
            `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)
          SELECT gen_random_uuid(),$1,$2,'budget comment','named' FROM generate_series(1,1025)`,
            [post.resourceId, second.accountId],
          );
          await assert.rejects(
            feeds.detail(first.accessToken, post.resourceId),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [post.resourceId],
          );
        },
      );

      await t.test(
        'ordinary runtime unavailable defaults cannot be opened by selected campus or forged flags',
        async () => {
          const defaultModule = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          })
            .overrideProvider(IDENTITY_PROVIDER)
            .useValue(provider)
            .compile();
          ordinary = defaultModule.createNestApplication({ logger: false });
          configureHttp(ordinary);
          await ordinary.init();
          const server = ordinary.getHttpServer();
          await request(server)
            .put('/v1/me/campus')
            .set('Authorization', auth)
            .send({ expectedRevision: 0, campusId: campusA })
            .expect(200);
          const capabilities = await request(server)
            .get(
              `/v1/community/capabilities?spaceId=${spaceId}&category=discussion`,
            )
            .set('Authorization', auth)
            .expect(200);
          assert.equal(capabilities.body.publish.availability, 'unavailable');
          assert.deepEqual(capabilities.body.authorModes, []);
          const intent = body('ordinary denied');
          await request(server)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(intent)
            .expect(503);
          await request(server)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send({ ...intent, verified: true, admin: true })
            .expect(400);
          await request(server)
            .get(`/v1/community/posts/${main.resourceId}`)
            .set('Authorization', auth)
            .expect(503);
          await assert.rejects(
            receipts.receipt(first.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
        },
      );

      await t.test(
        'transactional auth waits for the session before locking tokens, matching refresh ordering',
        async () => {
          const holder = await pool.connect(),
            waiter = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE',
              [first.sessionId],
            );
            await waiter.query('BEGIN');
            const holderPid = (
              await holder.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            const waiterPid = (
              await waiter.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            const authenticating = identity.session(first.accessToken, waiter);
            const deadline = Date.now() + 2000;
            let waiting = false;
            while (!waiting && Date.now() < deadline) {
              waiting = (
                await pool.query<{ waiting: boolean }>(
                  'SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS waiting',
                  [holderPid, waiterPid],
                )
              ).rows[0]!.waiting;
              if (!waiting)
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(
              waiting,
              true,
              'Auth should be waiting on the held session',
            );
            await holder.query("SET LOCAL lock_timeout='100ms'");
            await holder.query(
              'UPDATE whaleu_identity.access_tokens SET expires_at=expires_at WHERE session_id=$1',
              [first.sessionId],
            );
            await holder.query('COMMIT');
            assert.equal((await authenticating).accountId, first.accountId);
          } finally {
            await holder.query('ROLLBACK');
            await waiter.query('ROLLBACK');
            holder.release();
            waiter.release();
          }
        },
      );

      await t.test(
        'revoked/blocked active-owner requirement applies even to stored receipt replays',
        async () => {
          const intent = body('revoke recovery');
          await approve(pool, third.accountId, intent.text);
          created(await publications.post(third.accessToken, intent));
          await identity.logout(third.accessToken);
          await assert.rejects(
            publications.post(third.accessToken, intent),
            codeIs('SESSION_REVOKED'),
          );
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [second.accountId],
          );
          await request(http)
            .get(`/v1/community/posts?spaceId=${spaceId}`)
            .set('Authorization', `Bearer ${second.accessToken}`)
            .expect(403);
        },
      );
    } finally {
      authorization.beforeResolve = null;
      authorization.afterResolve = null;
      try {
        await ordinary?.close();
        await app?.close();
        if (owns) {
          for (const schema of [
            'whaleu_community_test',
            'whaleu_verification',
            'whaleu_authorization',
            'whaleu_community',
            'whaleu_profile',
            'whaleu_campus',
            'whaleu_identity',
            'whaleu_meta',
          ])
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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
  },
);
