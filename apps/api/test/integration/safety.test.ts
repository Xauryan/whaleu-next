import { PublicationService } from '../../src/community/publication.service.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
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
import { IdentityService } from '../../src/identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_BASE_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { FormationRepository } from '../../src/community/formation/repository.js';
import { FormationService } from '../../src/community/formation/service.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import { UpdatesReadService } from '../../src/notifications/read.service.js';
import { SavedMutationService } from '../../src/community/saved/mutation.service.js';
import { SavedReadService } from '../../src/community/saved/read.service.js';
import { ReplyPublicationService } from '../../src/community/discussion/publication.service.js';
import { FeedService } from '../../src/community/feed.service.js';
import { DiscussionReadService } from '../../src/community/discussion/read.service.js';
import { NamedBlockService } from '../../src/safety/service.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { blockRequestSchema } from '../../src/safety/contracts.js';
import type { BlockResult, BlockRequest } from '../../src/safety/contracts.js';
import { hashToken } from '../../src/identity/tokens.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  fixtureSchema,
  grant,
  verified,
  approveReply,
  approve,
} from '../support/community-fixtures.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function applied(result: BlockResult) {
  assert.equal(result.receipt.outcome, 'applied', JSON.stringify(result));
  if (result.receipt.outcome !== 'applied') throw new Error();
  return result.receipt;
}
function rejected(result: BlockResult, code: string) {
  assert.equal(result.receipt.outcome, 'rejected');
  if (result.receipt.outcome === 'rejected')
    assert.equal(result.receipt.code, code);
  assert.equal(result.current, null);
}
test(
  'real PostgreSQL directional named blocks, policy composition, receipts and final clocks',
  { timeout: 120000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(urlString, 'Use dedicated disposable loopback whaleu_test');
    const url = new URL(urlString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urlString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      ordinary: INestApplication | undefined,
      locked = false,
      owns = false;
    const schemas = ['whaleu_community_test', ...migrationSchemaNames];
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked, 'Run integration serially');
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
          appId: 'synthetic-safety-only',
          subject: code,
        }),
      };
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue(provider)
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(new FixtureAuthorization())
        .overrideProvider(COMMUNITY_BASE_VISIBILITY)
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
        blocks = app.get(NamedBlockService),
        feeds = app.get(FeedService),
        discussion = app.get(DiscussionReadService),
        access = app.get(CommunityAccessService),
        database = app.get(DatabaseService);
      const region = randomUUID(),
        space = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active)VALUES($1,'Synthetic',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active)VALUES($1,'regional',$2,'Synthetic',true)",
        [space, region],
      );
      async function actor() {
        const actor = await identity.login(randomUUID());
        await setSyntheticSnapshot(pool, actor.accountId, [
          syntheticAssertion(actor.accountId, randomUUID(), 'phone'),
        ]);
        await grant(pool, actor.accountId, space, verified(region));
        await pool.query(
          "INSERT INTO whaleu_profile.profiles(account_id,nickname)VALUES($1,'Synthetic')",
          [actor.accountId],
        );
        return actor;
      }
      async function post(
        accountId: string,
        mode: 'named' | 'anonymous' = 'named',
      ) {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy)VALUES($1,$2,$3,'discussion','Synthetic content',$4,'open')",
          [id, space, accountId, mode],
        );
        if (mode === 'anonymous')
          await pool.query(
            "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name)VALUES($1,$2,$3,'Synthetic anonymous')",
            [randomUUID(), id, accountId],
          );
        return id;
      }
      async function root(
        postId: string,
        accountId: string,
        mode: 'named' | 'anonymous' = 'named',
      ) {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)VALUES($1,$2,$3,'Synthetic root',$4)",
          [id, postId, accountId, mode],
        );
        if (mode === 'anonymous')
          await pool.query(
            "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name)VALUES($1,$2,$3,'Synthetic anonymous') ON CONFLICT DO NOTHING",
            [randomUUID(), postId, accountId],
          );
        return id;
      }
      const command = (
        id: string,
        kind: 'post' | 'comment' | 'reply' = 'post',
      ): BlockRequest => ({
        clientRequestId: randomUUID(),
        source: { kind, id },
        blocked: true,
      });
      await t.test(
        'new native coverage only; unknown history never means empty',
        async () => {
          const a = await actor();
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=$1 AND block_coverage='complete' AND restriction_coverage='complete'",
                [a.accountId],
              )
            ).rowCount,
            1,
          );
          const old = randomUUID();
          await pool.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [old],
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=$1',
                [old],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'phone-only eligibility, directional state, immutable replay and stale old block after unblock',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId);
          const body = command(p);
          const first = applied(await blocks.block(a.accessToken, body));
          assert.equal(first.revision, '1');
          assert.deepEqual(await blocks.block(a.accessToken, body), {
            receipt: first,
            current: {
              relationshipId: first.relationshipId,
              blocked: true,
              revision: '1',
            },
          });
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.blocks WHERE blocked_id=$1 AND blocker_id=$2',
                [a.accountId, b.accountId],
              )
            ).rowCount,
            0,
          );
          const gone = applied(
            await blocks.unblock(a.accessToken, first.relationshipId, {
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: '1',
            }),
          );
          assert.equal(gone.revision, '2');
          const replay = await blocks.block(a.accessToken, body);
          assert.deepEqual(replay.receipt, first);
          assert.equal(replay.current?.blocked, false);
          assert.equal(replay.current?.revision, '2');
          assert.equal(
            (await blocks.list(a.accessToken, { limit: 20 })).items.length,
            0,
          );
          await assert.rejects(
            blocks.block(a.accessToken, {
              ...body,
              source: { kind: 'post', id: randomUUID() },
            }),
            hasCode('REQUEST_CONFLICT'),
          );
          await assert.rejects(
            blocks.status(b.accessToken, first.relationshipId),
            hasCode('BLOCK_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'one-way feed but bilateral detail; anonymous rows and counts unaffected by hidden actor pair',
        async () => {
          const a = await actor(),
            b = await actor(),
            c = await actor(),
            pa = await post(a.accountId),
            pb = await post(b.accountId),
            anon = await post(b.accountId, 'anonymous'),
            parent = await post(c.accountId);
          await root(parent, b.accountId, 'anonymous');
          const before = (await feeds.detail(a.accessToken, parent))
            .discussionCount;
          await blocks.block(b.accessToken, command(pa));
          assert.ok(
            (
              await feeds.feed(a.accessToken, { spaceId: space, limit: 10 })
            ).items.some((p) => p.id === pb),
          );
          await assert.rejects(
            feeds.detail(a.accessToken, pb),
            hasCode('POST_NOT_FOUND'),
          );
          assert.equal((await feeds.detail(a.accessToken, anon)).id, anon);
          assert.equal(
            (await feeds.detail(a.accessToken, parent)).discussionCount,
            before,
          );
          rejected(
            await blocks.block(a.accessToken, command(anon)),
            'BLOCK_TARGET_NOT_ALLOWED',
          );
          rejected(
            await blocks.block(a.accessToken, command(pa)),
            'BLOCK_TARGET_NOT_ALLOWED',
          );
        },
      );
      await t.test(
        'reciprocal named child blocks persist independently and children retain outgoing list policy',
        async () => {
          const a = await actor(),
            b = await actor(),
            c = await actor(),
            p = await post(c.accountId),
            ra = await root(p, a.accountId),
            rb = await root(p, b.accountId);
          const one = applied(
            await blocks.block(a.accessToken, command(rb, 'comment')),
          );
          assert.equal((await discussion.comment(b.accessToken, ra)).id, ra);
          const two = applied(
            await blocks.block(b.accessToken, command(ra, 'comment')),
          );
          await blocks.unblock(a.accessToken, one.relationshipId, {
            clientRequestId: randomUUID(),
            blocked: false,
            expectedRevision: '1',
          });
          assert.equal(
            (await blocks.status(b.accessToken, two.relationshipId)).blocked,
            true,
          );
          assert.equal((await discussion.comment(a.accessToken, rb)).id, rb);
          await assert.rejects(
            discussion.comment(b.accessToken, ra),
            hasCode('COMMENT_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'own explanation only after live scope/base access; lost source still permits own cleanup',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId);
          const receipt = applied(
            await blocks.block(a.accessToken, command(p)),
          );
          await assert.rejects(
            feeds.detail(a.accessToken, p),
            hasCode('POST_BLOCKED_BY_YOU'),
          );
          await pool.query(
            'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
            [p],
          );
          await assert.rejects(
            feeds.detail(a.accessToken, p),
            hasCode('POST_NOT_FOUND'),
          );
          await pool.query(
            'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
            [b.accountId],
          );
          const own = await blocks.list(a.accessToken, { limit: 20 });
          assert.equal(own.items[0]?.display.kind, 'snapshot');
          applied(
            await blocks.unblock(a.accessToken, receipt.relationshipId, {
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: '1',
            }),
          );
        },
      );
      await t.test(
        'typed payloads reject actor overrides and bounded own cursor is account scoped',
        async () => {
          assert.equal(
            blockRequestSchema.safeParse({
              ...command(randomUUID()),
              targetAccountId: randomUUID(),
            }).success,
            false,
          );
          const a = await actor(),
            b = await actor(),
            c = await actor();
          applied(
            await blocks.block(a.accessToken, command(await post(b.accountId))),
          );
          applied(
            await blocks.block(a.accessToken, command(await post(c.accountId))),
          );
          const page = await blocks.list(a.accessToken, { limit: 1 });
          assert.equal(page.items.length, 1);
          assert.ok(page.nextCursor);
          const next = await blocks.list(a.accessToken, {
            limit: 1,
            cursor: page.nextCursor!,
          });
          assert.equal(next.items.length, 1);
          assert.notEqual(
            page.items[0]?.relationshipId,
            next.items[0]?.relationshipId,
          );
          await assert.rejects(
            blocks.list(b.accessToken, { limit: 1, cursor: page.nextCursor! }),
          );
          const serialized = JSON.stringify(page);
          assert.ok(
            !serialized.includes(a.accountId) &&
              !serialized.includes(b.accountId),
          );
          await request(app!.getHttpServer())
            .get('/v1/me/safety/blocks?limit=51')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .expect(400);
        },
      );
      await t.test(
        'missing phone/restriction coverage unavailable, known restriction terminal, no student gate',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId);
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET restriction_coverage='missing' WHERE account_id=$1",
            [a.accountId],
          );
          await assert.rejects(
            blocks.block(a.accessToken, command(p)),
            hasCode('SAFETY_UNAVAILABLE'),
          );
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET restriction_coverage='complete',actions_allowed=false WHERE account_id=$1",
            [a.accountId],
          );
          rejected(
            await blocks.block(a.accessToken, command(p)),
            'SAFETY_ACTION_RESTRICTED',
          );
          await pool.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
            [a.accountId],
          );
          await setSyntheticSnapshot(pool, a.accountId, []);
          await assert.rejects(
            blocks.block(a.accessToken, command(p)),
            hasCode('VERIFICATION_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'coverage expiry fails named reads while anonymous subject skips lookup',
        async () => {
          const a = await actor(),
            b = await actor(),
            named = await post(b.accountId),
            anon = await post(b.accountId, 'anonymous');
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()-interval '1 second' WHERE account_id=$1",
            [b.accountId],
          );
          await assert.rejects(
            feeds.detail(a.accessToken, named),
            hasCode('COMMUNITY_UNAVAILABLE'),
          );
          assert.equal((await feeds.detail(a.accessToken, anon)).id, anon);
        },
      );
      await t.test(
        'concurrent duplicate absent pair, conflicting key and stale revision cannot undo latest intent',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p);
          const results = await Promise.all([
            blocks.block(a.accessToken, body),
            blocks.block(a.accessToken, body),
          ]);
          assert.deepEqual(results[0], results[1]);
          const first = applied(results[0]!);
          const [off, stale] = await Promise.all([
            blocks.unblock(a.accessToken, first.relationshipId, {
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: '1',
            }),
            blocks.unblock(a.accessToken, first.relationshipId, {
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: '1',
            }),
          ]);
          const winner = [off, stale].find(
            (result) => result.receipt.outcome === 'applied',
          );
          const loser = [off, stale].find(
            (result) => result.receipt.outcome === 'rejected',
          );
          assert.ok(winner);
          assert.ok(loser);
          applied(winner);
          rejected(loser, 'BLOCK_REVISION_CONFLICT');
          assert.equal(
            (await blocks.status(a.accessToken, first.relationshipId)).revision,
            '2',
          );
        },
      );
      await t.test(
        'winning block serializes an anonymous-mode reply against each named target',
        async () => {
          const a = await actor(),
            b = await actor(),
            c = await actor(),
            p = await post(c.accountId),
            ra = await root(p, a.accountId),
            rb = await root(p, b.accountId);
          await blocks.block(b.accessToken, command(ra, 'comment'));
          const body = {
            clientRequestId: randomUUID(),
            text: 'Synthetic reply',
            imageAssetIds: [],
            authorMode: 'anonymous' as const,
            targetReplyId: null,
          };
          await approveReply(pool, a.accountId, p, rb, body);
          const receipt = await app!
            .get(ReplyPublicationService)
            .create(a.accessToken, rb, body);
          assert.equal(receipt.outcome, 'rejected');
          if (receipt.outcome === 'rejected')
            assert.equal(receipt.code, 'POST_NOT_FOUND');
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.replies WHERE account_id=$1',
                [a.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'session expires behind policy gate before mutation; no receipt or relationship commits',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p);
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '180 milliseconds' WHERE token_hash=$1",
            [hashToken(a.accessToken)],
          );
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await lockSafetyPolicy(blocker, true);
          const result = blocks.block(a.accessToken, body);
          await sleep(250);
          await blocker.query('COMMIT');
          blocker.release();
          await assert.rejects(result, hasCode('ACCESS_TOKEN_EXPIRED'));
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.requests WHERE account_id=$1',
                [a.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'phone expiry during deferred audit wait rolls back state and receipt',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p);
          await setSyntheticSnapshot(pool, a.accountId, [
            syntheticAssertion(a.accountId, randomUUID(), 'phone', {
              expires_at: new Date(Date.now() + 250),
            }),
          ]);
          await pool.query(
            `CREATE FUNCTION whaleu_safety.synthetic_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='blocked' THEN PERFORM pg_sleep(0.35); END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER synthetic_delay AFTER INSERT ON whaleu_safety.events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_safety.synthetic_delay()`,
          );
          try {
            await assert.rejects(
              blocks.block(a.accessToken, body),
              hasCode('PHONE_VERIFICATION_REQUIRED'),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_safety.requests WHERE account_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_delay ON whaleu_safety.events; DROP FUNCTION whaleu_safety.synthetic_delay()',
            );
          }
        },
      );
      await t.test(
        'session expiry after ordinary read query is checked by final transaction registry',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId);
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '180 milliseconds' WHERE token_hash=$1",
            [hashToken(a.accessToken)],
          );
          await assert.rejects(
            database.transaction(async (tx) => {
              const actor = await access.actor(a.accessToken, tx);
              await access.accessiblePost(p, actor, tx);
              await tx.query('SELECT pg_sleep(0.25)');
              return 'never delivered';
            }),
            hasCode('ACCESS_TOKEN_EXPIRED'),
          );
        },
      );
      await t.test(
        'rate policy bounded, replays consume no fresh mutation, safe retry-after',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p),
            first = applied(await blocks.block(a.accessToken, body));
          await pool.query(
            "UPDATE whaleu_safety.rate_buckets SET hits=30,window_start=date_trunc('minute',clock_timestamp()) WHERE account_id=$1 AND action='block_named'",
            [a.accountId],
          );
          assert.equal(
            applied(await blocks.block(a.accessToken, body)).relationshipId,
            first.relationshipId,
          );
          await request(app!.getHttpServer())
            .put('/v1/me/safety/blocks')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send(command(p))
            .expect(429)
            .expect('retry-after', '60');
        },
      );
      await t.test(
        'real block facts never convert unavailable aggregate runtime into allow',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId);
          const m = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          ordinary = m.createNestApplication({ logger: false });
          configureHttp(ordinary);
          await ordinary.init();
          await assert.rejects(
            ordinary.get(NamedBlockService).block(a.accessToken, command(p)),
            hasCode('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            ordinary.get(FeedService).detail(a.accessToken, p),
            hasCode('COMMUNITY_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'reverse-only formation discovery retains card without roster or contacts, and Saved stays direct-gated',
        async () => {
          const a = await actor(),
            b = await actor(),
            pa = await post(a.accountId),
            pb = randomUUID();
          await database.transaction(async (tx) => {
            await lockSafetyPolicy(tx);
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy)VALUES($1,$2,$3,'discussion','Synthetic formation','named','open')",
              [pb, space, b.accountId],
            );
            await app!.get(FormationRepository).create(
              pb,
              b.accountId,
              {
                kind: 'formation',
                capacity: 4,
                theme: 'Synthetic',
                contacts: { wechat: 'synthetic', qq: '', phone: '' },
                contactSharing: 'members_v1',
              },
              tx,
            );
          });
          await app!
            .get(SavedMutationService)
            .set(a.accessToken, randomUUID(), {
              operation: 'set_post_saved',
              postId: pb,
              desired: true,
              channel: null,
            });
          assert.equal(
            (await feeds.detail(a.accessToken, pb)).component.kind,
            'formation',
          );
          applied(await blocks.block(b.accessToken, command(pa)));
          const card = (
            await feeds.feed(a.accessToken, { spaceId: space, limit: 10 })
          ).items.find((item) => item.id === pb);
          assert.ok(card);
          assert.deepEqual(card.component, { kind: 'none' });
          await assert.rejects(
            app!.get(FormationService).get(a.accessToken, pb),
            hasCode('POST_NOT_FOUND'),
          );
          await assert.rejects(
            app!.get(FormationService).contacts(a.accessToken, pb),
            hasCode('POST_NOT_FOUND'),
          );
          assert.equal(
            (
              await app!
                .get(SavedReadService)
                .list(a.accessToken, { limit: 20 })
            ).items.length,
            0,
          );
        },
      );
      await t.test(
        'three-connection queued exclusive policy gate cannot deadlock Updates owner read versus worker update',
        async () => {
          const a = await actor(),
            b = await actor(),
            parent = await post(a.accountId);
          await approve(
            pool,
            b.accountId,
            'Synthetic queue comment',
            'publish_comment',
          );
          const published = await app!
            .get(PublicationService)
            .comment(b.accessToken, parent, {
              clientRequestId: randomUUID(),
              text: 'Synthetic queue comment',
              imageAssetIds: [],
              authorMode: 'named',
            });
          assert.equal(published.outcome, 'created');
          if (published.outcome !== 'created') throw new Error();
          const event = (
            await pool.query<{ id: string }>(
              'SELECT id FROM whaleu_community.outbox WHERE resource_id=$1',
              [published.resourceId],
            )
          ).rows[0]!;
          await app!
            .get(UpdatesWorker)
            .run({ mode: 'apply', eventIds: [event.id] });
          const worker = await pool.connect(),
            writer = await pool.connect();
          let waiting: Promise<void> | undefined,
            reading: ReturnType<UpdatesReadService['list']> | undefined;
          try {
            await worker.query('BEGIN');
            await worker.query("SET LOCAL statement_timeout='1500ms'");
            await lockSafetyPolicy(worker);
            await writer.query('BEGIN');
            await writer.query("SET LOCAL statement_timeout='3000ms'");
            const writerPid = (
              await writer.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            waiting = lockSafetyPolicy(writer, true);
            waiting.catch(() => undefined);
            const until = Date.now() + 1500;
            while (
              !(
                await pool.query(
                  "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                  [writerPid],
                )
              ).rowCount
            ) {
              assert.ok(Date.now() < until);
              await sleep(5);
            }
            reading = app!
              .get(UpdatesReadService)
              .list(a.accessToken, { limit: 20 });
            reading.catch(() => undefined);
            while (
              (
                await pool.query(
                  "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted",
                )
              ).rowCount! < 2
            ) {
              assert.ok(Date.now() < until);
              await sleep(5);
            }
            // Reader waits at gate without holding notifications.owner. This UPDATE
            // would timeout in the original reader-owner -> gate order.
            await app!
              .get(NotificationsRepository)
              .owner(a.accountId, worker, true);
            await worker.query('COMMIT');
            await waiting;
            await writer.query('COMMIT');
            const page = await reading;
            assert.equal(page.items.length, 1);
            assert.equal(page.items[0]?.status, 'available');
            assert.equal(page.unreadCount, 1);
          } finally {
            await worker.query('ROLLBACK');
            await writer.query('ROLLBACK');
            await waiting?.catch(() => undefined);
            await reading?.catch(() => undefined);
            worker.release();
            writer.release();
          }
        },
      );
      await t.test(
        'SQL guards reject incomplete and malformed receipts, forged audit ownership and source/revision mutation',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p),
            first = applied(await blocks.block(a.accessToken, body));
          for (const receipt of [
            {},
            null,
            [],
            true,
            {
              requestId: randomUUID(),
              operation: 'block_named',
              outcome: 'applied',
            },
            { ...first, blocked: false },
            { ...first, revision: '0' },
            { ...first, extra: 'private' },
            {
              requestId: randomUUID(),
              operation: 'block_named',
              outcome: 'rejected',
              code: 'AUTHORIZATION_UNAVAILABLE',
            },
          ]) {
            const id = randomUUID(),
              value =
                receipt &&
                typeof receipt === 'object' &&
                !Array.isArray(receipt)
                  ? { ...receipt, requestId: id }
                  : receipt;
            await assert.rejects(
              pool.query(
                "INSERT INTO whaleu_safety.requests(account_id,client_request_id,operation,payload_hash,receipt)VALUES($1,$2,'block_named',$3,$4::jsonb)",
                [a.accountId, id, 'a'.repeat(64), JSON.stringify(value)],
              ),
            );
          }
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_safety.requests(account_id,client_request_id,operation,payload_hash)VALUES($1,$2,'block_named',$3)",
              [a.accountId, randomUUID(), 'a'.repeat(64)],
            ),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_safety.requests SET created_at=clock_timestamp() WHERE account_id=$1',
              [a.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision)VALUES($1,$2,$3,'blocked',NULL)",
              [randomUUID(), a.accountId, first.relationshipId],
            ),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision)VALUES($1,$2,$3,'blocked',2)",
              [randomUUID(), b.accountId, first.relationshipId],
            ),
          );
          for (const sql of [
            'source_id=$2',
            'blocker_id=$2',
            'created_at=clock_timestamp()',
            'revision=revision+1',
            'active=false',
          ])
            await assert.rejects(
              pool.query(
                `UPDATE whaleu_safety.blocks SET ${sql} WHERE id=$1`,
                sql.includes('$2')
                  ? [first.relationshipId, randomUUID()]
                  : [first.relationshipId],
              ),
            );
          applied(
            await blocks.unblock(a.accessToken, first.relationshipId, {
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: '1',
            }),
          );
          const secondPost = await post(b.accountId);
          applied(await blocks.block(a.accessToken, command(secondPost)));
          const stored = (
            await pool.query<{ source_id: string; revision: string }>(
              'SELECT source_id,revision FROM whaleu_safety.blocks WHERE id=$1',
              [first.relationshipId],
            )
          ).rows[0]!;
          assert.equal(stored.source_id, p);
          assert.equal(stored.revision, '3');
        },
      );
      await t.test(
        'simultaneous reciprocal blocks and conflicting account request keys serialize independently',
        async () => {
          const a = await actor(),
            b = await actor(),
            c = await actor(),
            p = await post(c.accountId),
            ra = await root(p, a.accountId),
            rb = await root(p, b.accountId);
          const results = await Promise.all([
            blocks.block(a.accessToken, command(rb, 'comment')),
            blocks.block(b.accessToken, command(ra, 'comment')),
          ]);
          assert.equal(applied(results[0]!).blocked, true);
          assert.equal(applied(results[1]!).blocked, true);
          const d = await actor(),
            key = randomUUID(),
            one = await post(a.accountId),
            two = await post(b.accountId);
          const conflict = await Promise.allSettled([
            blocks.block(d.accessToken, {
              ...command(one),
              clientRequestId: key,
            }),
            blocks.block(d.accessToken, {
              ...command(two),
              clientRequestId: key,
            }),
          ]);
          assert.equal(
            conflict.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          const loser = conflict.find((result) => result.status === 'rejected');
          assert.ok(loser && loser.status === 'rejected');
          assert.ok(hasCode('REQUEST_CONFLICT')(loser.reason));
        },
      );
      await t.test(
        'an actually queued winning block denies later named-target interaction before reply commit',
        async () => {
          const a = await actor(),
            b = await actor(),
            c = await actor(),
            p = await post(c.accountId),
            ra = await root(p, a.accountId),
            rb = await root(p, b.accountId);
          const body = {
            clientRequestId: randomUUID(),
            text: 'Synthetic raced reply',
            imageAssetIds: [],
            authorMode: 'anonymous' as const,
            targetReplyId: null,
          };
          await approveReply(pool, a.accountId, p, rb, body);
          const barrier = await pool.connect();
          let mutation: ReturnType<NamedBlockService['block']> | undefined,
            publishing:
              ReturnType<ReplyPublicationService['create']> | undefined;
          try {
            await barrier.query('BEGIN');
            await barrier.query("SET LOCAL statement_timeout='3000ms'");
            await lockSafetyPolicy(barrier, true);
            mutation = blocks.block(b.accessToken, command(ra, 'comment'));
            mutation.catch(() => undefined);
            const until = Date.now() + 2000;
            while (
              !(
                await pool.query(
                  "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted",
                )
              ).rowCount
            ) {
              assert.ok(Date.now() < until);
              await sleep(5);
            }
            publishing = app!
              .get(ReplyPublicationService)
              .create(a.accessToken, rb, body);
            publishing.catch(() => undefined);
            while (
              !(
                await pool.query(
                  "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ShareLock' AND NOT granted",
                )
              ).rowCount
            ) {
              assert.ok(Date.now() < until);
              await sleep(5);
            }
            await barrier.query('COMMIT');
            applied(await mutation);
            const receipt = await publishing;
            assert.equal(receipt.outcome, 'rejected');
            if (receipt.outcome === 'rejected')
              assert.equal(receipt.code, 'POST_NOT_FOUND');
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.replies WHERE account_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await barrier.query('ROLLBACK');
            barrier.release();
            await mutation?.catch(() => undefined);
            await publishing?.catch(() => undefined);
          }
        },
      );
      await t.test(
        'audit and receipt persistence immutable; failed audit never returns success',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b.accountId),
            body = command(p);
          await pool.query(
            `CREATE FUNCTION whaleu_safety.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='blocked' THEN RAISE EXCEPTION 'synthetic private failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER synthetic_fail BEFORE INSERT ON whaleu_safety.events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.synthetic_fail()`,
          );
          try {
            await assert.rejects(
              blocks.block(a.accessToken, body),
              hasCode('SAFETY_UNAVAILABLE'),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_fail ON whaleu_safety.events;DROP FUNCTION whaleu_safety.synthetic_fail()',
            );
          }
          const first = applied(await blocks.block(a.accessToken, body));
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_safety.requests SET receipt=NULL WHERE account_id=$1',
              [a.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_safety.events WHERE relationship_id=$1',
              [first.relationshipId],
            ),
          );
          await identity.logout(a.accessToken);
          await assert.rejects(
            blocks.receipt(a.accessToken, body.clientRequestId),
            hasCode('SESSION_REVOKED'),
          );
        },
      );
    } finally {
      try {
        await ordinary?.close();
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
