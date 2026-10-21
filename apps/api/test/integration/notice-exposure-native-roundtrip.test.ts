/** Fresh disposable PostgreSQL and real AppModule writers/read owners.
 * The isolated worker executes emitted native Page/controller/ApiClient code.
 * Its wx intersection/commit callbacks and dwell clock are explicitly simulated;
 * this is bounded social likes/follows evidence, not all-source or Tencent proof.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  socialAuth,
  withSocialUpdatesFixture,
} from '../support/social-updates-fixture.js';

const likeRoles = ['qualifying', 'unknown', 'late', 'manual'] as const;
type LikeRole = (typeof likeRoles)[number];
type NoticeRole = LikeRole | 'follower';
const phases: readonly [string, readonly NoticeRole[]][] = [
  ['loaded', []],
  ['offscreen', []],
  ['short-dwell', []],
  ['stale-render', []],
  ['hidden', []],
  ['account-changed', []],
  ['navigated', []],
  ['qualified', ['qualifying']],
  ['unknown-committed', ['qualifying', 'unknown']],
  ['unknown-not-retried', ['qualifying', 'unknown']],
  ['manual-reconciled', ['qualifying', 'unknown']],
  ['late-in-flight', ['qualifying', 'unknown', 'late']],
  ['late-discarded', ['qualifying', 'unknown', 'late']],
  ['reloaded', ['qualifying', 'unknown', 'late']],
  ['manual-only', likeRoles],
  ['follow-qualified', [...likeRoles, 'follower']],
  ['durable', [...likeRoles, 'follower']],
];
interface NativeWrite {
  noticeId: string;
  category: 'likes' | 'followers';
  method: 'PUT';
}
interface NativeReceipt {
  noticeId: string;
  readAt: string;
  unreadCount: number;
  unreadCountStatus: 'available';
}
type WorkerMessage =
  | { event: 'checkpoint'; name: string; sequence: number }
  | { event: 'done'; writes: NativeWrite[]; receipts: NativeReceipt[] }
  | { event: 'failure'; message: string };
const exactCount = (unreadCount: number) => ({
  unreadCount,
  unreadCountStatus: 'available',
});

test(
  'emitted social Page viewport dwell -> exact owner HTTP acknowledgment -> durable PostgreSQL receipt',
  { timeout: 240000 },
  async (t) => {
    await withSocialUpdatesFixture(async (f) => {
      const owner = await f.actor();
      const actor = await f.actor();
      const other = await f.actor();
      const postIds = {} as Record<LikeRole, string>;
      for (const role of likeRoles) {
        const post = await f.publish(owner);
        postIds[role] = post.id;
        const liked = await request(f.http)
          .put(`/v1/community/posts/${post.id}/like`)
          .set('Authorization', socialAuth(actor))
          .send({ requestId: randomUUID(), liked: true });
        assert.equal(liked.status, 200, JSON.stringify(liked.body));
        assert.equal(liked.body.outcome, 'applied');
      }
      // Public identities and follow privacy are established by the ordinary
      // profile writer, never direct profile/source/notice inserts.
      const ownerProfile = await f.profile(owner);
      await f.profile(actor);
      const followed = await request(f.http)
        .post(`/v1/profiles/${ownerProfile}/follow`)
        .set('Authorization', socialAuth(actor))
        .send({ requestId: randomUUID() });
      assert.equal(followed.status, 200, JSON.stringify(followed.body));
      assert.equal(followed.body.outcome, 'applied');
      await f.dispatcher.cycle();
      const work = await f.pool.query<{ state: string; outcome: string }>(
        `SELECT w.state,r.outcome
         FROM whaleu_notifications.social_work w
         JOIN whaleu_notifications.social_receipts r ON r.source_id=w.source_id
         WHERE w.recipient_account_id=$1`,
        [owner.accountId],
      );
      assert.equal(work.rowCount, 5);
      assert.ok(
        work.rows.every(
          (row) => row.state === 'completed' && row.outcome === 'materialized',
        ),
      );

      const likes = await f.list(owner, 'likes');
      assert.equal(likes.items.length, 4);
      const noticeIds = {} as Record<NoticeRole, string>;
      for (const role of likeRoles) {
        const notice = likes.items.find(
          (item) =>
            item.status === 'available' &&
            item.kind === 'like' &&
            item.target.type === 'community' &&
            item.target.postId === postIds[role],
        );
        assert.ok(notice, `Real worker materialized ${role}`);
        assert.equal(notice.readAt, null);
        noticeIds[role] = notice.noticeId;
      }
      const follows = await f.list(owner, 'followers');
      assert.equal(follows.items.length, 1);
      assert.equal(follows.items[0]!.readAt, null);
      noticeIds.follower = follows.items[0]!.noticeId;
      assert.equal(new Set(Object.values(noticeIds)).size, 5);

      const firstReadAt = new Map<string, string>();
      async function assertDurable(
        readRoles: readonly NoticeRole[],
        phase: string,
      ) {
        const readIds = new Set(readRoles.map((role) => noticeIds[role]));
        const stored = await f.pool.query<{
          id: string;
          read_at: string | null;
        }>(
          `SELECT id,to_char(read_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') read_at
           FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1`,
          [owner.accountId],
        );
        assert.equal(stored.rowCount, 5, phase);
        for (const item of stored.rows) {
          assert.ok(Object.values(noticeIds).includes(item.id), phase);
          if (!readIds.has(item.id)) {
            assert.equal(
              item.read_at,
              null,
              `${phase}: no invented database read`,
            );
            continue;
          }
          assert.equal(typeof item.read_at, 'string');
          assert.match(item.read_at!, /^\d{4}-.*\.\d{6}Z$/);
          if (!firstReadAt.has(item.id))
            firstReadAt.set(item.id, item.read_at!);
          assert.equal(
            item.read_at,
            firstReadAt.get(item.id),
            `${phase}: first read timestamp is immutable`,
          );
        }
        for (const category of ['likes', 'followers'] as const) {
          const expectedUnread =
            category === 'likes'
              ? likeRoles.filter((role) => !readIds.has(noticeIds[role])).length
              : Number(!readIds.has(noticeIds.follower));
          assert.deepEqual(
            await f.count(owner, category),
            exactCount(expectedUnread),
            phase,
          );
          const fresh = await f.list(owner, category);
          assert.equal(fresh.unreadCount, expectedUnread, phase);
          assert.equal(fresh.unreadCountStatus, 'available', phase);
          assert.equal(fresh.items.length, category === 'likes' ? 4 : 1, phase);
          for (const item of fresh.items)
            assert.equal(
              item.readAt,
              firstReadAt.get(item.noticeId) ?? null,
              `${phase}: fresh HTTP agrees with durable PostgreSQL`,
            );
        }
        assert.deepEqual(await f.count(owner, 'saves'), exactCount(0), phase);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1',
              [other.accountId],
            )
          ).rowCount,
          0,
          `${phase}: replacement account gained no notice or read`,
        );
      }
      await assertDurable([], 'before native mount');
      await f.app.listen(0, '127.0.0.1');
      const port = (f.http.address() as AddressInfo).port;
      const child = fork(
        fileURLToPath(
          new URL(
            '../support/notice-exposure-native-worker.mjs',
            import.meta.url,
          ),
        ),
        [],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: ['--import', 'tsx'],
          env: { ...process.env },
          signal: t.signal,
        },
      );
      // Register termination immediately: database teardown must never race a
      // still-running child or an in-flight checkpoint query after failure.
      const closed = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      let logs = '';
      let phaseIndex = 0;
      let acceptingMessages = true;
      let checkpointWork = Promise.resolve();
      let protocolFailure: Error | undefined;
      let completed: Extract<WorkerMessage, { event: 'done' }> | undefined;
      child.stdout?.on('data', (value) => {
        logs += String(value);
      });
      child.stderr?.on('data', (value) => {
        logs += String(value);
      });
      const sendToWorker = (message: object) =>
        new Promise<void>((resolve, reject) => {
          if (!child.connected) {
            reject(new Error('Native exposure IPC closed before send'));
            return;
          }
          child.send(message, (error) => (error ? reject(error) : resolve()));
        });
      try {
        const finished = new Promise<void>((resolve, reject) => {
          const fail = (error: unknown) => {
            acceptingMessages = false;
            protocolFailure ??=
              error instanceof Error ? error : new Error(String(error));
            reject(protocolFailure);
          };
          child.once('error', fail);
          child.once('close', (code) => {
            if (code !== 0 || protocolFailure) {
              fail(
                protocolFailure ??
                  new Error(`Native exposure worker exited ${code}: ${logs}`),
              );
              return;
            }
            // A delivered done message may still be behind the previous send's
            // completion in our serialized queue. Drain already received work
            // before deciding that a clean child exit omitted its final result.
            void checkpointWork
              .then(() => {
                acceptingMessages = false;
                if (protocolFailure) reject(protocolFailure);
                else if (completed) resolve();
                else
                  fail(
                    new Error(
                      `Native exposure worker exited without a result: ${logs}`,
                    ),
                  );
              })
              .catch(fail);
          });
          child.on('message', (raw: unknown) => {
            if (!acceptingMessages) {
              fail(
                new Error(
                  'Native exposure worker sent a message after terminal state',
                ),
              );
              return;
            }
            // Serialize database checkpoint work. Every queued operation checks
            // terminal state before starting; failure stops any later query set.
            checkpointWork = checkpointWork
              .then(async () => {
                if (!acceptingMessages)
                  throw new Error(
                    'Native exposure checkpoint queued after terminal state',
                  );
                assert.ok(raw && typeof raw === 'object' && 'event' in raw);
                const message = raw as WorkerMessage;
                if (message.event === 'failure')
                  throw new Error(message.message);
                if (message.event === 'done') {
                  assert.equal(
                    phaseIndex,
                    phases.length,
                    'Every database boundary was independently verified',
                  );
                  completed = message;
                  acceptingMessages = false;
                  return;
                }
                assert.equal(message.event, 'checkpoint');
                const phase = phases[phaseIndex];
                assert.ok(phase, 'No unexpected checkpoint');
                assert.equal(message.sequence, phaseIndex + 1);
                assert.equal(message.name, phase[0]);
                await assertDurable(phase[1], phase[0]);
                if (!acceptingMessages)
                  throw new Error(
                    'Native exposure worker ended during database checkpoint',
                  );
                phaseIndex++;
                await sendToWorker({
                  event: 'checkpoint-result',
                  sequence: message.sequence,
                });
              })
              .catch(fail);
          });
          void sendToWorker({
            event: 'start',
            port,
            credentials: owner,
            otherCredentials: other,
            noticeIds,
            postIds,
          }).catch(fail);
        });
        await finished;
        assert.ok(completed);
        assert.equal(completed.writes.length, 6);
        for (const [role, noticeId] of Object.entries(noticeIds)) {
          const writes: NativeWrite[] = completed.writes.filter(
            (write) => write.noticeId === noticeId,
          );
          assert.equal(writes.length, role === 'unknown' ? 2 : 1);
          assert.ok(
            writes.every(
              (write) =>
                write.method === 'PUT' &&
                write.category ===
                  (role === 'follower' ? 'followers' : 'likes'),
            ),
          );
        }
        // The lost response is intentionally absent; the explicit retry obtains
        // the same first server timestamp observed while that response was lost.
        assert.equal(completed.receipts.length, 5);
        assert.equal(
          new Set(completed.receipts.map((receipt) => receipt.noticeId)).size,
          5,
        );
        for (const receipt of completed.receipts) {
          assert.equal(receipt.readAt, firstReadAt.get(receipt.noticeId));
          assert.equal(receipt.unreadCountStatus, 'available');
          const role = (
            Object.entries(noticeIds) as [NoticeRole, string][]
          ).find(([, id]) => id === receipt.noticeId)?.[0];
          assert.ok(role);
          assert.equal(
            receipt.unreadCount,
            { qualifying: 3, unknown: 2, late: 1, manual: 0, follower: 0 }[
              role
            ],
          );
        }
        await assertDurable(
          [...likeRoles, 'follower'],
          'after native worker exit',
        );
      } finally {
        acceptingMessages = false;
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        // A query already started before failure may finish, but no new message
        // starts work and no checkpoint remains active when PG cleanup begins.
        await checkpointWork;
      }
    });
  },
);
