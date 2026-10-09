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
import type { ExperienceEnqueueUnit } from '../../src/experience/ingress.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';
import { RatingExperienceSourceFacade } from '../../src/ratings/experience-source/facade.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';

interface Unit {
  id: string;
  group_id: string;
  event_id: string;
  beneficiary_id: string;
  action: 'like_save' | 'received_like_save';
  enrollment_order: string;
}

// Ordinary HTTP commands, native owner facts and the real Experience worker.
// Synthetic review, history and clock controls are confined to this suite.
test(
  'rating likes settle immutable v2 sources through the real Experience ledger',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const worker = f.app.get(ExperienceWorker);
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    type Catalog = Awaited<ReturnType<typeof f.catalog>>;
    type Target = Catalog['targets'][number];
    type Content = { id: string; revision: string };
    const units = async (actor: Actor, requestId: string): Promise<Unit[]> =>
      (
        await f.pool.query<Unit>(
          `SELECT u.* FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
     JOIN whaleu_ratings.effect_events e ON e.id=g.event_id WHERE e.actor_account_id=$1 AND e.request_id=$2
     ORDER BY u.enrollment_order,u.id`,
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
    const pendingOwners = async (...actors: Actor[]) =>
      (
        await f.pool.query<{ unit_id: string }>(
          "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=ANY($1::uuid[]) AND state<>'completed' ORDER BY enrollment_order,unit_id",
          [actors.map((a) => a.accountId)],
        )
      ).rows.map((r) => r.unit_id);
    const settleIds = async (unitIds: string[]) => {
      assert.ok(unitIds.length <= 50);
      const result = await worker.run({ mode: 'apply', unitIds });
      assert.equal(result.failed, 0, JSON.stringify(result));
      assert.equal(result.sourceUnavailable, 0, JSON.stringify(result));
      return result;
    };
    const settle = (rows: readonly Unit[]) => settleIds(rows.map((u) => u.id));
    const settleOwners = async (...actors: Actor[]) => {
      const ids = await pendingOwners(...actors);
      if (ids.length) assert.equal((await settleIds(ids)).settled, ids.length);
    };
    const ledger = async (rows: readonly Unit[]) =>
      (
        await f.pool.query<{
          unit_id: string;
          owner_id: string;
          action: Unit['action'];
          outcome: string;
          applied_delta: string;
          state: string;
          source_domain: string;
          source_version: number;
          exact_time: boolean;
          reward_day: string;
          settlement_id: string;
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
        assert.equal(record.action, source.action);
        assert.equal(
          record.applied_delta,
          capped ? '0' : source.action === 'like_save' ? '1' : '2',
        );
        assert.equal(record.outcome, capped ? 'capped' : 'awarded');
        assert.equal(record.state, 'completed');
        assert.equal(record.source_domain, 'ratings');
        assert.equal(record.source_version, 2);
        assert.equal(record.source_id, source.event_id);
        assert.equal(record.exact_time, true);
      }
      return records;
    };
    const state = async (actor: Actor, root: Content, reply?: Content) => {
      const response = await f.auth(
        request(f.http).get(
          `/v1/ratings/${reply ? 'replies' : 'comments'}/${reply?.id ?? root.id}/like`,
        ),
        actor,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(
        response.body.status,
        'known',
        JSON.stringify(response.body),
      );
      return response.body as {
        revision: string;
        liked: boolean;
        count: number;
      };
    };
    const like = async (
      actor: Actor,
      catalog: Catalog,
      target: Target,
      root: Content,
      liked: boolean,
      reply?: Content,
    ) => {
      const current = await state(actor, root, reply);
      const input = {
        clientRequestId: randomUUID(),
        regionId: catalog.regionId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: (reply ?? root).revision,
        expectedLikeRevision: current.revision,
        liked,
        ...(reply
          ? { rootId: root.id, expectedRootRevision: root.revision }
          : {}),
      };
      const path = `/v1/ratings/${reply ? 'replies' : 'comments'}/${reply?.id ?? root.id}/like`;
      const response = await f
        .auth(request(f.http).put(path), actor)
        .send(input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(
        response.body.outcome,
        current.liked === liked ? 'noop' : 'applied',
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
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-rating-like-unknown',$1,$2)",
          [subject, accountId],
        );
      });
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-rating-like-unknown',
          subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      const facts = await f.certify(accountId);
      const actor = { ...session, accessToken, refreshToken, facts };
      assert.equal(await balance(actor), null);
      return actor;
    };

    for (const kind of ['root', 'reply'] as const)
      for (const mode of ['named', 'anonymous'] as const)
        for (const self of [true, false])
          await t.test(
            `${kind} ${mode} ${self ? 'self' : 'nonself'} rewards captured subject author with a named actor`,
            async () => {
              const owner = await f.actor(),
                rootOwner = kind === 'root' ? owner : await f.actor(),
                actor = self ? owner : await f.actor();
              const c = await f.catalog(rootOwner),
                target = c.targets[0]!;
              const root = await f.publish(
                rootOwner,
                c,
                target,
                f.body(c, target, {
                  authorMode: kind === 'root' ? mode : 'named',
                }),
              );
              const reply =
                kind === 'reply'
                  ? await f.publishReply(
                      owner,
                      c,
                      target,
                      root,
                      f.replyBody(c, target, root, { authorMode: mode }),
                    )
                  : undefined;
              await settleOwners(owner, rootOwner, actor);
              const before = new Map(
                await Promise.all(
                  [owner, rootOwner, actor].map(
                    async (a) =>
                      [a.accountId, BigInt((await balance(a))!)] as const,
                  ),
                ),
              );
              const positive = await like(actor, c, target, root, true, reply);
              assert.deepEqual(
                positive.units
                  .map((u) => `${u.beneficiary_id}:${u.action}`)
                  .sort(),
                [
                  `${actor.accountId}:like_save`,
                  ...(!self ? [`${owner.accountId}:received_like_save`] : []),
                ].sort(),
              );
              const effect = (
                await f.pool.query<{
                  source_version: number;
                  rule_version: string;
                  root_author_id: string;
                  subject_author_id: string;
                  subject_author_mode: string;
                  author_mode: string;
                  reply_to_id: string | null;
                  direct_reply_author_id: string | null;
                  like_transition_id: string;
                }>('SELECT * FROM whaleu_ratings.effect_events WHERE id=$1', [
                  positive.units[0]!.event_id,
                ])
              ).rows[0]!;
              assert.equal(effect.source_version, 2);
              assert.equal(effect.rule_version, 'rating-likes-v1');
              assert.equal(effect.root_author_id, rootOwner.accountId);
              assert.equal(effect.subject_author_id, owner.accountId);
              assert.equal(effect.subject_author_mode, mode);
              assert.equal(effect.author_mode, 'named');
              assert.equal(effect.reply_to_id, null);
              assert.equal(effect.direct_reply_author_id, null);
              assert.match(effect.like_transition_id, /^[0-9a-f-]{36}$/);
              for (const u of positive.units) {
                const routed = await inTransaction(f.pool, (tx) =>
                  f.app.get(ExperienceSourceRouter).loadUnit(u.id, tx),
                );
                assert.equal(routed?.sourceKind, 'rating_event');
                assert.equal(routed?.sourceId, u.event_id);
              }
              const snapshot = await f.snapshot();
              assert.equal(
                (await worker.run({ unitIds: positive.units.map((u) => u.id) }))
                  .pending,
                positive.units.length,
              );
              assert.deepEqual(await f.snapshot(), snapshot);
              assert.equal(
                (await settle(positive.units)).settled,
                positive.units.length,
              );
              await assertAwarded(positive.units);
              assert.equal(
                BigInt((await balance(actor))!) - before.get(actor.accountId)!,
                1n,
              );
              if (!self)
                assert.equal(
                  BigInt((await balance(owner))!) -
                    before.get(owner.accountId)!,
                  2n,
                );
              if (
                rootOwner.accountId !== owner.accountId &&
                rootOwner.accountId !== actor.accountId
              )
                assert.equal(
                  BigInt((await balance(rootOwner))!),
                  before.get(rootOwner.accountId),
                );
              const recovery = await f.auth(
                request(f.http).get(
                  `/v1/ratings/like-requests/${positive.input.clientRequestId}`,
                ),
                actor,
              );
              assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
              assert.deepEqual(recovery.body, positive.receipt);
              const publicJson = JSON.stringify([
                positive.receipt,
                recovery.body,
                await state(actor, root, reply),
              ]);
              assert.ok(!publicJson.includes(owner.accountId));
              assert.ok(!publicJson.includes(positive.units[0]!.id));
            },
          );

    await t.test(
      'a nested reply rewards its own author after its quoted reply is deleted',
      async () => {
        const rootOwner = await f.actor(),
          quotedOwner = await f.actor(),
          owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(rootOwner),
          target = c.targets[0]!,
          root = await f.publish(rootOwner, c, target),
          quoted = await f.publishReply(quotedOwner, c, target, root),
          reply = await f.publishReply(
            owner,
            c,
            target,
            root,
            f.replyBody(c, target, root, {
              authorMode: 'anonymous',
              replyTo: {
                replyId: quoted.id,
                expectedRevision: quoted.revision,
              },
            }),
          );
        await settleOwners(rootOwner, quotedOwner, owner);
        await f.deleteReply(quotedOwner, c, target, root, quoted);
        const positive = await like(actor, c, target, root, true, reply);
        assert.deepEqual(
          positive.units.map((u) => `${u.beneficiary_id}:${u.action}`).sort(),
          [
            `${actor.accountId}:like_save`,
            `${owner.accountId}:received_like_save`,
          ].sort(),
        );
        assert.equal((await settle(positive.units)).settled, 2);
        await assertAwarded(positive.units);
      },
    );

    await t.test(
      'initial/noop/retry/unlike/re-like only reward real positive transitions and keep exact source time',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const initial = await like(actor, c, target, root, false);
        assert.deepEqual(initial.units, []);
        const first = await like(actor, c, target, root, true);
        const noop = await like(actor, c, target, root, true);
        assert.equal(noop.receipt.occurredAt, first.receipt.occurredAt);
        assert.deepEqual(noop.units, []);
        assert.equal((await settle(first.units)).settled, 2);
        const unlike = await like(actor, c, target, root, false);
        assert.deepEqual(unlike.units, []);
        const falseNoop = await like(actor, c, target, root, false);
        assert.equal(falseNoop.receipt.occurredAt, unlike.receipt.occurredAt);
        const retry = await f
          .auth(request(f.http).put(first.path), actor)
          .send(first.input);
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.deepEqual(retry.body, first.receipt);
        assert.equal((await state(actor, root)).liked, false);
        const second = await like(actor, c, target, root, true);
        assert.notEqual(second.units[0]!.event_id, first.units[0]!.event_id);
        assert.equal((await settle(second.units)).settled, 2);
        await assertAwarded([...first.units, ...second.units]);
        assert.equal(await balance(actor), '2');
        assert.equal(await balance(owner), '7');
        assert.equal(
          (await settle([...first.units, ...second.units])).completed,
          4,
        );
        const events = (
          await f.pool.query<{
            event_kind: string;
            expected_experience_units: number;
            groups: string;
          }>(
            `SELECT e.event_kind,e.expected_experience_units,(SELECT count(*)::text FROM whaleu_ratings.reward_groups g WHERE g.event_id=e.id) AS groups FROM whaleu_ratings.effect_events e WHERE e.root_id=$1 AND e.source_version=2 ORDER BY e.event_sequence`,
            [root.id],
          )
        ).rows;
        assert.deepEqual(events, [
          {
            event_kind: 'content_liked',
            expected_experience_units: 2,
            groups: '1',
          },
          {
            event_kind: 'content_unliked',
            expected_experience_units: 0,
            groups: '0',
          },
          {
            event_kind: 'content_liked',
            expected_experience_units: 2,
            groups: '1',
          },
        ]);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            f.app
              .get(RatingEffectsCapture)
              .captureLiked(actor.accountId, first.input.clientRequestId, tx),
          ),
          /Fresh rating source is absent/,
        );
      },
    );

    for (const unknown of ['actor', 'recipient', 'both'] as const)
      await t.test(
        `unknown ${unknown} blocks its own history only, including anonymous recipients`,
        async () => {
          const owner =
              unknown === 'actor' ? await f.actor() : await unknownActor(),
            actor =
              unknown === 'recipient' ? await f.actor() : await unknownActor();
          const c = await f.catalog(owner),
            target = c.targets[0]!,
            root = await f.publish(
              owner,
              c,
              target,
              f.body(c, target, { authorMode: 'anonymous' }),
            );
          await settleIds(await pendingOwners(owner));
          const positive = await like(actor, c, target, root, true);
          const result = await settle(positive.units);
          assert.equal(
            result.settled,
            unknown === 'both' ? 0 : 1,
            JSON.stringify(result),
          );
          for (const a of [owner, actor]) {
            if ((await balance(a)) !== null) continue;
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
          await settleOwners(owner, actor);
          await assertAwarded(positive.units);
          assert.equal((await settle(positive.units)).completed, 2);
        },
      );

    await t.test(
      'community likes, Saved and ratings share tenth/eleventh limits and Shanghai settlement day',
      async (sub) => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const clock = f.app.get(ExperienceClock);
        let now = '2026-10-08T15:59:59.999Z';
        sub.mock.method(
          clock,
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
          "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic cross-domain like pool',true)",
          [space],
        );
        for (let i = 0; i < 9; i++)
          await inTransaction(f.pool, async (tx) => {
            const post = randomUUID();
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic quota source','named','open')",
              [post, space, owner.accountId],
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
                  recipientAccountId: owner.accountId,
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
                owner.accountId,
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
        await settleOwners(owner, actor);
        assert.equal(await balance(actor), '9');
        assert.equal(await balance(owner), '21');
        const tenth = await like(actor, c, target, root, true);
        assert.equal((await settle(tenth.units)).settled, 2);
        assert.ok(
          (await assertAwarded(tenth.units)).every(
            (r) => r.reward_day === '2026-10-08',
          ),
        );
        await like(actor, c, target, root, false);
        const eleventh = await like(actor, c, target, root, true);
        assert.equal((await settle(eleventh.units)).settled, 2);
        const capped = await assertAwarded(eleventh.units, true);
        assert.equal(await balance(actor), '10');
        assert.equal(await balance(owner), '23');
        const buckets = (
          await f.pool.query<{ rewarded_count: number; refund_count: number }>(
            "SELECT rewarded_count,refund_count FROM whaleu_experience.daily_buckets WHERE reward_day='2026-10-08' AND ((owner_id=$1 AND action='like_save') OR (owner_id=$2 AND action='received_like_save'))",
            [actor.accountId, owner.accountId],
          )
        ).rows;
        assert.deepEqual(buckets, [
          { rewarded_count: 10, refund_count: 0 },
          { rewarded_count: 10, refund_count: 0 },
        ]);
        await like(actor, c, target, root, false);
        const nextDay = await like(actor, c, target, root, true);
        now = '2026-10-08T16:00:00.000Z';
        assert.equal((await settle(eleventh.units)).completed, 2);
        assert.deepEqual(await ledger(eleventh.units), capped);
        assert.equal((await settle(nextDay.units)).settled, 2);
        assert.ok(
          (await assertAwarded(nextDay.units)).every(
            (r) => r.reward_day === '2026-10-09',
          ),
        );
        assert.equal(await balance(actor), '11');
        assert.equal(await balance(owner), '25');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_experience.unlock_notices WHERE owner_id=$1 AND from_level=1 AND to_level=2',
              [owner.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      'delete, review or phone revocation after capture cannot erase anonymous subject rewards',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          rootOwner = await f.actor(),
          c = await f.catalog(rootOwner),
          target = c.targets[0]!,
          root = await f.publish(rootOwner, c, target);
        const reply = await f.publishReply(
          owner,
          c,
          target,
          root,
          f.replyBody(c, target, root, { authorMode: 'anonymous' }),
        );
        await settleOwners(owner, rootOwner);
        const positive = await like(actor, c, target, root, true, reply);
        await f.deleteReply(owner, c, target, root, reply);
        await f.deleteRoot(rootOwner, c, target, root);
        await setRatingReviewState(
          f.pool,
          reply.approval.decisionId,
          'revoked',
        );
        await f.certify(actor.accountId, { phone: 'unverified' });
        assert.equal((await settle(positive.units)).settled, 2);
        await assertAwarded(positive.units);
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_ratings.reward_units WHERE event_id IN (SELECT id FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind LIKE '%_deleted')",
              [root.id],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_experience.settlements WHERE owner_id=ANY($1::uuid[]) AND action LIKE 'delete_%'",
              [[owner.accountId, actor.accountId, rootOwner.accountId]],
            )
          ).rowCount,
          0,
        );
      },
    );

    for (const missing of ['capture', 'recipient work'] as const)
      await t.test(
        `missing ${missing} rolls back membership, effect and receipt`,
        async (sub) => {
          const owner = await f.actor(),
            actor = await f.actor(),
            c = await f.catalog(owner),
            target = c.targets[0]!,
            root = await f.publish(owner, c, target);
          await settleOwners(owner);
          const initial = await state(actor, root);
          const input = {
            clientRequestId: randomUUID(),
            regionId: c.regionId,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRevision: root.revision,
            expectedLikeRevision: initial.revision,
            liked: true,
          };
          const ingress = f.app.get(ExperienceIngressService),
            original = ingress.enqueue.bind(ingress);
          const fault =
            missing === 'capture'
              ? sub.mock.method(
                  f.app.get(RatingEffectsCapture),
                  'captureLiked',
                  async () => {},
                )
              : sub.mock.method(
                  ingress,
                  'enqueue',
                  async (
                    tx: PoolClient,
                    rows: readonly ExperienceEnqueueUnit[],
                  ) =>
                    original(
                      tx,
                      rows.filter((u) => u.action !== 'received_like_save'),
                    ),
                );
          const failed = await f
            .auth(
              request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
              actor,
            )
            .send(input);
          fault.mock.restore();
          assert.ok(failed.status >= 400, JSON.stringify(failed.body));
          assert.deepEqual(await state(actor, root), initial);
          assert.deepEqual(await units(actor, input.clientRequestId), []);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
                [actor.accountId, input.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, input.clientRequestId],
              )
            ).rowCount,
            0,
          );
          const retry = await f
            .auth(
              request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
              actor,
            )
            .send(input);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.equal(retry.body.outcome, 'applied');
          const captured = await units(actor, input.clientRequestId);
          assert.equal((await settle(captured)).settled, 2);
          await assertAwarded(captured);
        },
      );

    await t.test(
      'v2 work completion and acknowledgement require the exact beneficiary settlement',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const positive = await like(actor, c, target, root, true);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp() WHERE unit_id=$1",
              [positive.units[0]!.id],
            ),
          ),
        );
        assert.equal((await settle(positive.units)).settled, 2);
        const records = await assertAwarded(positive.units),
          first = positive.units[0]!,
          other = records.find((r) => r.unit_id !== first.id)!,
          own = records.find((r) => r.unit_id === first.id)!,
          facade = f.app.get(RatingExperienceSourceFacade);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            facade.acknowledge(first.id, other.settlement_id, tx),
          ),
          /settlement does not match/,
        );
        await inTransaction(f.pool, (tx) =>
          facade.acknowledge(first.id, own.settlement_id, tx),
        );
      },
    );

    await t.test(
      'duplicate concurrent workers and acknowledgement rollback keep one ledger per source',
      async (sub) => {
        const actor = await f.actor(),
          c = await f.catalog(actor),
          target = c.targets[0]!,
          root = await f.publish(actor, c, target);
        await settleOwners(actor);
        const positive = await like(actor, c, target, root, true);
        const facade = f.app.get(RatingExperienceSourceFacade);
        const fault = sub.mock.method(facade, 'acknowledge', async () => {
          throw new Error('Synthetic v2 acknowledgement fault');
        });
        const failed = await worker.run({
          mode: 'apply',
          unitIds: positive.units.map((u) => u.id),
        });
        fault.mock.restore();
        assert.equal(failed.failed, 1);
        assert.equal(await balance(actor), '3');
        assert.deepEqual(await ledger(positive.units), []);
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
        await assertAwarded(positive.units);
        assert.equal(await balance(actor), '4');
      },
    );

    await t.test(
      'worker holding a beneficiary never returns to mutable rating parents',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!,
          root = await f.publish(owner, c, target);
        await settleOwners(owner);
        const first = await like(actor, c, target, root, true);
        await like(actor, c, target, root, false);
        const actorUnit = first.units.find(
          (u) => u.beneficiary_id === actor.accountId,
        )!;
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
        let writing: ReturnType<typeof like> | undefined;
        try {
          processing = settle([actorUnit]);
          await Promise.race([
            started,
            sleep(5000).then(() => {
              throw new Error('Worker did not reach owner-held clock');
            }),
          ]);
          writing = like(actor, c, target, root, true);
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
            'New capture waits on beneficiary with its rating parent locks held',
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
        await settleOwners(owner, actor);
        await assertAwarded(first.units);
      },
    );
  },
);
