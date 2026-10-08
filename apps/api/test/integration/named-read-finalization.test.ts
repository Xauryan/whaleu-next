import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
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
import { configureHttp } from '../../src/http/http.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { FeedService } from '../../src/community/feed.service.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import type {
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import { hashToken } from '../../src/identity/tokens.js';
import {
  createRuntimeActor,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  syntheticAssertion,
  setSyntheticSnapshot,
} from '../support/verification-fixtures.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

type Result = Pick<Response, 'status' | 'body'>;
type Actor = Awaited<ReturnType<typeof createRuntimeActor>> & {
  profileId: string;
  nickname: string;
};
interface ReadCase {
  owner: string;
  actor: Actor;
  target: Actor;
  bilateral: boolean;
  run: () => Promise<Result>;
  expect: readonly string[];
  identity?: boolean;
}
const scalar = 'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks';
const finalRows = 'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';
const fence = 'LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT';
const serialized = (value: unknown) => JSON.stringify(value);
function success(result: Result, expected: readonly string[]) {
  assert.equal(result.status, 200, serialized(result.body));
  const body = serialized(result.body);
  for (const value of expected)
    assert.ok(
      body.includes(value),
      `Missing protected baseline ${value}: ${body}`,
    );
}
function unavailable(result: Result) {
  assert.equal(result.status, 503, serialized(result.body));
  assert.ok(
    ['COMMUNITY_UNAVAILABLE', 'SAFETY_UNAVAILABLE'].includes(
      result.body.error.code,
    ),
  );
  assert.deepEqual(Object.keys(result.body), ['error']);
  for (const key of [
    'items',
    'contacts',
    'accountId',
    'nickname',
    'studentNumber',
    'displayName',
    'reportCapability',
    'experienceDisplay',
  ])
    assert.equal(serialized(result.body).includes(`"${key}"`), false);
}
async function waitForWriter(pool: Pool, pid: number) {
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    const row = (
      await pool.query<{ blocked: boolean }>(
        "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$1",
        [pid],
      )
    ).rows[0];
    if (row?.blocked) return;
    await sleep(5);
  }
  assert.fail('Expected the raw block writer to wait on the held final fence');
}

