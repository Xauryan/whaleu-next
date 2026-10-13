import 'reflect-metadata';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

const inventorySql =
  'SELECT whaleu_community.admin_discussion_removal_inventory_current() current';

test(
  'discussion inventory resolves actual live trigger entry points and requires exact 0031/0078 hooks for both kinds',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      author = await f.actor();
    await f.grant(admin);
    const post = await f.publish(author),
      root = await f.discussion(author, post.id);
    const reply = await f.discussion(author, post.id, { rootId: root.id });
    const targets = [root, reply];
    const commands = await Promise.all(
      targets.map(async (target) => {
        const management = await f.removalManagement(target, admin);
        return f.removalCommand(target, management.targetVersion);
      }),
    );
    const inventory = async (expected: boolean) =>
      assert.equal(
        (await f.pool.query<{ current: boolean }>(inventorySql)).rows[0]!
          .current,
        expected,
      );
    const denied = async () => {
      for (const command of commands) {
        const response = await f.removalSend(admin, command);
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        const recovery = await f.removalRecovery(
          admin,
          command.clientRequestId,
        );
        profileOk(recovery);
        assert.deepEqual(recovery.body, { state: 'not_recorded' });
      }
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.admin_discussion_removal_events',
          )
        ).rows[0]!.n,
        0,
      );
    };
    await f.pool.query(`CREATE SCHEMA discussion_removal_inventory_spec;
      CREATE TABLE discussion_removal_inventory_spec.target(id integer PRIMARY KEY);
      CREATE FUNCTION discussion_removal_inventory_spec.noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$`);
    try {
      await inventory(true);
      for (const owner of [
        'whaleu_community.advance_discovery_count_epoch()',
        'whaleu_safety.advance_discovery_count_epoch()',
        'whaleu_campus.advance_discovery_count_epoch()',
        'whaleu_media.advance_owner_epoch()',
      ]) {
        await t.test(
          `actual new source ${owner} and WHEN-only dependencies`,
          async () => {
            try {
              await f.pool
                .query(`CREATE TRIGGER when_source BEFORE INSERT ON discussion_removal_inventory_spec.target
              FOR EACH STATEMENT WHEN (false AND ${owner} IS NULL) EXECUTE FUNCTION discussion_removal_inventory_spec.noop()`);
              const dependency = await f.pool.query<{ n: number }>(
                `SELECT count(*)::int n FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_trigger g ON g.oid=d.objid
               WHERE d.classid='pg_catalog.pg_trigger'::regclass AND d.refclassid='pg_catalog.pg_proc'::regclass
               AND d.refobjid=$1::regprocedure AND g.tgname='when_source' AND g.tgfoid<>$1::regprocedure`,
                [owner],
              );
              assert.equal(
                dependency.rows[0]!.n,
                1,
                'the misleading dependency must really exist',
              );
              await inventory(true);
              await f.pool
                .query(`CREATE TRIGGER actual_source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON discussion_removal_inventory_spec.target
              FOR EACH STATEMENT EXECUTE FUNCTION ${owner}`);
              await inventory(false);
              await denied();
              await f.pool
                .query(`CREATE TRIGGER when_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON discussion_removal_inventory_spec.target
              FOR EACH STATEMENT WHEN (false AND whaleu_community.admin_discussion_removal_source_statement_guard() IS NULL)
              EXECUTE FUNCTION discussion_removal_inventory_spec.noop()`);
              await inventory(false);
              await f.pool
                .query(`CREATE TRIGGER false_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON discussion_removal_inventory_spec.target
              FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()`);
              await inventory(false);
              await f.pool
                .query(`CREATE TRIGGER exact_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON discussion_removal_inventory_spec.target
              FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_discussion_removal_source_statement_guard()`);
              await inventory(true);
            } finally {
              await f.pool
                .query(`DROP TRIGGER IF EXISTS when_source ON discussion_removal_inventory_spec.target;
              DROP TRIGGER IF EXISTS actual_source ON discussion_removal_inventory_spec.target;
              DROP TRIGGER IF EXISTS when_guard ON discussion_removal_inventory_spec.target;
              DROP TRIGGER IF EXISTS false_guard ON discussion_removal_inventory_spec.target;
              DROP TRIGGER IF EXISTS exact_guard ON discussion_removal_inventory_spec.target`);
            }
            await inventory(true);
          },
        );
      }
      for (const relation of ['root_comments', 'replies']) {
        for (const name of [
          'comment_capture_content',
          'community_media_cleanup_capture',
        ]) {
          const original = (
            await f.pool.query<{ definition: string }>(
              `SELECT pg_catalog.pg_get_triggerdef(oid,true) definition FROM pg_catalog.pg_trigger
             WHERE tgrelid=$1::regclass AND tgname=$2`,
              [`whaleu_community.${relation}`, name],
            )
          ).rows[0]!.definition;
          await t.test(
            `${relation}/${name} cannot be missing, rebound, or conditionally disabled`,
            async () => {
              for (const replacement of [
                'missing',
                'wrong-owner',
                'false-when',
              ] as const) {
                await f.pool.query(
                  `DROP TRIGGER ${name} ON whaleu_community.${relation}`,
                );
                try {
                  if (replacement === 'wrong-owner')
                    await f.pool
                      .query(`CREATE TRIGGER ${name} AFTER UPDATE ON whaleu_community.${relation}
                    FOR EACH ROW EXECUTE FUNCTION discussion_removal_inventory_spec.noop()`);
                  if (replacement === 'false-when')
                    await f.pool.query(
                      original.replace(
                        ' EXECUTE FUNCTION ',
                        ' WHEN (false) EXECUTE FUNCTION ',
                      ),
                    );
                  await inventory(false);
                  await denied();
                } finally {
                  await f.pool.query(
                    `DROP TRIGGER IF EXISTS ${name} ON whaleu_community.${relation}`,
                  );
                  await f.pool.query(original);
                }
                assert.equal(
                  (
                    await f.pool.query<{ definition: string }>(
                      'SELECT pg_catalog.pg_get_triggerdef(oid,true) definition FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2',
                      [`whaleu_community.${relation}`, name],
                    )
                  ).rows[0]!.definition,
                  original,
                  'exact canonical trigger DDL was restored',
                );
                await inventory(true);
              }
            },
          );
        }
      }
    } finally {
      await f.pool.query(
        'DROP SCHEMA discussion_removal_inventory_spec CASCADE',
      );
    }
    await inventory(true);
    await f.removalApply(reply, admin);
    await f.removalApply(root, admin);
  },
);

