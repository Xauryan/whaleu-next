import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
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
import { DeletionService } from '../../src/community/deletion.service.js';
import { FeedService } from '../../src/community/feed.service.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublicationReceipt,
} from '../../src/community/contracts.js';
import { TradingService } from '../../src/community/trading/service.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approveTrading,
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
  assert.ok(receipt.outcome === 'created', JSON.stringify(receipt));
  return receipt;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test(
  'real PostgreSQL trading exact values, disclosure, independent state and durable receipts',
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
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      ordinary: INestApplication | undefined;
    let locked = false,
      owns = false;
    const authorization = new FixtureAuthorization(),
      visibility = new FixtureVisibility(),
      content = new FixtureContent();
    const region = randomUUID(),
      spaceId = randomUUID(),
      globalId = randomUUID();
    const schemas = ['whaleu_community_test', ...migrationSchemaNames];
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
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      assert.equal(
        (await pool.query('SELECT * FROM whaleu_community.trading_listings'))
          .rowCount,
        0,
      );
      await fixtureSchema(pool);
      const provider = {
        exchange: async (code: string) => ({
          provider: 'wechat',
          appId: 'synthetic-polls',
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
        trading = app.get(TradingService),
        deletions = app.get(DeletionService),
        feeds = app.get(FeedService);
      const author = await identity.login('author'),
        voter = await identity.login('voter'),
        other = await identity.login('other');
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES ($1,'regional','Regional',true,$2),($3,'global','Global',true,NULL)",
        [spaceId, region, globalId],
      );
      for (const actor of [author, voter, other])
        for (const space of [spaceId, globalId])
          await grant(pool, actor.accountId, space, verified(region));
      const body = (extra: Partial<PublishPost> = {}): PublishPost =>
        publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'trading',
          text: `Synthetic listing ${randomUUID()}`,
          authorMode: 'named',
          trading: {
            subtype: 'shuma',
            price: '123.12345678901234567890123456789',
            urgency: 'urgent',
            location: 'chosen location',
            contacts: { wechat: 'chosen-wechat', qq: '', phone: '' },
          },
          ...extra,
        });
      const publish = async (
        extra: Partial<PublishPost> = {},
        actor = author,
      ) => {
        const intent = body(extra);
        await approveTrading(pool, actor.accountId, intent);
        const receipt = created(
          await publications.post(actor.accessToken, intent),
        );
        return { intent, receipt, id: receipt.resourceId };
      };
      const resolution = (value: 'open' | 'resolved' = 'resolved') => ({
        clientRequestId: randomUUID(),
        resolution: value,
      });
      const events = async (id: string) =>
        (
          await pool.query(
            'SELECT event_type,context FROM whaleu_community.outbox WHERE resource_id=$1 ORDER BY created_at,id',
            [id],
          )
        ).rows;
      await t.test(
        'exact NUMERIC amount, chosen-only contact boundary, current DTO and source distribution',
        async () => {
          const { id, intent } = await publish();
          const stored = (
            await pool.query(
              'SELECT price::text,urgency,resolution FROM whaleu_community.trading_listings WHERE post_id=$1',
              [id],
            )
          ).rows[0];
          assert.equal(stored.price, intent.trading!.price);
          assert.equal(stored.urgency, 'urgent');
          assert.equal(stored.resolution, 'open');
          const detail = await feeds.detail(voter.accessToken, id);
          assert.deepEqual(detail.trading?.price, {
            kind: 'exact',
            amount: intent.trading!.price,
            legacyText: null,
          });
          assert.deepEqual(detail.trading?.subtype, {
            kind: 'known',
            key: 'shuma',
            legacyText: null,
          });
          assert.equal(detail.trading?.viewer.canSetResolution, false);
          assert.ok(!JSON.stringify(detail).includes('chosen-wechat'));
          assert.deepEqual(await trading.contacts(voter.accessToken, id), {
            postId: id,
            contacts: intent.trading!.contacts,
          });
          const generic = await feeds.feed(author.accessToken, {
            spaceId,
            limit: 10,
          });
          assert.ok(!generic.items.some((p) => p.id === id));
          const explicit = await feeds.feed(author.accessToken, {
            spaceId,
            category: 'trading',
            tradingSubtype: 'shuma',
            limit: 10,
          });
          assert.ok(explicit.items.some((p) => p.id === id));
          assert.ok(!JSON.stringify(explicit).includes('chosen-wechat'));
          assert.ok(
            (
              await feeds.ownTrading(author.accessToken, { limit: 10 })
            ).items.some((p) => p.id === id),
          );
          assert.equal(
            (await feeds.own(author.accessToken, { limit: 10 })).items.find(
              (p) => p.id === id,
            )?.status,
            'published',
          );
          assert.ok(
            !JSON.stringify(await events(id)).includes('chosen-wechat'),
          );
        },
      );
      await t.test(
        'publication hash binds all chosen contacts, location, exact price and urgency; body-only approval fails',
        async () => {
          const attempt = body();
          await approve(pool, author.accountId, attempt.text);
          assert.deepEqual(
            await publications.post(author.accessToken, attempt),
            {
              requestId: attempt.clientRequestId,
              operation: 'publish_post',
              outcome: 'rejected',
              code: 'CONTENT_REJECTED',
            },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [attempt.text],
              )
            ).rowCount,
            0,
          );
          const { id, intent } = await publish();
          for (const changes of [
            { price: '123.12345678901234567890123456788' },
            { location: 'changed' },
            { urgency: 'normal' as const },
            { contacts: { wechat: 'another', qq: '', phone: '' } },
          ])
            await assert.rejects(
              publications.post(author.accessToken, {
                ...intent,
                trading: { ...intent.trading!, ...changes },
              }),
              codeIs('REQUEST_CONFLICT'),
            );
          assert.equal(
            (await events(id)).filter((e) => e.event_type === 'post_created')
              .length,
            1,
          );
        },
      );
      await t.test(
        'parallel publication deduplicates and rejected review leaves no listing or orphan',
        async () => {
          const intent = body();
          await approveTrading(pool, author.accountId, intent);
          const receipts = await Promise.all(
            Array.from({ length: 8 }, () =>
              publications.post(author.accessToken, intent),
            ),
          );
          receipts.forEach((r) => assert.deepEqual(r, receipts[0]));
          const id = created(receipts[0]!).resourceId;
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.trading_listings WHERE post_id=$1',
                [id],
              )
            ).rowCount,
            1,
          );
          assert.equal((await events(id)).length, 1);
          const unapproved = body();
          assert.equal(
            (await publications.post(author.accessToken, unapproved)).outcome,
            'rejected',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [unapproved.text],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'resolution is independent of urgency; stale opposite-intent replay never reapplies',
        async () => {
          const { id } = await publish();
          const sold = resolution(),
            open = resolution('open');
          const receipts = await Promise.all(
            Array.from({ length: 8 }, () =>
              trading.setResolution(author.accessToken, id, sold),
            ),
          );
          receipts.forEach((r) => assert.deepEqual(r, receipts[0]));
          await trading.setResolution(author.accessToken, id, open);
          assert.deepEqual(
            await trading.setResolution(author.accessToken, id, sold),
            receipts[0],
          );
          assert.equal(
            (await feeds.detail(author.accessToken, id)).trading?.resolution,
            'open',
          );
          assert.equal(
            (await feeds.detail(author.accessToken, id)).trading?.urgency,
            'urgent',
          );
          assert.equal(
            (await events(id)).filter(
              (e) => e.event_type === 'trading_resolution_changed',
            ).length,
            2,
          );
          await trading.setResolution(
            author.accessToken,
            id,
            resolution('open'),
          );
          assert.equal(
            (await events(id)).filter(
              (e) => e.event_type === 'trading_resolution_changed',
            ).length,
            2,
          );
          await assert.rejects(
            trading.setResolution(author.accessToken, id, {
              ...sold,
              resolution: 'open',
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          await assert.rejects(
            trading.receipt(voter.accessToken, sold.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await deletions.post(author.accessToken, id);
          assert.deepEqual(
            await trading.receipt(author.accessToken, sold.clientRequestId),
            receipts[0],
          );
          assert.deepEqual(
            await trading.setResolution(author.accessToken, id, sold),
            receipts[0],
          );
          assert.equal(
            (await trading.setResolution(author.accessToken, id, resolution()))
              .outcome,
            'rejected',
          );
          await assert.rejects(
            trading.contacts(author.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'phone/restriction checks are independent from publication permission; foreign manager flag grants nothing',
        async () => {
          const { id } = await publish();
          await grant(pool, other.accountId, spaceId, {
            ...verified(region),
            canManage: true,
          });
          assert.equal(
            (await trading.setResolution(other.accessToken, id, resolution()))
              .outcome,
            'rejected',
          );
          await grant(pool, author.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
          });
          assert.equal(
            (await trading.setResolution(author.accessToken, id, resolution()))
              .outcome,
            'applied',
          );
          for (const authority of [
            { ...verified(region), phoneVerified: false },
            {
              ...verified(region),
              restrictedActions: ['resolve_trading' as const],
            },
          ]) {
            await grant(pool, author.accountId, spaceId, authority);
            assert.equal(
              (
                await trading.setResolution(
                  author.accessToken,
                  id,
                  resolution('open'),
                )
              ).outcome,
              'rejected',
            );
            assert.equal(
              (await feeds.detail(author.accessToken, id)).trading?.viewer
                .canSetResolution,
              false,
            );
          }
          await grant(pool, author.accountId, spaceId, verified(region));
          const globalAttempt = body({ spaceId: globalId });
          await approveTrading(pool, author.accountId, globalAttempt);
          assert.equal(
            (await publications.post(author.accessToken, globalAttempt))
              .outcome,
            'rejected',
          );
          const capabilities = await feeds.capabilities(
            author.accessToken,
            spaceId,
            'trading',
          );
          assert.deepEqual(capabilities.authorModes, ['named']);
        },
      );
      await t.test(
        'contacts recheck hidden, blocked, inactive and deleted parents without leaking private profile fields',
        async () => {
          const { id } = await publish();
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [voter.accountId, author.accountId],
          );
          await assert.rejects(
            trading.contacts(voter.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [voter.accountId],
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [id],
          );
          await assert.rejects(
            trading.contacts(author.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
          assert.ok(
            !(
              await feeds.ownTrading(author.accessToken, { limit: 10 })
            ).items.some((p) => p.id === id),
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [id],
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          await assert.rejects(
            trading.contacts(author.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
          assert.equal(
            (await feeds.ownTrading(author.accessToken, { limit: 10 })).items
              .length,
            0,
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );
      await t.test(
        'historical raw strings and unknown subtype are preserved and displayed explicitly without decimal guessing',
        async () => {
          const id = randomUUID(),
            tx = await pool.connect();
          const raw = '  面议 / 约 1e3 元（原文）  ',
            subtype = '旧分类 原文';
          try {
            await tx.query('BEGIN');
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'trading','historical synthetic','named','open')",
              [id, spaceId, author.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,legacy_raw_price,legacy_raw_subtype,urgency,location,wechat,qq,phone) VALUES($1,'unknown',NULL,$2,$3,'urgent',$4,$5,'','')",
              [id, raw, subtype, '旧位置'.repeat(100), '旧联系'.repeat(50)],
            );
            await tx.query('COMMIT');
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
          const view = (await feeds.detail(author.accessToken, id)).trading!;
          assert.deepEqual(view.price, { kind: 'legacy', text: raw });
          assert.deepEqual(view.subtype, { kind: 'legacy', text: subtype });
          assert.equal(view.location, '旧位置'.repeat(100));
          assert.equal(
            (await trading.contacts(author.accessToken, id)).contacts.wechat,
            '旧联系'.repeat(50),
          );
          await trading.setResolution(author.accessToken, id, resolution());
          assert.deepEqual(
            (await feeds.detail(author.accessToken, id)).trading?.price,
            view.price,
          );
        },
      );
      await t.test(
        'database guards reject incomplete/mismatched trading and immutable metadata/request mutations',
        async () => {
          const { id } = await publish();
          for (const sql of [
            'UPDATE whaleu_community.posts SET account_id=$2 WHERE id=$1',
            'UPDATE whaleu_community.posts SET space_id=$2 WHERE id=$1',
          ])
            await assert.rejects(
              pool.query(sql, [
                id,
                sql.includes('account_id') ? other.accountId : globalId,
              ]),
              sqlCode('23514'),
            );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.posts SET text='unreviewed' WHERE id=$1",
              [id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.posts SET author_mode='anonymous' WHERE id=$1",
              [id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.posts SET category='discussion' WHERE id=$1",
              [id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.trading_listings SET urgency='normal' WHERE post_id=$1",
              [id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.trading_listings WHERE post_id=$1',
              [id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'trading','incomplete','named','open')",
              [randomUUID(), spaceId, author.accountId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.trading_requests(account_id,client_request_id,payload_hash) VALUES($1,$2,$3)',
              [author.accountId, randomUUID(), 'a'.repeat(64)],
            ),
            sqlCode('23514'),
          );
          const request = resolution();
          await trading.setResolution(author.accessToken, id, request);
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.trading_requests WHERE account_id=$1 AND client_request_id=$2',
              [author.accountId, request.clientRequestId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.trading_requests SET receipt=receipt||\'{"resolution":"open"}\'::jsonb WHERE account_id=$1 AND client_request_id=$2',
              [author.accountId, request.clientRequestId],
            ),
            sqlCode('23514'),
          );
        },
      );
      await t.test(
        'commit failure rolls back listing/publication and resolution/event/receipt; exact retry commits once',
        async () => {
          const intent = body();
          await approveTrading(pool, author.accountId, intent);
          await pool.query(
            "CREATE FUNCTION whaleu_community_test.fail_trade_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic commit failure'; END $$; CREATE CONSTRAINT TRIGGER synthetic_trade_commit AFTER INSERT ON whaleu_community.trading_listings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_trade_commit()",
          );
          try {
            await assert.rejects(publications.post(author.accessToken, intent));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_trade_commit ON whaleu_community.trading_listings',
            );
          }
          await assert.rejects(
            app!
              .get(PublicationRepository)
              .receipt(author.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [intent.text],
              )
            ).rowCount,
            0,
          );
          const id = created(
              await publications.post(author.accessToken, intent),
            ).resourceId,
            request = resolution();
          await pool.query(
            'CREATE CONSTRAINT TRIGGER synthetic_trade_commit AFTER UPDATE ON whaleu_community.trading_listings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_trade_commit()',
          );
          try {
            await assert.rejects(
              trading.setResolution(author.accessToken, id, request),
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_trade_commit ON whaleu_community.trading_listings',
            );
          }
          assert.equal(
            (await feeds.detail(author.accessToken, id)).trading?.resolution,
            'open',
          );
          await assert.rejects(
            trading.receipt(author.accessToken, request.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (await events(id)).filter(
              (e) => e.event_type === 'trading_resolution_changed',
            ).length,
            0,
          );
          assert.equal(
            (await trading.setResolution(author.accessToken, id, request))
              .outcome,
            'applied',
          );
        },
      );
      await t.test(
        'resolution and parent deletion serialize; pending status cannot modify deleted listing',
        async () => {
          const { id } = await publish(),
            holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [id],
            );
            const pending = trading.setResolution(
              author.accessToken,
              id,
              resolution(),
            );
            await new Promise((r) => setTimeout(r, 40));
            await holder.query('COMMIT');
            const receipt = await pending;
            assert.equal(receipt.outcome, 'rejected');
            assert.equal(
              (
                await pool.query(
                  'SELECT resolution FROM whaleu_community.trading_listings WHERE post_id=$1',
                  [id],
                )
              ).rows[0].resolution,
              'open',
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
      await t.test(
        'authority lock stays held through resolution; revoked authority cannot race past it',
        async () => {
          const { id } = await publish(),
            entered = deferred(),
            release = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            entered.resolve();
            await release.promise;
          };
          const pending = trading.setResolution(
            author.accessToken,
            id,
            resolution(),
          );
          await entered.promise;
          let changed = false;
          const revoke = grant(pool, author.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          }).then(() => {
            changed = true;
          });
          await new Promise((r) => setTimeout(r, 40));
          assert.equal(changed, false);
          release.resolve();
          assert.equal((await pending).outcome, 'applied');
          await revoke;
          assert.equal(
            (
              await trading.setResolution(
                author.accessToken,
                id,
                resolution('open'),
              )
            ).outcome,
            'rejected',
          );
          await grant(pool, author.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'unavailable dependencies do not commit terminal requests; ordinary runtime never activates trading',
        async () => {
          const { id } = await publish(),
            request = resolution();
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1 AND space_id=$2',
            [author.accountId, spaceId],
          );
          await assert.rejects(
            trading.setResolution(author.accessToken, id, request),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            trading.receipt(author.accessToken, request.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await grant(pool, author.accountId, spaceId, verified(region));
          assert.equal(
            (await trading.setResolution(author.accessToken, id, request))
              .outcome,
            'applied',
          );
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          ordinary = module.createNestApplication({ logger: false });
          configureHttp(ordinary);
          await ordinary.init();
          const closed = ordinary.get(TradingService);
          await assert.rejects(
            closed.contacts(author.accessToken, id),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            closed.setResolution(author.accessToken, id, resolution()),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'active original session is checked before immutable receipt replay',
        async () => {
          const { id } = await publish(),
            request = resolution();
          await trading.setResolution(author.accessToken, id, request);
          await identity.logout(author.accessToken);
          await assert.rejects(
            trading.setResolution(author.accessToken, id, request),
            codeIs('SESSION_REVOKED'),
          );
          await assert.rejects(
            trading.receipt(author.accessToken, request.clientRequestId),
            codeIs('SESSION_REVOKED'),
          );
        },
      );
    } finally {
      authorization.beforeResolve = null;
      authorization.afterResolve = null;
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