// Ordinary AppModule, real canonical owner records, real SQL results. The only
// instrumentation is an after-query barrier. Raw block transitions retain the
// actual revision/event/deferred integrity rules and bypass only the API gate.
test(
  'named emitted-read owners finalize allowed relationships on real PostgreSQL',
  { timeout: 300000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Set TEST_DATABASE_URL to disposable loopback whaleu_test; no skips',
    );
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let owns = false,
      locked = false;
    let observer: ReturnType<typeof observeExactQueries> | undefined;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run integration suites serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refusing existing WhaleU schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer(),
        scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      let actorNumber = 0;
      const makeActor = async (): Promise<Actor> => {
        const actor = await createRuntimeActor(app!),
          nickname = `NamedProof${++actorNumber}`;
        const affiliation = syntheticAssertion(
          actor.accountId,
          scope.institutionId,
          'affiliation',
          { origin_region_id: scope.home.regionId },
        );
        const snapshot = await setSyntheticSnapshot(pool, actor.accountId, [
          affiliation,
          syntheticAssertion(actor.accountId, scope.institutionId, 'phone'),
          syntheticAssertion(
            actor.accountId,
            scope.institutionId,
            'student_number',
          ),
        ]);
        await appendIdentitySelection(
          pool,
          actor.accountId,
          {
            assertionId: affiliation.id,
            snapshotId: snapshot.snapshotId,
            institutionId: scope.institutionId,
            originRegionId: scope.home.regionId,
            validUntil: affiliation.expires_at!.getTime(),
          },
          scope,
        );
        const changed = await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ expectedRevision: 0, nickname, bio: '' });
        assert.equal(changed.status, 200, serialized(changed.body));
        // Distinctive, genuinely owned cosmetics must not escape any of the
        // existing raw INSERT/reactivation/final-wait relationship races below.
        const selected = await request(http)
          .put('/v1/me/experience/appearance')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({
            requestId: randomUUID(),
            expectedRevision: '0',
            titleKey: 'default_jingxiaoyu',
            colorId: 7,
          });
        assert.equal(selected.status, 200, serialized(selected.body));
        assert.equal(selected.body.outcome, 'applied');
        const reference = await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', `Bearer ${actor.accessToken}`);
        assert.equal(reference.status, 200);
        return {
          ...actor,
          nickname,
          profileId: reference.body.profileId as string,
        };
      };
      const get = (actor: Actor, path: string) => async (): Promise<Result> =>
        request(http)
          .get(path)
          .set('Authorization', `Bearer ${actor.accessToken}`);
      const post =
        (actor: Actor, path: string, body: object) =>
        async (): Promise<Result> =>
          request(http)
            .post(path)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(body);
      const publish = async (
        actor: Actor,
        extra: Partial<PublishPost> = {},
      ) => {
        const body: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text: 'Protected parent body',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
          ...extra,
        };
        await approveEnvelope(
          pool,
          await postApprovalEnvelope(app!, pool, actor.accountId, body),
        );
        const result = await post(actor, '/v1/community/posts', body)();
        assert.equal(result.status, 201, serialized(result.body));
        assert.equal(result.body.outcome, 'created', serialized(result.body));
        return {
          id: result.body.resourceId as string,
          body,
          receipt: result.body,
        };
      };
      const comment = async (
        actor: Actor,
        postId: string,
        text = 'Protected root body',
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const body: PublishComment = {
          clientRequestId: randomUUID(),
          text,
          imageAssetIds: [],
          authorMode,
        };
        await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.accountId,
            postId,
            body,
          ),
        );
        const result = await post(
          actor,
          `/v1/community/posts/${postId}/comments`,
          body,
        )();
        assert.equal(result.status, 201, serialized(result.body));
        assert.equal(result.body.outcome, 'created', serialized(result.body));
        return {
          id: result.body.resourceId as string,
          body,
          receipt: result.body,
        };
      };
      const reply = async (
        actor: Actor,
        postId: string,
        rootId: string,
        targetReplyId: string | null = null,
      ) => {
        const body: PublishReply = {
          clientRequestId: randomUUID(),
          text: 'Protected reply body',
          imageAssetIds: [],
          authorMode: 'named',
          targetReplyId,
        };
        await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.accountId,
            postId,
            body,
            rootId,
          ),
        );
        const result = await post(
          actor,
          `/v1/community/comments/${rootId}/replies`,
          body,
        )();
        assert.equal(result.status, 201, serialized(result.body));
        assert.equal(result.body.outcome, 'created', serialized(result.body));
        return {
          id: result.body.resourceId as string,
          body,
          receipt: result.body,
        };
      };
      const author = await makeActor(),
        child = await makeActor(),
        targetAuthor = await makeActor();
      const parent = await publish(author),
        root = await comment(child, parent.id);
      const targetReply = await reply(targetAuthor, parent.id, root.id);
      const leaf = await reply(child, parent.id, root.id, targetReply.id);
      const chosen = {
        wechat: 'protected-wechat',
        qq: 'protected-qq',
        phone: 'protected-phone',
      };
      const tradingInput: PublishPost['trading'] = {
        subtype: 'shuma',
        price: '12.5',
        urgency: 'normal',
        location: 'Synthetic location',
        contacts: chosen,
      };
      const trading = await publish(author, {
        category: 'trading',
        text: 'Protected trading body',
        trading: tradingInput,
      });
      const poll = await publish(author, {
        component: {
          kind: 'poll',
          question: 'Protected poll question',
          selectionMode: 'single',
          options: ['First', 'Second'],
        },
      });
      const formation = await publish(author, {
        component: {
          kind: 'formation',
          capacity: 20,
          theme: '隐私组局',
          contacts: chosen,
          contactSharing: 'members_v1',
        },
      });
      const join = async (actor: Actor, postId = formation.id) => {
        const body = {
          clientRequestId: randomUUID(),
          contacts: chosen,
          contactSharing: 'members_v1',
        };
        const result = await post(
          actor,
          `/v1/community/posts/${postId}/formation/memberships`,
          body,
        )();
        assert.equal(result.status, 201, serialized(result.body));
        assert.equal(result.body.outcome, 'created', serialized(result.body));
        return {
          id: result.body.resourceId as string,
          body,
          receipt: result.body,
        };
      };
      await join(child);
      const save = async (actor: Actor, postId = parent.id) => {
        const body = { clientRequestId: randomUUID() };
        const result = await request(http)
          .put(`/v1/community/posts/${postId}/save`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(body);
        assert.equal(result.status, 200, serialized(result.body));
        assert.equal(result.body.outcome, 'applied', serialized(result.body));
        return { body, receipt: result.body };
      };
      const developer = async (actor: Actor) =>
        pool.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-named-proof')",
          [randomUUID(), actor.accountId],
        );
      const notice = async (actor: Actor) => {
        // A genuine current save precedes its canonical published root event.
        await save(actor);
        const fresh = await comment(
          child,
          parent.id,
          'Protected notice preview',
        );
        const eventId = (
          await pool.query<{ id: string }>(
            'SELECT id FROM whaleu_community.outbox WHERE event_key=$1',
            [`comment:${fresh.id}:created`],
          )
        ).rows[0]!.id;
        await inTransaction(pool, async (tx) => {
          const event = await app!
            .get(CommunityUpdatesFacade)
            .event(eventId, tx);
          assert.equal(event.status, 'ready');
          if (event.status !== 'ready')
            assert.fail('Canonical fixture event unavailable');
          const recipient = event.event.recipients.find(
            (r) => r.accountId === actor.accountId,
          );
          assert.ok(
            recipient,
            'Recipient must come from real historical event eligibility',
          );
          const repository = app!.get(NotificationsRepository);
          await repository.owner(actor.accountId, tx, true);
          await repository.materialize(event.event, recipient, tx);
          await repository.settleEvent(eventId, 'processed', null, tx);
        });
        return (
          await pool.query<{ id: string }>(
            'SELECT id FROM whaleu_notifications.notices WHERE event_id=$1 AND recipient_account_id=$2',
            [eventId, actor.accountId],
          )
        ).rows[0]!.id;
      };
      const auditCount = async (actor: Actor) =>
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND outcome='disclosed'",
            [actor.accountId],
          )
        ).rows[0]!.n;
      const writeBlock = async (
        blocker: Actor,
        blocked: Actor,
        active: boolean,
        id?: string,
        retained?: PoolClient,
      ) => {
        const client = retained ?? (await pool.connect()),
          relation = id ?? randomUUID();
        try {
          if (!retained) await client.query('BEGIN');
          if (id)
            await client.query(
              'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
              [id, active],
            );
          else
            await client.query(
              "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,$4,1,'Synthetic','profile',$5)",
              [
                relation,
                blocker.accountId,
                blocked.accountId,
                active,
                blocked.profileId,
              ],
            );
          await client.query(
            'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
            [randomUUID(), active ? 'blocked' : 'unblocked', relation],
          );
          if (!retained) await client.query('COMMIT');
          return relation;
        } catch (error) {
          if (!retained) await client.query('ROLLBACK');
          throw error;
        } finally {
          if (!retained) client.release();
        }
      };
      observer = observeExactQueries(app);
      const makeCase = async (
        owner: string,
        actor: Actor,
      ): Promise<ReadCase> => {
        const base = { owner, actor, target: author, bilateral: true };
        switch (owner) {
          case 'FeedService.feed':
            return {
              ...base,
              bilateral: false,
              run: get(
                actor,
                `/v1/community/posts?spaceId=${scope.home.spaceId}&category=trading`,
              ),
              expect: [trading.body.text, author.nickname],
            };
          case 'FeedService.detail':
            return {
              ...base,
              run: get(actor, `/v1/community/posts/${parent.id}`),
              expect: [parent.body.text, author.nickname, 'discussionCount'],
            };
          case 'FeedService.commentCapabilities':
            return {
              ...base,
              run: get(
                actor,
                `/v1/community/posts/${parent.id}/comment-capabilities`,
              ),
              expect: ['authorModes', '"named"', 'lastAuthorMode'],
            };
          case 'FeedService.comments':
            return {
              ...base,
              run: async () => {
                try {
                  return {
                    status: 200,
                    body: await app!
                      .get(FeedService)
                      .comments(actor.accessToken, parent.id, { limit: 10 }),
                  };
                } catch (error) {
                  if (!(error instanceof ApplicationError)) throw error;
                  return { status: 503, body: { error: { code: error.code } } };
                }
              },
              expect: [root.body.text, child.nickname],
            };
          case 'FeedService.ownTrading': {
            const own = await publish(actor, {
              category: 'trading',
              trading: tradingInput,
            });
            await comment(child, own.id);
            return {
              ...base,
              target: child,
              bilateral: false,
              run: get(actor, '/v1/me/community/trading'),
              expect: [own.id, '"commentCount":1', '"isSelf":true'],
            };
          }
          case 'DiscussionReadService.comments':
            return {
              ...base,
              run: get(actor, `/v1/community/posts/${parent.id}/comments`),
              expect: [root.body.text, child.nickname, 'replyPreview'],
            };
          case 'DiscussionReadService.comment':
            return {
              ...base,
              run: get(actor, `/v1/community/comments/${root.id}`),
              expect: [root.body.text, child.nickname, '"replyCount":2'],
            };
          case 'DiscussionReadService.reply':
            return {
              ...base,
              run: get(actor, `/v1/community/replies/${leaf.id}`),
              expect: [leaf.body.text, targetAuthor.nickname, targetReply.id],
            };
          case 'DiscussionReadService.replies':
            return {
              ...base,
              run: get(actor, `/v1/community/comments/${root.id}/replies`),
              expect: [leaf.id, targetReply.id, targetAuthor.nickname],
            };
          case 'DiscussionReadService.context':
            return {
              ...base,
              run: get(
                actor,
                `/v1/community/posts/${parent.id}/discussion-context?replyId=${leaf.id}`,
              ),
              expect: [root.id, leaf.id, targetAuthor.nickname],
            };
          case 'SavedReadService.preferences':
            return {
              ...base,
              run: get(
                actor,
                `/v1/community/posts/${parent.id}/update-preferences`,
              ),
              expect: [parent.id, '"canSetPreference":true'],
            };
          case 'SavedReadService.status':
            return {
              ...base,
              run: post(actor, '/v1/me/community/saved/status', {
                postIds: [parent.id],
              }),
              expect: [
                parent.id,
                '"status":"available"',
                'saveCount',
                'preferences',
              ],
            };
          case 'SavedReadService.list':
            await save(actor);
            return {
              ...base,
              run: get(actor, '/v1/me/community/saved'),
              expect: [
                parent.body.text,
                author.nickname,
                '"visibleSavedCount":1',
              ],
            };
          case 'TradingService.contacts':
            return {
              ...base,
              run: get(
                actor,
                `/v1/community/posts/${trading.id}/trading/contacts`,
              ),
              expect: Object.values(chosen),
            };
          case 'FormationService.get':
            return {
              ...base,
              run: get(actor, `/v1/community/posts/${formation.id}/formation`),
              expect: ['隐私组局', child.nickname],
            };
          case 'FormationService.contacts':
            await join(actor);
            return {
              ...base,
              run: get(
                actor,
                `/v1/community/posts/${formation.id}/formation/contacts`,
              ),
              expect: Object.values(chosen),
            };
          case 'PollReadService.get':
            return {
              ...base,
              run: get(actor, `/v1/community/posts/${poll.id}/poll`),
              expect: ['Protected poll question', 'First', '"canVote":true'],
            };
          case 'UpdatesReadService.list': {
            const id = await notice(actor);
            return {
              ...base,
              run: get(actor, '/v1/me/community/updates'),
              expect: [id, 'Protected notice preview', child.nickname],
            };
          }
          case 'UpdatesReadService.target': {
            const id = await notice(actor);
            return {
              ...base,
              run: get(actor, `/v1/me/community/updates/${id}/target`),
              expect: [id, parent.id, '"status":"available"'],
            };
          }
          case 'ReportingService.progress':
            return {
              ...base,
              run: get(
                actor,
                `/v1/me/safety/report-progress/post/${parent.id}`,
              ),
              expect: [parent.id, 'reportCapability', '"isSelf":false'],
            };
          case 'IdentityPrivacyService.view':
            await developer(actor);
            return {
              ...base,
              identity: true,
              run: post(actor, '/v1/identity-privacy/content-identities', {
                targets: [{ kind: 'post', id: parent.id }],
              }),
              expect: [
                author.accountId,
                author.nickname,
                '00004721',
                '"status":"available"',
              ],
            };
          default:
            assert.fail(`Unknown named-read owner ${owner}`);
        }
      };
      const owners = [
        'FeedService.feed',
        'FeedService.detail',
        'FeedService.commentCapabilities',
        'FeedService.comments',
        'FeedService.ownTrading',
        'DiscussionReadService.comments',
        'DiscussionReadService.comment',
        'DiscussionReadService.reply',
        'DiscussionReadService.replies',
        'DiscussionReadService.context',
        'SavedReadService.preferences',
        'SavedReadService.status',
        'SavedReadService.list',
        'TradingService.contacts',
        'FormationService.get',
        'FormationService.contacts',
        'PollReadService.get',
        'UpdatesReadService.list',
        'UpdatesReadService.target',
        'ReportingService.progress',
        'IdentityPrivacyService.view',
      ];
      const race = async (
        read: ReadCase,
        direction: 'outgoing' | 'incoming',
        relation?: string,
      ) => {
        const blocker = direction === 'outgoing' ? read.actor : read.target,
          blocked = direction === 'outgoing' ? read.target : read.actor;
        let baselineAllows = 0;
        observer!.setHook(async (event) => {
          if (
            event.sql.startsWith(scalar) &&
            event.values[0] === read.actor.accountId &&
            event.values[1] === read.target.accountId
          )
            baselineAllows++;
          assert.equal(
            /writer_capacity|count_epochs|count_writer/.test(event.sql),
            false,
          );
        });
        const baseline = await observer!.measure(
          `${read.owner} baseline`,
          read.run,
        );
        observer!.setHook(null);
        assert.ok(
          baselineAllows > 0,
          'Baseline must actually authorize this pair',
        );
        success(baseline.value, read.expect);
        assert.deepEqual(
          baseline.measurement.begins,
          ['read committed'],
          'Each emitting owner explicitly selects READ COMMITTED',
        );
        const audits = read.identity ? await auditCount(read.actor) : 0;
        let fired = false,
          fact = false,
          disclosed = false,
          observedAllows = 0;
        observer!.setHook(async (event) => {
          assert.equal(
            /writer_capacity|count_epochs|count_writer/.test(event.sql),
            false,
            'Mandatory named reads have no optional count-capacity/epoch dependency',
          );
          if (
            event.sql.startsWith(scalar) &&
            event.values[0] === read.actor.accountId &&
            event.values[1] === read.target.accountId &&
            ++observedAllows === baselineAllows &&
            !fired
          ) {
            fired = true;
            relation = await writeBlock(blocker, blocked, true, relation);
          }
          if (event.sql.includes(finalRows)) fact = true;
          if (
            event.sql.includes(
              'INSERT INTO whaleu_authorization.identity_view_audit',
            ) &&
            event.values[8] === 'disclosed'
          )
            disclosed = true;
        });
        try {
          const result = await read.run();
          assert.equal(
            fired,
            true,
            'Actual scalar named owner allow must be crossed',
          );
          assert.equal(
            fact,
            true,
            'The enrolled owner must perform its mandatory relationship reread',
          );
          if (read.bilateral || direction === 'outgoing') {
            unavailable(result);
            for (const value of read.expect)
              assert.equal(serialized(result.body).includes(value), false);
            if (read.identity) {
              assert.equal(
                disclosed,
                true,
                'The test crosses a would-be disclosed audit insert',
              );
              assert.equal(
                await auditCount(read.actor),
                audits,
                'Final proof failure rolls back disclosed audit rows',
              );
            }
          } else success(result, read.expect);
        } finally {
          observer!.setHook(null);
          if (relation) await writeBlock(blocker, blocked, false, relation);
        }
        assert.ok(relation);
        return relation;
      };
      for (const owner of owners)
        for (const direction of ['outgoing', 'incoming'] as const) {
          await t.test(
            `${owner}: raw INSERT then reactivation ${direction} after scalar allow`,
            async () => {
              const read = await makeCase(owner, await makeActor());
              const relation = await race(read, direction);
              await race(read, direction, relation);
              success(await read.run(), read.expect); // A failure cannot poison pooled proof lifetime.
            },
          );
        }

      await t.test(
        'child, preview target and formation-member proofs stay outgoing-only',
        async () => {
          for (const kind of [
            'root',
            'reply',
            'reply-target',
            'formation-member',
            'formation-contact',
            'notice-child',
            'identity-member',
          ] as const) {
            const actor = await makeActor();
            let read: ReadCase;
            if (kind === 'formation-contact') {
              await join(actor);
              read = {
                owner: kind,
                actor,
                target: child,
                bilateral: false,
                run: get(
                  actor,
                  `/v1/community/posts/${formation.id}/formation/contacts`,
                ),
                expect: Object.values(chosen),
              };
            } else if (kind === 'formation-member')
              read = {
                owner: kind,
                actor,
                target: child,
                bilateral: false,
                run: get(
                  actor,
                  `/v1/community/posts/${formation.id}/formation`,
                ),
                expect: [child.nickname],
              };
            else if (kind === 'identity-member') {
              await developer(actor);
              const member = (
                await pool.query<{ id: string }>(
                  'SELECT m.id FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE f.post_id=$1 AND m.account_id=$2',
                  [formation.id, child.accountId],
                )
              ).rows[0]!.id;
              read = {
                owner: kind,
                actor,
                target: child,
                bilateral: false,
                identity: true,
                run: post(actor, '/v1/identity-privacy/content-identities', {
                  targets: [{ kind: 'formation_member', id: member }],
                }),
                expect: [child.accountId, child.nickname, '00004721'],
              };
            } else if (kind === 'notice-child') {
              const id = await notice(actor);
              read = {
                owner: kind,
                actor,
                target: child,
                bilateral: false,
                run: get(actor, `/v1/me/community/updates/${id}/target`),
                expect: [id, '"status":"available"'],
              };
            } else
              read = {
                owner: kind,
                actor,
                target: kind === 'reply-target' ? targetAuthor : child,
                bilateral: false,
                run: get(
                  actor,
                  kind === 'root'
                    ? `/v1/community/comments/${root.id}`
                    : `/v1/community/replies/${leaf.id}`,
                ),
                expect: [
                  kind === 'reply-target'
                    ? targetAuthor.nickname
                    : child.nickname,
                ],
              };
            for (const direction of ['outgoing', 'incoming'] as const) {
              const relation = await race(read, direction);
              await race(read, direction, relation);
            }
          }
        },
      );

      await t.test(
        'anonymous and self parents still enroll named nested authors; guests create no relationship facts',
        async () => {
          const actor = await makeActor();
          for (const mode of ['anonymous', 'self'] as const) {
            const p = await publish(mode === 'self' ? actor : author, {
              authorMode: mode === 'anonymous' ? 'anonymous' : 'named',
            });
            const c = await comment(child, p.id, `Protected ${mode} root`);
            const read: ReadCase = {
              owner: `${mode} parent`,
              actor,
              target: child,
              bilateral: false,
              run: get(actor, `/v1/community/posts/${p.id}/comments`),
              expect: [c.body.text, child.nickname],
            };
            // Reuse an existing inactive relationship because both parents use the same viewer/child pair.
            const existing = (
              await pool.query<{ id: string }>(
                'SELECT id FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2',
                [actor.accountId, child.accountId],
              )
            ).rows[0]?.id;
            await race(read, 'outgoing', existing);
          }
          let facts = 0;
          observer!.setHook(async (event) => {
            if (event.sql.includes(finalRows)) facts++;
          });
          try {
            const result = await request(http).get(
              `/v1/community/posts?spaceId=${scope.home.spaceId}&category=trading`,
            );
            assert.equal(result.status, 200, serialized(result.body));
            assert.ok(result.body.items.length > 0);
            assert.equal(
              facts,
              0,
              'Guest projections never resolve named block pairs',
            );
          } finally {
            observer!.setHook(null);
          }
        },
      );

      await t.test(
        'anonymous roots retain named reply-preview and anonymous formations retain named roster proofs',
        async () => {
          const anonymous = await publish(author, { authorMode: 'anonymous' });
          const anonymousRoot = await comment(
            child,
            anonymous.id,
            'Anonymous root preview',
            'anonymous',
          );
          const namedReply = await reply(
            targetAuthor,
            anonymous.id,
            anonymousRoot.id,
          );
          const actor = await makeActor();
          const preview: ReadCase = {
            owner: 'anonymous root preview',
            actor,
            target: targetAuthor,
            bilateral: false,
            run: get(actor, `/v1/community/comments/${anonymousRoot.id}`),
            expect: [namedReply.id, targetAuthor.nickname, '"replyCount":1'],
          };
          const first = await race(preview, 'outgoing');
          await race(preview, 'outgoing', first);
          await race(preview, 'incoming');
          const anonymousFormation = await publish(author, {
            authorMode: 'anonymous',
            component: {
              kind: 'formation',
              capacity: 20,
              theme: '匿名组局',
              contacts: chosen,
              contactSharing: 'members_v1',
            },
          });
          await join(child, anonymousFormation.id);
          const reader = await makeActor();
          const roster: ReadCase = {
            owner: 'anonymous formation roster',
            actor: reader,
            target: child,
            bilateral: false,
            run: get(
              reader,
              `/v1/community/posts/${anonymousFormation.id}/formation`,
            ),
            expect: [child.nickname, '"kind":"anonymous"', '"memberCount":2'],
          };
          await race(roster, 'outgoing');
          await race(roster, 'incoming');
        },
      );

      await t.test(
        'active raw writer makes final mandatory fence fail promptly without disclosing',
        async () => {
          const actor = await makeActor(),
            read = await makeCase('TradingService.contacts', actor);
          success(await read.run(), read.expect);
          const writer = await pool.connect();
          let started = false;
          observer!.setHook(async (event) => {
            if (
              !started &&
              event.sql.startsWith(scalar) &&
              event.values[0] === actor.accountId &&
              event.values[1] === author.accountId
            ) {
              started = true;
              await writer.query('BEGIN');
              await writeBlock(actor, author, true, undefined, writer);
            }
          });
          try {
            const begin = performance.now(),
              result = await read.run();
            assert.equal(started, true);
            unavailable(result);
            assert.equal(result.body.error.code, 'SAFETY_UNAVAILABLE');
            const elapsed = performance.now() - begin;
            assert.ok(elapsed < 1500, `NOWAIT proof took ${elapsed}ms`);
            t.diagnostic(
              `Held raw writer rejected contact read in ${elapsed.toFixed(1)}ms`,
            );
          } finally {
            observer!.setHook(null);
            await writer.query('ROLLBACK');
            writer.release();
          }
          success(await read.run(), read.expect);
        },
      );

      await t.test(
        'new raw writer waits through the held final fence until reader COMMIT',
        async () => {
          const actor = await makeActor(),
            read = await makeCase('TradingService.contacts', actor);
          const writer = await pool.connect();
          const pid = (
            await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          let pending: Promise<string> | undefined,
            relation: string | undefined;
          let acquiredAt = 0,
            committedAt = 0,
            writerCommittedAt = 0;
          observer!.setHook(async (event) => {
            if (event.sql === fence && !pending) {
              acquiredAt = performance.now();
              pending = (async () => {
                await writer.query('BEGIN');
                const id = await writeBlock(
                  actor,
                  author,
                  true,
                  undefined,
                  writer,
                );
                await writer.query('COMMIT');
                writerCommittedAt = performance.now();
                return id;
              })();
              await waitForWriter(pool, pid);
              assert.equal(writerCommittedAt, 0);
            }
            if (event.sql === 'COMMIT') committedAt = performance.now();
          });
          try {
            success(await read.run(), read.expect);
            assert.ok(pending);
            relation = await pending;
            assert.ok(committedAt >= acquiredAt && acquiredAt > 0);
            assert.ok(
              writerCommittedAt >= committedAt,
              'Raw writer cannot commit before the held reader commits',
            );
            t.diagnostic(
              `Final fence held ${(committedAt - acquiredAt).toFixed(1)}ms including controlled waiter observation`,
            );
          } finally {
            observer!.setHook(null);
            // If a test assertion fails, the reader wrapper has already rolled back;
            // settle the pending writer before cleaning its relationship and client.
            if (pending && !relation) relation = await pending;
            await writer.query('ROLLBACK');
            writer.release();
            if (relation) await writeBlock(actor, author, false, relation);
          }
          success(await read.run(), read.expect);
        },
      );

      await t.test(
        'final database clock expires a real token after relationship proof and pooled reuse succeeds',
        async () => {
          const actor = await makeActor(),
            read = await makeCase('TradingService.contacts', actor);
          const expiredAt = new Date(Date.now() + 1500);
          await pool.query(
            'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
            [hashToken(actor.accessToken), expiredAt],
          );
          let delayed = false,
            checked = false;
          observer!.setHook(async (event) => {
            if (event.sql.includes(finalRows)) checked = true;
            if (
              checked &&
              event.sql.includes("set_config('statement_timeout'") &&
              event.values[1] === '0' &&
              !delayed
            ) {
              delayed = true;
              await sleep(Math.max(0, expiredAt.getTime() - Date.now()) + 25);
            }
          });
          try {
            const result = await read.run();
            assert.equal(
              delayed,
              true,
              'Expiry is crossed after the actual relationship reread',
            );
            assert.equal(result.status, 401, serialized(result.body));
            assert.equal(result.body.error.code, 'ACCESS_TOKEN_EXPIRED');
            for (const value of Object.values(chosen))
              assert.equal(serialized(result.body).includes(value), false);
          } finally {
            observer!.setHook(null);
          }
          const fresh = await makeCase(
            'TradingService.contacts',
            await makeActor(),
          );
          success(await fresh.run(), fresh.expect);
        },
      );

      await t.test(
        'an earlier allowed Saved item remains mandatory after a later same-author item is denied',
        async () => {
          const actor = await makeActor();
          const run = post(actor, '/v1/me/community/saved/status', {
            postIds: [parent.id, trading.id],
          });
          success(await run(), [parent.id, trading.id, '"status":"available"']);
          let relation: string | undefined,
            reads = 0,
            checked = false;
          observer!.setHook(async (event) => {
            if (
              event.sql.startsWith(scalar) &&
              event.values[0] === actor.accountId &&
              event.values[1] === author.accountId
            ) {
              reads++;
              if (reads === 1) relation = await writeBlock(actor, author, true);
            }
            if (event.sql.includes(finalRows)) checked = true;
          });
          try {
            unavailable(await run());
            assert.ok(
              reads >= 2,
              'A later scalar observes the now-blocked pair',
            );
            assert.equal(
              checked,
              true,
              'The earlier available item retains its recorded allow',
            );
          } finally {
            observer!.setHook(null);
            if (relation) await writeBlock(actor, author, false, relation);
          }
        },
      );

      await t.test(
        'abandoned identity payload prunes content facts and durably audits unavailable attempts',
        async () => {
          const actor = await makeActor(),
            other = await makeActor();
          await developer(actor);
          const unavailablePost = await publish(other);
          const run = post(actor, '/v1/identity-privacy/content-identities', {
            targets: [
              { kind: 'post', id: parent.id },
              { kind: 'post', id: unavailablePost.id },
            ],
          });
          success(await run(), [author.accountId, other.accountId, '00004721']);
          const prior = await auditCount(actor);
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
            [other.accountId],
          );
          let relation: string | undefined,
            checked = false;
          observer!.setHook(async (event) => {
            if (
              !relation &&
              event.sql.startsWith(scalar) &&
              event.values[0] === actor.accountId &&
              event.values[1] === author.accountId
            )
              relation = await writeBlock(actor, author, true);
            if (event.sql.includes(finalRows)) checked = true;
          });
          try {
            const result = await run();
            assert.ok(
              relation,
              'An earlier private identity candidate was allowed before the block',
            );
            assert.equal(result.status, 503, serialized(result.body));
            assert.equal(result.body.error.code, 'IDENTITY_VIEW_UNAVAILABLE');
            assert.equal(
              checked,
              false,
              'Discarded candidate-only facts cannot abort attempt auditing',
            );
            assert.equal(await auditCount(actor), prior);
            const attempts = (
              await pool.query<{ outcome: string; disclosed_fields: string[] }>(
                "SELECT outcome,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND outcome='unavailable'",
                [actor.accountId],
              )
            ).rows;
            assert.deepEqual(attempts, [
              { outcome: 'unavailable', disclosed_fields: [] },
              { outcome: 'unavailable', disclosed_fields: [] },
            ]);
            for (const value of [
              author.accountId,
              author.nickname,
              other.accountId,
              '00004721',
            ])
              assert.equal(serialized(result.body).includes(value), false);
          } finally {
            observer!.setHook(null);
            await pool.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
              [other.accountId],
            );
            if (relation) await writeBlock(actor, author, false, relation);
          }
        },
      );

      await t.test(
        'pre-disclosure identity denial remains durably audited',
        async () => {
          const actor = await makeActor();
          const result = await post(
            actor,
            '/v1/identity-privacy/content-identities',
            { targets: [{ kind: 'post', id: parent.id }] },
          )();
          assert.equal(result.status, 403, serialized(result.body));
          assert.equal(result.body.error.code, 'AUTHORIZATION_REQUIRED');
          const rows = (
            await pool.query<{ outcome: string; disclosed_fields: string[] }>(
              'SELECT outcome,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1',
              [actor.accountId],
            )
          ).rows;
          assert.deepEqual(rows, [{ outcome: 'denied', disclosed_fields: [] }]);
        },
      );

      await t.test(
        'block management and historical receipts stay usable after parent access is lost',
        async () => {
          const actor = await makeActor();
          const saved = await save(actor),
            membership = await join(actor);
          const pollView = await get(
            actor,
            `/v1/community/posts/${poll.id}/poll`,
          )();
          const ballotBody = {
            clientRequestId: randomUUID(),
            optionIds: [pollView.body.options[0].id],
          };
          const ballot = await post(
            actor,
            `/v1/community/posts/${poll.id}/poll/ballots`,
            ballotBody,
          )();
          assert.equal(ballot.body.outcome, 'created', serialized(ballot.body));
          const discussionBody = { clientRequestId: randomUUID() };
          const discussion = await request(http)
            .put(`/v1/community/comments/${root.id}/like`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(discussionBody);
          assert.equal(
            discussion.body.outcome,
            'applied',
            serialized(discussion.body),
          );
          const reportBody = {
            clientRequestId: randomUUID(),
            target: { kind: 'post', id: parent.id },
          };
          const reported = await post(
            actor,
            '/v1/me/safety/reports',
            reportBody,
          )();
          assert.equal(
            reported.body.outcome,
            'accepted',
            serialized(reported.body),
          );
          const own = await publish(actor);
          const ownListing = await publish(actor, {
            category: 'trading',
            trading: tradingInput,
          });
          const resolutionBody = {
            clientRequestId: randomUUID(),
            resolution: 'resolved',
          };
          const resolution = await post(
            actor,
            `/v1/community/posts/${ownListing.id}/trading/resolution`,
            resolutionBody,
          )();
          assert.equal(
            resolution.body.outcome,
            'applied',
            serialized(resolution.body),
          );
          for (const id of [own.id, ownListing.id]) {
            const deleted = await request(http)
              .delete(`/v1/community/posts/${id}`)
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(deleted.status, 204, serialized(deleted.body));
          }
          const noticeId = await notice(actor);
          const blockBody = {
            clientRequestId: randomUUID(),
            source: { kind: 'profile', id: author.profileId },
            blocked: true,
          };
          const blocked = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send(blockBody);
          assert.equal(blocked.status, 200, serialized(blocked.body));
          assert.equal(blocked.body.receipt.outcome, 'applied');
          let facts = 0;
          observer!.setHook(async (event) => {
            if (event.sql.includes(finalRows)) facts++;
          });
          try {
            for (const [path, expected] of [
              [
                `/v1/me/community/saved-requests/${saved.body.clientRequestId}`,
                saved.receipt,
              ],
              [
                `/v1/me/community/formation-requests/${membership.body.clientRequestId}`,
                membership.receipt,
              ],
              [
                `/v1/me/community/poll-requests/${ballotBody.clientRequestId}`,
                ballot.body,
              ],
              [
                `/v1/me/community/discussion-requests/${discussionBody.clientRequestId}`,
                discussion.body,
              ],
              [
                `/v1/me/safety/report-requests/${reportBody.clientRequestId}`,
                reported.body,
              ],
              [
                `/v1/me/community/requests/${own.body.clientRequestId}`,
                own.receipt,
              ],
              [
                `/v1/me/community/trading-requests/${resolutionBody.clientRequestId}`,
                resolution.body,
              ],
            ] as const) {
              const result = await get(actor, path)();
              assert.equal(result.status, 200, serialized(result.body));
              assert.deepEqual(result.body, expected);
            }
            const replays: [() => Promise<Result>, unknown][] = [
              [
                async () =>
                  request(http)
                    .put(`/v1/community/posts/${parent.id}/save`)
                    .set('Authorization', `Bearer ${actor.accessToken}`)
                    .send(saved.body),
                saved.receipt,
              ],
              [
                post(
                  actor,
                  `/v1/community/posts/${formation.id}/formation/memberships`,
                  membership.body,
                ),
                membership.receipt,
              ],
              [
                post(
                  actor,
                  `/v1/community/posts/${poll.id}/poll/ballots`,
                  ballotBody,
                ),
                ballot.body,
              ],
              [
                async () =>
                  request(http)
                    .put(`/v1/community/comments/${root.id}/like`)
                    .set('Authorization', `Bearer ${actor.accessToken}`)
                    .send(discussionBody),
                discussion.body,
              ],
              [post(actor, '/v1/me/safety/reports', reportBody), reported.body],
              [post(actor, '/v1/community/posts', own.body), own.receipt],
              [
                post(
                  actor,
                  `/v1/community/posts/${ownListing.id}/trading/resolution`,
                  resolutionBody,
                ),
                resolution.body,
              ],
            ];
            for (const [repeat, expected] of replays) {
              const result = await repeat();
              assert.ok(
                [200, 201].includes(result.status),
                serialized(result.body),
              );
              assert.deepEqual(result.body, expected);
            }
            for (const path of [
              `/v1/me/community/formation-memberships/${formation.id}`,
              `/v1/me/community/poll-ballots/${poll.id}`,
              '/v1/me/community/updates/unread-count',
            ])
              assert.equal((await get(actor, path)()).status, 200);
            const mark = await request(http)
              .put(`/v1/me/community/updates/${noticeId}/read`)
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .send({});
            assert.equal(mark.status, 200, serialized(mark.body));
            const list = await get(actor, '/v1/me/safety/blocks')();
            success(list, [author.nickname, '"kind":"current"']);
            await pool.query(
              'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
              [author.accountId],
            );
            success(await get(actor, '/v1/me/safety/blocks')(), [
              author.nickname,
              '"kind":"snapshot"',
            ]);
            const status = await get(
              actor,
              `/v1/me/safety/blocks/${blocked.body.current.relationshipId}`,
            )();
            success(status, [
              '"blocked":true',
              blocked.body.current.relationshipId,
            ]);
            const replay = await request(http)
              .put('/v1/me/safety/blocks')
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .send(blockBody);
            assert.equal(replay.status, 200, serialized(replay.body));
            assert.deepEqual(replay.body.receipt, blocked.body.receipt);
            const unblock = await request(http)
              .put(
                `/v1/me/safety/blocks/${blocked.body.current.relationshipId}`,
              )
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                expectedRevision: blocked.body.current.revision,
                blocked: false,
              });
            assert.equal(unblock.status, 200, serialized(unblock.body));
            assert.equal(unblock.body.current.blocked, false);
            assert.equal(
              facts,
              0,
              'Excluded mutation/receipt/own-cleanup owners must not be globally enrolled',
            );
          } finally {
            observer!.setHook(null);
          }
        },
      );
    } finally {
      observer?.restore();
      try {
        await app?.close();
      } finally {
        try {
          if (owns)
            for (const schema of migrationSchemaNames)
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
    }
  },
);
