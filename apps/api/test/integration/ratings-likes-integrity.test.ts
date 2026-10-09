import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';

test(
  'rating likes retain exact causal chains under retries, competing actors and hostile SQL',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    type Catalog = Awaited<ReturnType<typeof f.catalog>>;
    type Target = Catalog['targets'][number];
    type Content = { id: string; revision: string };
    const capture = f.app.get(RatingEffectsCapture);
    const setup = async () => {
      const owner = await f.actor(),
        actor = await f.actor(),
        other = await f.actor(),
        c = await f.catalog(owner),
        target = c.targets[0]!,
        root = await f.publish(owner, c, target);
      return { owner, actor, other, c, target, root };
    };
    const state = async (actor: Actor, root: Content, reply?: Content) => {
      const response = await f.auth(
        request(f.http).get(
          `/v1/ratings/${reply ? 'replies' : 'comments'}/${reply?.id ?? root.id}/like`,
        ),
        actor,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.status, 'known');
      return response.body as {
        revision: string;
        count: number;
        liked: boolean;
      };
    };
    const input = (
      c: Catalog,
      target: Target,
      root: Content,
      revision: string,
      liked: boolean,
      reply?: Content,
    ) => ({
      clientRequestId: randomUUID(),
      regionId: c.regionId,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRevision: (reply ?? root).revision,
      expectedLikeRevision: revision,
      liked,
      ...(reply
        ? { rootId: root.id, expectedRootRevision: root.revision }
        : {}),
    });
    const send = (actor: Actor, root: Content, body: object, reply?: Content) =>
      f
        .auth(
          request(f.http).put(
            `/v1/ratings/${reply ? 'replies' : 'comments'}/${reply?.id ?? root.id}/like`,
          ),
          actor,
        )
        .send(body);
    const count = async (root: Content, reply?: Content) =>
      (
        await f.pool.query<{
          count: number;
          transitions: number;
          events: number;
          groups: number;
          units: number;
          notices: number;
        }>(
          `SELECT s.count,
    (SELECT count(*)::integer FROM whaleu_ratings.like_transitions WHERE root_id=$1) transitions,
    (SELECT count(*)::integer FROM whaleu_ratings.effect_events WHERE root_id=$1 AND source_version=2) events,
    (SELECT count(*)::integer FROM whaleu_ratings.reward_groups WHERE root_id=$1 AND source_version=2) groups,
    (SELECT count(*)::integer FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.effect_events e ON e.id=u.event_id WHERE e.root_id=$1 AND e.source_version=2) units,
    (SELECT count(*)::integer FROM whaleu_ratings.notice_obligations n JOIN whaleu_ratings.effect_events e ON e.id=n.event_id WHERE e.root_id=$1 AND e.source_version=2) notices
    FROM whaleu_ratings.like_states s WHERE s.subject_id=$2`,
          [root.id, (reply ?? root).id],
        )
      ).rows[0]!;
    const reject = (
      work: (tx: PoolClient) => Promise<unknown>,
      codes = ['23514', '23505'],
    ) =>
      assert.rejects(
        inTransaction(f.pool, work),
        (error: unknown) =>
          !!error &&
          typeof error === 'object' &&
          'code' in error &&
          codes.includes(String(error.code)),
      );
    const newRequest = async (
      tx: PoolClient,
      actor: string,
      key: string,
      operation = 'set_comment_like',
    ) => {
      await tx.query(
        'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
        [actor, key, operation, 'c'.repeat(64)],
      );
    };
    const rawSet = async (
      tx: PoolClient,
      actor: Actor,
      root: Content,
      target: Target,
      liked: boolean,
      skipCapture = false,
      reply?: Content,
      key = randomUUID(),
    ) => {
      const subject = reply ?? root;
      const operation = reply ? 'set_reply_like' : 'set_comment_like';
      await newRequest(tx, actor.accountId, key, operation);
      const before = (
        await tx.query<{
          revision: string;
          liked: boolean;
          exists: boolean;
          baseline_id: string;
          occurred_at: string;
          last_transition_id: string | null;
        }>(
          `SELECT coalesce(m.revision,s.baseline_id) revision,coalesce(m.liked,false) liked,m.account_id IS NOT NULL AS exists,s.baseline_id,${ratingIso('coalesce(m.updated_at,s.baseline_at)')} occurred_at,m.last_transition_id FROM whaleu_ratings.like_subjects s LEFT JOIN whaleu_ratings.like_memberships m ON m.subject_id=s.id AND m.account_id=$2 WHERE s.id=$1`,
          [subject.id, actor.accountId],
        )
      ).rows[0]!;
      if (before.liked === liked)
        await tx.query(
          'INSERT INTO whaleu_ratings.like_noop_observations(account_id,request_id,subject_id,baseline_id,anchor_transition_id,liked,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            actor.accountId,
            key,
            subject.id,
            before.baseline_id,
            before.last_transition_id,
            liked,
            before.revision,
            before.occurred_at,
          ],
        );
      else if (before.exists)
        await tx.query(
          'UPDATE whaleu_ratings.like_memberships SET liked=$3,request_id=$4,expected_revision=$5 WHERE subject_id=$1 AND account_id=$2',
          [subject.id, actor.accountId, liked, key, before.revision],
        );
      else
        await tx.query(
          'INSERT INTO whaleu_ratings.like_memberships(subject_id,account_id,liked,request_id,expected_revision) VALUES($1,$2,$3,$4,$5)',
          [subject.id, actor.accountId, liked, key, before.revision],
        );
      if (before.liked !== liked && liked && !skipCapture)
        await capture.captureLiked(actor.accountId, key, tx);
      const after =
        before.liked === liked
          ? before
          : (
              await tx.query<{ revision: string; occurred_at: string }>(
                `SELECT revision,${ratingIso('updated_at')} occurred_at FROM whaleu_ratings.like_memberships WHERE subject_id=$1 AND account_id=$2`,
                [subject.id, actor.accountId],
              )
            ).rows[0]!;
      const receipt = {
        requestId: key,
        operation,
        outcome: before.liked === liked ? 'noop' : 'applied',
        targetId: target.id,
        rootId: root.id,
        replyId: reply?.id ?? null,
        liked,
        revision: after.revision,
        occurredAt: after.occurred_at,
      };
      await tx.query(
        'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, key, JSON.stringify(receipt)],
      );
      return receipt;
    };
    const fault = async (
      table: string,
      event: string,
      condition: string,
      action: () => Promise<void>,
      body = 'RETURN NULL;',
    ) => {
      // Test-only suppression keeps every production guard and deferred constraint enabled.
      await f.pool.query(
        `CREATE FUNCTION whaleu_ratings.synthetic_like_integrity_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`,
      );
      await f.pool.query(
        `CREATE TRIGGER a_synthetic_like_integrity_fault BEFORE ${event} ON whaleu_ratings.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION whaleu_ratings.synthetic_like_integrity_fault()`,
      );
      try {
        await action();
      } finally {
        await f.pool.query(
          `DROP TRIGGER a_synthetic_like_integrity_fault ON whaleu_ratings.${table}`,
        );
        await f.pool.query(
          'DROP FUNCTION whaleu_ratings.synthetic_like_integrity_fault()',
        );
      }
    };

    await t.test(
      'independent actor CAS survives another actor count change and concurrent same-key replay is exact',
      async () => {
        const { actor, other, c, target, root } = await setup();
        const a = await state(actor, root),
          b = await state(other, root);
        const first = await send(
          other,
          root,
          input(c, target, root, b.revision, true),
        );
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal((await state(actor, root)).revision, a.revision);
        const body = input(c, target, root, a.revision, true);
        const responses = await Promise.all([
          send(actor, root, body),
          send(actor, root, body),
        ]);
        assert.ok(
          responses.every((r) => r.status === 200),
          JSON.stringify(responses.map((r) => r.body)),
        );
        assert.deepEqual(responses[0]!.body, responses[1]!.body);
        assert.equal(responses[0]!.body.outcome, 'applied');
        assert.deepEqual(await count(root), {
          count: 2,
          transitions: 2,
          events: 2,
          groups: 2,
          units: 4,
          notices: 2,
        });
      },
    );

    await t.test(
      'stale CAS precedes desired-state noop and old key replays after unlike without reliking',
      async () => {
        const { actor, other, c, target, root } = await setup();
        const initial = await state(actor, root),
          body = input(c, target, root, initial.revision, true);
        const first = await send(actor, root, body);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        const unlike = await send(
          actor,
          root,
          input(c, target, root, first.body.revision, false),
        );
        assert.equal(unlike.status, 200, JSON.stringify(unlike.body));
        const old = await send(actor, root, body);
        assert.deepEqual(old.body, first.body);
        assert.equal((await state(actor, root)).liked, false);
        const stale = await send(
          actor,
          root,
          input(c, target, root, first.body.revision, false),
        );
        assert.equal(stale.status, 200, JSON.stringify(stale.body));
        assert.deepEqual(stale.body, {
          requestId: stale.body.requestId,
          operation: 'set_comment_like',
          outcome: 'rejected',
          code: 'RATING_REVISION_CONFLICT',
        });
        const own = await f.auth(
          request(f.http).get(
            `/v1/ratings/like-requests/${body.clientRequestId}`,
          ),
          actor,
        );
        assert.deepEqual(own.body, first.body);
        const privateRead = await f.auth(
          request(f.http).get(
            `/v1/ratings/like-requests/${body.clientRequestId}`,
          ),
          other,
        );
        assert.equal(privateRead.status, 404);
        for (const path of ['requests', 'reply-requests']) {
          const oldRecovery = await f.auth(
            request(f.http).get(`/v1/ratings/${path}/${body.clientRequestId}`),
            actor,
          );
          assert.equal(oldRecovery.status, 404);
        }
        const scoreCollision = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            actor,
          )
          .send({
            clientRequestId: body.clientRequestId,
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 4,
          });
        assert.equal(
          scoreCollision.status,
          409,
          JSON.stringify(scoreCollision.body),
        );
        assert.deepEqual(await count(root), {
          count: 0,
          transitions: 2,
          events: 2,
          groups: 1,
          units: 2,
          notices: 1,
        });
      },
    );

    await t.test(
      'one raw transaction preserves initial noop plus multiple actors and same-actor re-like chains',
      async () => {
        const { actor, other, target, root } = await setup();
        const receipts = await inTransaction(f.pool, async (tx) => {
          const values = [];
          values.push(await rawSet(tx, actor, root, target, false));
          values.push(await rawSet(tx, actor, root, target, true));
          values.push(await rawSet(tx, other, root, target, true));
          values.push(await rawSet(tx, actor, root, target, false));
          values.push(await rawSet(tx, actor, root, target, true));
          return values;
        });
        assert.equal(receipts[0]!.outcome, 'noop');
        assert.deepEqual(await count(root), {
          count: 2,
          transitions: 4,
          events: 4,
          groups: 3,
          units: 6,
          notices: 3,
        });
        const transitions = (
          await f.pool.query<{
            id: string;
            previous_head_id: string | null;
            previous_count: number;
            new_count: number;
            account_id: string;
            previous_actor_transition_id: string | null;
            old_active_like_id: string | null;
            new_active_like_id: string | null;
          }>(
            'SELECT * FROM whaleu_ratings.like_transitions WHERE root_id=$1 ORDER BY sequence',
            [root.id],
          )
        ).rows;
        assert.deepEqual(
          transitions.map((r) => [r.previous_count, r.new_count]),
          [
            [0, 1],
            [1, 2],
            [2, 1],
            [1, 2],
          ],
        );
        for (let i = 1; i < transitions.length; i++)
          assert.equal(
            transitions[i]!.previous_head_id,
            transitions[i - 1]!.id,
          );
        assert.equal(transitions[2]!.old_active_like_id, transitions[0]!.id);
        assert.equal(
          transitions[3]!.previous_actor_transition_id,
          transitions[2]!.id,
        );
        assert.equal(transitions[3]!.new_active_like_id, transitions[3]!.id);
        assert.notEqual(
          transitions[3]!.new_active_like_id,
          transitions[0]!.new_active_like_id,
        );
        const originalNoop = await f.auth(
          request(f.http).get(
            `/v1/ratings/like-requests/${receipts[0]!.requestId}`,
          ),
          actor,
        );
        assert.deepEqual(originalNoop.body, receipts[0]);
      },
    );

    await t.test(
      'one actor can like, unlike and re-like within one transaction with distinct positive incarnations',
      async () => {
        const { actor, target, root } = await setup();
        const receipts = await inTransaction(f.pool, async (tx) => [
          await rawSet(tx, actor, root, target, true),
          await rawSet(tx, actor, root, target, false),
          await rawSet(tx, actor, root, target, true),
        ]);
        assert.deepEqual(
          receipts.map((r) => [r.outcome, r.liked]),
          [
            ['applied', true],
            ['applied', false],
            ['applied', true],
          ],
        );
        assert.equal(new Set(receipts.map((r) => r.revision)).size, 3);
        assert.deepEqual(await count(root), {
          count: 1,
          transitions: 3,
          events: 3,
          groups: 2,
          units: 4,
          notices: 2,
        });
        const chain = (
          await f.pool.query<{
            id: string;
            old_active_like_id: string | null;
            new_active_like_id: string | null;
          }>(
            'SELECT id,old_active_like_id,new_active_like_id FROM whaleu_ratings.like_transitions WHERE root_id=$1 ORDER BY sequence',
            [root.id],
          )
        ).rows;
        assert.equal(chain[1]!.old_active_like_id, chain[0]!.id);
        assert.equal(chain[2]!.new_active_like_id, chain[2]!.id);
        assert.notEqual(
          chain[0]!.new_active_like_id,
          chain[2]!.new_active_like_id,
        );
      },
    );

    await t.test(
      'savepoint rollback erases partial actor/count/source work before the causal chain resumes',
      async () => {
        const { actor, other, target, root } = await setup();
        const rolledBack: string[] = [];
        await inTransaction(f.pool, async (tx) => {
          const first = await rawSet(tx, actor, root, target, true);
          await tx.query('SAVEPOINT synthetic_like_partial');
          rolledBack.push(
            (await rawSet(tx, actor, root, target, false)).requestId,
          );
          rolledBack.push(
            (await rawSet(tx, other, root, target, true)).requestId,
          );
          await tx.query('ROLLBACK TO SAVEPOINT synthetic_like_partial');
          const restored = (
            await tx.query<{
              count: number;
              revision: string;
              transitions: number;
            }>(
              `SELECT s.count,m.revision,(SELECT count(*)::integer FROM whaleu_ratings.like_transitions WHERE subject_id=$1) transitions FROM whaleu_ratings.like_states s JOIN whaleu_ratings.like_memberships m ON m.subject_id=s.subject_id WHERE s.subject_id=$1 AND m.account_id=$2`,
              [root.id, actor.accountId],
            )
          ).rows[0]!;
          assert.deepEqual(restored, {
            count: 1,
            revision: first.revision,
            transitions: 1,
          });
          assert.equal(
            (
              await tx.query(
                'SELECT 1 FROM whaleu_ratings.like_memberships WHERE subject_id=$1 AND account_id=$2',
                [root.id, other.accountId],
              )
            ).rowCount,
            0,
          );
          await tx.query('RELEASE SAVEPOINT synthetic_like_partial');
          await rawSet(tx, actor, root, target, false);
          await rawSet(tx, actor, root, target, true);
        });
        assert.deepEqual(await count(root), {
          count: 1,
          transitions: 3,
          events: 3,
          groups: 2,
          units: 4,
          notices: 2,
        });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.requests WHERE request_id=ANY($1::uuid[])',
              [rolledBack],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=ANY($1::uuid[])',
              [rolledBack],
            )
          ).rowCount,
          0,
        );
      },
    );

    for (const initial of [true, false])
      await t.test(
        `suppressing only actor A's ${initial ? 'initial' : 'noninitial'} reply-count write cannot fork its head through actor B`,
        async () => {
          const { owner, actor, other, c, target, root } = await setup();
          const reply = await f.publishReply(owner, c, target, root);
          if (!initial)
            await inTransaction(f.pool, (tx) =>
              rawSet(tx, owner, root, target, true, false, reply),
            );
          const before = await count(root, reply),
            firstRequest = randomUUID();
          let firstCaptured = false;
          await fault(
            'like_states',
            'UPDATE',
            `NEW.subject_id='${reply.id}'::uuid`,
            async () => {
              await assert.rejects(
                inTransaction(f.pool, async (tx) => {
                  await rawSet(
                    tx,
                    actor,
                    root,
                    target,
                    true,
                    false,
                    reply,
                    firstRequest,
                  );
                  firstCaptured = true;
                  // B is deliberately NOT suppressed; without causal protection its
                  // write could overwrite the missing contribution from A.
                  await rawSet(tx, other, root, target, true, false, reply);
                }),
                (error: unknown) => {
                  if (!error || typeof error !== 'object' || !('code' in error))
                    return false;
                  return (
                    (error.code === '23505' &&
                      'constraint' in error &&
                      error.constraint ===
                        (initial
                          ? 'rating_like_count_initial'
                          : 'rating_like_count_successor')) ||
                    (error.code === '23514' &&
                      'message' in error &&
                      String(error.message).includes(
                        'Like transition projection incomplete',
                      ))
                  );
                },
              );
            },
            `IF EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions WHERE id=NEW.head_id AND account_id='${actor.accountId}'::uuid AND request_id='${firstRequest}'::uuid) THEN RETURN NULL; END IF; RETURN NEW;`,
          );
          assert.equal(
            firstCaptured,
            true,
            'The exact suppressed actor A source was captured before actor B attempted to advance',
          );
          assert.deepEqual(await count(root, reply), before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.like_memberships WHERE subject_id=$1 AND account_id=ANY($2::uuid[])',
                [reply.id, [actor.accountId, other.accountId]],
              )
            ).rowCount,
            0,
          );
        },
      );

    await t.test(
      'suppressing only the first actor effect cannot be covered by a second valid effect',
      async () => {
        const { actor, other, target, root } = await setup(),
          before = await count(root);
        await fault(
          'effect_events',
          'INSERT',
          `NEW.source_version=2 AND NEW.actor_account_id='${actor.accountId}'::uuid`,
          async () => {
            await reject(async (tx) => {
              await rawSet(tx, actor, root, target, true, true);
              await rawSet(tx, other, root, target, true);
            });
          },
        );
        assert.deepEqual(await count(root), before);
      },
    );

    await t.test(
      'known score coverage cannot manufacture an initial like noop without an independent subject baseline',
      async () => {
        const owner = await f.actor(),
          actor = await f.actor(),
          c = await f.catalog(owner),
          target = c.targets[0]!;
        let root!: Awaited<ReturnType<typeof f.publish>>;
        await fault(
          'like_subjects',
          'INSERT',
          "NEW.kind='comment'",
          async () => {
            root = await f.publish(owner, c, target);
          },
        );
        const current = await f.auth(
          request(f.http).get(`/v1/ratings/comments/${root.id}/like`),
          actor,
        );
        assert.equal(current.status, 200, JSON.stringify(current.body));
        assert.deepEqual(current.body, { status: 'unavailable' });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.score_baselines WHERE target_id=$1',
              [target.id],
            )
          ).rowCount,
          1,
        );
        await reject(async (tx) => {
          const key = randomUUID();
          await newRequest(tx, actor.accountId, key);
          await tx.query(
            'INSERT INTO whaleu_ratings.like_noop_observations(account_id,request_id,subject_id,baseline_id,liked,revision,occurred_at) VALUES($1,$2,$3,$4,false,$4,clock_timestamp())',
            [actor.accountId, key, root.id, randomUUID()],
          );
        });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.like_subjects WHERE id=$1',
              [root.id],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'raw count, transition, immutable baseline and same-state writes fail without new source',
      async () => {
        const { actor, c, target, root } = await setup();
        const initial = await state(actor, root),
          positive = await send(
            actor,
            root,
            input(c, target, root, initial.revision, true),
          );
        assert.equal(positive.status, 200, JSON.stringify(positive.body));
        const before = await count(root);
        await reject((tx) =>
          tx.query(
            'UPDATE whaleu_ratings.like_states SET count=count+1 WHERE subject_id=$1',
            [root.id],
          ),
        );
        await reject((tx) =>
          tx.query(
            'UPDATE whaleu_ratings.like_states SET count=-1 WHERE subject_id=$1',
            [root.id],
          ),
        );
        await reject((tx) =>
          tx.query(
            'DELETE FROM whaleu_ratings.like_memberships WHERE subject_id=$1 AND account_id=$2',
            [root.id, actor.accountId],
          ),
        );
        await reject((tx) =>
          tx.query(
            'UPDATE whaleu_ratings.like_subjects SET baseline_id=gen_random_uuid() WHERE id=$1',
            [root.id],
          ),
        );
        await reject(async (tx) => {
          const key = randomUUID();
          await newRequest(tx, actor.accountId, key);
          await tx.query(
            'UPDATE whaleu_ratings.like_memberships SET liked=true,request_id=$3,expected_revision=revision WHERE subject_id=$1 AND account_id=$2',
            [root.id, actor.accountId, key],
          );
        });
        await reject(async (tx) => {
          const key = randomUUID();
          await newRequest(tx, actor.accountId, key);
          await tx.query(
            `INSERT INTO whaleu_ratings.like_transitions(id,subject_id,target_id,root_id,reply_id,account_id,request_id,operation,old_revision,new_revision,previous_actor_transition_id,old_active_like_id,new_active_like_id,delta,previous_count,new_count,previous_head_id,occurred_at,mutation_transaction)
        SELECT gen_random_uuid(),subject_id,target_id,root_id,reply_id,account_id,$2,operation,old_revision,gen_random_uuid(),previous_actor_transition_id,old_active_like_id,new_active_like_id,delta,previous_count,new_count,previous_head_id,clock_timestamp(),pg_current_xact_id() FROM whaleu_ratings.like_transitions WHERE root_id=$1 LIMIT 1`,
            [root.id, key],
          );
        });
        assert.deepEqual(await count(root), before);
      },
    );

    for (const variant of [
      'no observation',
      'wrong actor',
      'wrong baseline',
      'wrong anchor',
      'wrong operation',
      'wrong liked',
    ] as const)
      await t.test(
        `a fake noop with ${variant} cannot borrow another causal anchor`,
        async () => {
          const { actor, other, c, target, root } = await setup();
          const initial = await state(actor, root),
            positive = await send(
              actor,
              root,
              input(c, target, root, initial.revision, true),
            );
          assert.equal(positive.status, 200, JSON.stringify(positive.body));
          const before = await count(root);
          await reject(async (tx) => {
            const key = randomUUID(),
              operation =
                variant === 'wrong operation'
                  ? 'set_reply_like'
                  : 'set_comment_like';
            await newRequest(tx, actor.accountId, key, operation);
            const row = (
              await tx.query<{
                baseline_id: string;
                last_transition_id: string;
                revision: string;
                occurred_at: string;
              }>(
                `SELECT s.baseline_id,m.last_transition_id,m.revision,${ratingIso('m.updated_at')} occurred_at FROM whaleu_ratings.like_subjects s JOIN whaleu_ratings.like_memberships m ON m.subject_id=s.id WHERE s.id=$1 AND m.account_id=$2`,
                [root.id, actor.accountId],
              )
            ).rows[0]!;
            if (variant !== 'no observation')
              await tx.query(
                'INSERT INTO whaleu_ratings.like_noop_observations(account_id,request_id,subject_id,baseline_id,anchor_transition_id,liked,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                [
                  variant === 'wrong actor' ? other.accountId : actor.accountId,
                  key,
                  root.id,
                  variant === 'wrong baseline' ? randomUUID() : row.baseline_id,
                  variant === 'wrong anchor'
                    ? randomUUID()
                    : row.last_transition_id,
                  variant !== 'wrong liked',
                  row.revision,
                  row.occurred_at,
                ],
              );
            await tx.query(
              'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
              [
                actor.accountId,
                key,
                JSON.stringify({
                  requestId: key,
                  operation,
                  outcome: 'noop',
                  targetId: target.id,
                  rootId: root.id,
                  replyId: null,
                  liked: true,
                  revision: row.revision,
                  occurredAt: row.occurred_at,
                }),
              ],
            );
          });
          assert.deepEqual(await count(root), before);
        },
      );

    await t.test(
      'applied/rejected forged receipts cannot substitute for the source and effect tuple',
      async () => {
        const { actor, target, root } = await setup(),
          before = await count(root);
        await reject(async (tx) => {
          const key = randomUUID();
          await newRequest(tx, actor.accountId, key);
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              actor.accountId,
              key,
              JSON.stringify({
                requestId: key,
                operation: 'set_comment_like',
                outcome: 'applied',
                targetId: target.id,
                rootId: root.id,
                replyId: null,
                liked: true,
                revision: randomUUID(),
                occurredAt: '2026-10-09T00:00:00.123456Z',
              }),
            ],
          );
        });
        await reject(async (tx) => {
          const valid = await rawSet(tx, actor, root, target, true);
          // Mutation of a finalized request is independently forbidden.
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
            [
              actor.accountId,
              valid.requestId,
              JSON.stringify({
                requestId: valid.requestId,
                operation: 'set_comment_like',
                outcome: 'rejected',
                code: 'RATING_NOT_FOUND',
              }),
            ],
          );
        });
        assert.deepEqual(await count(root), before);
      },
    );

    await t.test(
      'old v1 source and registry cannot be relabeled or replayed as a fresh rating like',
      async () => {
        const { owner, actor, c, target, root } = await setup();
        const legacy = (
          await f.pool.query<{
            id: string;
            group_id: string;
            event_id: string;
          }>(
            "SELECT u.id,u.group_id,u.event_id FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.effect_events e ON e.id=u.event_id WHERE e.root_id=$1 AND e.event_kind='root_created'",
            [root.id],
          )
        ).rows[0]!;
        const before = await inTransaction(f.pool, (tx) =>
          f.app.get(ExperienceSourceRouter).loadUnit(legacy.id, tx),
        );
        assert.equal(before?.action, 'comment');
        await reject((tx) =>
          tx.query(
            'INSERT INTO whaleu_experience.source_groups(group_id,source_domain,source_version,enrollment_order,creation_transaction,rating_group_id) SELECT group_id,source_domain,2,enrollment_order,pg_current_xact_id(),rating_group_id FROM whaleu_experience.source_groups WHERE group_id=$1',
            [legacy.group_id],
          ),
        );
        await reject((tx) =>
          tx.query(
            'UPDATE whaleu_experience.source_groups SET source_version=2 WHERE group_id=$1',
            [legacy.group_id],
          ),
        );
        await reject((tx) =>
          tx.query(
            "UPDATE whaleu_ratings.reward_groups SET source_version=2,event_kind='content_liked',subject_author_id=$2,subject_author_mode='named' WHERE id=$1",
            [legacy.group_id, owner.accountId],
          ),
        );
        await reject((tx) =>
          tx.query(
            `INSERT INTO whaleu_ratings.reward_groups(id,event_id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,occurred_at,enrollment_order,expected_unit_count)
      SELECT gen_random_uuid(),event_id,source_version,event_kind,target_id,root_id,reply_id,reply_to_id,actor_account_id,root_author_id,direct_reply_author_id,occurred_at,enrollment_order,expected_unit_count FROM whaleu_ratings.reward_groups WHERE id=$1`,
            [legacy.group_id],
          ),
        );
        const positive = await send(
          actor,
          root,
          input(c, target, root, (await state(actor, root)).revision, true),
        );
        assert.equal(positive.status, 200, JSON.stringify(positive.body));
        await reject(async (tx) => {
          const key = randomUUID();
          await newRequest(tx, actor.accountId, key);
          await tx.query(
            `INSERT INTO whaleu_ratings.effect_events(id,source_version,rule_version,event_kind,target_id,root_id,reply_id,actor_account_id,author_mode,root_author_id,subject_author_id,subject_author_mode,region_id,like_transition_id,request_id,occurred_at,mutation_transaction,expected_experience_units,expected_direct_notice_obligations)
        SELECT gen_random_uuid(),source_version,rule_version,event_kind,target_id,root_id,reply_id,actor_account_id,author_mode,root_author_id,subject_author_id,subject_author_mode,region_id,like_transition_id,$2,clock_timestamp(),pg_current_xact_id(),expected_experience_units,expected_direct_notice_obligations FROM whaleu_ratings.effect_events WHERE root_id=$1 AND source_version=2 LIMIT 1`,
            [root.id, key],
          );
        });
        assert.deepEqual(
          await inTransaction(f.pool, (tx) =>
            f.app.get(ExperienceSourceRouter).loadUnit(legacy.id, tx),
          ),
          before,
        );
      },
    );
  },
);
