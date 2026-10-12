import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  windowDiscussionFixture,
  reviewWindowDiscussion,
} from '../support/window-discussion-fixture.js';
import type {
  WindowRootPublish,
  WindowReplyPublish,
} from '../../src/ratings/windows/discussion/contracts.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
const credentials = (a: SessionCredentials): SessionCredentials => ({
  accountId: a.accountId,
  sessionId: a.sessionId,
  accessToken: a.accessToken,
  refreshToken: a.refreshToken,
  expiresAt: a.expiresAt,
  refreshExpiresAt: a.refreshExpiresAt,
});
test(
  'legacy-client capability compatibility harness: emitted W3 App/Page/WXML → native discussion, flat reply targets, reversible likes, independent notices, receipt-first cold recovery and eligibility withdrawal through real HTTP/PostgreSQL',
  { timeout: 240000 },
  async (t) => {
    const f = await windowDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      window = f.add({ name: 'Synthetic Native Discussion Window' }),
      paging = f.add({ name: 'Synthetic Native Discussion Paging' }),
      catalog = await f.accept([window, paging]);
    await f.acceptDiscussion([window.id, paging.id]);
    const http = f.app.getHttpServer();
    const post = async (path: string, body: unknown, a = actor) => {
      const r = await request(http)
        .post(path)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send(body as object);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as Record<string, unknown>;
    };
    for (let n = 0; n < 22; n++) {
      const c = f.root(catalog, paging, `Synthetic paging ${n}`);
      await reviewWindowDiscussion(f.pool, actor.accountId, paging.id, c);
      assert.equal(
        (await post(`/v1/ratings/windows/${paging.id}/discussion`, c))[
          'outcome'
        ],
        'applied',
      );
    }
    const restore = async () => {
      for (const a of [actor, other]) {
        await f.certify(a.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET actions_allowed=true,restriction_coverage='complete' WHERE account_id=$1",
          [a.accountId],
        );
      }
      await f.pool.query(
        "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
      );
    };
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/window-discussion-native-worker.mjs',
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
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const checkpoints: string[] = [],
      losses: string[] = [];
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
              const c = message['command'] as
                WindowRootPublish | WindowReplyPublish;
              if (!c.body.startsWith('PENDING'))
                await reviewWindowDiscussion(
                  f.pool,
                  String(message['actorId']),
                  String(message['windowId']),
                  c,
                  typeof message['rootId'] === 'string'
                    ? message['rootId']
                    : null,
                );
            } else {
              checkpoints.push(name);
              if (name === 'first-root-committed') {
                const c = message['command'] as WindowRootPublish;
                const row = (
                  await f.pool.query<{ body: string }>(
                    'SELECT body FROM whaleu_ratings.window_discussion_comments WHERE actor_id=$1 AND request_id=$2',
                    [actor.accountId, c.clientRequestId],
                  )
                ).rows[0];
                assert.equal(row?.body, c.body);
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT id FROM whaleu_notifications.window_discussion_notices WHERE window_id=$1',
                      [window.id],
                    )
                  ).rowCount,
                  0,
                );
                await f.pool.query(
                  "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                );
              } else if (name === 'restore') await restore();
              else if (name === 'historical-like') {
                const comment = String(message['commentId']);
                const r = await request(http)
                  .get(
                    `/v1/ratings/windows/${window.id}/discussion/${comment}/my-like`,
                  )
                  .set('Authorization', `Bearer ${other.accessToken}`);
                assert.equal(r.status, 200, JSON.stringify(r.body));
                assert.equal(r.body.active, true);
                assert.equal(
                  (
                    await post(
                      `/v1/ratings/windows/${window.id}/discussion/${comment}/like`,
                      f.like(
                        r.body.catalogRevision,
                        { revision: r.body.windowRevision },
                        false,
                        r.body.revision,
                      ),
                      other,
                    )
                  )['active'],
                  false,
                );
                await f.pool.query(
                  "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                );
              } else if (name === 'loss') {
                const loss = String(message['loss']);
                losses.push(loss);
                if (loss === 'source')
                  await f.pool.query(
                    "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
                  );
                else if (loss === 'phone')
                  await f.certify(other.accountId, {
                    phone: 'unverified',
                    affiliation: 'unverified',
                    identity: false,
                  });
                else if (loss === 'safety')
                  await f.pool.query(
                    'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                    [other.accountId],
                  );
                else throw Error('Unknown loss ' + loss);
              } else if (name === 'like-notice-count') {
                const notices = await request(http)
                  .get('/v1/me/window-discussion/notices')
                  .set('Authorization', `Bearer ${actor.accessToken}`);
                assert.equal(notices.status, 200, JSON.stringify(notices.body));
                assert.equal(
                  notices.body.items.filter(
                    (i: {
                      status: string;
                      kind?: string;
                      target?: { commentId: string };
                    }) =>
                      i.status === 'available' &&
                      i.kind === 'like' &&
                      i.target?.commentId === message['commentId'],
                  ).length,
                  5,
                );
              } else if (name === 'paging-change') {
                const c = f.root(
                  catalog,
                  paging,
                  'Synthetic off-page inserted root',
                );
                await reviewWindowDiscussion(
                  f.pool,
                  other.accountId,
                  paging.id,
                  c,
                );
                assert.equal(
                  (
                    await post(
                      `/v1/ratings/windows/${paging.id}/discussion`,
                      c,
                      other,
                    )
                  )['outcome'],
                  'applied',
                );
              } else throw Error('Unknown checkpoint ' + name);
            }
            child.send({ event: 'continue', name });
          } else if (message['event'] === 'done') {
            done = true;
            assert.ok(Number(message['nativeCommands']) >= 10);
            assert.ok(Number(message['receiptReads']) >= 4);
            assert.ok(checkpoints.includes('first-root-committed'));
            assert.ok(checkpoints.includes('historical-like'));
            assert.ok(checkpoints.includes('like-notice-count'));
            assert.ok(checkpoints.includes('paging-change'));
            assert.ok(
              ['source', 'phone', 'safety'].every((s) => losses.includes(s)),
            );
            const cancelled = await request(http)
              .get(
                `/v1/ratings/windows/discussion-requests/${String(message['cancelledRequestId'])}`,
              )
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
            assert.equal(cancelled.body.code, 'WINDOW_DISCUSSION_CANCELLED');
            assert.equal(
              (
                await f.pool.query(
                  'SELECT id FROM whaleu_ratings.window_discussion_comments WHERE actor_id=$1 AND request_id=$2',
                  [actor.accountId, message['cancelledRequestId']],
                )
              ).rowCount,
              0,
            );
            const w1 = await request(http)
              .get(`/v1/ratings/windows/${window.id}`)
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(w1.status, 200, JSON.stringify(w1.body));
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
        if (!done)
          reject(
            Error(`Native window discussion worker exited ${code}: ${logs}`),
          );
      });
      child.send({
        port: f.port,
        actor: credentials(actor),
        other: credentials(other),
        windowId: window.id,
        pagingId: paging.id,
      });
    });
  },
);
