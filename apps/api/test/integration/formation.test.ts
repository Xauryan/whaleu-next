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
import { DeletionService } from '../../src/community/deletion.service.js';
import { FeedService } from '../../src/community/feed.service.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublicationReceipt,
} from '../../src/community/contracts.js';
import { FormationService } from '../../src/community/formation/service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { joinFormationSchema } from '../../src/community/formation/contracts.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approveFormation,
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
test(
  'real PostgreSQL formation creator, seats, immutable joins, privacy and loss recovery',
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
        (await pool.query('SELECT * FROM whaleu_community.formations'))
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
        formations = app.get(FormationService),
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
      const contacts = { wechat: 'chosen-member-contact', qq: '', phone: '' };
      const body = (extra: Partial<PublishPost> = {}): PublishPost =>
        publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'companions',
          text: `Synthetic formation ${randomUUID()}`,
          authorMode: 'anonymous',
          component: {
            kind: 'formation',
            capacity: 3,
            theme: '周末爬山',
            contacts: { wechat: 'chosen-creator-contact', qq: '', phone: '' },
            contactSharing: 'members_v1',
          },
          ...extra,
        });
      const publish = async (
        extra: Partial<PublishPost> = {},
        actor = author,
      ) => {
        const intent = body(extra);
        await approveFormation(pool, actor.accountId, intent);
        const receipt = created(
          await publications.post(actor.accessToken, intent),
        );
        return { intent, receipt, id: receipt.resourceId };
      };
      const join = (extra: Record<string, unknown> = {}) =>
        joinFormationSchema.parse({
          clientRequestId: randomUUID(),
          contacts,
          contactSharing: 'members_v1',
          ...extra,
        });
      const component = (capacity: number) => ({
        kind: 'formation' as const,
        capacity,
        theme: '组局',
        contacts: { wechat: 'chosen-creator-contact', qq: '', phone: '' },
        contactSharing: 'members_v1' as const,
      });
      const memberCount = async (id: string) =>
        (
          await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE f.post_id=$1',
            [id],
          )
        ).rows[0]!.count;
      const eventCount = async (id: string) =>
        (
          await pool.query(
            'SELECT context FROM whaleu_community.outbox WHERE resource_id=$1',
            [id],
          )
        ).rows;
      await t.test(
        'creator occupies first seat, capacity1 is full; public anonymous persona has no account/contact leakage',
        async () => {
          const { id } = await publish({ component: component(1) });
          const view = await formations.get(author.accessToken, id);
          assert.equal(view.status, 'full');
          assert.equal(view.memberCount, 1);
          assert.equal(view.viewer.isCreator, true);
          assert.equal(view.viewer.isMember, true);
          assert.equal(view.viewer.canReadContacts, true);
          assert.equal(view.members[0]!.isCreator, true);
          assert.equal(view.members[0]!.author.kind, 'anonymous');
          const detail = await feeds.detail(voter.accessToken, id);
          assert.equal(detail.component.kind, 'formation');
          assert.deepEqual(view.members[0]!.author, detail.author);
          for (const secret of [
            author.accountId,
            'chosen-creator-contact',
            'wechat',
            'phone',
          ])
            assert.ok(!JSON.stringify(detail).includes(secret), secret);
          assert.equal(
            (await formations.join(voter.accessToken, id, join())).outcome,
            'rejected',
          );
          assert.deepEqual(await formations.contacts(author.accessToken, id), {
            postId: id,
            members: [
              {
                membershipId: view.members[0]!.id,
                contacts: component(1).contacts,
              },
            ],
          });
          await assert.rejects(
            formations.contacts(voter.accessToken, id),
            codeIs('FORMATION_MEMBERSHIP_REQUIRED'),
          );
          assert.equal(
            (await formations.own(author.accessToken, id)).isCreator,
            true,
          );
        },
      );
      await t.test(
        'phone-qualified unverified account joins without student or campus gate; named member uses public profile',
        async () => {
          const { id } = await publish();
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
            restrictedActions: ['publish_post'],
          });
          const receipt = await formations.join(voter.accessToken, id, join());
          assert.equal(receipt.outcome, 'created');
          const view = await formations.get(voter.accessToken, id);
          assert.equal(view.members[1]!.author.kind, 'named');
          assert.equal(view.viewer.isCreator, false);
          assert.equal(view.viewer.isMember, true);
          assert.ok(!JSON.stringify(view).includes(voter.accountId));
          assert.ok(!JSON.stringify(view).includes('chosen-member-contact'));
          assert.equal(
            (await formations.contacts(voter.accessToken, id)).members.length,
            2,
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'simultaneous last-seat joins serialize; creator capacity and distinct membership enforced',
        async () => {
          const { id } = await publish({ component: component(2) });
          const outcomes = await Promise.all([
            formations.join(voter.accessToken, id, join()),
            formations.join(other.accessToken, id, join()),
          ]);
          assert.equal(
            outcomes.filter((r) => r.outcome === 'created').length,
            1,
          );
          assert.equal(
            outcomes.filter(
              (r) => r.outcome === 'rejected' && r.code === 'FORMATION_FULL',
            ).length,
            1,
          );
          assert.equal(await memberCount(id), 2);
          assert.equal(
            (await formations.get(author.accessToken, id)).status,
            'full',
          );
        },
      );
      await t.test(
        'equal-key replay and concurrent duplicate/new-key requests cannot add or replace a membership',
        async () => {
          const { id } = await publish({ component: component(20) }),
            input = join();
          const receipts = await Promise.all([
            formations.join(voter.accessToken, id, input),
            formations.join(voter.accessToken, id, input),
          ]);
          assert.deepEqual(receipts[0], receipts[1]);
          assert.equal(receipts[0]!.outcome, 'created');
          await assert.rejects(
            formations.join(voter.accessToken, id, {
              ...input,
              contacts: { ...contacts, phone: 'changed' },
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          const changed = await formations.join(
            voter.accessToken,
            id,
            join({ contacts: { ...contacts, phone: 'changed' } }),
          );
          assert.equal(changed.outcome, 'rejected');
          if (changed.outcome === 'rejected')
            assert.equal(changed.code, 'FORMATION_ALREADY_JOINED');
          const [a, b] = await Promise.all([
            formations.join(other.accessToken, id, join()),
            formations.join(other.accessToken, id, join()),
          ]);
          assert.equal([a, b].filter((r) => r.outcome === 'created').length, 1);
          assert.equal(await memberCount(id), 3);
          if (receipts[0]!.outcome === 'created')
            assert.deepEqual(await eventCount(receipts[0]!.resourceId), [
              { context: {} },
            ]);
          const privateResult = await formations.contacts(
            voter.accessToken,
            id,
          );
          assert.equal(
            privateResult.members.find(
              (m) =>
                m.membershipId ===
                (receipts[0]!.outcome === 'created'
                  ? receipts[0]!.resourceId
                  : ''),
            )!.contacts.phone,
            '',
          );
        },
      );
      await t.test(
        'owner minimal receipts/status survive restart, deletion and permission loss; other accounts cannot recover them',
        async () => {
          const { id } = await publish(),
            input = join();
          const result = await formations.join(voter.accessToken, id, input);
          await deletions.post(author.accessToken, id);
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
            restrictedActions: ['join_formation', 'read_formation_contacts'],
          });
          const fresh = new FormationService(
            app!.get(CommunityRepository),
            app!.get(
              (await import('../../src/community/community-access.service.js'))
                .CommunityAccessService,
            ),
            app!.get(
              (await import('../../src/community/formation/repository.js'))
                .FormationRepository,
            ),
            app!.get(
              (await import('../../src/profile/author-display.service.js'))
                .AuthorDisplayService,
            ),
          );
          assert.deepEqual(
            await fresh.join(voter.accessToken, id, input),
            result,
          );
          assert.deepEqual(
            await fresh.receipt(voter.accessToken, input.clientRequestId),
            result,
          );
          const own = await fresh.own(voter.accessToken, id);
          assert.deepEqual(Object.keys(own).sort(), [
            'isCreator',
            'joinedAt',
            'membershipId',
            'postId',
          ]);
          assert.ok(!JSON.stringify(own).includes('chosen-member-contact'));
          await assert.rejects(
            fresh.receipt(other.accessToken, input.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await assert.rejects(
            fresh.own(other.accessToken, id),
            codeIs('FORMATION_MEMBERSHIP_NOT_FOUND'),
          );
          await assert.rejects(
            fresh.contacts(voter.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'rejection ledger is immutable across later phone or parent permission changes',
        async () => {
          const { id } = await publish(),
            input = join();
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          const rejected = await formations.join(voter.accessToken, id, input);
          assert.equal(rejected.outcome, 'rejected');
          if (rejected.outcome === 'rejected')
            assert.equal(rejected.code, 'PHONE_VERIFICATION_REQUIRED');
          await grant(pool, voter.accountId, spaceId, verified(region));
          assert.deepEqual(
            await formations.join(voter.accessToken, id, input),
            rejected,
          );
          assert.equal(await memberCount(id), 1);
          assert.equal(
            (await formations.join(voter.accessToken, id, join())).outcome,
            'created',
          );
        },
      );
      await t.test(
        'hidden/deleted/inactive parent and join/read-contact restrictions fail closed',
        async () => {
          for (const column of ['visibility', 'deleted_at']) {
            const { id } = await publish();
            await formations.join(voter.accessToken, id, join());
            await pool.query(
              `UPDATE whaleu_community.posts SET ${column}=${column === 'visibility' ? "'hidden'" : 'clock_timestamp()'} WHERE id=$1`,
              [id],
            );
            const rejected = await formations.join(
              other.accessToken,
              id,
              join(),
            );
            assert.equal(rejected.outcome, 'rejected');
            if (rejected.outcome === 'rejected')
              assert.equal(rejected.code, 'POST_NOT_FOUND');
            await assert.rejects(
              formations.contacts(voter.accessToken, id),
              codeIs('POST_NOT_FOUND'),
            );
          }
          const { id } = await publish();
          await formations.join(voter.accessToken, id, join());
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['read_formation_contacts'],
          });
          await assert.rejects(
            formations.contacts(voter.accessToken, id),
            codeIs('COMMUNITY_ACTION_RESTRICTED'),
          );
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          await assert.rejects(
            formations.contacts(voter.accessToken, id),
            codeIs('PHONE_VERIFICATION_REQUIRED'),
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
          await grant(pool, other.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['join_formation'],
          });
          const rejected = await formations.join(other.accessToken, id, join());
          assert.equal(rejected.outcome, 'rejected');
          await grant(pool, other.accountId, spaceId, verified(region));
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          await assert.rejects(
            formations.contacts(voter.accessToken, id),
            codeIs('POST_NOT_FOUND'),
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );
      await t.test(
        'named member block filters both public roster and private contacts without changing occupied seats',
        async () => {
          const { id } = await publish();
          await formations.join(voter.accessToken, id, join());
          await formations.join(other.accessToken, id, join());
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [voter.accountId, other.accountId],
          );
          const view = await formations.get(voter.accessToken, id);
          assert.equal(view.memberCount, 3);
          assert.equal(view.members.length, 2);
          const privateView = await formations.contacts(voter.accessToken, id);
          assert.equal(privateView.members.length, 2);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [voter.accountId],
          );
          const named = await publish({ authorMode: 'named' });
          await formations.join(voter.accessToken, named.id, join());
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [voter.accountId, author.accountId],
          );
          await assert.rejects(
            formations.contacts(voter.accessToken, named.id),
            codeIs('POST_NOT_FOUND'),
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [voter.accountId],
          );
        },
      );
      await t.test(
        'denied requester-membership visibility withholds all contacts without removing the seat or recovery',
        async () => {
          const { id } = await publish();
          const input = join();
          const receipt = await formations.join(voter.accessToken, id, input);
          const own = await formations.own(voter.accessToken, id);
          const check = visibility.check.bind(visibility);
          visibility.check = async (viewer, subject, tx, purpose) =>
            viewer === voter.accountId && subject.contentId === own.membershipId
              ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
              : check(viewer, subject, tx, purpose);
          try {
            const view = await formations.get(voter.accessToken, id);
            assert.equal(view.viewer.isMember, true);
            assert.equal(view.memberCount, 2);
            assert.equal(view.viewer.canReadContacts, false);
            await assert.rejects(
              formations.contacts(voter.accessToken, id),
              codeIs('FORMATION_MEMBERSHIP_REQUIRED'),
            );
            assert.deepEqual(await formations.own(voter.accessToken, id), own);
            assert.deepEqual(
              await formations.receipt(
                voter.accessToken,
                input.clientRequestId,
              ),
              receipt,
            );
          } finally {
            visibility.check = check;
          }
        },
      );
      await t.test(
        'approved formation images commit atomically and reject later append, edit or removal',
        async () => {
          const assetId = randomUUID(),
            digest = 'a'.repeat(64);
          await pool.query(
            "INSERT INTO whaleu_community_test.assets(id,account_id,purpose,digest,ready) VALUES($1,$2,'publish_post',$3,true)",
            [assetId, author.accountId, digest],
          );
          const intent = body({ imageAssetIds: [assetId] });
          await approveFormation(pool, author.accountId, intent, [
            { assetId, digest },
          ]);
          const id = created(
            await publications.post(author.accessToken, intent),
          ).resourceId;
          assert.equal(
            (await feeds.detail(author.accessToken, id)).images[0]!.assetId,
            assetId,
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.post_images(post_id,asset_id,digest,position) VALUES($1,$2,$3,1)',
              [id, randomUUID(), digest],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.post_images SET digest=$2 WHERE post_id=$1',
              [id, 'b'.repeat(64)],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.post_images WHERE post_id=$1',
              [id],
            ),
            sqlCode('23514'),
          );
          await deletions.post(author.accessToken, id);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.post_images WHERE post_id=$1',
                [id],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'queued deletion/hiding and authority revocation win before a new join or private contact read',
        async () => {
          for (const contactRead of [false, true]) {
            const { id } = await publish();
            if (contactRead)
              await formations.join(voter.accessToken, id, join());
            const blocker = await pool.connect();
            await blocker.query('BEGIN');
            await blocker.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [id],
            );
            const pending = contactRead
              ? formations.contacts(voter.accessToken, id)
              : formations.join(voter.accessToken, id, join());
            const handled = pending.then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
            await sleep(30);
            await blocker.query('COMMIT');
            blocker.release();
            const outcome = await handled;
            if (contactRead) {
              assert.ok('error' in outcome);
              assert.ok(codeIs('POST_NOT_FOUND')(outcome.error));
            } else {
              assert.ok('value' in outcome);
              assert.equal(
                (outcome.value as { outcome: string }).outcome,
                'rejected',
              );
              assert.equal(await memberCount(id), 1);
            }
          }
          const { id } = await publish();
          await formations.join(voter.accessToken, id, join());
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            "UPDATE whaleu_community_test.grants SET authority=jsonb_set(authority,'{phoneVerified}','false') WHERE account_id=$1 AND space_id=$2",
            [voter.accountId, spaceId],
          );
          const pending = formations.contacts(voter.accessToken, id).then(
            () => null,
            (error) => error,
          );
          await sleep(30);
          await blocker.query('COMMIT');
          blocker.release();
          assert.ok(codeIs('PHONE_VERIFICATION_REQUIRED')(await pending));
          await grant(pool, voter.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'block insertion while private read waits is re-evaluated and cannot expose member contact',
        async () => {
          const { id } = await publish();
          await formations.join(voter.accessToken, id, join());
          await formations.join(other.accessToken, id, join());
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE whaleu_community_test.blocks IN ACCESS EXCLUSIVE MODE',
          );
          await blocker.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [voter.accountId, other.accountId],
          );
          const pending = formations.contacts(voter.accessToken, id);
          await sleep(30);
          await blocker.query('COMMIT');
          blocker.release();
          assert.equal((await pending).members.length, 2);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [voter.accountId],
          );
        },
      );
      await t.test(
        'approval binds capacity/theme/contact consent and post-plus-creator commit rolls back atomically',
        async () => {
          const intent = body();
          await approve(pool, author.accountId, intent.text);
          const bodyOnly = await publications.post(author.accessToken, intent);
          assert.equal(bodyOnly.outcome, 'rejected');
          const approved = body();
          await approveFormation(pool, author.accountId, approved);
          const changed = {
            ...approved,
            component: {
              ...component(3),
              contacts: { ...contacts, phone: 'unapproved' },
            },
          };
          const result = await publications.post(author.accessToken, changed);
          assert.equal(result.outcome, 'rejected');
          const community = app!.get(CommunityRepository),
            event = community.event.bind(community);
          community.event = async () => {
            throw new Error('Synthetic outbox failure');
          };
          try {
            const intent = body();
            await approveFormation(pool, author.accountId, intent);
            await assert.rejects(publications.post(author.accessToken, intent));
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                  [intent.text],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                  [intent.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            community.event = event;
          }
        },
      );
      await t.test(
        'join outbox failure rolls back seat and request; retry creates one immutable transition',
        async () => {
          const { id } = await publish(),
            input = join();
          const community = app!.get(CommunityRepository),
            event = community.event.bind(community);
          community.event = async () => {
            throw new Error('Synthetic outbox failure');
          };
          try {
            await assert.rejects(formations.join(voter.accessToken, id, input));
          } finally {
            community.event = event;
          }
          assert.equal(await memberCount(id), 1);
          await assert.rejects(
            formations.receipt(voter.accessToken, input.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (await formations.join(voter.accessToken, id, input)).outcome,
            'created',
          );
          assert.equal(await memberCount(id), 2);
        },
      );
      await t.test(
        'database independently rejects mutable parents/members, overflow, orphan creator, malformed receipts and component mixing',
        async () => {
          const { id } = await publish({ component: component(1) });
          const form = (
            await pool.query(
              'SELECT id FROM whaleu_community.formations WHERE post_id=$1',
              [id],
            )
          ).rows[0].id;
          for (const sql of [
            "UPDATE whaleu_community.posts SET text='changed' WHERE id=$1",
            "UPDATE whaleu_community.posts SET author_mode='named' WHERE id=$1",
            'UPDATE whaleu_community.posts SET account_id=gen_random_uuid() WHERE id=$1',
            'UPDATE whaleu_community.formations SET capacity=2 WHERE post_id=$1',
            'DELETE FROM whaleu_community.formations WHERE post_id=$1',
            "UPDATE whaleu_community.formation_members SET wechat='changed' WHERE formation_id=(SELECT id FROM whaleu_community.formations WHERE post_id=$1)",
            'DELETE FROM whaleu_community.formation_members WHERE formation_id=(SELECT id FROM whaleu_community.formations WHERE post_id=$1)',
          ])
            await assert.rejects(pool.query(sql, [id]), sqlCode('23514'));
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.formation_members(id,formation_id,account_id,is_creator,wechat,qq,phone,contact_sharing) VALUES($1,$2,$3,false,'x','','','members_v1')",
              [randomUUID(), form, voter.accountId],
            ),
            sqlCode('23514'),
          );
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            const post = randomUUID();
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'companions','synthetic','named','open')",
              [post, spaceId, author.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_community.formations(id,post_id,capacity,theme) VALUES($1,$2,2,'x')",
              [randomUUID(), post],
            );
            await assert.rejects(tx.query('COMMIT'), sqlCode('23514'));
            await tx.query('ROLLBACK');
            await tx.query('BEGIN');
            await tx.query(
              "INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode) VALUES($1,$2,'q','single')",
              [randomUUID(), id],
            );
            await assert.rejects(tx.query('COMMIT'), sqlCode('23514'));
            await tx.query('ROLLBACK');
          } finally {
            tx.release();
          }
          for (const receipt of [
            {
              operation: 'join_formation',
              outcome: 'created',
              resourceId: { wechat: 'leak' },
              createdAt: new Date().toISOString(),
            },
            {
              operation: 'join_formation',
              outcome: 'rejected',
              code: 'unknown',
            },
            {
              operation: 'join_formation',
              outcome: 'rejected',
              code: { wechat: 'leak' },
            },
          ]) {
            const requestId = randomUUID();
            await assert.rejects(
              pool.query(
                'INSERT INTO whaleu_community.formation_requests(account_id,client_request_id,payload_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',
                [
                  voter.accountId,
                  requestId,
                  'a'.repeat(64),
                  JSON.stringify({ ...receipt, requestId }),
                ],
              ),
              sqlCode('23514'),
            );
          }
          const requestId = randomUUID();
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.formation_requests(account_id,client_request_id,payload_hash) VALUES($1,$2,$3)',
              [voter.accountId, requestId, 'a'.repeat(64)],
            ),
            sqlCode('23514'),
          );
        },
      );
      await t.test(
        'historical raw themes and consented contacts remain exact while unreconciled/unconfirmed reads stay closed',
        async () => {
          const createHistorical = async (
            reconciliation: string,
            sharing: string,
            theme = '  原始历史主题'.repeat(5) + '\r\n',
          ) => {
            const tx = await pool.connect(),
              id = randomUUID(),
              form = randomUUID();
            try {
              await tx.query('BEGIN');
              await tx.query(
                "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'companions','synthetic historical','named','open')",
                [id, spaceId, author.accountId],
              );
              await tx.query(
                'INSERT INTO whaleu_community.formations(id,post_id,capacity,theme,reconciliation,legacy_raw) VALUES($1,$2,2,$3,$4,$5::jsonb)',
                [
                  form,
                  id,
                  theme,
                  reconciliation,
                  JSON.stringify({ sourceStatus: 91, sourceCount: 9 }),
                ],
              );
              await tx.query(
                "INSERT INTO whaleu_community.formation_members(id,formation_id,account_id,is_creator,wechat,qq,phone,contact_sharing,legacy_raw) VALUES($1,$2,$3,true,$4,'','',$5,$6::jsonb)",
                [
                  randomUUID(),
                  form,
                  author.accountId,
                  ' chosen '.repeat(20),
                  sharing,
                  JSON.stringify({ sourceId: 88 }),
                ],
              );
              await tx.query('COMMIT');
              return id;
            } catch (error) {
              await tx.query('ROLLBACK');
              throw error;
            } finally {
              tx.release();
            }
          };
          const safe = await createHistorical('current', 'members_v1');
          assert.equal(
            (await formations.get(author.accessToken, safe)).theme,
            '  原始历史主题'.repeat(5) + '\r\n',
          );
          assert.equal(
            (await formations.contacts(author.accessToken, safe)).members[0]!
              .contacts.wechat,
            ' chosen '.repeat(20),
          );
          const unknown = await createHistorical(
            'unreconciled',
            'legacy_unconfirmed',
          );
          assert.equal(
            (await formations.get(author.accessToken, unknown)).status,
            'unavailable',
          );
          await assert.rejects(
            formations.contacts(author.accessToken, unknown),
            codeIs('FORMATION_UNAVAILABLE'),
          );
          const unconfirmed = await createHistorical(
            'current',
            'legacy_unconfirmed',
          );
          const invalid = await createHistorical('current', 'members_v1', ' ');
          assert.equal(
            (await formations.get(author.accessToken, invalid)).status,
            'unavailable',
          );
          await assert.rejects(
            formations.contacts(author.accessToken, invalid),
            codeIs('FORMATION_UNAVAILABLE'),
          );
          const denied = await formations.join(
            voter.accessToken,
            invalid,
            join(),
          );
          assert.equal(denied.outcome, 'rejected');
          if (denied.outcome === 'rejected')
            assert.equal(denied.code, 'FORMATION_UNAVAILABLE');
          assert.deepEqual(
            (await formations.contacts(author.accessToken, unconfirmed))
              .members,
            [],
          );
        },
      );
      await t.test(
        'final presented-token clock recheck after last authority wait protects private contacts',
        async () => {
          const expiring = await identity.login('expiring-contact');
          await grant(pool, expiring.accountId, spaceId, verified(region));
          const { id } = await publish();
          await formations.join(expiring.accessToken, id, join());
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE session_id=$1",
            [expiring.sessionId],
          );
          let calls = 0;
          authorization.afterResolve = async () => {
            if (++calls === 2) await sleep(300);
          };
          try {
            await assert.rejects(
              formations.contacts(expiring.accessToken, id),
              codeIs('ACCESS_TOKEN_EXPIRED'),
            );
          } finally {
            authorization.afterResolve = null;
          }
        },
      );
      await t.test(
        'token expiry while join waits for parent cannot commit a new seat',
        async () => {
          const expiring = await identity.login('expiring-join');
          await grant(pool, expiring.accountId, spaceId, verified(region));
          const { id } = await publish();
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE session_id=$1",
            [expiring.sessionId],
          );
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
            [id],
          );
          const pending = formations
            .join(expiring.accessToken, id, join())
            .then(
              () => null,
              (error) => error,
            );
          await sleep(300);
          await blocker.query('COMMIT');
          blocker.release();
          assert.ok(codeIs('ACCESS_TOKEN_EXPIRED')(await pending));
          assert.equal(await memberCount(id), 1);
        },
      );
      await t.test(
        'ordinary unavailable runtime gates are never opened by formation routes',
        async () => {
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          ordinary = module.createNestApplication({ logger: false });
          await ordinary.init();
          const closed = ordinary.get(FormationService);
          const { id } = await publish();
          await assert.rejects(
            closed.get(voter.accessToken, id),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            closed.contacts(author.accessToken, id),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            closed.join(voter.accessToken, id, join()),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'developer identity overlay resolves the actual visible membership and never bypasses contact membership',
        async () => {
          const { IdentityPrivacyService } =
            await import('../../src/identity-privacy/identity-privacy.service.js');
          const privacy = app!.get(IdentityPrivacyService);
          const developer = await identity.login(
            'synthetic-formation-developer',
          );
          await grant(pool, developer.accountId, spaceId, verified(region));
          await pool.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-fixture-only')",
            [randomUUID(), developer.accountId],
          );
          const { id } = await publish();
          await formations.join(voter.accessToken, id, join());
          const roster = await formations.get(developer.accessToken, id);
          const targets = roster.members.map((member) => ({
            kind: 'formation_member' as const,
            id: member.id,
          }));
          const requestId = randomUUID();
          const result = await privacy.view(
            developer.accessToken,
            { targets },
            requestId,
          );
          assert.equal(result.items[0]!.status, 'available');
          if (result.items[0]!.status === 'available') {
            assert.equal(result.items[0]!.authorMode, 'anonymous');
            assert.equal(result.items[0]!.identity.accountId, author.accountId);
          }
          assert.equal(result.items[1]!.status, 'available');
          if (result.items[1]!.status === 'available') {
            assert.equal(result.items[1]!.authorMode, 'named');
            assert.equal(result.items[1]!.identity.accountId, voter.accountId);
          }
          await assert.rejects(
            formations.contacts(developer.accessToken, id),
            codeIs('FORMATION_MEMBERSHIP_REQUIRED'),
          );
          const audits = (
            await pool.query(
              'SELECT target_kind,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE request_id=$1',
              [requestId],
            )
          ).rows;
          assert.equal(audits.length, 2);
          assert.ok(
            audits.every((entry) => entry.target_kind === 'formation_member'),
          );
          assert.ok(!JSON.stringify(audits).includes(author.accountId));
          assert.ok(!JSON.stringify(audits).includes('chosen'));
          await assert.rejects(
            privacy.view(other.accessToken, { targets }, randomUUID()),
            codeIs('AUTHORIZATION_REQUIRED'),
          );
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [developer.accountId, voter.accountId],
          );
          const blocked = await privacy.view(
            developer.accessToken,
            { targets: [targets[1]!] },
            randomUUID(),
          );
          assert.equal(blocked.items[0]!.status, 'unavailable');
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [developer.accountId],
          );
          const foreign = await publish();
          const foreignMember = (
            await formations.get(author.accessToken, foreign.id)
          ).members[0]!.id;
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [foreign.id],
          );
          const hidden = await privacy.view(
            developer.accessToken,
            { targets: [{ kind: 'formation_member', id: foreignMember }] },
            randomUUID(),
          );
          assert.equal(hidden.items[0]!.status, 'unavailable');
          const accountSelector = await privacy.view(
            developer.accessToken,
            { targets: [{ kind: 'formation_member', id: author.accountId }] },
            randomUUID(),
          );
          assert.equal(accountSelector.items[0]!.status, 'unavailable');
          await assert.rejects(
            privacy.view(
              developer.accessToken,
              { targets: [{ ...targets[0]!, postId: foreign.id }] } as never,
              randomUUID(),
            ),
          );
          await deletions.post(author.accessToken, id);
          assert.equal(
            (
              await privacy.view(
                developer.accessToken,
                { targets },
                randomUUID(),
              )
            ).items.every((item) => item.status === 'unavailable'),
            true,
          );
        },
      );
      await t.test(
        'revoked original session cannot recover or replay committed minimal membership',
        async () => {
          const { id } = await publish(),
            input = join();
          await formations.join(voter.accessToken, id, input);
          await identity.logout(voter.accessToken);
          // Start each rejecting operation only after assert.rejects attaches its handler.
          for (const operation of [
            () => formations.join(voter.accessToken, id, input),
            () => formations.receipt(voter.accessToken, input.clientRequestId),
            () => formations.own(voter.accessToken, id),
          ])
            await assert.rejects(operation, codeIs('SESSION_REVOKED'));
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