test(
  'real grant token phone Review Media and component-baseline writers queued before finalization roll back the complete tentative removal',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture(true);
    t.after(() => f.close());
    const admin = await f.actor(),
      author = await f.actor();
    const grant = await f.grant(admin);
    const post = await f.publish(author, {}, true);
    const root = await f.discussion(author, post.id, { images: true });
    const reply = await f.discussion(author, post.id, {
      rootId: root.id,
      images: true,
    });
    const database = f.moderationApp.get(DatabaseService);
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
       'root',(SELECT to_jsonb(c) FROM whaleu_community.root_comments c WHERE id=$1),
       'reply',(SELECT to_jsonb(r) FROM whaleu_community.replies r WHERE id=$2),
       'commands',(SELECT count(*) FROM whaleu_community.admin_discussion_removal_commands),
       'events',(SELECT count(*) FROM whaleu_community.admin_discussion_removal_events),
       'jobs',(SELECT count(*) FROM whaleu_community.media_cleanup_jobs),
       'negative',(SELECT count(*) FROM whaleu_post_hotness.comment_sources WHERE transition='deleted')) value`,
          [root.id, reply.id],
        )
      ).rows[0]!.value;
    const before = await snapshot();
    const sources: {
      name: string;
      relation: string;
      mutation: string;
      values: unknown[];
    }[] = [
      {
        name: 'grant',
        relation: 'whaleu_authorization.role_grants',
        mutation:
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        values: [grant],
      },
      {
        name: 'token',
        relation: 'whaleu_identity.access_tokens',
        mutation:
          'UPDATE whaleu_identity.access_tokens SET expires_at=expires_at WHERE token_hash=$1',
        values: [hashToken(admin.accessToken)],
      },
      {
        name: 'phone',
        relation: 'whaleu_verification.account_heads',
        mutation:
          'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false',
        values: [],
      },
      {
        name: 'Review',
        relation: 'whaleu_community.content_approval_heads',
        mutation:
          'UPDATE whaleu_community.content_approval_heads SET event_id=event_id WHERE false',
        values: [],
      },
      {
        name: 'Media',
        relation: 'whaleu_media.asset_safety_heads',
        mutation:
          'UPDATE whaleu_media.asset_safety_heads SET event_id=event_id WHERE false',
        values: [],
      },
      {
        name: 'component-baseline',
        relation: 'whaleu_post_hotness.comment_baselines',
        mutation:
          'INSERT INTO whaleu_post_hotness.comment_baselines SELECT * FROM whaleu_post_hotness.comment_baselines WHERE false',
        values: [],
      },
    ];
    for (const target of [root, reply]) {
      for (const source of sources) {
        await t.test(
          `${target.kind}/${source.name} observes an actual PostgreSQL lock queue`,
          async () => {
            const view = await f.removalManagement(target, admin);
            const command = f.removalCommand(target, view.targetVersion);
            const writer = await f.pool.connect();
            const original = database.transaction,
              run = original.bind(database);
            let writerWork:
              Promise<{ result?: QueryResult; error?: unknown }> | undefined;
            let writerOutcome:
              { result?: QueryResult; error?: unknown } | undefined;
            let restoreQuery: (() => void) | undefined;
            let observedQueue = false,
              tentative = false;
            let responseStatus: number | undefined,
              responseCode: string | undefined;
            let observedLocks: { mode: string; granted: boolean }[] = [];
            const proofFailures: {
              statement: string;
              code: string;
              constraint: string | null;
              where: string | null;
            }[] = [];
            try {
              await writer.query('BEGIN');
              const pid = (
                await writer.query<{ pid: number }>(
                  'SELECT pg_backend_pid() pid',
                )
              ).rows[0]!.pid;
              database.transaction = (work, options) =>
                run(async (tx) => {
                  const raw = tx.query;
                  const query = raw.bind(tx) as (
                    sql: string,
                    values?: unknown[],
                  ) => Promise<QueryResult>;
                  restoreQuery = () => {
                    tx.query = raw;
                  };
                  tx.query = (async (sql: string, values?: unknown[]) => {
                    try {
                      return await query(sql, values);
                    } catch (error) {
                      if (
                        tentative &&
                        error &&
                        typeof error === 'object' &&
                        'code' in error
                      )
                        proofFailures.push({
                          statement: sql,
                          code: String(error.code),
                          constraint:
                            'constraint' in error && error.constraint
                              ? String(error.constraint)
                              : null,
                          where:
                            'where' in error && error.where
                              ? String(error.where)
                              : null,
                        });
                      throw error;
                    }
                  }) as PoolClient['query'];
                  const result = await work(tx);
                  if (
                    result &&
                    typeof result === 'object' &&
                    'outcome' in result &&
                    result.outcome === 'applied'
                  ) {
                    tentative = (
                      await tx.query<{ present: boolean }>(
                        'SELECT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_transitions WHERE actor_id=$1 AND request_id=$2) present',
                        [admin.accountId, command.clientRequestId],
                      )
                    ).rows[0]!.present;
                    // A bare queued AccessExclusive request is not admitted DML.
                    // First hold its real RowExclusive admission, then queue the
                    // stronger lock with the exact source operation still pending.
                    writerWork = (async () => {
                      await writer.query(
                        `LOCK TABLE ${source.relation} IN ROW EXCLUSIVE MODE`,
                      );
                      await writer.query(
                        `LOCK TABLE ${source.relation} IN ACCESS EXCLUSIVE MODE`,
                      );
                      return await writer.query(source.mutation, source.values);
                    })().then(
                      (result) => ({ result }),
                      (error) => ({ error }),
                    );
                    const limit = performance.now() + 3000;
                    while (performance.now() < limit) {
                      const state = (
                        await f.pool.query<{
                          waiting: boolean;
                          queued: boolean;
                          admitted: boolean;
                        }>(
                          `SELECT a.wait_event_type='Lock' waiting,
                       EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=a.pid AND l.locktype='relation' AND l.relation=$2::regclass AND l.mode='RowExclusiveLock' AND l.granted) admitted,
                       EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=a.pid AND l.locktype='relation' AND l.relation=$2::regclass AND l.mode='AccessExclusiveLock' AND NOT l.granted) queued
                       FROM pg_catalog.pg_stat_activity a WHERE a.pid=$1`,
                          [pid, source.relation],
                        )
                      ).rows[0];
                      if (state?.waiting && state.queued && state.admitted) {
                        observedQueue = true;
                        break;
                      }
                      await sleep(5);
                    }
                    assert.equal(
                      observedQueue,
                      true,
                      'both granted writer admission and a real pending source lock must precede final proof',
                    );
                    observedLocks = (
                      await f.pool.query<{ mode: string; granted: boolean }>(
                        "SELECT mode,granted FROM pg_catalog.pg_locks WHERE pid=$1 AND locktype='relation' AND relation=$2::regclass ORDER BY granted DESC,mode",
                        [pid, source.relation],
                      )
                    ).rows;
                  }
                  return result;
                }, options);
              const response = await f.removalSend(admin, command);
              responseStatus = response.status;
              responseCode = response.body.error?.code;
              assert.equal(tentative, true);
              assert.equal(observedQueue, true);
              assert.equal(response.status, 503, JSON.stringify(response.body));
              assert.match(
                responseCode ?? '',
                /_UNAVAILABLE$/,
                JSON.stringify(response.body),
              );
              assert.equal(
                proofFailures[0]?.code,
                '55P03',
                'the final proof must reject the real conflicting writer lock',
              );
              const failure = proofFailures[0]!;
              if (
                /^SET CONSTRAINTS ALL IMMEDIATE;?$/i.test(
                  failure.statement.trim(),
                )
              ) {
                // The deferred trigger executes the source fence inside SET
                // CONSTRAINTS; require its actual PostgreSQL call stack and the
                // exact conflicting source, rather than accepting that SQL alone.
                const closure = failure.where?.match(
                  /^SQL statement "LOCK TABLE ([\s\S]+?) IN SHARE MODE NOWAIT"\s+PL\/pgSQL function whaleu_community\.admin_discussion_removal_assert_complete\(whaleu_community\.admin_discussion_removal_commands\) line \d+ at (?:SQL statement|EXECUTE)\s+SQL statement "SELECT whaleu_community\.admin_discussion_removal_assert_complete\(NEW\)"\s+PL\/pgSQL function whaleu_community\.admin_discussion_removal_complete\(\) line \d+ at PERFORM\s*$/,
                );
                assert.ok(closure, JSON.stringify(proofFailures));
                assert.ok(
                  closure[1]!
                    .split(',')
                    .map((relation) => relation.trim())
                    .includes(source.relation),
                  JSON.stringify(proofFailures),
                );
              } else {
                assert.ok(
                  failure.statement.includes('NOWAIT') ||
                    failure.statement.includes(
                      'admin_discussion_removal_assert_complete',
                    ),
                  JSON.stringify(proofFailures),
                );
              }
            } finally {
              database.transaction = original;
              restoreQuery?.();
              if (writerWork) writerOutcome = await writerWork;
              await writer.query('ROLLBACK');
              writer.release();
            }
            assert.ok(
              writerOutcome?.result,
              `the pending source operation must complete after reader rollback: ${String(writerOutcome?.error)}`,
            );
            assert.equal(
              writerOutcome.result.rowCount,
              source.name === 'grant' || source.name === 'token' ? 1 : 0,
            );
            assert.deepEqual(await snapshot(), before);
            const recovered = await f.removalRecovery(
              admin,
              command.clientRequestId,
            );
            profileOk(recovered);
            assert.deepEqual(recovered.body, { state: 'not_recorded' });
            t.diagnostic(
              JSON.stringify({
                kind: target.kind,
                source: source.name,
                pendingOperation: source.mutation,
                observedLocks,
                finalProofFailures: proofFailures,
                responseStatus,
                responseCode,
                tentativeRemoval: tentative,
                tentativeRollbackVerified: true,
                writerCompleted: true,
                writerCommand: writerOutcome.result.command,
                writerRows: writerOutcome.result.rowCount,
                writerRolledBack: true,
              }),
            );
          },
        );
      }
    }
    await f.removalApply(reply, admin);
    await f.removalApply(root, admin);
  },
);

test(
  'a bare unadmitted AccessExclusive request can serialize after the existing reader, and its later revocation sees the committed removal',
  { timeout: 60000 },
  async (t) => {
    // The first diagnostic run observed HTTP 200 for this lock-only queue. Keep
    // that observation explicit: no RowExclusive admission or revocation had yet
    // happened. It is not evidence that an already admitted writer is safe.
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      author = await f.actor();
    const grant = await f.grant(admin),
      post = await f.publish(author);
    const target = await f.discussion(author, post.id);
    const management = await f.removalManagement(target, admin),
      command = f.removalCommand(target, management.targetVersion);
    const database = f.moderationApp.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database);
    const writer = await f.pool.connect();
    let writerWork:
      | Promise<
          | { committedRemoval: boolean; changed: number | null }
          | { error: unknown }
        >
      | undefined;
    let completed: Awaited<NonNullable<typeof writerWork>> | undefined;
    let before: { mode: string; granted: boolean }[] = [],
      after: { mode: string; granted: boolean }[] = [];
    let readerNowait: { granted: boolean; mode: string }[] = [];
    try {
      await writer.query('BEGIN');
      const pid = (
        await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      database.transaction = (work, options) =>
        run(async (tx) => {
          const result = await work(tx);
          if (
            result &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'applied'
          ) {
            writerWork = (async () => {
              await writer.query(
                'LOCK TABLE whaleu_authorization.role_grants IN ACCESS EXCLUSIVE MODE',
              );
              after = (
                await writer.query<{ mode: string; granted: boolean }>(
                  "SELECT mode,granted FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND relation='whaleu_authorization.role_grants'::regclass ORDER BY mode",
                )
              ).rows;
              const committedRemoval = (
                await writer.query<{ committed: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2 AND receipt->>'outcome'='applied') committed",
                  [admin.accountId, command.clientRequestId],
                )
              ).rows[0]!.committed;
              const changed = (
                await writer.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                  [grant],
                )
              ).rowCount;
              return { committedRemoval, changed };
            })().catch((error) => ({ error }));
            const limit = performance.now() + 3000;
            while (performance.now() < limit) {
              before = (
                await f.pool.query<{ mode: string; granted: boolean }>(
                  "SELECT mode,granted FROM pg_catalog.pg_locks WHERE pid=$1 AND locktype='relation' AND relation='whaleu_authorization.role_grants'::regclass ORDER BY mode",
                  [pid],
                )
              ).rows;
              const waiting = (
                await f.pool.query<{ waiting: boolean }>(
                  "SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",
                  [pid],
                )
              ).rows[0]?.waiting;
              if (
                waiting &&
                before.some(
                  (lock) =>
                    lock.mode === 'AccessExclusiveLock' && !lock.granted,
                )
              )
                break;
              await sleep(5);
            }
            assert.ok(
              before.some(
                (lock) => lock.mode === 'AccessExclusiveLock' && !lock.granted,
              ),
            );
            assert.equal(
              before.some((lock) => lock.granted),
              false,
              'no writer admission or authority mutation exists yet',
            );
            // Directly verify PostgreSQL's actual lock conversion behavior, rather
            // than inferring it just from the original HTTP 200 observation.
            await tx.query(
              'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
            );
            readerNowait = (
              await tx.query<{ mode: string; granted: boolean }>(
                "SELECT mode,granted FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND relation='whaleu_authorization.role_grants'::regclass AND mode='ShareLock'",
              )
            ).rows;
            assert.deepEqual(readerNowait, [
              { mode: 'ShareLock', granted: true },
            ]);
          }
          return result;
        }, options);
      const response = await f.removalSend(admin, command);
      profileOk(response);
      assert.equal(response.body.outcome, 'applied');
    } finally {
      database.transaction = original;
      if (writerWork) completed = await writerWork;
      await writer.query('ROLLBACK');
      writer.release();
    }
    assert.ok(
      completed && 'committedRemoval' in completed,
      JSON.stringify(completed),
    );
    assert.equal(
      completed.committedRemoval,
      true,
      'the admitted revocation must observe that removal committed before its lock was granted',
    );
    assert.equal(
      completed.changed,
      1,
      'the later real revocation operation completed before its test rollback',
    );
    assert.ok(
      after.some((lock) => lock.mode === 'AccessExclusiveLock' && lock.granted),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT revoked_at FROM whaleu_authorization.role_grants WHERE id=$1',
          [grant],
        )
      ).rows[0]!.revoked_at,
      null,
    );
    const recovery = await f.removalRecovery(admin, command.clientRequestId);
    profileOk(recovery);
    assert.equal(recovery.body.state, 'recorded');
    assert.equal(recovery.body.receipt.outcome, 'applied');
    t.diagnostic(
      JSON.stringify({
        originalObservation: 'bare queued AccessExclusive returned applied',
        queuedBefore: before,
        readerNowait,
        writerGrantedAfter: after,
        actualRevocationSawCommittedRemoval: completed.committedRemoval,
        actualRevocationRows: completed.changed,
        distinction:
          'authority revocation was not admitted until after the reader committed',
        writerRolledBack: true,
      }),
    );
  },
);
