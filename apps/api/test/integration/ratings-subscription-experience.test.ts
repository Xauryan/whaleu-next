import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { SavedRepository } from '../../src/community/saved/repository.js';
import { ExperienceClock } from '../../src/experience/repository.js';
import { ExperienceIngressService } from '../../src/experience/ingress.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';
import { RatingExperienceSourceFacade } from '../../src/ratings/experience-source/facade.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';

interface Unit {
  id: string;
  group_id: string;
  event_id: string;
  beneficiary_id: string;
  action: 'like_save';
  enrollment_order: string;
}

// Disposable synthetic identities and approvals, ordinary subscription HTTP
// commands, SQL-owned source capture and the unchanged real Experience worker.
test(
  'target subscriptions settle target-only v3 sources in the existing like/save pool',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const worker = f.app.get(ExperienceWorker);
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    type Catalog = Awaited<ReturnType<typeof f.catalog>>;
    type Target = Catalog['targets'][number];
    const units = async (actor: Actor, requestId: string): Promise<Unit[]> =>
      (
        await f.pool.query<Unit>(
          `SELECT u.* FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
       JOIN whaleu_ratings.effect_events e ON e.id=g.event_id WHERE e.actor_account_id=$1 AND e.request_id=$2 ORDER BY u.enrollment_order,u.id`,
          [actor.accountId, requestId],
        )
      ).rows;
    const balance = async (actor: Actor) =>
      (
        await f.pool.query<{ balance: string }>(
          'SELECT balance::text FROM whaleu_experience.account_states WHERE owner_id=$1',
          [actor.accountId],
        )
      ).rows[0]?.balance ?? null;
    const settleIds = async (unitIds: string[]) => {
      assert.ok(unitIds.length <= 50);
      const result = await worker.run({ mode: 'apply', unitIds });
      assert.equal(result.failed, 0, JSON.stringify(result));
      assert.equal(result.sourceUnavailable, 0, JSON.stringify(result));
      return result;
    };
    const settle = (rows: readonly Unit[]) => settleIds(rows.map((u) => u.id));
    const settleOwners = async (...actors: Actor[]) => {
      const ids = (
        await f.pool.query<{ unit_id: string }>(
          "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=ANY($1::uuid[]) AND state<>'completed' ORDER BY enrollment_order,unit_id",
          [actors.map((a) => a.accountId)],
        )
      ).rows.map((r) => r.unit_id);
      if (ids.length) assert.equal((await settleIds(ids)).settled, ids.length);
    };
    const ledger = async (rows: readonly Unit[]) =>
      (
        await f.pool.query<{
          unit_id: string;
          settlement_id: string;
          owner_id: string;
          action: string;
          outcome: string;
          applied_delta: string;
          reward_day: string;
          state: string;
          source_domain: string;
          source_version: number;
          exact_time: boolean;
          source_id: string;
        }>(
          `SELECT u.id AS unit_id,s.id AS settlement_id,s.owner_id,s.action,s.outcome,s.applied_delta::text,s.reward_day::text,
       w.state,su.source_domain,g.source_version,r.occurred_at=g.occurred_at AS exact_time,g.event_id AS source_id
       FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
       JOIN whaleu_experience.source_units su ON su.unit_id=u.id JOIN whaleu_experience.work w ON w.unit_id=u.id
       JOIN whaleu_experience.settlements s ON s.unit_id=u.id JOIN whaleu_experience.records r ON r.settlement_id=s.id
       WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`,
          [rows.map((u) => u.id)],
        )
      ).rows;
    const assertAwarded = async (rows: readonly Unit[], capped = false) => {
      const records = await ledger(rows);
      assert.equal(records.length, rows.length);
      for (const record of records) {
        const source = rows.find((u) => u.id === record.unit_id)!;
        assert.equal(record.owner_id, source.beneficiary_id);
        assert.equal(record.action, 'like_save');
        assert.equal(record.applied_delta, capped ? '0' : '1');
        assert.equal(record.outcome, capped ? 'capped' : 'awarded');
        assert.equal(record.state, 'completed');
        assert.equal(record.source_domain, 'ratings');
        assert.equal(record.source_version, 3);
        assert.equal(record.source_id, source.event_id);
        assert.equal(record.exact_time, true);
      }
      return records;
    };
    const state = async (actor: Actor, catalog: Catalog, target: Target) => {
      const response = await f
        .auth(
          request(f.http).get(`/v1/ratings/targets/${target.id}/subscription`),
          actor,
        )
        .query(catalog.regionId ? { regionId: catalog.regionId } : {});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(
        response.body.status,
        'known',
        JSON.stringify(response.body),
      );
      return response.body as {
        status: 'known';
        targetId: string;
        revision: string;
        subscribed: boolean;
        count: number;
      };
    };
    const subscribe = async (
      actor: Actor,
      catalog: Catalog,
      target: Target,
      subscribed: boolean,
    ) => {
      const current = await state(actor, catalog, target);
      const input = {
        clientRequestId: randomUUID(),
        regionId: catalog.regionId,
        expectedTargetRevision: target.revision,
        expectedSubscriptionRevision: current.revision,
        subscribed,
      };
      const path = `/v1/ratings/targets/${target.id}/subscription`;
      const response = await f
        .auth(request(f.http).put(path), actor)
        .send(input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(
        response.body.outcome,
        current.subscribed === subscribed ? 'noop' : 'applied',
        JSON.stringify(response.body),
      );
      return {
        input,
        path,
        receipt: response.body,
        units: await units(actor, input.clientRequestId),
      };
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
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-rating-subscription-unknown',$1,$2)",
          [subject, accountId],
        );
      });
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-rating-subscription-unknown',
          subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      const facts = await f.certify(accountId);
      const actor = { ...session, accessToken, refreshToken, facts };
      assert.equal(await balance(actor), null);
      return actor;
    };

    await t.test(
      'a target without score or content captures one actor, no creator reward, and no fake root',
      async () => {
        const creator = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(creator),
          target = c.targets[0]!;
        const first = await subscribe(actor, c, target, true);
        assert.equal(first.units.length, 1);
        assert.equal(first.units[0]!.beneficiary_id, actor.accountId);
        const source = (
          await f.pool.query<{
            event_kind: string;
            source_version: number;
            rule_version: string;
            target_id: string;
            root_id: string | null;
            root_author_id: string | null;
            author_mode: string | null;
            reply_id: string | null;
            reply_to_id: string | null;
            direct_reply_author_id: string | null;
            like_transition_id: string | null;
            subject_author_id: string | null;
            subject_author_mode: string | null;
            subscription_transition_id: string;
            expected_experience_units: number;
            expected_direct_notice_obligations: number;
            exact_transition: boolean;
            exact_group: boolean;
          }>(
            `SELECT e.*,ROW(e.target_id,e.actor_account_id,e.request_id,e.occurred_at,e.mutation_transaction)
        IS NOT DISTINCT FROM ROW(t.target_id,t.account_id,t.request_id,t.occurred_at,t.mutation_transaction) AS exact_transition,
       g.subscription_transition_id=e.subscription_transition_id AND g.source_version=3 AND g.root_id IS NULL AND g.root_author_id IS NULL AS exact_group
       FROM whaleu_ratings.effect_events e JOIN whaleu_ratings.subscription_transitions t ON t.id=e.subscription_transition_id
       JOIN whaleu_ratings.reward_groups g ON g.event_id=e.id WHERE e.id=$1`,
            [first.units[0]!.event_id],
          )
        ).rows[0]!;
        assert.equal(source.source_version, 3);
        assert.equal(source.rule_version, 'rating-subscriptions-v1');
        assert.equal(source.event_kind, 'target_subscribed');
        assert.equal(source.target_id, target.id);
        for (const field of [
          'root_id',
          'root_author_id',
          'author_mode',
          'reply_id',
          'reply_to_id',
          'direct_reply_author_id',
          'like_transition_id',
          'subject_author_id',
          'subject_author_mode',
        ] as const)
          assert.equal(source[field], null);
        assert.equal(source.expected_experience_units, 1);
        assert.equal(source.expected_direct_notice_obligations, 0);
        assert.equal(source.exact_transition, true);
        assert.equal(source.exact_group, true);
        const loaded = await inTransaction(f.pool, (tx) =>
          f.app.get(ExperienceSourceRouter).loadUnit(first.units[0]!.id, tx),
        );
        assert.equal(loaded?.sourceKind, 'rating_event');
        assert.equal(loaded?.sourceId, first.units[0]!.event_id);
        assert.equal(loaded?.action, 'like_save');
        assert.equal(loaded?.beneficiaryId, actor.accountId);
        const dry = await worker.run({
          mode: 'dry-run',
          unitIds: first.units.map((u) => u.id),
        });
        assert.equal(dry.pending, 1);
        assert.deepEqual(await ledger(first.units), []);
        assert.equal((await settle(first.units)).settled, 1);
        await assertAwarded(first.units);
        assert.equal(await balance(actor), '1');
        assert.equal(await balance(creator), '0');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.comments WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.notice_obligations WHERE event_id=$1',
              [first.units[0]!.event_id],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'same-state commands and replay never reward, unsubscribe never deducts, and a new epoch rewards once',
      async () => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!;
        const first = await subscribe(actor, c, target, true);
        const noop = await subscribe(actor, c, target, true);
        assert.deepEqual(noop.units, []);
        const removed = await subscribe(actor, c, target, false);
        assert.deepEqual(removed.units, []);
        const falseNoop = await subscribe(actor, c, target, false);
        assert.deepEqual(falseNoop.units, []);
        const replay = await f
          .auth(request(f.http).put(first.path), actor)
          .send(first.input);
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.deepEqual(replay.body, first.receipt);
        assert.equal((await state(actor, c, target)).subscribed, false);
        assert.equal((await settle(first.units)).settled, 1);
        const second = await subscribe(actor, c, target, true);
        assert.notEqual(second.units[0]!.event_id, first.units[0]!.event_id);
        assert.equal((await settle(second.units)).settled, 1);
        await assertAwarded([...first.units, ...second.units]);
        assert.equal(
          (await settle([...first.units, ...second.units])).completed,
          2,
        );
        assert.equal(await balance(actor), '2');
        const effects = (
          await f.pool.query<{
            event_kind: string;
            expected_experience_units: number;
            groups: string;
          }>(
            `SELECT e.event_kind,e.expected_experience_units,(SELECT count(*)::text FROM whaleu_ratings.reward_groups g WHERE g.event_id=e.id) AS groups
       FROM whaleu_ratings.effect_events e WHERE e.target_id=$1 AND e.source_version=3 ORDER BY e.event_sequence`,
            [target.id],
          )
        ).rows;
        assert.deepEqual(effects, [
          {
            event_kind: 'target_subscribed',
            expected_experience_units: 1,
            groups: '1',
          },
          {
            event_kind: 'target_unsubscribed',
            expected_experience_units: 0,
            groups: '0',
          },
          {
            event_kind: 'target_subscribed',
            expected_experience_units: 1,
            groups: '1',
          },
        ]);
        const transition = (
          await f.pool.query<
            Parameters<RatingEffectsCapture['captureSubscription']>[1]
          >(
            'SELECT id,target_id,account_id,request_id,delta,target_order::text,occurred_at::text FROM whaleu_ratings.subscription_transitions WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, first.input.clientRequestId],
          )
        ).rows[0]!;
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            f.app.get(RatingEffectsCapture).captureSubscription(tx, transition),
          ),
          /Fresh rating subscription source is absent/,
        );
      },
    );

    await t.test(
      'known membership never implies known XP history; the captured epoch survives unsubscribe until baseline recovery',
      async () => {
        const creator = await f.actor(),
          actor = await unknownActor(),
          c = await f.catalog(creator),
          target = c.targets[0]!;
        const positive = await subscribe(actor, c, target, true);
        assert.equal((await state(actor, c, target)).subscribed, true);
        const blocked = await settle(positive.units);
        assert.equal(blocked.blockedBaseline, 1);
        assert.equal(await balance(actor), null);
        assert.deepEqual(await ledger(positive.units), []);
        await subscribe(actor, c, target, false);
        await inTransaction(f.pool, (tx) =>
          establishSyntheticExperienceBaseline(tx, actor.accountId, {
            balance: 0n,
          }),
        );
        assert.equal((await settle(positive.units)).settled, 1);
        await assertAwarded(positive.units);
        assert.equal(await balance(actor), '1');
        assert.equal(await balance(creator), '0');
      },
    );

    await t.test(
      'community likes, Saved, rating likes and target subscriptions share tenth/eleventh limits and Shanghai day',
      async (sub) => {
        const creator = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(creator),
          target = c.targets[0]!,
          root = await f.publish(creator, c, target);
        await settleOwners(creator);
        let now = '2026-10-08T15:59:59.999Z';
        sub.mock.method(
          f.app.get(ExperienceClock),
          'now',
          async (tx: PoolClient) =>
            (
              await tx.query<{ at: Date; day: string }>(
                "SELECT $1::timestamptz AS at,($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS day",
                [now],
              )
            ).rows[0]!,
        );
        const space = randomUUID(),
          community = f.app.get(CommunityRepository),
          saved = f.app.get(SavedRepository);
        await f.pool.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic subscription quota sources',true)",
          [space],
        );
        for (let i = 0; i < 8; i++)
          await inTransaction(f.pool, async (tx) => {
            const post = randomUUID();
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic shared quota source','named','open')",
              [post, space, creator.accountId],
            );
            if (i < 4) {
              const membership = (
                await tx.query<{ like_id: string }>(
                  'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2) RETURNING like_id',
                  [post, actor.accountId],
                )
              ).rows[0]!;
              await community.event(
                `post:like:${membership.like_id}`,
                'post_liked',
                post,
                tx,
                {
                  experienceSourceVersion: 1,
                  actorAccountId: actor.accountId,
                  actorAuthorMode: null,
                  resourceAuthorMode: 'named',
                  recipientAccountId: creator.accountId,
                  likeId: membership.like_id,
                },
              );
            } else {
              const changed = await saved.setSaved(
                actor.accountId,
                post,
                true,
                tx,
              );
              assert.ok(changed);
              const ids = await saved.obligations(
                changed.epochId,
                actor.accountId,
                creator.accountId,
                true,
                tx,
              );
              await community.event(
                `save:${changed.epochId}:started`,
                'post_saved',
                changed.epochId,
                tx,
                {
                  experienceSourceVersion: 1,
                  actorAccountId: actor.accountId,
                  actorAuthorMode: null,
                  resourceAuthorMode: 'named',
                  rewardObligationIds: ids,
                  postId: post,
                  saveEpochId: changed.epochId,
                  sequence: changed.sequence,
                  occurredAt: changed.at.toISOString(),
                  desired: true,
                },
              );
            }
          });
        const likeState = await f.auth(
          request(f.http).get(`/v1/ratings/comments/${root.id}/like`),
          actor,
        );
        assert.equal(likeState.status, 200);
        const liked = await f
          .auth(
            request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
            actor,
          )
          .send({
            clientRequestId: randomUUID(),
            regionId: c.regionId,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRevision: root.revision,
            expectedLikeRevision: likeState.body.revision,
            liked: true,
          });
        assert.equal(liked.status, 200, JSON.stringify(liked.body));
        await settleOwners(creator, actor);
        assert.equal(await balance(actor), '9');
        const creatorBefore = await balance(creator);
        const tenth = await subscribe(actor, c, target, true);
        assert.equal((await settle(tenth.units)).settled, 1);
        assert.equal(
          (await assertAwarded(tenth.units))[0]!.reward_day,
          '2026-10-08',
        );
        await subscribe(actor, c, target, false);
        const eleventh = await subscribe(actor, c, target, true);
        assert.equal((await settle(eleventh.units)).settled, 1);
        const capped = await assertAwarded(eleventh.units, true);
        assert.equal(await balance(actor), '10');
        assert.equal(await balance(creator), creatorBefore);
        assert.deepEqual(
          (
            await f.pool.query<{
              rewarded_count: number;
              refund_count: number;
            }>(
              "SELECT rewarded_count,refund_count FROM whaleu_experience.daily_buckets WHERE owner_id=$1 AND action='like_save' AND reward_day='2026-10-08'",
              [actor.accountId],
            )
          ).rows,
          [{ rewarded_count: 10, refund_count: 0 }],
        );
        await subscribe(actor, c, target, false);
        const nextDay = await subscribe(actor, c, target, true);
        now = '2026-10-08T16:00:00.000Z';
        assert.equal((await settle(eleventh.units)).completed, 1);
        assert.deepEqual(await ledger(eleventh.units), capped);
        assert.equal((await settle(nextDay.units)).settled, 1);
        assert.equal(
          (await assertAwarded(nextDay.units))[0]!.reward_day,
          '2026-10-09',
        );
        assert.equal(await balance(actor), '11');
      },
    );

    for (const missing of ['capture', 'work'] as const)
      await t.test(
        `missing subscription ${missing} rolls back transition, source and receipt`,
        async (sub) => {
          const actor = await f.actor(),
            c = await f.catalog(actor),
            target = c.targets[0]!;
          const initial = await state(actor, c, target);
          const input = {
            clientRequestId: randomUUID(),
            regionId: c.regionId,
            expectedTargetRevision: target.revision,
            expectedSubscriptionRevision: initial.revision,
            subscribed: true,
          };
          const fault =
            missing === 'capture'
              ? sub.mock.method(
                  f.app.get(RatingEffectsCapture),
                  'captureSubscription',
                  async () => {},
                )
              : sub.mock.method(
                  f.app.get(ExperienceIngressService),
                  'enqueue',
                  async () => {},
                );
          const failed = await f
            .auth(
              request(f.http).put(
                `/v1/ratings/targets/${target.id}/subscription`,
              ),
              actor,
            )
            .send(input);
          fault.mock.restore();
          assert.ok(failed.status >= 400, JSON.stringify(failed.body));
          assert.deepEqual(await state(actor, c, target), initial);
          assert.deepEqual(await units(actor, input.clientRequestId), []);
          for (const table of [
            'subscription_transitions',
            'effect_events',
            'requests',
          ]) {
            const accountColumn =
              table === 'effect_events' ? 'actor_account_id' : 'account_id';
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_ratings.${table} WHERE ${accountColumn}=$1 AND request_id=$2`,
                  [actor.accountId, input.clientRequestId],
                )
              ).rowCount,
              0,
            );
          }
          const retry = await f
            .auth(
              request(f.http).put(
                `/v1/ratings/targets/${target.id}/subscription`,
              ),
              actor,
            )
            .send(input);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.equal(retry.body.outcome, 'applied');
          const captured = await units(actor, input.clientRequestId);
          assert.equal((await settle(captured)).settled, 1);
          await assertAwarded(captured);
        },
      );

    await t.test(
      'captured rewards ignore subsequent target review and actor phone revocation',
      async () => {
        const creator = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(creator),
          target = c.targets[0]!;
        const positive = await subscribe(actor, c, target, true);
        await setRatingReviewState(
          f.pool,
          target.approval.decisionId,
          'revoked',
        );
        await f.certify(actor.accountId, { phone: 'unverified' });
        assert.equal((await settle(positive.units)).settled, 1);
        await assertAwarded(positive.units);
        assert.equal(await balance(creator), '0');
      },
    );

    await t.test(
      'acknowledgement rollback, exact settlement and concurrent workers preserve one ledger per epoch',
      async (sub) => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!;
        const positive = await subscribe(actor, c, target, true);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp() WHERE unit_id=$1",
              [positive.units[0]!.id],
            ),
          ),
        );
        const facade = f.app.get(RatingExperienceSourceFacade);
        const fault = sub.mock.method(facade, 'acknowledge', async () => {
          throw new Error('Synthetic v3 acknowledgement fault');
        });
        const failed = await worker.run({
          mode: 'apply',
          unitIds: positive.units.map((u) => u.id),
        });
        fault.mock.restore();
        assert.equal(failed.failed, 1);
        assert.deepEqual(await ledger(positive.units), []);
        assert.equal(await balance(actor), '0');
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_experience.daily_buckets WHERE owner_id=$1 AND action='like_save'",
              [actor.accountId],
            )
          ).rowCount,
          0,
        );
        const results = await Promise.all([
          settle(positive.units),
          settle(positive.units),
        ]);
        assert.equal(
          results.reduce((n, r) => n + r.settled, 0),
          1,
        );
        assert.equal(
          results.reduce((n, r) => n + r.completed, 0),
          1,
        );
        const records = await assertAwarded(positive.units);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            facade.acknowledge(positive.units[0]!.id, randomUUID(), tx),
          ),
          /settlement does not match/,
        );
        await inTransaction(f.pool, (tx) =>
          facade.acknowledge(
            positive.units[0]!.id,
            records[0]!.settlement_id,
            tx,
          ),
        );
        assert.equal(await balance(actor), '1');
      },
    );

    await t.test(
      'owner-held settlement never reacquires target locks held by a concurrent new subscription epoch',
      async () => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!;
        const first = await subscribe(actor, c, target, true);
        await subscribe(actor, c, target, false);
        const clock = f.app.get(ExperienceClock),
          original = clock.now.bind(clock);
        let reached!: () => void, release!: () => void;
        const started = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        clock.now = async (tx) => {
          reached();
          await held;
          return original(tx);
        };
        let processing: ReturnType<typeof settle> | undefined;
        let writing: ReturnType<typeof subscribe> | undefined;
        try {
          processing = settle(first.units);
          await Promise.race([
            started,
            sleep(5000).then(() => {
              throw new Error('Worker did not reach owner-held clock');
            }),
          ]);
          writing = subscribe(actor, c, target, true);
          let waiting = false;
          for (let i = 0; i < 100 && !waiting; i++) {
            waiting = !!(
              await f.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%whaleu_experience.owners%'",
              )
            ).rowCount;
            if (!waiting) await sleep(10);
          }
          assert.equal(
            waiting,
            true,
            'New epoch capture holds target and waits for its XP owner',
          );
          release();
          assert.equal((await processing).settled, 1);
          assert.equal((await writing).receipt.outcome, 'applied');
        } finally {
          release();
          clock.now = original;
          await Promise.allSettled(
            [processing, writing].filter((v) => v !== undefined),
          );
        }
        await settleOwners(actor);
        await assertAwarded(first.units);
        assert.equal(await balance(actor), '2');
      },
    );
  },
);
