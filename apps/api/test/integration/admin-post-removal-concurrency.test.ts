/** Witness real lock ordering on disposable source-backed content, never infer it
 * from Promise.all timing. No production worker/provider is enabled. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { APP_CONFIG } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { JuryWorker } from '../../src/safety/reporting/worker.js';
import { JurySettlementService } from '../../src/safety/reporting/settlement.js';
import { ReportsRepository } from '../../src/safety/reporting/repository.js';
import { CommunityReportTargetFacade } from '../../src/community/report-target.facade.js';
import {
  categoryPolicyDigest,
  categoryReviewDigest,
} from '../../src/community/category-reclassification/evidence.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import type { AdminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function orderedWriters<A, B>(
  f: AdminPostRemovalFixture,
  post: string,
  firstWork: () => PromiseLike<A>,
  secondWork: () => PromiseLike<B>,
): Promise<readonly [A, B]> {
  const database = f.moderationApp.get(DatabaseService),
    original = database.transaction,
    run = original.bind(database);
  const entered = signal<number>(),
    contender = signal<number>(),
    release = signal<void>();
  let ordinal = 0;
  let first: Promise<A> | undefined, second: Promise<B> | undefined;
  database.transaction = (work, options) => {
    const index = ordinal++;
    return run(async (tx) => {
      const raw = tx.query,
        query = raw.bind(tx) as (
          sql: string,
          values?: unknown[],
        ) => Promise<QueryResult>;
      const pid = (await query('SELECT pg_backend_pid() pid')).rows[0]!
        .pid as number;
      let captured = false;
      tx.query = (async (sql: string, values?: unknown[]) => {
        const result = query(sql, values);
        if (
          index < 2 &&
          !captured &&
          sql.includes('FROM whaleu_community.posts') &&
          /FOR (UPDATE|SHARE)/.test(sql) &&
          values?.includes(post)
        ) {
          captured = true;
          if (index === 0) {
            const locked = await result;
            entered.resolve(pid);
            await release.promise;
            return locked;
          }
          contender.resolve(pid);
        }
        return result;
      }) as PoolClient['query'];
      try {
        return await work(tx);
      } finally {
        tx.query = raw;
      }
    }, options);
  };
  async function beforeCompletion<T>(
    gate: Promise<T>,
    operation: Promise<unknown>,
    label: string,
  ) {
    return Promise.race([
      gate,
      operation.then((value) => {
        throw Error(
          `${label} finished before its canonical post lock: ${JSON.stringify(value && typeof value === 'object' && 'status' in value ? { status: value.status, body: 'body' in value ? value.body : null } : value)}`,
        );
      }),
      sleep(3000, undefined, { ref: false }).then(() => {
        throw Error(`${label} did not reach canonical post lock`);
      }),
    ]);
  }
  try {
    first = Promise.resolve(firstWork());
    const firstPid = await beforeCompletion(
      entered.promise,
      first,
      'First writer',
    );
    second = Promise.resolve(secondWork());
    const secondPid = await beforeCompletion(
      contender.promise,
      second,
      'Contender',
    );
    const deadline = Date.now() + 1500;
    let witnessed = false;
    while (!witnessed && Date.now() < deadline) {
      witnessed =
        (
          await f.pool.query<{ waiting: boolean }>(
            `SELECT a.wait_event_type='Lock'
        AND a.query LIKE '%whaleu_community.posts%' AND $2::integer=ANY(pg_blocking_pids(a.pid))
        AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) waiting
        FROM pg_stat_activity a WHERE a.pid=$1`,
            [secondPid, firstPid],
          )
        ).rows[0]?.waiting === true;
      if (!witnessed) await sleep(1);
    }
    assert.equal(
      witnessed,
      true,
      'The contender actually waits for the first backend canonical post lock',
    );
    release.resolve();
    return await Promise.all([first, second] as const);
  } finally {
    release.resolve();
    await Promise.allSettled(
      [first, second].filter((value) => value !== undefined),
    );
    database.transaction = original;
  }
}
const applied = (response: { status: number; body: { outcome?: string } }) =>
  response.status === 200 && response.body.outcome === 'applied';

test(
  'administrative post removal serializes real administrator, owner, pin, visibility, classification and jury writers',
  { timeout: 360000 },
  async (t) => {
    const f = await adminPostRemovalFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      admin = await f.actor(),
      secondAdmin = await f.actor();
    const grant = await f.grant(admin);
    await f.grant(secondAdmin);
    const prepare = async (category: 'discussion' | 'pets' = 'discussion') => {
      const post = await f.publish(owner, { category });
      const view = await f.removalManagement(post, admin);
      return { post, command: f.removalCommand(post, view.targetVersion) };
    };
    const cause = async (post: string) =>
      (
        await f.pool.query(
          `SELECT
    (SELECT count(*)::int FROM whaleu_community.admin_post_removal_events WHERE target_id=$1) admin,
    (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='post_deleted') owner,
    (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='moderation_removed') jury,
    (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_kind='post' AND resource_id=$1) jobs,
    (SELECT count(*)::int FROM whaleu_notifications.admin_post_removal_notices n JOIN whaleu_community.admin_post_removal_events e ON e.id=n.event_id WHERE e.target_id=$1) notices`,
          [post],
        )
      ).rows[0]!;
    await t.test(
      'two administrators have exactly one actual remover and immutable recovery',
      async () => {
        for (const winner of [admin, secondAdmin]) {
          const loser = winner === admin ? secondAdmin : admin,
            { post, command } = await prepare();
          const next = { ...command, clientRequestId: randomUUID() };
          const [first, second] = await orderedWriters(
            f,
            post.id,
            () => f.removalSend(winner, command),
            () => f.removalSend(loser, next),
          );
          assert.equal(applied(first), true, JSON.stringify(first.body));
          assert.equal(applied(second), false, JSON.stringify(second.body));
          assert.deepEqual(await cause(post.id), {
            admin: 1,
            owner: 0,
            jury: 0,
            jobs: 1,
            notices: 1,
          });
          const replay = await f.removalSend(winner, command);
          profileOk(replay);
          assert.deepEqual(replay.body, first.body);
        }
      },
    );
    await t.test(
      'author deletion before/after administrator preserves the actual cause and its Experience semantics',
      async () => {
        for (const adminFirst of [true, false]) {
          const { post, command } = await prepare();
          const remove = () => f.removalSend(admin, command),
            own = () =>
              request(f.http)
                .delete(`/v1/community/posts/${post.id}`)
                .set('Authorization', `Bearer ${owner.accessToken}`);
          const [first, second] = await orderedWriters(
            f,
            post.id,
            adminFirst ? remove : own,
            adminFirst ? own : remove,
          );
          const administrative = adminFirst ? first : second,
            author = adminFirst ? second : first;
          assert.equal(author.status, 204, JSON.stringify(author.body));
          assert.equal(
            applied(administrative),
            adminFirst,
            JSON.stringify(administrative.body),
          );
          assert.deepEqual(await cause(post.id), {
            admin: adminFirst ? 1 : 0,
            owner: adminFirst ? 0 : 1,
            jury: 0,
            jobs: 1,
            notices: adminFirst ? 1 : 0,
          });
        }
      },
    );
    await t.test(
      'owner-hide and removal serialize without erasing the earlier visibility fact',
      async () => {
        for (const adminFirst of [true, false]) {
          const { post, command } = await prepare();
          const hide = () =>
            request(f.http)
              .post('/v1/me/community/owner-visibility-commands')
              .set('Authorization', `Bearer ${owner.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                postId: post.id,
                ownerHidden: true,
                expectedVersion: 0,
              });
          const remove = () => f.removalSend(admin, command);
          const [first, second] = await orderedWriters(
            f,
            post.id,
            adminFirst ? remove : hide,
            adminFirst ? hide : remove,
          );
          assert.equal(applied(adminFirst ? first : second), adminFirst);
          assert.equal(applied(adminFirst ? second : first), !adminFirst);
          const row = (
            await f.pool.query(
              'SELECT p.deleted_at,coalesce(v.owner_hidden,false) hidden FROM whaleu_community.posts p LEFT JOIN whaleu_community.post_owner_visibility v ON v.post_id=p.id WHERE p.id=$1',
              [post.id],
            )
          ).rows[0]!;
          assert.equal(row.deleted_at !== null, adminFirst);
          assert.equal(row.hidden, !adminFirst);
          assert.equal((await cause(post.id)).notices, adminFirst ? 1 : 0);
        }
      },
    );
    await t.test(
      'pin reader first closes the real pin; removal first cannot create a fresh pin',
      async () => {
        const scope = randomUUID();
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until)
        VALUES($1,$2,'regional',$3,'synthetic:admin-removal-race','accepted',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
            [scope, f.scope.home.spaceId, f.scope.home.regionId],
          );
          await tx.query(
            `INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until)
        VALUES($1,'accepted_empty','synthetic:independent-pin-history',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
            [scope],
          );
        });
        for (const adminFirst of [true, false]) {
          const { post, command } = await prepare();
          const pin = () =>
            request(f.http)
              .post('/v1/community/post-pin-commands')
              .set('Authorization', `Bearer ${admin.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                operation: 'pin',
                postId: post.id,
                durationHours: 1,
                level: 2,
              });
          const remove = () => f.removalSend(secondAdmin, command);
          const [first, second] = await orderedWriters(
            f,
            post.id,
            adminFirst ? remove : pin,
            adminFirst ? pin : remove,
          );
          assert.equal(
            applied(adminFirst ? first : second),
            true,
            JSON.stringify([first.body, second.body]),
          );
          const pinned = adminFirst ? second : first;
          assert.equal(
            applied(pinned),
            !adminFirst,
            JSON.stringify(pinned.body),
          );
          const rows = (
            await f.pool.query(
              'SELECT p.id,c.reason FROM whaleu_community.post_pins p LEFT JOIN whaleu_community.post_pin_closures c ON c.pin_id=p.id WHERE p.post_id=$1',
              [post.id],
            )
          ).rows;
          assert.equal(rows.length, adminFirst ? 0 : 1);
          if (rows.length) assert.equal(rows[0]!.reason, 'deleted');
          assert.deepEqual(await cause(post.id), {
            admin: 1,
            owner: 0,
            jury: 0,
            jobs: 1,
            notices: 1,
          });
        }
      },
    );
    await t.test(
      'reviewed classification before removal invalidates the original source CAS, and removal first blocks classification',
      async () => {
        const issuer = randomUUID(),
          policy = randomUUID(),
          sourceKey = `synthetic:removal-race:${randomUUID()}`;
        const definition = {
          version: 1,
          authorMode: 'named',
          content: 'text_only',
          component: 'none',
          distribution: 'regional',
          sync: 'none',
          anonymousDm: false,
          origin: 'native',
          crosswalk: { pets: 10, scenery: 12 },
          transitions: [
            { from: 'pets', to: 'scenery' },
            { from: 'scenery', to: 'pets' },
          ],
          continueDescendants: true,
          futureChildren: 'original_envelope_plus_reviewed_current_parent',
          descendantMedia: 'text_only',
        };
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_community.post_category_issuers(id,source_ref,accepted_at,valid_until)
        VALUES($1,'synthetic:admin-removal-race',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')`,
            [issuer],
          );
          await tx.query(
            `INSERT INTO whaleu_community.post_category_policies(id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until)
        VALUES($1,$2,1,'synthetic:admin-removal-crosswalk',$3,$4,$5,$6,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
            [
              policy,
              sourceKey,
              f.scope.home.regionId,
              issuer,
              definition,
              categoryPolicyDigest(definition),
            ],
          );
          await tx.query(
            'INSERT INTO whaleu_community.post_category_policy_heads(source_key,policy_id) VALUES($1,$2)',
            [sourceKey, policy],
          );
        });
        for (const adminFirst of [true, false]) {
          const { post, command } = await prepare('pets');
          const classification = {
            clientRequestId: randomUUID(),
            postId: post.id,
            expectedRevision: 0,
            targetCategory: 'scenery',
          };
          const envelope = (
            await f.pool.query(
              'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) envelope',
              [admin.accountId, classification, grant, policy],
            )
          ).rows[0]!.envelope;
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_community.post_category_reviews(id,issuer_id,policy_id,purpose,envelope,digest,result,accepted_at,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,'allow',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
              [
                randomUUID(),
                issuer,
                policy,
                envelope.purpose,
                envelope,
                categoryReviewDigest(envelope),
              ],
            ),
          );
          // Review insertion is a distinct source change; obtain the original removal
          // version after the independent accepted review has been installed.
          const view = await f.removalManagement(post, secondAdmin);
          command.expectedTargetVersion = view.targetVersion;
          const classify = () =>
            request(f.http)
              .post('/v1/community/category-commands')
              .set('Authorization', `Bearer ${admin.accessToken}`)
              .send(classification);
          const remove = () => f.removalSend(secondAdmin, command);
          const [first, second] = await orderedWriters(
            f,
            post.id,
            adminFirst ? remove : classify,
            adminFirst ? classify : remove,
          );
          assert.equal(
            applied(adminFirst ? first : second),
            adminFirst,
            JSON.stringify([first.body, second.body]),
          );
          assert.equal(
            applied(adminFirst ? second : first),
            !adminFirst,
            JSON.stringify([first.body, second.body]),
          );
          assert.equal((await cause(post.id)).admin, adminFirst ? 1 : 0);
        }
      },
    );
    await t.test(
      'the existing real jury worker either removes first or records superseded after administration',
      async () => {
        // Same explicit synthetic clock construction as the reporting integration:
        // no tally is invented and the immutable 24-hour jury interval remains exact.
        await f.pool
          .query(`CREATE TABLE whaleu_safety.synthetic_admin_removal_jury_clocks(post_id uuid PRIMARY KEY);
      CREATE FUNCTION whaleu_safety.synthetic_admin_removal_jury_clock() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
        IF EXISTS(SELECT 1 FROM whaleu_safety.synthetic_admin_removal_jury_clocks WHERE post_id=NEW.post_id) THEN
          NEW.deadline:=date_trunc('milliseconds',clock_timestamp()+interval '3 seconds');NEW.created_at:=NEW.deadline-interval '24 hours';
        END IF;RETURN NEW;END$$;
      CREATE TRIGGER synthetic_admin_removal_jury_clock BEFORE INSERT ON whaleu_safety.post_juries FOR EACH ROW EXECUTE FUNCTION whaleu_safety.synthetic_admin_removal_jury_clock()`);
        const voter = await f.actor(),
          app = f.moderationApp;
        const worker = new JuryWorker(
          { ...app.get(APP_CONFIG), SAFETY_JURY_PROCESSING: 'manual_only' },
          app.get(DatabaseService),
          app.get(CommunityReportTargetFacade),
          app.get(ReportsRepository),
          app.get(JurySettlementService),
        );
        for (const adminFirst of [true, false]) {
          const { post, command } = await prepare();
          await f.pool.query(
            'INSERT INTO whaleu_safety.synthetic_admin_removal_jury_clocks VALUES($1)',
            [post.id],
          );
          const reported = await request(f.http)
            .post('/v1/me/safety/reports')
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              target: { kind: 'post', id: post.id },
            });
          profileOk(reported);
          assert.equal(reported.body.outcome, 'accepted');
          const jury = (
            await f.pool.query<{ id: string }>(
              'SELECT id FROM whaleu_safety.post_juries WHERE post_id=$1',
              [post.id],
            )
          ).rows[0]!;
          const voted = await request(f.http)
            .post('/v1/me/safety/jury-votes')
            .set('Authorization', `Bearer ${voter.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              postId: post.id,
              juryId: jury.id,
              vote: 'remove',
            });
          profileOk(voted);
          assert.equal(voted.body.outcome, 'accepted');
          let due = false;
          const until = Date.now() + 6000;
          while (!due && Date.now() < until) {
            due = (
              await f.pool.query<{ due: boolean }>(
                'SELECT deadline<=clock_timestamp() due FROM whaleu_safety.post_juries WHERE id=$1',
                [jury.id],
              )
            ).rows[0]!.due;
            if (!due) await sleep(10);
          }
          assert.equal(
            due,
            true,
            'PostgreSQL confirms the real synthetic deadline elapsed before either writer starts',
          );
          const remove = () => f.removalSend(secondAdmin, command),
            settle = () => worker.run({ mode: 'apply', juryIds: [jury.id] });
          let administrative, settlement;
          if (adminFirst)
            [administrative, settlement] = await orderedWriters(
              f,
              post.id,
              remove,
              settle,
            );
          else
            [settlement, administrative] = await orderedWriters(
              f,
              post.id,
              settle,
              remove,
            );
          assert.equal(
            applied(administrative),
            adminFirst,
            JSON.stringify(administrative.body),
          );
          assert.equal(settlement.completed, 1, JSON.stringify(settlement));
          assert.equal(settlement.failed, 0);
          const final = (
            await f.pool.query(
              `SELECT j.state,d.outcome,d.keep_votes,d.remove_votes,
        (SELECT count(*)::int FROM whaleu_notifications.system_notices n WHERE n.decision_id=d.id) notices
        FROM whaleu_safety.post_juries j JOIN whaleu_safety.report_decisions d ON d.id=j.decision_id WHERE j.id=$1`,
              [jury.id],
            )
          ).rows[0]!;
          assert.deepEqual(final, {
            state: adminFirst ? 'superseded' : 'removed',
            outcome: adminFirst ? 'superseded' : 'removed',
            keep_votes: 0,
            remove_votes: 1,
            notices: adminFirst ? 0 : 1,
          });
          assert.deepEqual(await cause(post.id), {
            admin: adminFirst ? 1 : 0,
            owner: 0,
            jury: adminFirst ? 0 : 1,
            jobs: 1,
            notices: adminFirst ? 1 : 0,
          });
        }
      },
    );
  },
);
