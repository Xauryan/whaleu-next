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
import { DeletionService } from '../../src/community/deletion.service.js';
import { FeedService } from '../../src/community/feed.service.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublicationReceipt,
} from '../../src/community/contracts.js';
import { PollReadService } from '../../src/community/polls/poll-read.service.js';
import { PollVotingService } from '../../src/community/polls/poll-voting.service.js';
import { BallotRequestsRepository } from '../../src/community/polls/ballot-requests.repository.js';
import type {
  BallotReceipt,
  PollView,
} from '../../src/community/polls/contracts.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approvePoll,
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
function created<T extends PublicationReceipt | BallotReceipt>(
  receipt: T,
): Extract<T, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  return receipt as Extract<T, { outcome: 'created' }>;
}
function rejected(receipt: PublicationReceipt | BallotReceipt, code: string) {
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
function noPrivate(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'profileId',
        'sessionId',
        'studentNumber',
        'phone',
        'voters',
        'ballots',
        'creation_transaction',
      ].includes(key),
      key,
    );
    noPrivate(child);
  }
}

test(
  'real PostgreSQL C2A polls, immutable receipts, parent locking and independent voting policy',
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
        (await pool.query('SELECT * FROM whaleu_community.polls')).rowCount,
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
        reads = app.get(PollReadService),
        votes = app.get(PollVotingService),
        receipts = app.get(BallotRequestsRepository),
        deletions = app.get(DeletionService),
        feeds = app.get(FeedService);
      const author = await identity.login('author'),
        voter = await identity.login('voter'),
        other = await identity.login('other');
      const http = app.getHttpServer();
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
          category: 'discussion',
          text: `Synthetic poll ${randomUUID()}`,
          authorMode: 'anonymous',
          component: {
            kind: 'poll',
            question: '怎么选？',
            selectionMode: 'multiple',
            options: ['甲', '乙', '吃瓜🍉'],
          },
          ...extra,
        });
      const publish = async (
        extra: Partial<PublishPost> = {},
        actor = author,
      ) => {
        const intent = body(extra);
        await approvePoll(pool, actor.accountId, intent);
        const receipt = created(
          await publications.post(actor.accessToken, intent),
        );
        return {
          intent,
          receipt,
          poll: await reads.get(actor.accessToken, receipt.resourceId),
        };
      };
      // Synthetic historical import boundary: definitions and dated/raw options
      // are inserted atomically, never edited after publication.
      const historical = async (
        deadlineMs: number,
        question = 'Historical',
        labels = ['甲', '乙', '吃瓜🍉'],
      ) => {
        const intent = body({ component: { kind: 'none' } });
        await approve(pool, author.accountId, intent.text);
        const receipt = created(
          await publications.post(author.accessToken, intent),
        );
        const tx = await pool.connect();
        const id = randomUUID();
        try {
          await tx.query('BEGIN');
          await tx.query(
            "INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode,deadline) VALUES ($1,$2,$3,'multiple',clock_timestamp()+$4*interval '1 millisecond')",
            [id, receipt.resourceId, question, deadlineMs],
          );
          for (const [position, label] of labels.entries())
            await tx.query(
              'INSERT INTO whaleu_community.poll_options(id,poll_id,position,label) VALUES ($1,$2,$3,$4)',
              [randomUUID(), id, position, label],
            );
          await tx.query('COMMIT');
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        return {
          poll: await reads.get(author.accessToken, receipt.resourceId),
        };
      };
      const ballot = (poll: PollView, indices = [0]) => ({
        clientRequestId: randomUUID(),
        optionIds: indices.map((index) => poll.options[index]!.id),
      });
      await t.test(
        'poll publication deduplicates atomically with ordered option IDs, persona, and one post transition',
        async () => {
          const intent = body();
          await approvePoll(pool, author.accountId, intent);
          const results = await Promise.all(
            Array.from({ length: 5 }, () =>
              publications.post(author.accessToken, intent),
            ),
          );
          const receipt = created(results[0]!);
          for (const result of results) assert.deepEqual(result, receipt);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.polls WHERE post_id=$1',
                [receipt.resourceId],
              )
            ).rowCount,
            1,
          );
          const poll = await reads.get(author.accessToken, receipt.resourceId);
          assert.deepEqual(
            poll.options.map((o) => [o.position, o.label, o.count]),
            [
              [0, '甲', 0],
              [1, '乙', 0],
              [2, '吃瓜🍉', 0],
            ],
          );
          assert.equal(poll.deadline, null);
          assert.equal(poll.expired, false);
          assert.equal(poll.viewer.canVote, true);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.outbox WHERE resource_id=$1',
                [receipt.resourceId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.thread_personas WHERE post_id=$1',
                [receipt.resourceId],
              )
            ).rowCount,
            1,
          );
          const detail = await feeds.detail(
            author.accessToken,
            receipt.resourceId,
          );
          assert.deepEqual(detail.component, { kind: 'poll', poll });
          noPrivate(detail);
          const feed = await feeds.feed(null, { spaceId, limit: 10 });
          const summary = feed.items.find((p) => p.id === receipt.resourceId)!;
          assert.equal(summary.component.kind, 'poll');
          if (summary.component.kind === 'poll')
            assert.equal(
              summary.component.poll.viewer.reason,
              'AUTHENTICATION_REQUIRED',
            );
          await assert.rejects(
            publications.post(author.accessToken, {
              ...intent,
              component: {
                kind: 'poll',
                question: '改变',
                selectionMode: 'single',
                options: ['甲', '乙'],
              },
            }),
            codeIs('REQUEST_CONFLICT'),
          );
        },
      );
      await t.test(
        'text approval cannot authorize poll fields; hash binds question, ordered labels and publication behavior',
        async () => {
          const unapproved = body();
          await approve(pool, author.accountId, unapproved.text);
          rejected(
            await publications.post(author.accessToken, unapproved),
            'CONTENT_REJECTED',
          );
          for (const change of [
            {
              component: {
                kind: 'poll' as const,
                question: 'different',
                selectionMode: 'multiple' as const,
                options: ['甲', '乙', '吃瓜🍉'],
              },
            },
            {
              component: {
                kind: 'poll' as const,
                question: '怎么选？',
                selectionMode: 'multiple' as const,
                options: ['乙', '甲', '吃瓜🍉'],
              },
            },
            { authorMode: 'named' as const },
            { spaceId: globalId },
          ]) {
            const intent = body();
            await approvePoll(pool, author.accountId, intent);
            const altered = { ...intent, ...change };
            rejected(
              await publications.post(author.accessToken, altered),
              'CONTENT_REJECTED',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.posts WHERE text=$1',
                  [intent.text],
                )
              ).rowCount,
              0,
            );
          }
          const transient = body();
          content.unavailable = true;
          await assert.rejects(
            publications.post(author.accessToken, transient),
            codeIs('CONTENT_REVIEW_UNAVAILABLE'),
          );
          content.unavailable = false;
          await assert.rejects(
            app!
              .get(PublicationRepository)
              .receipt(author.accessToken, transient.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await approvePoll(pool, author.accountId, transient);
          created(await publications.post(author.accessToken, transient));
        },
      );
      await t.test(
        'post/poll commit failure rolls back publication, options, persona, receipt and outbox together',
        async () => {
          const intent = body();
          await approvePoll(pool, author.accountId, intent);
          const before = (
            await pool.query('SELECT * FROM whaleu_community.poll_options')
          ).rowCount;
          await pool.query(
            "CREATE FUNCTION whaleu_community_test.fail_poll_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic poll commit failure'; END $$; CREATE CONSTRAINT TRIGGER synthetic_poll_commit_failure AFTER INSERT ON whaleu_community.polls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_poll_commit()",
          );
          try {
            await assert.rejects(publications.post(author.accessToken, intent));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_poll_commit_failure ON whaleu_community.polls',
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
                'SELECT * FROM whaleu_community.posts WHERE text=$1',
                [intent.text],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.poll_options'))
              .rowCount,
            before,
          );
          created(await publications.post(author.accessToken, intent));
        },
      );
      await t.test(
        'phone failure is durable for that key but does not create a ballot; fresh permitted intent can succeed',
        async () => {
          const { poll } = await publish();
          const intent = ballot(poll);
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          rejected(
            await votes.cast(voter.accessToken, poll.postId, intent),
            'PHONE_VERIFICATION_REQUIRED',
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
          rejected(
            await votes.cast(voter.accessToken, poll.postId, intent),
            'PHONE_VERIFICATION_REQUIRED',
          );
          created(
            await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
          );
        },
      );
      await t.test(
        'receipt-not-found during an in-flight transaction is not proof of noncommit',
        async () => {
          const { poll } = await publish();
          const intent = ballot(poll);
          const reached = deferred(),
            resume = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            reached.resolve();
            await resume.promise;
          };
          const pending = votes.cast(voter.accessToken, poll.postId, intent);
          await reached.promise;
          try {
            await assert.rejects(
              receipts.receipt(voter.accessToken, intent.clientRequestId),
              codeIs('REQUEST_NOT_FOUND'),
            );
          } finally {
            resume.resolve();
          }
          const result = created(await pending);
          assert.deepEqual(
            await receipts.receipt(voter.accessToken, intent.clientRequestId),
            result,
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [poll.postId],
          );
          assert.deepEqual(
            await receipts.receipt(voter.accessToken, intent.clientRequestId),
            result,
          );
          assert.equal(
            (await reads.own(voter.accessToken, poll.postId)).ballotId,
            result.resourceId,
          );
          await assert.rejects(
            reads.get(voter.accessToken, poll.postId),
            codeIs('POST_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'author can vote; phone-verified student-unverified voter needs no identity campus or publish privilege; counts separate 2 voters from 5 selections',
        async () => {
          const { poll } = await publish();
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
            restrictedActions: ['publish_post', 'publish_comment'],
          });
          created(
            await votes.cast(
              author.accessToken,
              poll.postId,
              ballot(poll, [0, 1, 2]),
            ),
          );
          created(
            await votes.cast(
              voter.accessToken,
              poll.postId,
              ballot(poll, [0, 2]),
            ),
          );
          const result = await reads.get(voter.accessToken, poll.postId);
          assert.equal(result.voterCount, 2);
          assert.equal(result.selectionCount, 5);
          assert.deepEqual(
            result.options.map((o) => o.count),
            [2, 1, 2],
          );
          assert.equal(result.viewer.hasVoted, true);
          assert.equal(result.viewer.canVote, false);
          assert.equal(result.viewer.reason, 'POLL_ALREADY_VOTED');
          assert.deepEqual(
            new Set(result.viewer.selectedOptionIds),
            new Set([poll.options[0]!.id, poll.options[2]!.id]),
          );
          const observer = await reads.get(other.accessToken, poll.postId);
          assert.equal(observer.voterCount, 2);
          assert.deepEqual(observer.viewer.selectedOptionIds, []);
          assert.equal(observer.viewer.canVote, true);
          noPrivate(result);
          noPrivate(observer);
          await grant(pool, voter.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'single choice, cross-poll IDs and strict HTTP requests reject without coercion or actor override',
        async () => {
          const { poll } = await publish({
            component: {
              kind: 'poll',
              question: 'single',
              selectionMode: 'single',
              options: ['one', 'two'],
            },
          });
          rejected(
            await votes.cast(
              voter.accessToken,
              poll.postId,
              ballot(poll, [0, 1]),
            ),
            'POLL_OPTIONS_INVALID',
          );
          rejected(
            await votes.cast(voter.accessToken, poll.postId, {
              clientRequestId: randomUUID(),
              optionIds: [randomUUID()],
            }),
            'POLL_OPTIONS_INVALID',
          );
          const foreign = await publish();
          rejected(
            await votes.cast(
              voter.accessToken,
              poll.postId,
              ballot(foreign.poll),
            ),
            'POLL_OPTIONS_INVALID',
          );
          for (const path of [
            `/v1/community/posts/${poll.postId}/poll`,
            `/v1/me/community/poll-ballots/${poll.postId}`,
            `/v1/me/community/poll-requests/${randomUUID()}`,
          ])
            await request(http)
              .get(`${path}?accountId=${author.accountId}`)
              .set('Authorization', `Bearer ${voter.accessToken}`)
              .expect(400);
          await request(http)
            .post(
              `/v1/community/posts/${poll.postId}/poll/ballots?accountId=${author.accountId}`,
            )
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .send(ballot(poll))
            .expect(400);
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_community.poll_ballot_requests',
            )
          ).rowCount;
          for (const change of [
            { optionIds: [] },
            { optionIds: [1] },
            { optionIds: [poll.options[0]!.id, poll.options[0]!.id] },
            { accountId: author.accountId },
            { optionIds: ['1'] },
            { clientRequestId: 'bad' },
          ])
            await request(http)
              .post(`/v1/community/posts/${poll.postId}/poll/ballots`)
              .set('Authorization', `Bearer ${voter.accessToken}`)
              .send({ ...ballot(poll), ...change })
              .expect(400);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballot_requests',
              )
            ).rowCount,
            before,
          );
          const intent = ballot(poll);
          const response = await request(http)
            .post(`/v1/community/posts/${poll.postId}/poll/ballots`)
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .send(intent)
            .expect(201);
          created(response.body);
          noPrivate(response.body);
          await request(http)
            .get(`/v1/me/community/poll-requests/${intent.clientRequestId}`)
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .expect(200)
            .expect(({ body }) => assert.deepEqual(body, response.body));
          await request(http)
            .get(`/v1/community/posts/${poll.postId}/poll`)
            .expect(401);
          await request(http)
            .get(`/v1/community/posts/${poll.postId}/poll/voters`)
            .set('Authorization', `Bearer ${author.accessToken}`)
            .expect(404);
        },
      );
      await t.test(
        'simultaneous equal keys canonicalize option set; different keys cannot replace a ballot; account and publication namespaces isolate',
        async () => {
          const { poll, intent: postIntent } = await publish();
          const intent = ballot(poll, [2, 0]);
          const results = await Promise.all(
            Array.from({ length: 6 }, (_, i) =>
              votes.cast(voter.accessToken, poll.postId, {
                ...intent,
                optionIds:
                  i % 2 ? [...intent.optionIds].reverse() : intent.optionIds,
              }),
            ),
          );
          const original = created(results[0]!);
          for (const result of results) assert.deepEqual(result, original);
          await assert.rejects(
            votes.cast(voter.accessToken, poll.postId, {
              ...intent,
              optionIds: [poll.options[1]!.id],
            }),
            codeIs('REQUEST_CONFLICT'),
          );
          for (const result of await Promise.all([
            votes.cast(voter.accessToken, poll.postId, ballot(poll, [1])),
            votes.cast(voter.accessToken, poll.postId, ballot(poll, [2])),
          ]))
            rejected(result, 'POLL_ALREADY_VOTED');
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballots WHERE poll_id=$1 AND account_id=$2',
                [poll.id, voter.accountId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='poll_ballot_cast'",
                [original.resourceId],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            receipts.receipt(other.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          created(await votes.cast(other.accessToken, poll.postId, intent));
          // A UUID already used by publication may independently identify a ballot request.
          created(
            await votes.cast(author.accessToken, poll.postId, {
              ...ballot(poll),
              clientRequestId: postIntent.clientRequestId,
            }),
          );
        },
      );
      await t.test(
        'new-key concurrent ballots converge on exactly one success',
        async () => {
          const { poll } = await publish();
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
              votes.cast(voter.accessToken, poll.postId, ballot(poll, [i % 3])),
            ),
          );
          assert.equal(
            results.filter((r) => r.outcome === 'created').length,
            1,
          );
          assert.equal(
            results.filter(
              (r) =>
                r.outcome === 'rejected' && r.code === 'POLL_ALREADY_VOTED',
            ).length,
            7,
          );
        },
      );
      await t.test(
        'durable minimal receipt and own-status survive permissions, expiry and deleted parent; recovery never leaks content or resets vote',
        async () => {
          const { poll } = await historical(2000);
          const intent = ballot(poll, [0, 2]);
          const original = created(
            await votes.cast(voter.accessToken, poll.postId, intent),
          );
          await deletions.post(author.accessToken, poll.postId);
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
            restrictedActions: ['vote'],
          });
          await pool.query(
            'SELECT pg_sleep(greatest(0,extract(epoch FROM deadline-clock_timestamp()))+0.01) FROM whaleu_community.polls WHERE id=$1',
            [poll.id],
          );
          assert.deepEqual(
            await votes.cast(voter.accessToken, poll.postId, intent),
            original,
          );
          assert.deepEqual(
            await receipts.receipt(voter.accessToken, intent.clientRequestId),
            original,
          );
          const own = await reads.own(voter.accessToken, poll.postId);
          assert.deepEqual(own, {
            postId: poll.postId,
            ballotId: original.resourceId,
            createdAt: original.createdAt,
            selectedOptionIds: [...intent.optionIds].sort(),
          });
          noPrivate(own);
          await request(http)
            .get(`/v1/me/community/poll-ballots/${poll.postId}`)
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .expect(200)
            .expect(({ body }) => assert.deepEqual(body, own));
          await assert.rejects(
            reads.get(voter.accessToken, poll.postId),
            codeIs('POST_NOT_FOUND'),
          );
          await assert.rejects(
            reads.own(other.accessToken, poll.postId),
            codeIs('BALLOT_NOT_FOUND'),
          );
          rejected(
            await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
            'POST_NOT_FOUND',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballots WHERE poll_id=$1',
                [poll.id],
              )
            ).rowCount,
            1,
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'historical raw text above new-write limits stays verbatim and dated/null polls expire correctly',
        async () => {
          const question = '历史🐳'.repeat(200);
          const label = '历史选项'.repeat(100);
          const imported = await historical(-1, question, [
            label,
            '乙',
            '吃瓜🍉',
          ]);
          const poll = await reads.get(voter.accessToken, imported.poll.postId);
          assert.equal(poll.options[0]?.label, label);
          assert.equal(poll.question, question);
          assert.equal(poll.expired, true);
          assert.equal(poll.viewer.reason, 'POLL_EXPIRED');
          rejected(
            await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
            'POLL_EXPIRED',
          );
          const future = await historical(86400000);
          assert.equal(
            (await reads.get(voter.accessToken, future.poll.postId)).expired,
            false,
          );
          created(
            await votes.cast(
              voter.accessToken,
              future.poll.postId,
              ballot(future.poll),
            ),
          );
        },
      );
      await t.test(
        'vote waiting on parent lock reevaluates database expiry after all locks, not request-start time',
        async () => {
          const { poll } = await historical(2000);
          const holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [poll.postId],
            );

            const intent = ballot(poll);
            const pending = votes.cast(voter.accessToken, poll.postId, intent);
            const holderPid = (
              await holder.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            let queued = false;
            const waitUntil = Date.now() + 1500;
            while (!queued && Date.now() < waitUntil) {
              queued = (
                await pool.query<{ queued: boolean }>(
                  'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS queued',
                  [holderPid],
                )
              ).rows[0]!.queued;
              if (!queued)
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(
              queued,
              true,
              'Vote must be queued on held parent before deadline',
            );
            assert.equal(
              (
                await holder.query<{ before: boolean }>(
                  'SELECT clock_timestamp()<deadline AS before FROM whaleu_community.polls WHERE id=$1',
                  [poll.id],
                )
              ).rows[0]!.before,
              true,
            );
            await holder.query(
              'SELECT pg_sleep(greatest(0,extract(epoch FROM deadline-clock_timestamp()))+0.01) FROM whaleu_community.polls WHERE id=$1',
              [poll.id],
            );
            await holder.query('COMMIT');
            rejected(await pending, 'POLL_EXPIRED');
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.poll_ballots WHERE poll_id=$1',
                  [poll.id],
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
        'hidden/deleted parent, inactive scope and blocks prevent new ballots; named/anonymous projection stays private',
        async () => {
          for (const mode of ['named', 'anonymous'] as const) {
            const { poll } = await publish({ authorMode: mode });
            await pool.query(
              'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
              [voter.accountId, author.accountId],
            );
            if (mode === 'named')
              rejected(
                await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
                'POST_NOT_FOUND',
              );
            else {
              const read = await reads.get(voter.accessToken, poll.postId);
              noPrivate(read);
              created(
                await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
              );
            }
            await pool.query('DELETE FROM whaleu_community_test.blocks');
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [poll.postId],
            );
            rejected(
              await votes.cast(other.accessToken, poll.postId, ballot(poll)),
              'POST_NOT_FOUND',
            );
            await assert.rejects(
              reads.get(other.accessToken, poll.postId),
              codeIs('POST_NOT_FOUND'),
            );
          }
          const { poll } = await publish();
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          rejected(
            await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
            'POST_NOT_FOUND',
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );
      await t.test(
        'delete winning parent lock rejects queued ballot; vote winning blocks delete until atomic commit',
        async () => {
          const deleted = await publish();
          const holder = await pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [deleted.poll.postId],
            );
            const pending = votes.cast(
              voter.accessToken,
              deleted.poll.postId,
              ballot(deleted.poll),
            );
            await holder.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [deleted.poll.postId],
            );
            await holder.query('COMMIT');
            rejected(await pending, 'POST_NOT_FOUND');
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
          const { poll } = await publish();
          const reached = deferred(),
            resume = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            reached.resolve();
            await resume.promise;
          };
          const pending = votes.cast(
            voter.accessToken,
            poll.postId,
            ballot(poll),
          );
          await reached.promise;
          const contender = await pool.connect();
          try {
            await contender.query('BEGIN');
            await contender.query("SET LOCAL lock_timeout='60ms'");
            await assert.rejects(
              contender.query(
                'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
                [poll.postId],
              ),
              sqlCode('55P03'),
            );
          } finally {
            await contender.query('ROLLBACK');
            contender.release();
            resume.resolve();
          }
          created(await pending);
          await deletions.post(author.accessToken, poll.postId);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballots WHERE poll_id=$1',
                [poll.id],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'restriction races recheck current vote action; locks serialize scope, authority, session and block insertion',
        async () => {
          const { poll } = await publish({ authorMode: 'named' });
          const reached = deferred(),
            resume = deferred();
          authorization.beforeResolve = async () => {
            authorization.beforeResolve = null;
            reached.resolve();
            await resume.promise;
          };
          const pending = votes.cast(
            voter.accessToken,
            poll.postId,
            ballot(poll),
          );
          await reached.promise;
          await grant(pool, voter.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['vote'],
          });
          resume.resolve();
          rejected(await pending, 'COMMUNITY_ACTION_RESTRICTED');
          await grant(pool, voter.accountId, spaceId, verified(region));
          const held = deferred(),
            finish = deferred();
          authorization.afterResolve = async () => {
            authorization.afterResolve = null;
            held.resolve();
            await finish.promise;
          };
          const writing = votes.cast(
            voter.accessToken,
            poll.postId,
            ballot(poll),
          );
          await held.promise;
          const contender = await pool.connect();
          try {
            for (const [sql, values] of [
              [
                'UPDATE whaleu_community_test.grants SET authority=$3 WHERE account_id=$1 AND space_id=$2',
                [
                  voter.accountId,
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
                [voter.sessionId],
              ],
              [
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [voter.accountId],
              ],
              [
                'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
                [voter.accountId, author.accountId],
              ],
            ] as const) {
              await contender.query('BEGIN');
              await contender.query("SET LOCAL lock_timeout='60ms'");
              await assert.rejects(
                contender.query(sql, [...values]),
                sqlCode('55P03'),
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
        'global polls and explicit unverified regional publication inherit C1 while voting is independent',
        async () => {
          const global = await publish({
            spaceId: globalId,
            authorMode: 'named',
          });
          created(
            await votes.cast(
              voter.accessToken,
              global.poll.postId,
              ballot(global.poll),
            ),
          );
          await grant(pool, other.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
            unverifiedCategories: ['discussion'],
          });
          const local = await publish({ authorMode: 'named' }, other);
          created(
            await votes.cast(
              other.accessToken,
              local.poll.postId,
              ballot(local.poll),
            ),
          );
          const denied = body({ authorMode: 'anonymous' });
          await approvePoll(pool, other.accountId, denied);
          rejected(
            await publications.post(other.accessToken, denied),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          await grant(pool, other.accountId, spaceId, verified(region));
        },
      );
      await t.test(
        'real commit failure rolls back ballot/selections/receipt/outbox; successful retry remains exactly once',
        async () => {
          const { poll } = await publish();
          const intent = ballot(poll, [0, 1]);
          await pool.query(
            "CREATE FUNCTION whaleu_community_test.fail_ballot_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic commit failure'; END $$; CREATE CONSTRAINT TRIGGER synthetic_ballot_commit_failure AFTER INSERT ON whaleu_community.poll_ballots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_ballot_commit()",
          );
          try {
            await assert.rejects(
              votes.cast(voter.accessToken, poll.postId, intent),
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_ballot_commit_failure ON whaleu_community.poll_ballots',
            );
          }
          await assert.rejects(
            receipts.receipt(voter.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_selections WHERE poll_id=$1',
                [poll.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballots WHERE poll_id=$1',
                [poll.id],
              )
            ).rowCount,
            0,
          );
          const result = created(
            await votes.cast(voter.accessToken, poll.postId, intent),
          );
          assert.deepEqual(
            await votes.cast(voter.accessToken, poll.postId, intent),
            result,
          );
        },
      );
      await t.test(
        'database enforces one ballot, same-poll option membership, complete selections and immutable committed choices',
        async () => {
          const { poll } = await publish();
          const first = created(
            await votes.cast(voter.accessToken, poll.postId, ballot(poll)),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.polls SET selection_mode='single' WHERE id=$1",
              [poll.id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query('DELETE FROM whaleu_community.polls WHERE id=$1', [
              poll.id,
            ]),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.poll_ballot_requests SET receipt=receipt WHERE account_id=$1 AND client_request_id=$2',
              [voter.accountId, first.requestId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.poll_ballot_requests(account_id,client_request_id,payload_hash) VALUES ($1,$2,$3)',
              [voter.accountId, randomUUID(), 'a'.repeat(64)],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.poll_ballots SET account_id=$2 WHERE id=$1',
              [first.resourceId, other.accountId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_community.poll_selections WHERE ballot_id=$1',
              [first.resourceId],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.poll_selections(ballot_id,poll_id,option_id) VALUES ($1,$2,$3)',
              [first.resourceId, poll.id, poll.options[1]!.id],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.poll_options SET label=$2 WHERE id=$1',
              [poll.options[0]!.id, 'changed'],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.poll_ballots(id,poll_id,account_id) VALUES ($1,$2,$3)',
              [randomUUID(), poll.id, voter.accountId],
            ),
            sqlCode('23505'),
          );
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.poll_ballots(id,poll_id,account_id) VALUES ($1,$2,$3)',
              [randomUUID(), poll.id, other.accountId],
            ),
            sqlCode('23514'),
          );
          const foreign = await publish();
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            const id = randomUUID();
            await tx.query(
              'INSERT INTO whaleu_community.poll_ballots(id,poll_id,account_id) VALUES ($1,$2,$3)',
              [id, poll.id, other.accountId],
            );
            await assert.rejects(
              tx.query(
                'INSERT INTO whaleu_community.poll_selections(ballot_id,poll_id,option_id) VALUES ($1,$2,$3)',
                [id, poll.id, foreign.poll.options[0]!.id],
              ),
              sqlCode('23503'),
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'ordinary unavailable adapters do not enable live voting; unavailable decisions never become durable terminal receipts',
        async () => {
          const { poll } = await publish();
          const ordinaryModule = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          })
            .overrideProvider(IDENTITY_PROVIDER)
            .useValue(provider)
            .compile();
          ordinary = ordinaryModule.createNestApplication({ logger: false });
          configureHttp(ordinary);
          await ordinary.init();
          const intent = ballot(poll);
          await request(ordinary.getHttpServer())
            .post(`/v1/community/posts/${poll.postId}/poll/ballots`)
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .send(intent)
            .expect(503);
          await assert.rejects(
            receipts.receipt(voter.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1 AND space_id=$2',
            [voter.accountId, spaceId],
          );
          await assert.rejects(
            votes.cast(voter.accessToken, poll.postId, intent),
            codeIs('COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            receipts.receipt(voter.accessToken, intent.clientRequestId),
            codeIs('REQUEST_NOT_FOUND'),
          );
          await grant(pool, voter.accountId, spaceId, verified(region));
          created(await votes.cast(voter.accessToken, poll.postId, intent));
        },
      );
      await t.test(
        'active original account is rechecked before even successful receipt/status replay',
        async () => {
          const { poll } = await publish();
          const intent = ballot(poll);
          created(await votes.cast(voter.accessToken, poll.postId, intent));
          await identity.logout(voter.accessToken);
          for (const operation of [
            () => votes.cast(voter.accessToken, poll.postId, intent),
            () => receipts.receipt(voter.accessToken, intent.clientRequestId),
            () => reads.own(voter.accessToken, poll.postId),
          ])
            await assert.rejects(operation(), codeIs('SESSION_REVOKED'));
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.accountId],
          );
          await assert.rejects(
            reads.get(author.accessToken, poll.postId),
            codeIs('ACCOUNT_BLOCKED'),
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
