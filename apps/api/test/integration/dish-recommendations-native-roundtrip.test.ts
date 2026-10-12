import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  dishRecommendationFixture,
  dishHistory,
  reviewDish,
  revokeDishReview,
} from '../support/dish-recommendation-fixture.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import type { DishCommand } from '../../src/ratings/windows/dishes/contracts.js';
const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});
test(
  'emitted W2 App/Page/WXML → exact-name endorsements, two actors, membership CAS, receipt-first restart/cancel, all eligibility-loss closures, Review and cursor boundaries through real HTTP/PostgreSQL',
  { timeout: 240000 },
  async (t) => {
    const f = await dishRecommendationFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false });
    const window = f.add({ name: 'Synthetic Native Dish Window' }),
      paging = f.add({ name: 'Synthetic Dish Paging Window' }),
      unknown = f.add({ name: 'Synthetic Unknown Dish History' });
    let catalog = await f.accept([window, paging, unknown]);
    await f.acceptDishes([window.id, paging.id]);
    const http = f.app.getHttpServer();
    const post = async (
      op: 'recommend' | 'retract',
      command: DishCommand,
      a = actor,
      id = window.id,
    ) => {
      const r = await request(http)
        .post(`/v1/ratings/windows/${id}/dishes/${op}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send(command);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as {
        outcome: string;
        membershipRevision: string;
        active: boolean;
        code?: string;
      };
    };
    const current = async (name: string, a = actor, id = window.id) => {
      const r = await request(http)
        .get(`/v1/ratings/windows/${id}/dishes/my-membership`)
        .query({ dishName: name })
        .set('Authorization', `Bearer ${a.accessToken}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as {
        kind: string;
        revision: string;
        catalogRevision: string;
        windowRevision: string;
        active: boolean;
      };
    };
    for (let n = 0; n < 22; n++) {
      const q = f.recommend(
        catalog,
        paging,
        `Dish${String(n).padStart(2, '0')}`,
      );
      await reviewDish(f.pool, actor.accountId, paging.id, q);
      assert.equal(
        (await post('recommend', q, actor, paging.id)).outcome,
        'applied',
      );
    }
    const restore = async () => {
      await f.certify(actor.accountId, {
        affiliation: 'unverified',
        identity: false,
      });
      await f.pool.query(
        "UPDATE whaleu_safety.account_heads SET actions_allowed=true,restriction_coverage='complete' WHERE account_id=$1",
        [actor.accountId],
      );
      await f.pool.query(
        "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
      );
      catalog = await f.accept([window, paging, unknown]);
      await f.acceptDishes([window.id]);
    };
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/dish-recommendations-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (value) => (logs += String(value)));
    child.stderr?.on('data', (value) => (logs += String(value)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const checkpoints: string[] = [],
      losses: string[] = [];
    let firstRequestId: string | undefined;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const message = raw as Record<string, unknown>;
          if (message['event'] === 'failure')
            throw Error(String(message['message']) + '\n' + logs);
          if (message['event'] === 'checkpoint') {
            const name = String(message['name']);
            if (name === 'review') {
              const command = message['command'] as DishCommand;
              if (command.dishName !== '待审菜')
                await reviewDish(
                  f.pool,
                  String(message['actorId']),
                  String(message['windowId']),
                  command,
                  command.dishName === '拒绝菜' ? 'reject' : 'allow',
                );
            } else {
              checkpoints.push(name);
              if (name === 'first-committed') {
                const command = message['command'] as DishCommand;
                firstRequestId = command.clientRequestId;
                const own = await current(command.dishName);
                assert.equal(own.active, true);
                assert.equal(
                  (
                    await post(
                      'retract',
                      f.recommend(
                        own.catalogRevision,
                        { revision: own.windowRevision },
                        command.dishName,
                        own.revision,
                      ),
                    )
                  ).active,
                  false,
                );
                await f.pool.query(
                  "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                );
              } else if (name === 'source-restored') {
                await f.pool.query(
                  "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
                );
              } else if (name === 'concurrent-membership') {
                assert.equal(
                  (
                    await post(
                      'retract',
                      f.recommend(
                        catalog,
                        window,
                        String(message['dishName']),
                        String(message['revision']),
                      ),
                    )
                  ).active,
                  false,
                );
              } else if (name === 'cancel-loss') {
                await f.certify(actor.accountId, {
                  phone: 'unverified',
                  affiliation: 'unverified',
                  identity: false,
                });
                await f.pool.query(
                  "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                );
              } else if (name === 'restore-all') await restore();
              else if (name === 'review-revoked') {
                const row = (
                  await f.pool.query<{ review_decision_id: string }>(
                    "SELECT e.review_decision_id FROM whaleu_ratings.dish_heads h JOIN whaleu_ratings.dish_events e ON e.id=h.revision WHERE h.actor_id=$1 AND h.window_id=$2 AND h.name_bytes=convert_to($3,'UTF8')",
                    [actor.accountId, window.id, String(message['dishName'])],
                  )
                ).rows[0]!;
                await revokeDishReview(f.pool, row.review_decision_id);
              } else if (name === 'loss') {
                const loss = String(message['loss']);
                losses.push(loss);
                if (loss === 'source')
                  await f.pool.query(
                    "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                  );
                else if (loss === 'parent')
                  catalog = await f.accept(
                    [window, paging, unknown].map((row) => ({
                      ...row,
                      parentActive: false,
                    })),
                  );
                else if (loss === 'phone')
                  await f.certify(actor.accountId, {
                    phone: 'unverified',
                    affiliation: 'unverified',
                    identity: false,
                  });
                else if (loss === 'safety')
                  await f.pool.query(
                    'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                    [actor.accountId],
                  );
                else if (loss === 'population' || loss === 'membership')
                  await dishHistory(f.pool, window.id, loss, 'unknown');
                else throw Error('Unknown native loss ' + loss);
              } else if (name === 'offpage-change') {
                const q = f.recommend(catalog, paging, 'Dish21');
                await reviewDish(f.pool, other.accountId, paging.id, q);
                assert.equal(
                  (await post('recommend', q, other, paging.id)).outcome,
                  'applied',
                );
              } else throw Error('Unknown dish-native checkpoint ' + name);
            }
            child.send({ event: 'continue', name });
          } else if (message['event'] === 'done') {
            done = true;
            assert.equal(message['firstRequestId'], firstRequestId);
            assert.ok(Number(message['nativeCommands']) >= 25);
            assert.ok(Number(message['receiptReads']) >= 4);
            assert.deepEqual(losses, [
              'source',
              'parent',
              'phone',
              'safety',
              'population',
              'membership',
            ]);
            assert.ok(checkpoints.includes('review-revoked'));
            assert.ok(checkpoints.includes('offpage-change'));
            const own = await current('😀'.repeat(10));
            assert.equal(own.active, false);
            const publicPage = await request(http)
              .get(`/v1/ratings/windows/${window.id}/dishes`)
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(publicPage.status, 200);
            assert.equal(
              publicPage.body.items.find(
                (item: { dishName: string }) =>
                  item.dishName === '😀'.repeat(10),
              ).recommendationCount,
              1,
            );
            assert.equal(
              JSON.stringify(publicPage.body).includes(actor.accountId),
              false,
            );
            assert.equal(
              JSON.stringify(publicPage.body).includes(other.accountId),
              false,
            );
            const w1 = await request(http)
              .get(`/v1/ratings/windows/${window.id}`)
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(w1.status, 200);
            assert.deepEqual(w1.body.window.summary, {
              kind: 'known',
              ratingCount: 0,
              mean: null,
            });
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::integer n FROM whaleu_ratings.window_score_events',
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::integer n FROM whaleu_ratings.course_comments',
                )
              ).rows[0].n,
              0,
            );
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done) reject(Error(`Native dish worker exited ${code}: ${logs}`));
      });
      child.send({
        port: f.port,
        actor: credentials(actor),
        other: credentials(other),
        windowId: window.id,
        pagingId: paging.id,
        unknownId: unknown.id,
      });
    });
  },
);
