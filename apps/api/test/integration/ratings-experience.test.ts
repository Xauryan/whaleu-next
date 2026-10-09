import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';
import { RatingExperienceSourceFacade } from '../../src/ratings/experience-source/facade.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';

interface Unit {
  id: string;
  group_id: string;
  event_id: string;
  beneficiary_id: string;
  action: 'comment' | 'received_comment';
  enrollment_order: string;
}

// These acceptance cases use ordinary HTTP publication, durable SQL capture,
// the real worker/settlement/ledger and the public experience HTTP projection.
// All accounts, review approvals and any historical baselines are synthetic.
test(
  'rating source real owner settlement, shared pools and retained causal rewards',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const worker = f.app.get(ExperienceWorker);
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const units = async (actor: Actor, requestId: string): Promise<Unit[]> =>
      (
        await f.pool.query<Unit>(
          `SELECT u.* FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
       JOIN whaleu_ratings.effect_events e ON e.id=g.event_id WHERE e.actor_account_id=$1 AND e.request_id=$2
       ORDER BY u.enrollment_order,u.id`,
          [actor.accountId, requestId],
        )
      ).rows;
    const shape = (rows: Unit[]) =>
      rows.map((r) => `${r.beneficiary_id}:${r.action}`).sort();
    const balance = async (owner: Actor) =>
      (
        await f.pool.query<{ balance: string }>(
          'SELECT balance::text FROM whaleu_experience.account_states WHERE owner_id=$1',
          [owner.accountId],
        )
      ).rows[0]?.balance ?? null;
    const settle = async (rows: readonly Unit[]) => {
      const result = await worker.run({
        mode: 'apply',
        unitIds: rows.map((u) => u.id),
      });
      assert.equal(result.failed, 0, JSON.stringify(result));
      assert.equal(result.sourceUnavailable, 0, JSON.stringify(result));
      return result;
    };
    const settleOwners = async (...actors: Actor[]) => {
      const rows = (
        await f.pool.query<{ unit_id: string }>(
          "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=ANY($1::uuid[]) AND state<>'completed' ORDER BY enrollment_order,unit_id",
          [actors.map((a) => a.accountId)],
        )
      ).rows;
      if (!rows.length) return;
      const result = await worker.run({
        mode: 'apply',
        unitIds: rows.map((r) => r.unit_id),
      });
      assert.equal(result.settled, rows.length, JSON.stringify(result));
    };
    const ledger = async (rows: readonly Unit[]) =>
      (
        await f.pool.query<{
          id: string;
          owner_id: string;
          action: string;
          outcome: string;
          applied_delta: string;
          state: string;
          source_domain: string;
          source_time_exact: boolean;
          record_id: string;
          source_at: string;
          record_at: string;
          settlement_id: string;
        }>(
          `SELECT u.id,s.owner_id,s.action,s.outcome,s.applied_delta::text,w.state,su.source_domain,
       r.id AS record_id,s.id AS settlement_id,g.occurred_at::text AS source_at,r.occurred_at::text AS record_at,
       r.occurred_at=g.occurred_at AS source_time_exact
       FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
       JOIN whaleu_experience.source_units su ON su.unit_id=u.id JOIN whaleu_experience.work w ON w.unit_id=u.id
       JOIN whaleu_experience.settlements s ON s.unit_id=u.id JOIN whaleu_experience.records r ON r.settlement_id=s.id
       WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`,
          [rows.map((u) => u.id)],
        )
      ).rows;
    const assertAwarded = async (rows: readonly Unit[], delta = '3') => {
      const records = await ledger(rows);
      assert.equal(records.length, rows.length);
      for (const r of records) {
        const source = rows.find((u) => u.id === r.id)!;
        assert.equal(r.owner_id, source.beneficiary_id);
        assert.equal(r.action, source.action);
        assert.equal(r.applied_delta, delta);
        assert.equal(r.state, 'completed');
        assert.equal(r.source_domain, 'ratings');
        assert.equal(r.source_time_exact, true);
        assert.equal(r.record_at, r.source_at);
        assert.equal(r.outcome, delta === '0' ? 'capped' : 'awarded');
      }
      return records;
    };
    const unknownActor = async (): Promise<Actor> => {
      const accountId = randomUUID(),
        subject = randomUUID(),
        accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      await inTransaction(f.pool, async (tx) => {
        await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
          accountId,
        ]);
        await initializeNativeSafetyAccount(accountId, tx);
        await tx.query(
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-rating-unknown-experience',$1,$2)",
          [subject, accountId],
        );
      });
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-rating-unknown-experience',
          subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      const facts = await f.certify(accountId);
      assert.equal(
        await balance({ ...session, accessToken, refreshToken, facts }),
        null,
      );
      return { ...session, accessToken, refreshToken, facts };
    };

    await t.test(
      'new root grants only its actor; dry-run is read-only; source microseconds and HTTP ledger agree',
      async () => {
        const creator = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(creator),
          target = c.targets[0]!;
        const root = await f.publish(actor, c, target),
          rows = await units(actor, root.input.clientRequestId);
        assert.deepEqual(shape(rows), [`${actor.accountId}:comment`]);
        const reference = await inTransaction(f.pool, (tx) =>
          f.app.get(ExperienceSourceRouter).loadUnit(rows[0]!.id, tx),
        );
        assert.equal(reference?.sourceKind, 'rating_event');
        assert.equal(reference?.sourceId, rows[0]!.event_id);
        const sourceTime = (
          await f.pool.query<{ occurred_at: string }>(
            'SELECT occurred_at::text FROM whaleu_ratings.reward_groups WHERE id=$1',
            [rows[0]!.group_id],
          )
        ).rows[0]!.occurred_at;
        assert.equal(reference?.occurredAt, sourceTime);
        const snapshot = await f.snapshot();
        assert.equal(
          (await worker.run({ unitIds: rows.map((u) => u.id) })).pending,
          1,
        );
        assert.deepEqual(await f.snapshot(), snapshot);
        assert.equal((await settle(rows)).settled, 1);
        await assertAwarded(rows);
        assert.equal(await balance(actor), '3');
        assert.equal(await balance(creator), '0');
        const summary = await f.auth(
          request(f.http).get('/v1/me/experience'),
          actor,
        );
        assert.equal(summary.status, 200, JSON.stringify(summary.body));
        assert.equal(summary.body.balance, '3');
        const records = await f.auth(
          request(f.http).get('/v1/me/experience/records'),
          actor,
        );
        assert.equal(records.status, 200, JSON.stringify(records.body));
        assert.equal(records.body.items.length, 1);
        assert.equal(records.body.items[0].action, 'comment');
        assert.equal(records.body.items[0].appliedDelta, '3');
      },
    );

    for (const self of [false, true])
      await t.test(
        `reply to root captures actor and only a nonself recipient: self=${self}`,
        async () => {
          const rootActor = await f.actor(),
            actor = self ? rootActor : await f.actor();
          const c = await f.catalog(rootActor),
            target = c.targets[0]!,
            root = await f.publish(rootActor, c, target);
          await settleOwners(rootActor);
          const reply = await f.publishReply(actor, c, target, root),
            rows = await units(actor, reply.input.clientRequestId);
          assert.deepEqual(
            shape(rows),
            [
              `${actor.accountId}:comment`,
              ...(!self ? [`${rootActor.accountId}:received_comment`] : []),
            ].sort(),
          );
          assert.equal((await settle(rows)).settled, rows.length);
          await assertAwarded(rows);
        },
      );

    for (const relation of [
      'all_distinct',
      'root_is_direct',
      'actor_is_direct',
      'actor_is_root',
      'all_same',
    ] as const)
      await t.test(
        `nested beneficiary matrix ${relation} settles only actor and direct author`,
        async () => {
          const rootActor = await f.actor();
          const direct =
            relation === 'root_is_direct' || relation === 'all_same'
              ? rootActor
              : await f.actor();
          const actor =
            relation === 'actor_is_root' || relation === 'all_same'
              ? rootActor
              : relation === 'actor_is_direct'
                ? direct
                : await f.actor();
          const c = await f.catalog(rootActor),
            target = c.targets[0]!,
            root = await f.publish(rootActor, c, target);
          const prior = await f.publishReply(direct, c, target, root);
          await settleOwners(rootActor, direct, actor);
          const before = new Map(
            await Promise.all(
              [
                ...new Map(
                  [rootActor, direct, actor].map((a) => [a.accountId, a]),
                ).values(),
              ].map(
                async (a) =>
                  [a.accountId, BigInt((await balance(a))!)] as const,
              ),
            ),
          );
          const reply = await f.publishReply(
            actor,
            c,
            target,
            root,
            f.replyBody(c, target, root, {
              replyTo: { replyId: prior.id, expectedRevision: prior.revision },
              authorMode: relation === 'all_distinct' ? 'anonymous' : 'named',
            }),
          );
          const rows = await units(actor, reply.input.clientRequestId);
          assert.deepEqual(
            shape(rows),
            [
              `${actor.accountId}:comment`,
              ...(actor.accountId !== direct.accountId
                ? [`${direct.accountId}:received_comment`]
                : []),
            ].sort(),
          );
          assert.equal((await settle(rows)).settled, rows.length);
          await assertAwarded(rows);
          for (const a of [rootActor, direct, actor]) {
            const delta =
              rows.filter((u) => u.beneficiary_id === a.accountId).length * 3;
            assert.equal(
              BigInt((await balance(a))!) - before.get(a.accountId)!,
              BigInt(delta),
            );
          }
          if (relation === 'all_distinct') {
            assert.equal(
              rows.some((u) => u.beneficiary_id === rootActor.accountId),
              false,
            );
            const noticeRecipients = (
              await f.pool.query<{ recipient_account_id: string }>(
                'SELECT recipient_account_id FROM whaleu_ratings.notice_obligations WHERE event_id=$1 ORDER BY recipient_account_id',
                [rows[0]!.event_id],
              )
            ).rows.map((r) => r.recipient_account_id);
            assert.deepEqual(
              noticeRecipients,
              [rootActor.accountId, direct.accountId].sort(),
            );
          }
        },
      );

    for (const unknown of ['actor', 'recipient', 'both'] as const)
      await t.test(
        `unknown ${unknown} does not create zero history or block another beneficiary`,
        async () => {
          const rootActor =
            unknown === 'recipient' || unknown === 'both'
              ? await unknownActor()
              : await f.actor();
          const actor =
            unknown === 'actor' || unknown === 'both'
              ? await unknownActor()
              : await f.actor();
          const c = await f.catalog(rootActor),
            target = c.targets[0]!,
            root = await f.publish(rootActor, c, target);
          const rootUnits = await units(rootActor, root.input.clientRequestId);
          const rootResult = await settle(rootUnits);
          assert.equal(
            rootResult.blockedBaseline,
            unknown === 'recipient' || unknown === 'both' ? 1 : 0,
          );
          const reply = await f.publishReply(actor, c, target, root),
            rows = await units(actor, reply.input.clientRequestId);
          const result = await settle(rows);
          assert.equal(result.settled, unknown === 'both' ? 0 : 1);
          for (const a of [rootActor, actor]) {
            const isUnknown =
              (a === actor && unknown !== 'recipient') ||
              (a === rootActor && unknown !== 'actor');
            if (!isUnknown) continue;
            assert.equal(await balance(a), null);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_experience.records WHERE owner_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
            await inTransaction(f.pool, (tx) =>
              establishSyntheticExperienceBaseline(tx, a.accountId, {
                balance: 0n,
              }),
            );
          }
          await settleOwners(rootActor, actor);
          await assertAwarded(rows);
          assert.equal((await settle(rows)).completed, rows.length);
        },
      );

    await t.test(
      'community and rating comment/received_comment share fifth and sixth quota and level effects',
      async () => {
        const actor = await f.actor(),
          receiver = await f.actor(),
          c = await f.catalog(receiver),
          target = c.targets[0]!;
        const root = await f.publish(receiver, c, target);
        await settleOwners(receiver);
        const space = randomUUID(),
          post = randomUUID(),
          community = f.app.get(CommunityRepository);
        await f.pool.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic shared rating quota',true)",
          [space],
        );
        await f.pool.query(
          "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic shared source','named','open')",
          [post, space, receiver.accountId],
        );
        for (let i = 0; i < 4; i++) {
          const id = randomUUID();
          await inTransaction(f.pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Synthetic quota comment','named')",
              [id, post, actor.accountId],
            );
            await community.event(
              `comment:${id}:created`,
              'comment_created',
              id,
              tx,
              {
                experienceSourceVersion: 1,
                actorAccountId: actor.accountId,
                actorAuthorMode: 'named',
                resourceAuthorMode: 'named',
                recipientAccountIds: [receiver.accountId],
              },
            );
          });
        }
        await settleOwners(actor, receiver);
        assert.equal(await balance(actor), '12');
        for (const [ordinal, delta] of [
          [5, '3'],
          [6, '0'],
        ] as const) {
          const reply = await f.publishReply(actor, c, target, root),
            rows = await units(actor, reply.input.clientRequestId);
          assert.equal(
            (await settle(rows)).settled,
            2,
            `quota unit ${ordinal}`,
          );
          await assertAwarded(rows, delta);
        }
        assert.equal(await balance(actor), '15');
        assert.equal(await balance(receiver), '18');
        const buckets = (
          await f.pool.query<{
            owner_id: string;
            action: string;
            rewarded_count: number;
          }>(
            "SELECT owner_id,action,rewarded_count FROM whaleu_experience.daily_buckets WHERE (owner_id=$1 AND action='comment') OR (owner_id=$2 AND action='received_comment') ORDER BY owner_id",
            [actor.accountId, receiver.accountId],
          )
        ).rows;
        assert.equal(buckets.length, 2);
        assert.ok(buckets.every((b) => b.rewarded_count === 5));
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_experience.unlock_notices WHERE owner_id=$1 AND from_level=1 AND to_level=2',
              [actor.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      'deletion before settlement retains earned source and produces no deduction or quota refund',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        const reply = await f.publishReply(actor, c, target, root),
          rows = await units(actor, reply.input.clientRequestId);
        await f.deleteReply(actor, c, target, root, reply);
        await f.deleteRoot(owner, c, target, root);
        const deleted = (
          await f.pool.query<{
            expected_experience_units: number;
            groups: string;
          }>(
            `SELECT e.expected_experience_units,(SELECT count(*)::text FROM whaleu_ratings.reward_groups g WHERE g.event_id=e.id) AS groups FROM whaleu_ratings.effect_events e WHERE e.root_id=$1 AND e.event_kind LIKE '%_deleted'`,
            [root.id],
          )
        ).rows;
        assert.equal(deleted.length, 2);
        assert.ok(
          deleted.every(
            (e) => e.expected_experience_units === 0 && e.groups === '0',
          ),
        );
        await settleOwners(owner, actor);
        await assertAwarded(rows);
        assert.equal(await balance(owner), '6');
        assert.equal(await balance(actor), '3');
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_experience.settlements WHERE owner_id=ANY($1::uuid[]) AND action LIKE 'delete_%'",
              [[owner.accountId, actor.accountId]],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'review and phone revocation after capture cannot recalculate historical beneficiaries',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const reply = await f.publishReply(actor, c, target, root),
          rows = await units(actor, reply.input.clientRequestId);
        await setRatingReviewState(
          f.pool,
          reply.approval.decisionId,
          'revoked',
        );
        await f.certify(actor.accountId, { phone: 'unverified' });
        assert.equal((await settle(rows)).settled, 2);
        await assertAwarded(rows);
      },
    );

    await t.test(
      'duplicate concurrent workers produce one real settlement and one completed result',
      async () => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!,
          root = await f.publish(actor, c, target),
          rows = await units(actor, root.input.clientRequestId);
        const results = await Promise.all([settle(rows), settle(rows)]);
        assert.equal(
          results.reduce((n, r) => n + r.settled, 0),
          1,
        );
        assert.equal(
          results.reduce((n, r) => n + r.completed, 0),
          1,
        );
        await assertAwarded(rows);
        assert.equal(await balance(actor), '3');
      },
    );

    await t.test(
      'acknowledgement failure rolls back real ledger, bucket and owner state, then safely retries',
      async (sub) => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!,
          root = await f.publish(actor, c, target),
          rows = await units(actor, root.input.clientRequestId);
        const facade = f.app.get(RatingExperienceSourceFacade);
        const fault = sub.mock.method(facade, 'acknowledge', async () => {
          throw new Error('Synthetic failure after real settlement');
        });
        const failed = await worker.run({
          mode: 'apply',
          unitIds: [rows[0]!.id],
        });
        fault.mock.restore();
        assert.equal(failed.failed, 1);
        assert.equal(await balance(actor), '0');
        assert.deepEqual(await ledger(rows), []);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_experience.daily_buckets WHERE owner_id=$1',
              [actor.accountId],
            )
          ).rowCount,
          0,
        );
        const work = (
          await f.pool.query<{ state: string; attempts: number }>(
            'SELECT state,attempts FROM whaleu_experience.work WHERE unit_id=$1',
            [rows[0]!.id],
          )
        ).rows[0]!;
        assert.equal(work.state, 'pending');
        assert.equal(work.attempts, 1);
        assert.equal((await settle(rows)).settled, 1);
        await assertAwarded(rows);
      },
    );

    await t.test(
      'ack rejects another beneficiary settlement and raw completion cannot forge a ledger',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const reply = await f.publishReply(actor, c, target, root),
          rows = await units(actor, reply.input.clientRequestId);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp() WHERE unit_id=$1",
              [rows[0]!.id],
            ),
          ),
        );
        assert.equal((await settle(rows)).settled, 2);
        const records = await assertAwarded(rows),
          facade = f.app.get(RatingExperienceSourceFacade);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            facade.acknowledge(
              rows[0]!.id,
              records.find((r) => r.id !== rows[0]!.id)!.settlement_id,
              tx,
            ),
          ),
          /settlement does not match/,
        );
        await inTransaction(f.pool, (tx) =>
          facade.acknowledge(
            rows[0]!.id,
            records.find((r) => r.id === rows[0]!.id)!.settlement_id,
            tx,
          ),
        );
      },
    );
    for (const collisionKind of ['group', 'unit'] as const)
      await t.test(
        `same UUID in real community and rating ${collisionKind} sources fails at the typed registry and rolls back publication`,
        async (sub) => {
          const actor = await f.actor(),
            c = await f.catalog(actor),
            target = c.targets[0]!,
            post = randomUUID(),
            space = randomUUID();
          await f.pool.query(
            "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic collision source',true)",
            [space],
          );
          await inTransaction(f.pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic collision source','named','open')",
              [post, space, actor.accountId],
            );
            await f.app
              .get(CommunityRepository)
              .event(`post:${post}:created`, 'post_created', post, tx, {
                experienceSourceVersion: 1,
                actorAccountId: actor.accountId,
                actorAuthorMode: 'named',
                resourceAuthorMode: 'named',
              });
          });
          const existing = (
            await f.pool.query<{ unit_id: string; group_id: string }>(
              'SELECT u.id AS unit_id,u.group_id FROM whaleu_community.reward_source_units u JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id WHERE g.post_id=$1',
              [post],
            )
          ).rows[0]!;
          const collision =
            collisionKind === 'group' ? existing.group_id : existing.unit_id;
          assert.match(collision, /^[0-9a-f-]{36}$/);
          const input = f.body(c, target);
          await approveRating(f.pool, f.envelope(actor, c, target, input));
          const counts = async () =>
            (
              await f.pool.query(`SELECT
            (SELECT count(*)::text FROM whaleu_ratings.comments) AS comments,
            (SELECT count(*)::text FROM whaleu_ratings.effect_events) AS events,
            (SELECT count(*)::text FROM whaleu_ratings.reward_groups) AS groups,
            (SELECT count(*)::text FROM whaleu_ratings.reward_units) AS units,
            (SELECT count(*)::text FROM whaleu_experience.source_groups) AS source_groups,
            (SELECT count(*)::text FROM whaleu_experience.source_units) AS source_units,
            (SELECT count(*)::text FROM whaleu_experience.work) AS work`)
            ).rows[0];
          const before = await counts(),
            capture = f.app.get(RatingEffectsCapture),
            original = capture.captureCreated.bind(capture);
          let failure: unknown;
          const observer = sub.mock.method(
            capture,
            'captureCreated',
            async (...args: Parameters<typeof original>) => {
              try {
                return await original(...args);
              } catch (error) {
                failure = error;
                throw error;
              }
            },
          );
          // This disposable test-only BEFORE hook chooses a deterministic UUID.
          // All actual source guards, FKs and registry triggers remain enabled.
          await f.pool.query(
            `CREATE FUNCTION whaleu_ratings.synthetic_reward_collision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.id:='${collision}'::uuid;RETURN NEW;END $$`,
          );
          await f.pool.query(
            `CREATE TRIGGER a_synthetic_reward_collision BEFORE INSERT ON whaleu_ratings.reward_${collisionKind === 'group' ? 'groups' : 'units'} FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_reward_collision()`,
          );
          try {
            const response = await f
              .auth(
                request(f.http).post(
                  `/v1/ratings/targets/${target.id}/comments`,
                ),
                actor,
              )
              .send(input);
            assert.ok(response.status >= 400, JSON.stringify(response.body));
            assert.ok(failure && typeof failure === 'object');
            assert.equal('code' in failure && failure.code, '23505');
            assert.equal(
              'constraint' in failure && failure.constraint,
              `source_${collisionKind === 'group' ? 'groups' : 'units'}_pkey`,
            );
            assert.deepEqual(await counts(), before);
            assert.equal(
              (
                await inTransaction(f.pool, (tx) =>
                  f.app
                    .get(ExperienceSourceRouter)
                    .loadUnit(existing.unit_id, tx),
                )
              )?.sourceDomain,
              'community',
            );
          } finally {
            observer.mock.restore();
            await f.pool.query(
              `DROP TRIGGER a_synthetic_reward_collision ON whaleu_ratings.reward_${collisionKind === 'group' ? 'groups' : 'units'}`,
            );
            await f.pool.query(
              'DROP FUNCTION whaleu_ratings.synthetic_reward_collision()',
            );
          }
        },
      );
  },
);
