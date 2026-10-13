/** Witness actual queued canonical post locks, never just Promise.all timing. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import type { AdminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function orderedWriters<A, B>(
  f: AdminDiscussionRemovalFixture,
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
          ((sql.includes('FROM whaleu_community.posts') &&
            /FOR (UPDATE|SHARE)/.test(sql) &&
            values?.includes(post)) ||
            (index === 1 && sql.includes('whaleu:named-block-policy:v1')))
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
        AND (a.query LIKE '%whaleu_community.posts%' OR a.query LIKE '%whaleu:named-block-policy:v1%') AND $2::integer=ANY(pg_blocking_pids(a.pid))
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
      'The contender actually waits for the first backend canonical Safety-policy or post lock',
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
  'discussion removal serializes exact admin, author, parent deletion, pin, visibility and report-threshold writers',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      author = await f.actor(),
      admin = await f.actor(),
      secondAdmin = await f.actor();
    await f.grant(admin);
    await f.grant(secondAdmin);
    const prepare = async (kind: 'comment' | 'reply') => {
      const post = await f.publish(owner),
        root = await f.discussion(author, post.id),
        reply = await f.discussion(author, post.id, { rootId: root.id });
      const target = kind === 'comment' ? root : reply;
      const view = await f.removalManagement(target, admin);
      return {
        post,
        root,
        reply,
        target,
        command: f.removalCommand(target, view.targetVersion),
      };
    };
    const cause = async (id: string) =>
      (
        await f.pool.query(
          `SELECT
   (SELECT count(*)::int FROM whaleu_community.admin_discussion_removal_events WHERE target_id=$1) admin,
   (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type IN('comment_deleted','reply_deleted')) owner,
   (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='moderation_removed') reporting,
   (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1) jobs,
   (SELECT count(*)::int FROM whaleu_post_hotness.comment_sources WHERE content_id=$1 AND transition='deleted') negative`,
          [id],
        )
      ).rows[0]!;
    for (const kind of ['comment', 'reply'] as const) {
      await t.test(
        `${kind}: two actual administrators and same-key replay have one remover`,
        async () => {
          const { post, target, command } = await prepare(kind);
          const [first, second] = await orderedWriters(
            f,
            post.id,
            () => f.removalSend(admin, command),
            () =>
              f.removalSend(secondAdmin, {
                ...command,
                clientRequestId: randomUUID(),
              }),
          );
          assert.ok(applied(first), JSON.stringify(first.body));
          assert.ok(!applied(second));
          assert.deepEqual(await cause(target.id), {
            admin: 1,
            owner: 0,
            reporting: 0,
            jobs: 1,
            negative: 1,
          });
          assert.deepEqual(
            (await f.removalSend(admin, command)).body,
            first.body,
          );
        },
      );
      for (const adminFirst of [false, true])
        await t.test(
          `${kind}: owner deletion ${adminFirst ? 'after' : 'before'} administration retains real cause`,
          async () => {
            const { post, target, command } = await prepare(kind);
            const remove = () => f.removalSend(admin, command),
              own = () =>
                request(f.http)
                  .delete(
                    `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${target.id}`,
                  )
                  .set('Authorization', `Bearer ${author.accessToken}`);
            const [first, second] = await orderedWriters(
              f,
              post.id,
              adminFirst ? remove : own,
              adminFirst ? own : remove,
            );
            const administrative = adminFirst ? first : second,
              authored = adminFirst ? second : first;
            assert.equal(authored.status, 204, JSON.stringify(authored.body));
            assert.equal(applied(administrative), adminFirst);
            assert.deepEqual(await cause(target.id), {
              admin: adminFirst ? 1 : 0,
              owner: adminFirst ? 0 : 1,
              reporting: 0,
              jobs: 1,
              negative: 1,
            });
          },
        );
      for (const adminFirst of [false, true])
        await t.test(
          `${kind}: parent deletion ${adminFirst ? 'after' : 'before'} selected child`,
          async () => {
            const { post, root, target, command } = await prepare(kind);
            const remove = () => f.removalSend(admin, command),
              parent = () =>
                request(f.http)
                  .delete(
                    `/v1/community/${kind === 'comment' ? 'posts' : 'comments'}/${kind === 'comment' ? post.id : root.id}`,
                  )
                  .set(
                    'Authorization',
                    `Bearer ${(kind === 'comment' ? owner : author).accessToken}`,
                  );
            const [first, second] = await orderedWriters(
              f,
              post.id,
              adminFirst ? remove : parent,
              adminFirst ? parent : remove,
            );
            assert.equal((adminFirst ? second : first).status, 204);
            assert.equal(applied(adminFirst ? first : second), adminFirst);
            assert.equal((await cause(target.id)).admin, adminFirst ? 1 : 0);
            assert.equal((await cause(target.id)).negative, adminFirst ? 1 : 0);
          },
        );
      for (const ancestorKind of kind === 'reply'
        ? (['post', 'comment'] as const)
        : (['post'] as const))
        for (const childFirst of [false, true])
          await t.test(
            `${kind}: independent ${ancestorKind} admin runs ${childFirst ? 'after' : 'before'} child admin`,
            async () => {
              const { post, root, target, command } = await prepare(kind);
              const ancestor = {
                kind: ancestorKind,
                id: ancestorKind === 'post' ? post.id : root.id,
              };
              const prefix = `/v1/community/admin-${ancestorKind === 'post' ? 'post' : 'discussion'}-removal`;
              const management = await request(f.http)
                .get(`${prefix}/management`)
                .set('Authorization', `Bearer ${secondAdmin.accessToken}`)
                .query(ancestor);
              profileOk(management);
              const parentCommand = {
                clientRequestId: randomUUID(),
                target: ancestor,
                expectedTargetVersion: management.body.targetVersion,
                action:
                  ancestorKind === 'post' ? 'remove_post' : 'remove_discussion',
              };
              const parent = () =>
                request(f.http)
                  .post(`${prefix}/commands`)
                  .set('Authorization', `Bearer ${secondAdmin.accessToken}`)
                  .send(parentCommand);
              const child = () => f.removalSend(admin, command);
              const [first, second] = await orderedWriters(
                f,
                post.id,
                childFirst ? child : parent,
                childFirst ? parent : child,
              );
              const parentResult = childFirst ? second : first;
              if (childFirst) {
                assert.equal(
                  parentResult.status,
                  503,
                  JSON.stringify(parentResult.body),
                );
                assert.equal(
                  parentResult.body.error.code,
                  ancestorKind === 'post'
                    ? 'ADMIN_POST_REMOVAL_UNAVAILABLE'
                    : 'ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE',
                );
                const recovery = await request(f.http)
                  .get(`${prefix}/requests/${parentCommand.clientRequestId}`)
                  .set('Authorization', `Bearer ${secondAdmin.accessToken}`);
                profileOk(recovery);
                assert.deepEqual(recovery.body, { state: 'not_recorded' });
                assert.equal(
                  (
                    await f.pool.query(
                      `SELECT deleted_at FROM whaleu_community.${ancestorKind === 'post' ? 'posts' : 'root_comments'} WHERE id=$1`,
                      [ancestor.id],
                    )
                  ).rows[0]!.deleted_at,
                  null,
                );
                assert.equal(
                  (
                    await f.pool.query(
                      'SELECT count(*)::int n FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1',
                      [ancestor.id],
                    )
                  ).rows[0]!.n,
                  0,
                );
                assert.equal(
                  (
                    await f.pool.query(
                      `SELECT count(*)::int n FROM whaleu_community.${ancestorKind === 'post' ? 'admin_post_removal_events' : 'admin_discussion_removal_events'} WHERE target_id=$1`,
                      [ancestor.id],
                    )
                  ).rows[0]!.n,
                  0,
                );
                // The race changed the retained initial Community vector, not the
                // parent's target CAS. Retry the exact same intent/key, never swap
                // target/version/action under an unresolved key.
                const current = await request(f.http)
                  .get(`${prefix}/management`)
                  .set('Authorization', `Bearer ${secondAdmin.accessToken}`)
                  .query(ancestor);
                profileOk(current);
                assert.equal(
                  current.body.targetVersion,
                  parentCommand.expectedTargetVersion,
                );
                const retry = await parent();
                profileOk(retry);
                assert.ok(applied(retry), JSON.stringify(retry.body));
                assert.equal(
                  retry.body.requestId,
                  parentCommand.clientRequestId,
                );
              } else
                assert.ok(
                  applied(parentResult),
                  JSON.stringify(parentResult.body),
                );
              assert.equal(applied(childFirst ? first : second), childFirst);
              assert.deepEqual(await cause(target.id), {
                admin: childFirst ? 1 : 0,
                owner: 0,
                reporting: 0,
                jobs: childFirst ? 1 : 0,
                negative: childFirst ? 1 : 0,
              });
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1',
                    [ancestor.id],
                  )
                ).rows[0]!.n,
                1,
              );
              const row = (
                await f.pool.query(
                  `SELECT deleted_at FROM whaleu_community.${kind === 'comment' ? 'root_comments' : 'replies'} WHERE id=$1`,
                  [target.id],
                )
              ).rows[0]!;
              assert.equal(
                row.deleted_at !== null,
                childFirst,
                'Ancestor removal never fabricates the child tombstone',
              );
            },
          );
      for (const adminFirst of [false, true])
        await t.test(
          `${kind}: owner hide ${adminFirst ? 'after' : 'before'} selected child`,
          async () => {
            const { post, target, command } = await prepare(kind);
            const remove = () => f.removalSend(admin, command),
              hide = () =>
                request(f.http)
                  .post('/v1/me/community/owner-visibility-commands')
                  .set('Authorization', `Bearer ${owner.accessToken}`)
                  .send({
                    clientRequestId: randomUUID(),
                    postId: post.id,
                    ownerHidden: true,
                    expectedVersion: 0,
                  });
            const [first, second] = await orderedWriters(
              f,
              post.id,
              adminFirst ? remove : hide,
              adminFirst ? hide : remove,
            );
            assert.equal(applied(adminFirst ? first : second), adminFirst);
            assert.ok(applied(adminFirst ? second : first));
            assert.equal((await cause(target.id)).admin, adminFirst ? 1 : 0);
          },
        );
      for (const adminFirst of [false, true])
        await t.test(
          `${kind}: exact root pin ${adminFirst ? 'after' : 'before'} selected child`,
          async () => {
            const { post, root, target, command } = await prepare(kind);
            const remove = () => f.removalSend(admin, command),
              pin = () =>
                request(f.http)
                  .put(`/v1/community/comments/${root.id}/pin`)
                  .set('Authorization', `Bearer ${owner.accessToken}`)
                  .send({ clientRequestId: randomUUID() });
            const [first, second] = await orderedWriters(
              f,
              post.id,
              adminFirst ? remove : pin,
              adminFirst ? pin : remove,
            );
            assert.ok(
              applied(adminFirst ? first : second),
              JSON.stringify([first.body, second.body]),
            );
            const pinned = adminFirst ? second : first;
            if (kind === 'reply' || !adminFirst) profileOk(pinned);
            else
              assert.equal(
                pinned.body.outcome,
                'rejected',
                JSON.stringify(pinned.body),
              );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.comment_pins WHERE comment_id=$1',
                  [root.id],
                )
              ).rowCount,
              kind === 'reply' ? 1 : 0,
            );
            assert.equal((await cause(target.id)).admin, 1);
          },
        );
      await t.test(
        `${kind}: genuine tenth report competes with admin removal without fabricated reporting or XP`,
        async () => {
          for (const adminFirst of [false, true]) {
            const { post, target, command } = await prepare(kind);
            const reporters: (typeof author)[] = [];
            for (let i = 0; i < 10; i++) reporters.push(await f.actor());
            const report = (actor: typeof admin) =>
              request(f.http)
                .post('/v1/me/safety/reports')
                .set('Authorization', `Bearer ${actor.accessToken}`)
                .send({
                  clientRequestId: randomUUID(),
                  target: { kind, id: target.id },
                });
            for (const reporter of reporters.slice(0, 9)) {
              const result = await report(reporter);
              profileOk(result);
              assert.equal(result.body.outcome, 'accepted');
            }
            const view = await f.removalManagement(target, admin);
            command.expectedTargetVersion = view.targetVersion;
            const remove = () => f.removalSend(admin, command),
              threshold = () => report(reporters[9]!);
            const [first, second] = await orderedWriters(
              f,
              post.id,
              adminFirst ? remove : threshold,
              adminFirst ? threshold : remove,
            );
            assert.equal(applied(adminFirst ? first : second), adminFirst);
            assert.deepEqual(await cause(target.id), {
              admin: adminFirst ? 1 : 0,
              owner: 0,
              reporting: adminFirst ? 0 : 1,
              jobs: 1,
              negative: 1,
            });
          }
        },
      );
    }
  },
);
