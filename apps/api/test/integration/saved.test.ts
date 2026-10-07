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
import { FeedService } from '../../src/community/feed.service.js';
import { TradingService } from '../../src/community/trading/service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublicationReceipt,
} from '../../src/community/contracts.js';
import { SavedMutationService } from '../../src/community/saved/mutation.service.js';
import { SavedReadService } from '../../src/community/saved/read.service.js';
import type {
  SavedIntent,
  UpdateChannel,
} from '../../src/community/saved/contracts.js';
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
  'real PostgreSQL saved relations, independent preferences, receipts, current visibility and obligations',
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
      ordinary: INestApplication | undefined,
      locked = false,
      owns = false;
    const authorization = new FixtureAuthorization(),
      visibility = new FixtureVisibility();
    const schemas = [
      'whaleu_community_test',
      'whaleu_verification',
      'whaleu_authorization',
      'whaleu_community',
      'whaleu_profile',
      'whaleu_campus',
      'whaleu_identity',
      'whaleu_meta',
    ];
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
      for (const table of [
        'saved_posts',
        'saved_epochs',
        'saved_requests',
        'post_update_preferences',
        'post_update_preference_history',
        'saved_obligations',
      ])
        assert.equal(
          (await pool.query(`SELECT 1 FROM whaleu_community.${table}`))
            .rowCount,
          0,
        );
      await fixtureSchema(pool);
      const provider = {
        exchange: async (code: string) => ({
          provider: 'wechat',
          appId: 'synthetic-saved',
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
        .useValue(new FixtureContent())
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService),
        publications = app.get(PublicationService),
        mutations = app.get(SavedMutationService),
        reads = app.get(SavedReadService),
        feeds = app.get(FeedService);
      const author = await identity.login('saved-author'),
        saver = await identity.login('saved-reader'),
        other = await identity.login('saved-other');
      const region = randomUUID(),
        spaceId = randomUUID(),
        globalId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Regional',true,$2),($3,'global','Global',true,NULL)",
        [spaceId, region, globalId],
      );
      const noStudent = {
        ...verified(region),
        studentVerified: false,
        identityRegionId: null,
      };
      for (const actor of [author, saver, other])
        for (const space of [spaceId, globalId])
          await grant(
            pool,
            actor.accountId,
            space,
            actor === saver
              ? noStudent
              : { ...verified(region), canManage: true },
          );
      const publish = async (extra: Partial<PublishPost> = {}) => {
        const body = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          text: `Synthetic saved ${randomUUID()}`,
          authorMode: 'named',
          ...extra,
        });
        if (body.trading) await approveTrading(pool, author.accountId, body);
        else await approve(pool, author.accountId, body.text);
        return created(await publications.post(author.accessToken, body));
      };
      const saveIntent = (id: string, desired: boolean): SavedIntent => ({
        operation: 'set_post_saved',
        postId: id,
        desired,
        channel: null,
      });
      const preferenceIntent = (
        id: string,
        channel: UpdateChannel,
        desired: boolean,
      ): SavedIntent => ({
        operation: 'set_post_update_preference',
        postId: id,
        desired,
        channel,
      });
      const set = (
        id: string,
        desired: boolean,
        req = randomUUID(),
        actor = saver,
        cleanup = false,
      ) =>
        mutations.set(actor.accessToken, req, saveIntent(id, desired), cleanup);
      const pref = (
        id: string,
        channel: UpdateChannel,
        desired: boolean,
        req = randomUUID(),
        actor = saver,
        cleanup = false,
      ) =>
        mutations.set(
          actor.accessToken,
          req,
          preferenceIntent(id, channel, desired),
          cleanup,
        );
      const state = async (id: string, actor = saver) =>
        (
          await pool.query(
            'SELECT * FROM whaleu_community.saved_posts WHERE account_id=$1 AND post_id=$2',
            [actor.accountId, id],
          )
        ).rows[0];
      const outboxCount = async (id: string) =>
        Number(
          (
            await pool.query(
              "SELECT count(*) AS count FROM whaleu_community.outbox WHERE context->>'postId'=$1 AND event_type IN ('post_saved','post_unsaved')",
              [id],
            )
          ).rows[0].count,
        );
      await t.test(
        'student-unverified self/readers can save, own state and aggregate reveal no saver roster',
        async () => {
          const id = await publish({
            authorMode: 'anonymous',
            commentsPolicy: 'restricted',
          });
          assert.equal((await set(id, true)).outcome, 'applied');
          assert.equal(
            (await set(id, true, randomUUID(), author)).outcome,
            'applied',
          );
          const post = await feeds.detail(saver.accessToken, id);
          assert.equal(post.saveCount, 2);
          assert.equal(post.viewer.isSaved, true);
          assert.equal(post.viewer.canSave, true);
          assert.equal(post.viewer.canComment, false);
          assert.equal(post.viewer.canSetUpdatePreference, true);
          assert.ok(!JSON.stringify(post).includes(author.accountId));
          assert.ok(!JSON.stringify(post).includes(saver.accountId));
          const self = (
            await pool.query(
              'SELECT action,recipient_account_id FROM whaleu_community.saved_obligations WHERE epoch_id=$1',
              [(await state(id, author)).epoch_id],
            )
          ).rows;
          assert.equal(
            self.filter((r) => r.action === 'saver_reward').length,
            1,
          );
          assert.equal(
            self.filter((r) => r.action === 'author_reward').length,
            0,
          );
          assert.ok(
            self.every((r) => r.recipient_account_id === author.accountId),
          );
          assert.ok(
            visibility.seen
              .filter((s) => s.authorMode === 'anonymous')
              .every((s) => !('namedAccountId' in s)),
          );
        },
      );
      await t.test(
        'concurrent exact retry, no-op and opposite-intent recovery preserve immutable epochs and receipts',
        async () => {
          const id = await publish(),
            req = randomUUID();
          const receipts = await Promise.all(
            Array.from({ length: 5 }, () => set(id, true, req)),
          );
          for (const receipt of receipts)
            assert.deepEqual(receipt, receipts[0]);
          const first = await state(id);
          assert.equal(await outboxCount(id), 1);
          await set(id, true);
          assert.deepEqual(await state(id), first);
          assert.equal(await outboxCount(id), 1);
          await assert.rejects(set(id, false, req), codeIs('REQUEST_CONFLICT'));
          await assert.rejects(
            pref(id, 'saved', true, req),
            codeIs('REQUEST_CONFLICT'),
          );
          await set(id, false);
          const stopped = await state(id);
          assert.equal(stopped.epoch_id, null);
          assert.equal(stopped.saved_at, null);
          assert.deepEqual(
            await mutations.receipt(saver.accessToken, req),
            receipts[0],
          );
          assert.deepEqual(await set(id, true, req), receipts[0]);
          assert.deepEqual(await state(id), stopped);
          await sleep(3);
          await set(id, true);
          const second = await state(id);
          assert.notEqual(second.epoch_id, first.epoch_id);
          assert.ok(second.saved_at > first.saved_at);
          assert.equal(await outboxCount(id), 3);
          const epochs = (
            await pool.query(
              'SELECT * FROM whaleu_community.saved_epochs WHERE account_id=$1 AND post_id=$2 ORDER BY started_sequence',
              [saver.accountId, id],
            )
          ).rows;
          assert.equal(epochs.length, 2);
          assert.ok(
            BigInt(epochs[0].ended_sequence) <
              BigInt(epochs[1].started_sequence),
          );
          const obligations = (
            await pool.query(
              'SELECT action,transition,status FROM whaleu_community.saved_obligations WHERE epoch_id=ANY($1::uuid[])',
              [epochs.map((e) => e.id)],
            )
          ).rows;
          assert.equal(obligations.length, 10);
          assert.ok(obligations.every((o) => o.status === 'pending'));
          assert.ok(
            obligations
              .filter((o) => o.transition === 'unsaved')
              .every((o) =>
                ['author_interactions', 'save_ranking'].includes(o.action),
              ),
          );
          await assert.rejects(
            mutations.receipt(other.accessToken, req),
            codeIs('REQUEST_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'independent defaults, channel revisions and mute choices survive no-op, replay and re-save',
        async () => {
          const id = await publish();
          const defaults = await reads.preferences(saver.accessToken, id);
          assert.deepEqual(defaults, {
            postId: id,
            savedUpdatesEnabled: true,
            externalUpdatesEnabled: true,
            revision: '0',
            canSetPreference: true,
            reason: null,
            inAppCapability: 'unavailable',
            externalCapability: 'unavailable',
          });
          await pref(id, 'external', true);
          assert.equal(
            (await reads.preferences(saver.accessToken, id)).revision,
            '0',
          );
          const req = randomUUID();
          await pref(id, 'saved', false, req);
          const muted = await reads.preferences(saver.accessToken, id);
          await pref(id, 'saved', false);
          assert.deepEqual(
            await reads.preferences(saver.accessToken, id),
            muted,
          );
          await Promise.all([
            pref(id, 'saved', true),
            pref(id, 'external', false),
          ]);
          const independent = await reads.preferences(saver.accessToken, id);
          assert.equal(independent.savedUpdatesEnabled, true);
          assert.equal(independent.externalUpdatesEnabled, false);
          await pref(id, 'saved', false, req);
          assert.deepEqual(
            await reads.preferences(saver.accessToken, id),
            independent,
          );
          await pref(id, 'saved', false);
          await set(id, true);
          await set(id, false);
          await set(id, true);
          const bothOff = await reads.preferences(saver.accessToken, id);
          assert.equal(bothOff.savedUpdatesEnabled, false);
          assert.equal(bothOff.externalUpdatesEnabled, false);
          await pref(id, 'saved', true);
          await pref(id, 'external', true);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.post_update_preferences WHERE account_id=$1 AND post_id=$2',
                [saver.accountId, id],
              )
            ).rowCount,
            1,
          );
          assert.ok(
            BigInt((await reads.preferences(saver.accessToken, id)).revision) >
              BigInt(muted.revision),
          );
          assert.equal(
            (await pref(id, 'external', false, randomUUID(), author)).outcome,
            'applied',
          );
          assert.equal(
            await state(id, author),
            undefined,
            'Preferences do not create saves',
          );
        },
      );
      await t.test(
        'visibility loss returns no hidden metadata; explicit own cleanup and minimal recovery bypass no new gates',
        async () => {
          const id = await publish(),
            req = randomUUID();
          await set(id, true, req);
          await pref(id, 'saved', false);
          await pref(id, 'saved', true);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [id],
          );
          const unavailable = await reads.status(saver.accessToken, [
            id,
            randomUUID(),
          ]);
          assert.ok(
            unavailable.items.every(
              (item) =>
                item.status === 'unavailable' && Object.keys(item).length === 2,
            ),
          );
          assert.ok(
            !(await reads.list(saver.accessToken, { limit: 50 })).items.some(
              (item) => item.post.id === id,
            ),
          );
          const denied = await set(id, false);
          assert.equal(denied.outcome, 'rejected');
          if (denied.outcome === 'rejected')
            assert.equal(denied.code, 'POST_NOT_FOUND');
          await grant(pool, saver.accountId, spaceId, {
            ...noStudent,
            phoneVerified: false,
            restrictedActions: ['save_post', 'set_post_update_preference'],
          });
          assert.equal(
            (await set(id, false, randomUUID(), saver, true)).outcome,
            'applied',
          );
          assert.equal(
            (await pref(id, 'saved', false, randomUUID(), saver, true)).outcome,
            'applied',
          );
          assert.equal((await state(id)).epoch_id, null);
          assert.deepEqual(
            await set(id, true, req),
            await mutations.receipt(saver.accessToken, req),
          );
          assert.equal((await state(id)).epoch_id, null);
          const unknown = randomUUID();
          assert.equal(
            (await set(unknown, false, randomUUID(), saver, true)).outcome,
            'applied',
          );
          const unknownPreference = await pref(
            unknown,
            'external',
            false,
            randomUUID(),
            saver,
            true,
          );
          assert.equal(unknownPreference.outcome, 'rejected');
          const otherCleanup = await pref(
            id,
            'external',
            false,
            randomUUID(),
            other,
            true,
          );
          assert.equal(otherCleanup.outcome, 'rejected');
          assert.ok(
            !JSON.stringify(
              await mutations.receipt(saver.accessToken, req),
            ).includes(author.accountId),
          );
          await grant(pool, saver.accountId, spaceId, noStudent);
        },
      );
      await t.test(
        'dedicated phone/action checks and unavailable authority never reuse publication rules',
        async () => {
          const id = await publish();
          await grant(pool, saver.accountId, spaceId, {
            ...noStudent,
            phoneVerified: false,
          });
          for (const result of [
            await set(id, true),
            await pref(id, 'external', false),
          ]) {
            assert.equal(result.outcome, 'rejected');
            if (result.outcome === 'rejected')
              assert.equal(result.code, 'PHONE_VERIFICATION_REQUIRED');
          }
          assert.equal(
            (await reads.preferences(saver.accessToken, id)).canSetPreference,
            false,
          );
          await reads.list(saver.accessToken, { limit: 20 });
          await reads.status(saver.accessToken, [id]);
          await grant(pool, saver.accountId, spaceId, {
            ...noStudent,
            restrictedActions: ['save_post'],
          });
          const denied = await set(id, true);
          assert.equal(denied.outcome, 'rejected');
          if (denied.outcome === 'rejected')
            assert.equal(denied.code, 'COMMUNITY_ACTION_RESTRICTED');
          assert.equal((await pref(id, 'external', false)).outcome, 'applied');
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1 AND space_id=$2',
            [saver.accountId, spaceId],
          );
          const req = randomUUID();
          await assert.rejects(
            set(id, true, req),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            mutations.receipt(saver.accessToken, req),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await grant(pool, saver.accountId, spaceId, noStudent);
          assert.equal((await set(id, true, req)).outcome, 'applied');
        },
      );
      await t.test(
        'Saved list preserves urgent/resolved trades, entitled scopes and exact visible totals',
        async () => {
          const reader = await identity.login('saved-list-reader');
          for (const space of [spaceId, globalId])
            await grant(pool, reader.accountId, space, noStudent);
          const plain = await publish(),
            global = await publish({ spaceId: globalId }),
            hidden = await publish(),
            blocked = await publish();
          const urgent = await publish({
            category: 'trading',
            trading: {
              subtype: 'shuma',
              price: '2.50',
              urgency: 'urgent',
              location: '校内',
              contacts: { wechat: 'private-saved-contact', qq: '', phone: '' },
            },
          });
          await app!
            .get(TradingService)
            .setResolution(author.accessToken, urgent, {
              clientRequestId: randomUUID(),
              resolution: 'resolved',
            });
          for (const id of [plain, global, hidden, blocked, urgent])
            await set(id, true, randomUUID(), reader);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [hidden],
          );
          // Block filtering uses an anonymous parent to preserve the established rule.
          await pool.query(
            "UPDATE whaleu_community.posts SET author_mode='anonymous' WHERE id=$1",
            [plain],
          );
          await pool.query(
            "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name) VALUES($1,$2,$3,'匿名鲸鱼')",
            [randomUUID(), plain, author.accountId],
          );
          const page = await reads.list(reader.accessToken, { limit: 2 });
          assert.equal(page.visibleSavedCount, 4);
          assert.ok(page.nextCursor);
          const next = await reads.list(reader.accessToken, {
            limit: 2,
            cursor: page.nextCursor!,
          });
          assert.equal(next.visibleSavedCount, 4);
          assert.equal(next.nextCursor, null);
          const all = [...page.items, ...next.items];
          assert.equal(new Set(all.map((item) => item.post.id)).size, 4);
          assert.equal(
            all.find((item) => item.post.id === urgent)!.post.trading!
              .resolution,
            'resolved',
          );
          assert.equal(
            all.find((item) => item.post.id === urgent)!.post.trading!.urgency,
            'urgent',
          );
          assert.ok(all.every((item) => item.post.viewer.isSaved));
          assert.ok(all.some((item) => item.post.id === global));
          assert.ok(!JSON.stringify(all).includes('private-saved-contact'));
          await assert.rejects(
            reads.list(saver.accessToken, {
              limit: 2,
              cursor: page.nextCursor!,
            }),
          );
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [reader.accountId, author.accountId],
          );
          const filtered = await reads.list(reader.accessToken, { limit: 20 });
          assert.equal(filtered.visibleSavedCount, 1);
          assert.equal(filtered.items[0]!.post.id, plain);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [reader.accountId],
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          const regionalOff = await reads.list(reader.accessToken, {
            limit: 20,
          });
          assert.equal(regionalOff.visibleSavedCount, 1);
          assert.equal(regionalOff.items[0]!.post.id, global);
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );
      await t.test(
        'tied Saved timestamps use epoch tie-breaker; movement, empty visibility and list bound are explicit',
        async () => {
          const reader = await identity.login('saved-tied-reader');
          await grant(pool, reader.accountId, spaceId, noStudent);
          const ids = [await publish(), await publish(), await publish()],
            at = '2026-01-01T00:00:00.000Z';
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            for (const id of ids) {
              const epoch = randomUUID();
              await tx.query(
                'INSERT INTO whaleu_community.saved_posts(account_id,post_id) VALUES($1,$2)',
                [reader.accountId, id],
              );
              const order = (
                await tx.query(
                  "SELECT nextval('whaleu_community.discussion_sequence') AS sequence",
                )
              ).rows[0].sequence;
              await tx.query(
                'INSERT INTO whaleu_community.saved_epochs(id,account_id,post_id,started_at,started_sequence) VALUES($1,$2,$3,$4,$5)',
                [epoch, reader.accountId, id, at, order],
              );
              await tx.query(
                'UPDATE whaleu_community.saved_posts SET epoch_id=$3,saved_at=$4,revision=$5 WHERE account_id=$1 AND post_id=$2',
                [reader.accountId, id, epoch, at, order],
              );
            }
            await tx.query('COMMIT');
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          } finally {
            tx.release();
          }
          const first = await reads.list(reader.accessToken, { limit: 2 });
          assert.equal(first.visibleSavedCount, 3);
          assert.ok(first.nextCursor);
          const rest = await reads.list(reader.accessToken, {
            limit: 2,
            cursor: first.nextCursor!,
          });
          const full = [...first.items, ...rest.items];
          assert.equal(new Set(full.map((item) => item.post.id)).size, 3);
          assert.deepEqual(
            full.map((item) => item.saveEpochId),
            [...full.map((item) => item.saveEpochId)].sort().reverse(),
          );
          const moved = rest.items[0]!.post.id;
          await set(moved, false, randomUUID(), reader);
          await set(moved, true, randomUUID(), reader);
          const afterMove = await reads.list(reader.accessToken, {
            limit: 2,
            cursor: first.nextCursor!,
          });
          assert.equal(afterMove.visibleSavedCount, 3);
          assert.deepEqual(afterMove.items, []);
          assert.equal(afterMove.nextCursor, null);
          assert.equal(
            (await reads.list(reader.accessToken, { limit: 2 })).items[0]!.post
              .id,
            moved,
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=ANY($1::uuid[])",
            [ids],
          );
          assert.deepEqual(await reads.list(reader.accessToken, { limit: 2 }), {
            items: [],
            nextCursor: null,
            visibleSavedCount: 0,
          });
          const bounded = await identity.login('saved-over-limit-reader');
          const bulk = await pool.connect();
          try {
            await bulk.query('BEGIN');
            // Entirely synthetic current relations. No import or real account data.
            await bulk.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,visibility) SELECT gen_random_uuid(),$1,$2,'discussion','Synthetic saved bound','named','open','hidden' FROM generate_series(1,1025)",
              [spaceId, bounded.accountId],
            );
            await bulk.query(
              'INSERT INTO whaleu_community.saved_posts(account_id,post_id) SELECT $1,id FROM whaleu_community.posts WHERE account_id=$1',
              [bounded.accountId],
            );
            await bulk.query(
              "INSERT INTO whaleu_community.saved_epochs(id,account_id,post_id,started_at,started_sequence) SELECT gen_random_uuid(),account_id,post_id,$2,nextval('whaleu_community.discussion_sequence') FROM whaleu_community.saved_posts WHERE account_id=$1",
              [bounded.accountId, at],
            );
            await bulk.query(
              'UPDATE whaleu_community.saved_posts s SET epoch_id=e.id,saved_at=e.started_at,revision=e.started_sequence FROM whaleu_community.saved_epochs e WHERE s.account_id=$1 AND e.account_id=s.account_id AND e.post_id=s.post_id',
              [bounded.accountId],
            );
            await bulk.query('COMMIT');
          } catch (error) {
            await bulk.query('ROLLBACK');
            throw error;
          } finally {
            bulk.release();
          }
          await assert.rejects(
            reads.list(bounded.accessToken, { limit: 50 }),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'rollback of obligations/outbox also removes request, epoch and relationship; retry is safe',
        async () => {
          const id = await publish(),
            req = randomUUID(),
            community = app!.get(CommunityRepository),
            event = community.event.bind(community);
          community.event = async () => {
            throw new Error('Synthetic saved outbox failure');
          };
          try {
            await assert.rejects(set(id, true, req));
          } finally {
            community.event = event;
          }
          assert.equal(await state(id), undefined);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.saved_epochs WHERE post_id=$1',
                [id],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            mutations.receipt(saver.accessToken, req),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await set(id, true, req);
          assert.equal(await outboxCount(id), 1);
        },
      );
      await t.test(
        'database rejects incomplete/mutated/malformed receipts and inconsistent epoch/history',
        async () => {
          const id = await publish(),
            req = randomUUID(),
            receipt = await set(id, true, req),
            relation = await state(id);
          for (const sql of [
            'UPDATE whaleu_community.saved_requests SET desired=false WHERE client_request_id=$1',
            'DELETE FROM whaleu_community.saved_requests WHERE client_request_id=$1',
          ])
            await assert.rejects(pool.query(sql, [req]), sqlCode('23514'));
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.saved_epochs SET started_at=clock_timestamp() WHERE id=$1',
              [relation.epoch_id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.saved_posts SET epoch_id=NULL,saved_at=NULL,revision=revision+1 WHERE account_id=$1 AND post_id=$2',
              [saver.accountId, id],
            ),
            sqlCode('23514'),
          );
          const invalidChannel = randomUUID();
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.saved_requests(account_id,client_request_id,payload_hash,operation,post_id,desired,channel,receipt) VALUES($1,$2,$3,'set_post_update_preference',$4,true,NULL,$5::jsonb)",
              [
                saver.accountId,
                invalidChannel,
                'a'.repeat(64),
                id,
                JSON.stringify({
                  requestId: invalidChannel,
                  operation: 'set_post_update_preference',
                  postId: id,
                  desired: true,
                  channel: null,
                  outcome: 'applied',
                }),
              ],
            ),
            sqlCode('23514'),
          );
          const incomplete = randomUUID();
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.saved_requests(account_id,client_request_id,payload_hash,operation,post_id,desired) VALUES($1,$2,$3,'set_post_saved',$4,true)",
              [saver.accountId, incomplete, 'a'.repeat(64), id],
            ),
            sqlCode('23514'),
          );
          for (const change of [
            { postId: randomUUID() },
            { desired: false },
            { channel: 'saved' },
            { outcome: 'rejected', code: 'unexpected' },
            { contacts: { phone: 'leak' } },
          ]) {
            const requestId = randomUUID();
            await assert.rejects(
              pool.query(
                "INSERT INTO whaleu_community.saved_requests(account_id,client_request_id,payload_hash,operation,post_id,desired,receipt) VALUES($1,$2,$3,'set_post_saved',$4,true,$5::jsonb)",
                [
                  saver.accountId,
                  requestId,
                  'a'.repeat(64),
                  id,
                  JSON.stringify({ ...receipt, requestId, ...change }),
                ],
              ),
              sqlCode('23514'),
            );
          }
          await pref(id, 'saved', false);
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.post_update_preferences SET saved_updates_enabled=true,revision=revision+1 WHERE account_id=$1 AND post_id=$2',
              [saver.accountId, id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.post_update_preference_history WHERE account_id=$1 AND post_id=$2',
              [saver.accountId, id],
            ),
            sqlCode('23514'),
          );
        },
      );
      await t.test(
        'authoritative shared order distinguishes events before save, active epoch and re-save',
        async () => {
          const id = await publish();
          const comment = async () => {
            const body = {
              clientRequestId: randomUUID(),
              text: `root ${randomUUID()}`,
              imageAssetIds: [],
              authorMode: 'named' as const,
            };
            await approve(pool, author.accountId, body.text, 'publish_comment');
            return created(
              await publications.comment(author.accessToken, id, body),
            );
          };
          const before = await comment();
          await set(id, true);
          const first = await state(id);
          const during = await comment();
          await pref(id, 'saved', false);
          await set(id, false);
          await set(id, true);
          const second = await state(id);
          const orders = (
            await pool.query(
              'SELECT id,interaction_sequence FROM whaleu_community.root_comments WHERE id=ANY($1::uuid[])',
              [[before, during]],
            )
          ).rows;
          const epoch = (
            await pool.query(
              'SELECT * FROM whaleu_community.saved_epochs WHERE id=$1',
              [first.epoch_id],
            )
          ).rows[0];
          assert.ok(
            BigInt(orders.find((r) => r.id === before).interaction_sequence) <
              BigInt(epoch.started_sequence),
          );
          assert.ok(
            BigInt(epoch.started_sequence) <
              BigInt(orders.find((r) => r.id === during).interaction_sequence),
          );
          assert.ok(
            BigInt(orders.find((r) => r.id === during).interaction_sequence) <
              BigInt(epoch.ended_sequence),
          );
          assert.ok(BigInt(epoch.ended_sequence) < BigInt(second.revision));
          assert.equal(
            (await reads.preferences(saver.accessToken, id)).inAppCapability,
            'unavailable',
          );
        },
      );
      await t.test(
        'strict HTTP route/body/status contract, no actor selectors and terminal desired identity',
        async () => {
          const id = await publish(),
            req = randomUUID(),
            auth = `Bearer ${saver.accessToken}`;
          const result = await request(app!.getHttpServer())
            .put(`/v1/community/posts/${id}/save`)
            .set('Authorization', auth)
            .send({ clientRequestId: req })
            .expect(200);
          assert.deepEqual(result.body, {
            requestId: req,
            operation: 'set_post_saved',
            postId: id,
            desired: true,
            channel: null,
            outcome: 'applied',
          });
          await request(app!.getHttpServer())
            .get(`/v1/me/community/saved-requests/${req}`)
            .set('Authorization', auth)
            .expect(200, result.body);
          await request(app!.getHttpServer())
            .post('/v1/me/community/saved/status')
            .set('Authorization', auth)
            .send({ postIds: [id] })
            .expect(200);
          for (const body of [
            { clientRequestId: randomUUID(), actor: author.accountId },
            { clientRequestId: randomUUID(), desired: false },
          ])
            await request(app!.getHttpServer())
              .put(`/v1/community/posts/${id}/save`)
              .set('Authorization', auth)
              .send(body)
              .expect(400);
          await request(app!.getHttpServer())
            .post('/v1/me/community/saved/status')
            .set('Authorization', auth)
            .send({ postIds: [id, id.toUpperCase()] })
            .expect(400);
          await request(app!.getHttpServer())
            .get('/v1/me/community/saved?limit=51')
            .set('Authorization', auth)
            .expect(400);
          await request(app!.getHttpServer())
            .put(`/v1/community/posts/${id}/update-preferences`)
            .set('Authorization', auth)
            .send({
              clientRequestId: randomUUID(),
              channel: 'all',
              enabled: false,
            })
            .expect(400);
          await request(app!.getHttpServer())
            .delete(`/v1/community/posts/${id}/save`)
            .set('Authorization', auth)
            .send({ clientRequestId: randomUUID() })
            .expect(200);
          await request(app!.getHttpServer())
            .get(`/v1/community/posts/${id}/update-preferences`)
            .set('Authorization', auth)
            .expect(200);
        },
      );
      await t.test(
        'parent hiding and token expiry while lock-waiting cannot commit a new save',
        async () => {
          const id = await publish(),
            blocker = await pool.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [id],
          );
          const pending = set(id, true);
          await sleep(50);
          await blocker.query('COMMIT');
          blocker.release();
          const result = await pending;
          assert.equal(result.outcome, 'rejected');
          if (result.outcome === 'rejected')
            assert.equal(result.code, 'POST_NOT_FOUND');
          const expiring = await identity.login('saved-expiring');
          await grant(pool, expiring.accountId, spaceId, noStudent);
          const visible = await publish();
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE session_id=$1",
            [expiring.sessionId],
          );
          const hold = await pool.connect();
          await hold.query('BEGIN');
          await hold.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
            [visible],
          );
          const waiting = set(visible, true, randomUUID(), expiring).then(
            () => null,
            (e: unknown) => e,
          );
          await sleep(300);
          await hold.query('COMMIT');
          hold.release();
          assert.ok(codeIs('ACCESS_TOKEN_EXPIRED')(await waiting));
          assert.equal(await state(visible, expiring), undefined);
        },
      );
      await t.test(
        'unavailable ordinary runtime remains closed and revoked accounts cannot recover',
        async () => {
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          ordinary = module.createNestApplication({ logger: false });
          await ordinary.init();
          const id = await publish();
          await assert.rejects(
            ordinary.get(SavedReadService).preferences(saver.accessToken, id),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            ordinary
              .get(SavedMutationService)
              .set(saver.accessToken, randomUUID(), saveIntent(id, true)),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          const req = randomUUID();
          await set(id, true, req);
          await identity.logout(saver.accessToken);
          await assert.rejects(
            mutations.receipt(saver.accessToken, req),
            codeIs('SESSION_REVOKED'),
          );
          await assert.rejects(set(id, true, req), codeIs('SESSION_REVOKED'));
          await assert.rejects(
            set(id, false, randomUUID(), saver, true),
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
