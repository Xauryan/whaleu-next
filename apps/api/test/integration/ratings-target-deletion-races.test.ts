import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { RatingsRepository } from '../../src/ratings/repository.js';
import { RatingTargetOwnerDeletionRepository } from '../../src/ratings/management/target-deletion/repository.js';
import { RatingCompletePoolRepository } from '../../src/ratings/random/complete-pool.repository.js';

const prefix = '/v1/ratings/management/owner-deletion';
function barrier() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reach, release, reached, held };
}
async function atBarrier(reached: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Expected real M2A race barrier within five seconds'),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function tracked<T>(pending: Promise<unknown>[], operation: Promise<T>) {
  pending.push(operation);
  void operation.catch(() => undefined);
  return operation;
}

test(
  'M2A deferred waits cannot cross phone, Safety or presented-session deadlines',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    for (const mode of [
      'phone',
      'safety',
      'negative_safety',
      'session',
    ] as const)
      await t.test(
        `${mode} expiry rolls back the entire tentative owner command and the same key remains retryable`,
        async () => {
          const actor = await f.actor();
          const catalog = await f.catalog(actor),
            target = catalog.targets[0]!;
          const command = {
            clientRequestId: randomUUID(),
            expectedTargetRevision: target.revision,
          };
          const remove = () =>
            f
              .auth(
                request(f.http).post(`${prefix}/targets/${target.id}`),
                actor,
              )
              .send(command);
          await f.pool
            .query(`CREATE FUNCTION whaleu_ratings.synthetic_target_owner_delete_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$;
        CREATE CONSTRAINT TRIGGER synthetic_target_owner_delete_wait AFTER INSERT ON whaleu_ratings.requests
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='delete_target')
        EXECUTE FUNCTION whaleu_ratings.synthetic_target_owner_delete_wait()`);
          if (mode === 'phone')
            await f.certify(actor.accountId, {
              expiresAt: new Date(Date.now() + 2000),
            });
          else if (mode === 'session')
            await f.pool.query(
              "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
              [actor.sessionId],
            );
          else
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "UPDATE whaleu_safety.account_heads SET actions_allowed=$2,valid_until=clock_timestamp()+interval '2 seconds' WHERE account_id=$1",
                [actor.accountId, mode !== 'negative_safety'],
              ),
            );
          const beforeTarget = (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.targets WHERE id=$1',
              [target.id],
            )
          ).rows;
          const beforeStates = (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.target_state_revisions WHERE target_id=$1 ORDER BY revision',
              [target.id],
            )
          ).rows;
          const beforeEpochs = (
            await f.pool.query(
              'SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,(SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation',
            )
          ).rows;
          const observer = observeDirectoryQueries(f.app);
          const statements: string[] = [];
          observer.setHook(async ({ sql }) => {
            statements.push(sql);
          });
          try {
            const started = Date.now();
            const result = await remove();
            assert.ok(
              Date.now() - started >= 2300,
              'The actual SQL deferred wait must execute after writing the tentative result',
            );
            const code =
              mode === 'phone'
                ? 'VERIFICATION_UNAVAILABLE'
                : mode === 'session'
                  ? 'ACCESS_TOKEN_EXPIRED'
                  : 'SAFETY_UNAVAILABLE';
            assert.equal(
              result.body.error?.code,
              code,
              JSON.stringify(result.body),
            );
            assert.ok(
              statements.some((sql) =>
                /UPDATE whaleu_ratings\.requests SET receipt/.test(sql),
              ),
              'A receipt was tentatively written before deferred finalization',
            );
            if (mode === 'negative_safety') {
              assert.ok(
                statements.some((sql) =>
                  /INSERT INTO whaleu_ratings\.target_owner_delete_closures/.test(
                    sql,
                  ),
                ),
              );
              assert.ok(
                statements.every(
                  (sql) =>
                    !/INSERT INTO whaleu_ratings\.target_owner_delete_audits/.test(
                      sql,
                    ),
                ),
              );
            } else {
              assert.ok(
                statements.some((sql) =>
                  /INSERT INTO whaleu_ratings\.target_owner_delete_audits/.test(
                    sql,
                  ),
                ),
              );
              assert.ok(
                statements.some((sql) =>
                  /UPDATE whaleu_ratings\.targets SET active=false/.test(sql),
                ),
              );
              assert.ok(
                statements.some((sql) =>
                  /INSERT INTO whaleu_ratings\.target_owner_tombstones/.test(
                    sql,
                  ),
                ),
              );
            }
            for (const table of [
              'requests',
              'command_claims',
              'target_owner_delete_audits',
              'target_owner_delete_closures',
              'effect_events',
            ])
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT 1 FROM whaleu_ratings.${table} WHERE request_id=$1`,
                    [command.clientRequestId],
                  )
                ).rowCount,
                0,
                table,
              );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
                  [target.id],
                )
              ).rowCount,
              0,
            );
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT * FROM whaleu_ratings.targets WHERE id=$1',
                  [target.id],
                )
              ).rows,
              beforeTarget,
            );
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT * FROM whaleu_ratings.target_state_revisions WHERE target_id=$1 ORDER BY revision',
                  [target.id],
                )
              ).rows,
              beforeStates,
            );
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,(SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation',
                )
              ).rows,
              beforeEpochs,
            );
          } finally {
            observer.restore();
            await f.pool.query(
              'DROP TRIGGER synthetic_target_owner_delete_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_target_owner_delete_wait()',
            );
          }
          await f.certify(actor.accountId);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=true,valid_until=NULL WHERE account_id=$1',
              [actor.accountId],
            ),
          );
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '10 minutes' WHERE session_id=$1",
            [actor.sessionId],
          );
          const retryObserver = observeDirectoryQueries(f.app);
          const finalStatements: string[] = [];
          let finalized = false;
          retryObserver.setHook(async ({ sql }) => {
            if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') finalized = true;
            else if (finalized) finalStatements.push(sql);
          });
          try {
            const retry = await remove();
            assert.equal(retry.status, 200, JSON.stringify(retry.body));
            assert.equal(
              retry.body.outcome,
              'applied',
              JSON.stringify(retry.body),
            );
            assert.notEqual(retry.body.revision, target.revision);
            assert.ok(
              finalStatements.some(
                (sql) =>
                  sql.includes('JOIN whaleu_ratings.targets t') &&
                  sql.includes('target_owner_tombstones'),
              ),
              'A real bounded after-state proof ran without retaining stale before state',
            );
            assert.ok(
              finalStatements.every(
                (sql) => !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql),
              ),
              'Owner final proof remains read-only',
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.target_owner_delete_audits WHERE request_id=$1',
                  [command.clientRequestId],
                )
              ).rows[0]!.n,
              1,
            );
          } finally {
            retryObserver.restore();
          }
        },
      );
  },
);

test(
  'M2A target deletion and real score/child cleanup commands linearize in both orders',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      writer = await f.actor();
    const catalog = await f.catalog(owner, { count: 4 });
    const records = f.app.get(RatingsRepository);
    const metadata = f.app.get(RatingTargetOwnerDeletionRepository);
    const remove = (
      target: (typeof catalog.targets)[number],
      command = {
        clientRequestId: randomUUID(),
        expectedTargetRevision: target.revision,
      },
    ) =>
      f
        .auth(request(f.http).post(`${prefix}/targets/${target.id}`), owner)
        .send(command);
    const score = (target: (typeof catalog.targets)[number]) =>
      f
        .auth(
          request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
          writer,
        )
        .send({
          clientRequestId: randomUUID(),
          regionId: null,
          expectedTargetRevision: target.revision,
          expectedRevision: null,
          score: 5,
        });

    await t.test(
      'already-authorized scoring finishes before queued owner deletion takes any pool epoch',
      async (sub) => {
        const target = catalog.targets[0]!,
          b = barrier(),
          pending: Promise<unknown>[] = [];
        const original = records.setScore.bind(records);
        const hook = sub.mock.method(
          records,
          'setScore',
          async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if (args[0] === target.id) {
              b.reach();
              await b.held;
            }
            return result;
          },
        );
        try {
          const scoring = tracked(
            pending,
            score(target).then((response) => response),
          );
          await atBarrier(b.reached);
          const deleting = tracked(
            pending,
            remove(target).then((response) => response),
          );
          await f.waitForLock(
            "pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1'",
          );
          b.release();
          const [scored, deleted] = await Promise.all([scoring, deleting]);
          assert.equal(
            scored.body.outcome,
            'applied',
            JSON.stringify(scored.body),
          );
          assert.equal(
            deleted.body.outcome,
            'applied',
            JSON.stringify(deleted.body),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT score FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
                [target.id, writer.accountId],
              )
            ).rows[0]!.score,
            5,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count,sum FROM whaleu_ratings.score_summaries WHERE target_id=$1',
                [target.id],
              )
            ).rows[0]!.count,
            '1',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=$1',
                [deleted.body.requestId],
              )
            ).rowCount,
            0,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    await t.test(
      'owner deletion wins before a fresh score and the late write cannot resurrect or mint a transition',
      async (sub) => {
        const target = catalog.targets[1]!,
          b = barrier(),
          pending: Promise<unknown>[] = [];
        const original = metadata.metadata.bind(metadata);
        const hook = sub.mock.method(
          metadata,
          'metadata',
          async (...args: Parameters<typeof original>) => {
            const row = await original(...args);
            if (args[0] === target.id) {
              b.reach();
              await b.held;
            }
            return row;
          },
        );
        try {
          const deleting = tracked(
            pending,
            remove(target).then((response) => response),
          );
          await atBarrier(b.reached);
          const scoring = tracked(
            pending,
            score(target).then((response) => response),
          );
          await f.waitForLock(
            "pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1'",
          );
          b.release();
          const [deleted, scored] = await Promise.all([deleting, scoring]);
          assert.equal(
            deleted.body.outcome,
            'applied',
            JSON.stringify(deleted.body),
          );
          assert.equal(
            scored.body.code,
            'RATING_NOT_FOUND',
            JSON.stringify(scored.body),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.scores WHERE target_id=$1',
                [target.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.score_transitions WHERE target_id=$1',
                [target.id],
              )
            ).rowCount,
            0,
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
      },
    );

    for (const ownerFirst of [false, true])
      await t.test(
        `child author cleanup ${ownerFirst ? 'after' : 'before'} owner deletion preserves each independent CAS and history`,
        async (sub) => {
          const target = catalog.targets[ownerFirst ? 3 : 2]!;
          const root = await f.publish(writer, catalog, target);
          const command = {
            clientRequestId: randomUUID(),
            regionId: null,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRevision: root.revision,
          };
          const cleanup = (input = command) =>
            f
              .auth(
                request(f.http).delete(`/v1/ratings/comments/${root.id}`),
                writer,
              )
              .send(input);
          const b = barrier(),
            pending: Promise<unknown>[] = [];
          const originalOwner = metadata.metadata.bind(metadata);
          const originalChild = records.deleteComment.bind(records);
          const hook = ownerFirst
            ? sub.mock.method(
                metadata,
                'metadata',
                async (...args: Parameters<typeof originalOwner>) => {
                  const row = await originalOwner(...args);
                  if (args[0] === target.id) {
                    b.reach();
                    await b.held;
                  }
                  return row;
                },
              )
            : sub.mock.method(
                records,
                'deleteComment',
                async (...args: Parameters<typeof originalChild>) => {
                  const result = await originalChild(...args);
                  if (args[0].id === root.id) {
                    b.reach();
                    await b.held;
                  }
                  return result;
                },
              );
          try {
            let deleting: Promise<request.Response>,
              cleaning: Promise<request.Response>;
            if (ownerFirst) {
              deleting = tracked(
                pending,
                remove(target).then((response) => response),
              );
              await atBarrier(b.reached);
              cleaning = tracked(
                pending,
                cleanup().then((response) => response),
              );
              await f.waitForLock(
                "pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1'",
              );
            } else {
              cleaning = tracked(
                pending,
                cleanup().then((response) => response),
              );
              await atBarrier(b.reached);
              deleting = tracked(
                pending,
                remove(target).then((response) => response),
              );
              await f.waitForLock(
                "pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1'",
              );
            }
            b.release();
            const [deleted, cleaned] = await Promise.all([deleting, cleaning]);
            assert.equal(
              deleted.body.outcome,
              'applied',
              JSON.stringify(deleted.body),
            );
            if (ownerFirst) {
              assert.equal(
                cleaned.body.code,
                'RATING_REVISION_CONFLICT',
                JSON.stringify(cleaned.body),
              );
              const current = await f.auth(
                request(f.http).get(
                  `/v1/ratings/comments/${root.id}/deletion-context`,
                ),
                writer,
              );
              assert.equal(current.body.targetRevision, deleted.body.revision);
              const retry = await cleanup({
                ...command,
                clientRequestId: randomUUID(),
                expectedTargetRevision: current.body.targetRevision,
              });
              assert.equal(
                retry.body.outcome,
                'applied',
                JSON.stringify(retry.body),
              );
            } else
              assert.equal(
                cleaned.body.outcome,
                'applied',
                JSON.stringify(cleaned.body),
              );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_ratings.comment_transitions WHERE comment_id=$1 AND operation='delete_comment'",
                  [root.id],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind='root_deleted'",
                  [root.id],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
                  [target.id],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=$1',
                  [deleted.body.requestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            b.release();
            hook.mock.restore();
            await Promise.allSettled(pending);
          }
        },
      );
  },
);

test(
  'M2A uses Safety-before-pool locking and tombstone statements participate in R3R pending fences',
  { timeout: 90000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      catalog = await f.catalog(actor, { count: 2 });
    const target = catalog.targets[0]!;
    const pool = f.app.get(RatingCompletePoolRepository);
    const sample = () =>
      f
        .auth(request(f.http).get('/v1/ratings/random-target'), actor)
        .query({ categoryId: catalog.categoryId });
    const epochs = async () =>
      (
        await f.pool.query<{ pool: string; navigation: string }>(
          'SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,(SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation',
        )
      ).rows[0]!;

    await t.test(
      'an authorized complete-pool read linearizes before a waiting owner deletion; the next complete read excludes it',
      async (sub) => {
        const before = await epochs(),
          b = barrier(),
          pending: Promise<unknown>[] = [];
        const original = pool.complete.bind(pool);
        const hook = sub.mock.method(
          pool,
          'complete',
          async (...args: Parameters<typeof original>) => {
            await original(...args);
            b.reach();
            await b.held;
          },
        );
        try {
          const reading = tracked(
            pending,
            sample().then((response) => response),
          );
          await atBarrier(b.reached);
          const deleting = tracked(
            pending,
            f
              .auth(
                request(f.http).post(`${prefix}/targets/${target.id}`),
                actor,
              )
              .send({
                clientRequestId: randomUUID(),
                expectedTargetRevision: target.revision,
              })
              .then((response) => response),
          );
          await f.waitForLock(
            "pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1'",
          );
          const waiting = (
            await f.pool.query<{ pid: number }>(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended(%' AND query LIKE '%whaleu:named-block-policy:v1%' ORDER BY pid",
            )
          ).rows;
          assert.ok(waiting.length > 0);
          for (const { pid } of waiting)
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='whaleu_ratings.random_pool_epoch'::regclass AND granted AND mode='RowExclusiveLock'",
                  [pid],
                )
              ).rowCount,
              0,
              'A deletion waiting on Safety must not already hold the pool writer fence',
            );
          assert.deepEqual(await epochs(), before);
          b.release();
          const [read, deleted] = await Promise.all([reading, deleting]);
          assert.equal(read.status, 200, JSON.stringify(read.body));
          assert.equal(read.body.candidateCount, 2);
          assert.equal(
            deleted.body.outcome,
            'applied',
            JSON.stringify(deleted.body),
          );
        } finally {
          b.release();
          hook.mock.restore();
          await Promise.allSettled(pending);
        }
        const after = await epochs();
        assert.ok(BigInt(after.pool) > BigInt(before.pool));
        assert.ok(BigInt(after.navigation) > BigInt(before.navigation));
        const fresh = await sample();
        assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
        assert.equal(fresh.body.candidateCount, 1);
        assert.equal(fresh.body.item.target.id, catalog.targets[1]!.id);
      },
    );

    await t.test(
      'zero-row tombstone writers take both mutation epochs, reject pending SHARE NOWAIT fences and preserve trigger order',
      async () => {
        const triggerOrder = (
          await f.pool.query<{
            tgname: string;
          }>(`SELECT tgname FROM pg_trigger WHERE tgrelid='whaleu_ratings.target_owner_tombstones'::regclass
      AND NOT tgisinternal AND (tgtype & 1)=0 AND (tgtype & 2)=2 AND (tgtype & 16)=16 ORDER BY tgname`)
        ).rows.map((row) => row.tgname);
        assert.deepEqual(triggerOrder.slice(0, 3), [
          'a0_rating_owner_delete_writer',
          'a1_rating_owner_delete_pool',
          'a2_rating_owner_delete_navigation',
        ]);
        const holder = await f.pool.connect(),
          reader = await f.pool.connect();
        const before = await epochs();
        try {
          await holder.query('BEGIN');
          await holder.query(
            'UPDATE whaleu_ratings.target_owner_tombstones SET target_id=target_id WHERE false',
          );
          const pending = (
            await holder.query<{ pool: string; navigation: string }>(
              'SELECT (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,(SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation',
            )
          ).rows[0]!;
          assert.equal(BigInt(pending.pool), BigInt(before.pool) + 1n);
          assert.equal(
            BigInt(pending.navigation),
            BigInt(before.navigation) + 1n,
          );
          assert.deepEqual(
            await epochs(),
            before,
            'The reader cannot see an uncommitted epoch as a committed pool',
          );
          await reader.query('BEGIN');
          await assert.rejects(
            reader.query(
              'LOCK TABLE whaleu_ratings.random_pool_epoch IN SHARE MODE NOWAIT',
            ),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === '55P03',
          );
          await reader.query('ROLLBACK');
          await holder.query('COMMIT');
          assert.deepEqual(await epochs(), pending);
        } finally {
          await reader.query('ROLLBACK');
          await holder.query('ROLLBACK');
          reader.release();
          holder.release();
        }
        const stable = await sample();
        assert.equal(stable.status, 200, JSON.stringify(stable.body));
        assert.equal(stable.body.candidateCount, 1);
      },
    );
  },
);
