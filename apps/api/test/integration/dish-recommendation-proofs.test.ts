import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  dishRecommendationFixture,
  dishHistory,
  reviewDish,
  revokeDishReview,
} from '../support/dish-recommendation-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { dishIntentHash } from '../../src/ratings/windows/dishes/service.js';
import {
  dishIdentity,
  dishReviewDigest,
} from '../../src/community/content-review/dish-review.facade.js';
import type { DishCommand } from '../../src/ratings/windows/dishes/contracts.js';
import { DishCursors } from '../../src/ratings/windows/dishes/cursor.js';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'W2 strict SQL causal guards, owner-negative proof, exact deadlines and bounded population',
  { timeout: 240000 },
  async (t) => {
    const f = await dishRecommendationFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor(),
      w = f.add();
    let catalog = await f.accept([w]);
    await f.acceptDishes([w.id]);
    const base = '/v1/ratings/windows',
      http = f.app.getHttpServer();
    const post = (q: object, a = actor, op = 'recommend') =>
      request(http)
        .post(`${base}/${w.id}/dishes/${op}`)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(q);
    const page = (query = '', a = actor) =>
      request(http)
        .get(`${base}/${w.id}/dishes${query}`)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const own = (name: string, a = actor) =>
      request(http)
        .get(`${base}/${w.id}/dishes/my-membership`)
        .query({ dishName: name })
        .set('Authorization', 'Bearer ' + a.accessToken);
    const add = async (
      name: string,
      a = actor,
      options: Parameters<typeof reviewDish>[5] = {},
    ) => {
      const q = f.recommend(catalog, w, name);
      const decision = await reviewDish(
        f.pool,
        a.accountId,
        w.id,
        q,
        'allow',
        options,
      );
      const r = await post(q, a);
      ok(r);
      return { q, decision, r };
    };
    await add('A');
    await add('Z');
    await t.test(
      'strict raw cancellation/rejection/receipt types and immutable heads/events/commands',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.dish_events SET active=false',
          'DELETE FROM whaleu_ratings.dish_heads',
          'TRUNCATE whaleu_ratings.dish_commands',
          'UPDATE whaleu_ratings.dish_commands SET receipt=receipt',
          'UPDATE whaleu_ratings.dish_heads SET revision=revision',
        ])
          await assert.rejects(f.pool.query(sql));
        const insert = async (
          q: DishCommand,
          receipt: unknown,
          operation = 'window.dish.recommend.v1' as const,
        ) =>
          inTransaction(f.pool, (tx) =>
            tx.query(
              'INSERT INTO whaleu_ratings.dish_commands(actor_id,request_id,session_id,window_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                actor.accountId,
                q.clientRequestId,
                actor.sessionId,
                w.id,
                operation,
                q,
                dishIntentHash(actor.accountId, w.id, operation, q),
                receipt,
              ],
            ),
          );
        for (const patch of [
          { dishName: 7 },
          { dishName: ' ' },
          { dishName: '🍱'.repeat(11) },
          { expectedMembershipRevision: 7 },
          { expectedCatalogRevision: 123 },
        ]) {
          const q = {
            ...f.recommend(catalog, w, 'Bad'),
            ...patch,
          } as DishCommand;
          await assert.rejects(
            insert(q, {
              requestId: q.clientRequestId,
              windowId: w.id,
              operation: 'window.dish.recommend.v1',
              dishIdentity:
                typeof q.dishName === 'string'
                  ? dishIdentity(q.dishName)
                  : '37',
              outcome: 'rejected',
              code: 'DISH_CANCELLED',
            }),
          );
        }
        for (const code of [
          'WINDOW_REVISION_CONFLICT',
          'DISH_MEMBERSHIP_REVISION_CONFLICT',
          'DISH_ALREADY_RECOMMENDED',
          'CONTENT_REJECTED',
        ]) {
          const q = f.recommend(catalog, w, 'Absent');
          await assert.rejects(
            insert(q, {
              requestId: q.clientRequestId,
              windowId: w.id,
              operation: 'window.dish.recommend.v1',
              dishIdentity: dishIdentity(q.dishName),
              outcome: 'rejected',
              code,
            }),
          );
        }
        const q = f.recommend(catalog, w, '12');
        await assert.rejects(
          insert(q, {
            requestId: q.clientRequestId,
            windowId: w.id,
            operation: 'window.dish.recommend.v1',
            dishIdentity: Number(dishIdentity(q.dishName)),
            outcome: 'rejected',
            code: 'DISH_CANCELLED',
          }),
        );
        const current = (await own('A')).body;
        const changed = f.recommend(catalog, w, 'A', current.revision);
        await assert.rejects(
          insert(changed, {
            requestId: changed.clientRequestId,
            windowId: w.id,
            operation: 'window.dish.recommend.v1',
            dishIdentity: dishIdentity('A'),
            outcome: 'applied',
            active: true,
            membershipRevision: current.revision,
            recordedAt: current.recordedAt,
          }),
        );
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(tx.query('SELECT whaleu_ratings.dish_fence()'));
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      },
    );
    await t.test(
      'each fresh re-add needs original request/source/name Review, not another actor or old allow',
      async () => {
        const result = await add('Readd'),
          remove = f.recommend(
            catalog,
            w,
            'Readd',
            result.r.body.membershipRevision,
          ),
          removed = await post(remove, actor, 'retract');
        ok(removed);
        const q = f.recommend(
          catalog,
          w,
          'Readd',
          removed.body.membershipRevision,
        );
        ok(await post(q), 503);
        await reviewDish(f.pool, other.accountId, w.id, q);
        ok(await post(q), 503);
        await reviewDish(f.pool, actor.accountId, w.id, {
          ...q,
          dishName: 'Wrong',
        });
        ok(await post(q), 503);
        await reviewDish(f.pool, actor.accountId, w.id, q);
        ok(await post(q));
      },
    );
    await t.test(
      'known Safety deny removes contribution; unknown Safety fails closed without erasing own membership',
      async () => {
        await add('Neighbor', other);
        let r = await page('?limit=50');
        ok(r);
        assert.ok(
          r.body.items.some(
            (i: { dishName: string }) => i.dishName === 'Neighbor',
          ),
        );
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [other.accountId],
        );
        r = await page('?limit=50');
        ok(r);
        assert.equal(
          r.body.items.some(
            (i: { dishName: string }) => i.dishName === 'Neighbor',
          ),
          false,
        );
        assert.equal((await own('Neighbor', other)).body.active, true);
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET restriction_coverage='missing' WHERE account_id=$1",
          [other.accountId],
        );
        ok(await page(), 503);
        const state = (await own('Neighbor', other)).body;
        ok(
          await post(
            f.recommend(
              state.catalogRevision,
              { revision: state.windowRevision },
              'Neighbor',
              state.revision,
            ),
            other,
            'retract',
          ),
        );
        ok(await page());
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET actions_allowed=true,restriction_coverage='complete' WHERE account_id=$1",
          [other.accountId],
        );
      },
    );
    await t.test(
      'off-page Review revocation and time-only expiry invalidate the full cursor ranking',
      async () => {
        const result = await add('Offpage');
        let r = await page('?limit=1');
        ok(r);
        const cursor = r.body.nextCursor;
        await revokeDishReview(f.pool, result.decision);
        r = await page('?limit=1&cursor=' + encodeURIComponent(cursor));
        ok(r, 409);
        const expiring = await add('Expires', actor, {
          visibilityUntil: new Date(Date.now() + 600),
        });
        r = await page('?limit=1');
        ok(r);
        await sleep(650);
        ok(
          await page(
            '?limit=1&cursor=' + encodeURIComponent(r.body.nextCursor),
          ),
          409,
        );
        ok(await page(), 503);
        await revokeDishReview(f.pool, expiring.decision);
        ok(await page());
      },
    );
    await t.test(
      'required final NOWAIT fences reject external uncommitted off-page Review writers',
      async () => {
        const cursors = f.app.get(DishCursors),
          original = cursors.create.bind(cursors),
          writer = await f.pool.connect();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((r) => (entered = r)),
          hold = new Promise<void>((r) => (release = r));
        cursors.create = async (...args) => {
          const value = await original(...args);
          entered();
          await hold;
          return value;
        };
        try {
          const reading = page('?limit=1').then((r) => r);
          await ready;
          await writer.query('BEGIN');
          await writer.query(
            "UPDATE whaleu_community.dish_review_heads SET state='revoked' WHERE actor_id=$1",
            [other.accountId],
          );
          release();
          ok(await reading, 503);
          await writer.query('ROLLBACK');
        } finally {
          release();
          cursors.create = original;
          await writer.query('ROLLBACK');
          writer.release();
        }
      },
    );
    await t.test(
      'after-statement deferred Review/source/history/session/Safety change rolls back event and receipt',
      async () => {
        const changes = [
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
          'DELETE FROM whaleu_ratings.dish_history_heads WHERE window_id=NEW.window_id',
          "UPDATE whaleu_community.dish_review_heads SET state='revoked' WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id",
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
        ];
        for (const [index, change] of changes.entries()) {
          const q = f.recommend(catalog, w, 'Deferred' + index);
          await reviewDish(f.pool, actor.accountId, w.id, q);
          await f.pool.query(
            'CREATE FUNCTION whaleu_ratings.w2_test_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              change +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_w2_test_change AFTER INSERT ON whaleu_ratings.dish_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.w2_test_change()',
          );
          try {
            const r = await post(q);
            assert.ok(
              [401, 403, 503].includes(r.status),
              JSON.stringify(r.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.dish_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.dish_events WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_w2_test_change ON whaleu_ratings.dish_commands;DROP FUNCTION whaleu_ratings.w2_test_change()',
            );
          }
        }
      },
    );
    await t.test(
      'actual deferred wait across Review/history/phone/source exact expiry cannot commit old authority',
      async () => {
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.w2_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_w2_test_wait AFTER INSERT ON whaleu_ratings.dish_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.w2_test_wait()',
        );
        try {
          for (const kind of [
            'review',
            'history',
            'phone',
            'source',
            'session',
            'safety',
          ]) {
            const a = await f.actor({
                affiliation: 'unverified',
                identity: false,
              }),
              q = f.recommend(catalog, w, kind);
            if (kind === 'history')
              await dishHistory(
                f.pool,
                w.id,
                'population',
                'accepted_empty',
                new Date(Date.now() + 400),
              );
            if (kind === 'phone')
              await f.certify(a.accountId, {
                phone: 'verified',
                affiliation: 'unverified',
                identity: false,
                expiresAt: new Date(Date.now() + 400),
              });
            if (kind === 'source') {
              catalog = await f.accept([w], {
                validUntil: new Date(Date.now() + 400),
              });
              q.expectedCatalogRevision = catalog;
            }
            if (kind === 'session')
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
                [a.sessionId],
              );
            if (kind === 'safety')
              await f.pool.query(
                "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '400 milliseconds' WHERE account_id=$1",
                [a.accountId],
              );
            await reviewDish(
              f.pool,
              a.accountId,
              w.id,
              q,
              'allow',
              kind === 'review'
                ? { consumeUntil: new Date(Date.now() + 400) }
                : {},
            );
            const r = await post(q, a);
            assert.ok(
              [401, 503].includes(r.status),
              kind + JSON.stringify(r.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.dish_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
            if (kind === 'history')
              await dishHistory(f.pool, w.id, 'population');
            if (kind === 'source') catalog = await f.accept([w]);
          }
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_w2_test_wait ON whaleu_ratings.dish_commands;DROP FUNCTION whaleu_ratings.w2_test_wait()',
          );
        }
      },
    );
    await t.test(
      'history and Review exact microsecond predicates; source expiry/future boundary captured before pause',
      async () => {
        const row = (
          await f.pool.query(
            `SELECT whaleu_ratings.dish_history($1,'population',a.accepted_at-interval '1 microsecond') IS NULL before,whaleu_ratings.dish_history($1,'population',a.accepted_at)=a.id accepted,whaleu_ratings.dish_history($1,'population',a.valid_until) IS NULL expired FROM whaleu_ratings.dish_history_heads h JOIN whaleu_ratings.dish_history_assertions a ON a.id=h.assertion_id WHERE h.window_id=$1 AND h.kind='population'`,
            [w.id],
          )
        ).rows[0];
        assert.deepEqual(row, { before: true, accepted: true, expired: true });
        await f.pool.query(
          `ALTER FUNCTION whaleu_ratings.dish_source(uuid,timestamptz) RENAME TO w2_original_source;CREATE FUNCTION whaleu_ratings.dish_source(wid uuid,instant timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$DECLARE value jsonb;BEGIN value:=whaleu_ratings.w2_original_source(wid,instant);PERFORM pg_sleep(0.6);RETURN value;END$$`,
        );
        try {
          await dishHistory(
            f.pool,
            w.id,
            'population',
            'accepted_empty',
            new Date(Date.now() + 300),
          );
          ok(await page(), 503);
        } finally {
          await f.pool.query(
            'DROP FUNCTION whaleu_ratings.dish_source(uuid,timestamptz);ALTER FUNCTION whaleu_ratings.w2_original_source(uuid,timestamptz) RENAME TO dish_source',
          );
          await dishHistory(f.pool, w.id, 'population');
        }
      },
    );
    await t.test(
      '1001 real causal memberships return unavailable, never a truncated count or fake empty',
      async () => {
        const large = f.add();
        catalog = await f.accept([w, large]);
        await f.acceptDishes([large.id]);
        const policy = randomUUID();
        await f.pool.query(
          "INSERT INTO whaleu_community.dish_review_policies(id,issuer,source_reference,coverage,valid_until) VALUES($1,'synthetic:budget','synthetic:budget-test','complete',clock_timestamp()+interval '1 hour')",
          [policy],
        );
        const entries = Array.from({ length: 1001 }, (_, i) => {
          const command = f.recommend(
              catalog,
              large,
              'D' + String(i).padStart(4, '0'),
            ),
            decision = randomUUID();
          return {
            event: randomUUID(),
            decision,
            command,
            request: command.clientRequestId,
            name: command.dishName,
            digest: dishReviewDigest({
              version: 1,
              purpose: 'window.dish.recommend.v1',
              actorId: actor.accountId,
              requestId: command.clientRequestId,
              windowId: large.id,
              catalogRevision: catalog,
              windowRevision: large.revision,
              dishName: command.dishName,
              dishIdentity: dishIdentity(command.dishName),
            }),
            hash: dishIntentHash(
              actor.accountId,
              large.id,
              'window.dish.recommend.v1',
              command,
            ),
          };
        });
        await inTransaction(f.pool, async (tx) => {
          await tx.query('SET LOCAL statement_timeout=120000');
          await tx.query(
            `CREATE TEMP TABLE w2_budget ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(event uuid,decision uuid,command jsonb,request uuid,name text,digest text,hash text)`,
            [JSON.stringify(entries)],
          );
          await tx.query(
            `INSERT INTO whaleu_community.dish_review_decisions(id,actor_id,request_id,window_id,catalog_id,window_revision,dish_name,policy_id,verdict,digest,consume_until,visibility_until) SELECT decision,$1,request,$2,$3,$4,name,$5,'allow',digest,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 hour' FROM w2_budget`,
            [actor.accountId, large.id, catalog, large.revision, policy],
          );
          await tx.query(
            `INSERT INTO whaleu_community.dish_review_heads(actor_id,request_id,decision_id,state) SELECT $1,request,decision,'active' FROM w2_budget`,
            [actor.accountId],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.dish_events(id,window_id,actor_id,request_id,dish_name,previous_revision,active,catalog_id,window_revision,population_assertion_id,membership_assertion_id,review_decision_id) SELECT event,$1,$2,request,name,NULL,true,$3,$4,whaleu_ratings.dish_history($1,'population',clock_timestamp()),whaleu_ratings.dish_history($1,'membership',clock_timestamp()),decision FROM w2_budget`,
            [large.id, actor.accountId, catalog, large.revision],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.dish_heads(window_id,actor_id,name_bytes,revision) SELECT $1,$2,convert_to(name,'UTF8'),event FROM w2_budget`,
            [large.id, actor.accountId],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.dish_commands(actor_id,request_id,session_id,window_id,operation,command,intent_hash,receipt) SELECT $1,request,$2,$3,'window.dish.recommend.v1',command,hash,jsonb_build_object('requestId',request,'operation','window.dish.recommend.v1','windowId',$3::uuid::text,'dishIdentity',encode(convert_to(name,'UTF8'),'hex'),'outcome','applied','active',true,'membershipRevision',event,'recordedAt',to_char(date_trunc('milliseconds',transaction_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM w2_budget`,
            [actor.accountId, actor.sessionId, large.id],
          );
        });
        const r = await request(http)
          .get(`${base}/${large.id}/dishes`)
          .set('Authorization', 'Bearer ' + actor.accessToken);
        ok(r, 503);
        assert.equal(r.body.error.code, 'DISH_BUDGET_UNAVAILABLE');
        assert.equal(r.body.items, undefined);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.dish_heads WHERE window_id=$1',
              [large.id],
            )
          ).rows[0].n,
          1001,
        );
      },
    );
  },
);
