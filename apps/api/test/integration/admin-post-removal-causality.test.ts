/** Raw SQL adversaries over disposable, source-backed native publications. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { APP_CONFIG } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
} from '../../src/database/database.js';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { hashToken } from '../../src/identity/tokens.js';
import { adminPostRemovalIntentHash } from '../../src/community/admin-removal/evidence.js';
import type { AdminPostRemovalCommand } from '../../src/community/admin-removal/contracts.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';

const causal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '23505', '23502', '22P02', '55P03'].includes(
    String(error.code),
  );

test(
  'administrative removal requires a unique actual tombstone and immutable exact closure',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor(),
      other = await f.actor();
    const grant = await f.grant(admin),
      wrongGrant = await f.grant(other);
    const post = await f.publish(subject, { authorMode: 'anonymous' }),
      unrelated = await f.publish(other);
    const root = await f.child(other, post.id);
    await f.pool.query(
      'INSERT INTO whaleu_community.comment_pins(post_id,comment_id) VALUES($1,$2)',
      [post.id, root.id],
    );
    const body = async (): Promise<AdminPostRemovalCommand> =>
      f.removalCommand(
        post,
        (
          await f.pool.query<{ version: string }>(
            'SELECT whaleu_community.admin_post_removal_target_version($1) version',
            [post.id],
          )
        ).rows[0]!.version,
      );
    const base = (command: AdminPostRemovalCommand) => ({
      requestId: command.clientRequestId,
      target: command.target,
      expectedTargetVersion: command.expectedTargetVersion,
      action: command.action,
    });
    const transaction = async <T>(
      work: (tx: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const tx = await f.pool.connect();
      try {
        await tx.query(
          "BEGIN ISOLATION LEVEL READ COMMITTED;SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='8s'",
        );
        const value = await work(tx);
        await tx.query('COMMIT');
        return value;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    };
    const insert = (
      tx: Pick<PoolClient, 'query'>,
      command: AdminPostRemovalCommand,
      receipt: object,
      selected: string | null = grant,
    ) =>
      tx.query(
        `INSERT INTO whaleu_community.admin_post_removal_commands
      (actor_id,request_id,session_id,token_hash,target_id,grant_id,intent_hash,command,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          admin.accountId,
          command.clientRequestId,
          admin.sessionId,
          hashToken(admin.accessToken),
          command.target.id,
          selected,
          adminPostRemovalIntentHash(admin.accountId, command),
          command,
          receipt,
        ],
      );
    const insertRejects = async (
      command: AdminPostRemovalCommand,
      receipt: object,
      selected: string | null = grant,
      expectedMessage?: string,
    ) => {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN');
        await assert.rejects(
          insert(tx, command, receipt, selected),
          (error) =>
            causal(error) &&
            (expectedMessage === undefined ||
              String((error as Error).message).includes(expectedMessage)),
        );
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    };
    const totals = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'posts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.posts p),
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
    'commands',(SELECT count(*) FROM whaleu_community.admin_post_removal_commands),
    'transitions',(SELECT count(*) FROM whaleu_community.admin_post_removal_transitions),
    'statements',(SELECT count(*) FROM whaleu_community.admin_post_removal_statements),
    'epochs',(SELECT jsonb_agg(to_jsonb(e) ORDER BY slot) FROM whaleu_community.discovery_count_epochs e),
    'events',(SELECT count(*) FROM whaleu_community.admin_post_removal_events),
    'notices',(SELECT count(*) FROM whaleu_notifications.admin_post_removal_notices),
    'registry',(SELECT count(*) FROM whaleu_notifications.system_notice_ids),
    'outbox',(SELECT count(*) FROM whaleu_community.outbox),
    'jobs',(SELECT count(*) FROM whaleu_community.media_cleanup_jobs),
    'pins',(SELECT jsonb_agg(to_jsonb(p) ORDER BY post_id) FROM whaleu_community.comment_pins p)) value`)
      ).rows[0]!.value;
    type Fault = {
      omit?: 'post' | 'event' | 'outbox' | 'notice' | 'pin';
      zero?: boolean;
      multi?: boolean;
      grant?: string;
      subject?: string;
      target?: string;
      authority?: object;
      noticeSubject?: string;
      noticeId?: string;
      before?: (tx: PoolClient) => Promise<unknown>;
      after?: (tx: PoolClient) => Promise<unknown>;
    };
    const mutate = async (
      tx: PoolClient,
      command: AdminPostRemovalCommand,
      fault: Fault = {},
    ) => {
      const recordedAt = (
        await tx.query<{ now: Date }>(
          "SELECT date_trunc('milliseconds',clock_timestamp()) now",
        )
      ).rows[0]!.now.toISOString();
      const receipt = {
        ...base(command),
        outcome: 'applied' as const,
        eventId: randomUUID(),
        recordedAt,
      };
      await insert(tx, command, receipt, fault.grant ?? grant);
      await fault.before?.(tx);
      if (fault.omit !== 'pin')
        await tx.query(
          'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1',
          [post.id],
        );
      if (fault.omit !== 'post')
        await tx.query(
          `UPDATE whaleu_community.posts SET deleted_at=$2
      WHERE (id=$1 OR ($3::boolean AND id=$4)) AND deleted_at IS NULL AND NOT $5::boolean`,
          [
            post.id,
            recordedAt,
            fault.multi ?? false,
            unrelated.id,
            fault.zero ?? false,
          ],
        );
      if (fault.omit !== 'event')
        await tx.query(
          `INSERT INTO whaleu_community.admin_post_removal_events
      (id,actor_id,request_id,subject_id,target_id,original_region_id,grant_id,selected_authority,recorded_at)
      SELECT $3,q.actor_id,q.request_id,coalesce($4::uuid,q.subject_id),coalesce($5::uuid,q.target_id),q.original_region_id,q.grant_id,$6,$7
      FROM whaleu_community.admin_post_removal_commands q WHERE actor_id=$1 AND request_id=$2`,
          [
            admin.accountId,
            command.clientRequestId,
            receipt.eventId,
            fault.subject ?? null,
            fault.target ?? null,
            fault.authority ?? null,
            recordedAt,
          ],
        );
      if (fault.omit !== 'outbox')
        await tx.query(
          `INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id,context)
      VALUES($1,$2,'admin_post_removed',$3,$4)`,
          [
            randomUUID(),
            `admin-post-removal:${receipt.eventId}`,
            post.id,
            {
              cause: 'admin_post_removal',
              eventId: receipt.eventId,
              kind: 'post',
              postId: post.id,
              obligations: ['content_invalidation', 'media_cleanup'],
            },
          ],
        );
      if (fault.omit !== 'notice')
        await tx.query(
          `INSERT INTO whaleu_notifications.admin_post_removal_notices(id,event_id,recipient_account_id,created_at)
      VALUES($1,$2,$3,$4)`,
          [
            fault.noticeId ?? randomUUID(),
            receipt.eventId,
            fault.noticeSubject ?? subject.accountId,
            recordedAt,
          ],
        );
      await fault.after?.(tx);
      return receipt;
    };
    const fails = async (fault: Fault) => {
      const command = await body(),
        before = await totals();
      await assert.rejects(
        transaction((tx) => mutate(tx, command, fault)),
        causal,
      );
      assert.deepEqual(
        await totals(),
        before,
        'Every failed attempt rolls back the post, epoch, ledger, pins, cleanup and notice',
      );
    };

    await t.test(
      'missing steps, zero-row/multi-row deletion, forged scope and recipient all roll back',
      async () => {
        for (const fault of [
          { omit: 'post' },
          { omit: 'event' },
          { omit: 'outbox' },
          { omit: 'notice' },
          { omit: 'pin' },
          { zero: true },
          { multi: true },
          { grant: wrongGrant },
          { subject: other.accountId },
          { target: unrelated.id },
          { authority: { role: 'super_admin' } },
          { noticeSubject: other.accountId },
        ] satisfies Fault[])
          await fails(fault);
      },
    );
    await t.test(
      'cleanup capture failure rolls back the actual tombstone and pin release',
      async () => {
        await fails({
          before: async (tx) => {
            await tx.query(`CREATE FUNCTION whaleu_community.synthetic_admin_removal_cleanup_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
        RAISE EXCEPTION 'Synthetic cleanup insertion fault' USING ERRCODE='23514';END$$`);
            await tx.query(`CREATE TRIGGER z_synthetic_admin_removal_cleanup_fault BEFORE INSERT ON whaleu_community.media_cleanup_jobs
        FOR EACH ROW EXECUTE FUNCTION whaleu_community.synthetic_admin_removal_cleanup_fault()`);
          },
        });
      },
    );
    await t.test(
      'an author tombstone cannot be reused as an administrative transition',
      async () => {
        const removed = await f.publish(subject);
        const version = (
          await f.pool.query<{ version: string }>(
            'SELECT whaleu_community.admin_post_removal_target_version($1) version',
            [removed.id],
          )
        ).rows[0]!.version;
        const response = await request(f.http)
          .delete(`/v1/community/posts/${removed.id}`)
          .set('Authorization', `Bearer ${subject.accessToken}`);
        assert.equal(response.status, 204, JSON.stringify(response.body));
        const command = f.removalCommand(removed, version),
          before = await totals();
        await assert.rejects(
          transaction((tx) =>
            insert(tx, command, {
              ...base(command),
              outcome: 'applied',
              eventId: randomUUID(),
              recordedAt: new Date().toISOString(),
            }),
          ),
          causal,
        );
        assert.deepEqual(await totals(), before);
      },
    );
    await t.test(
      'raw transition, epoch, event and notice cannot invent a cause',
      async () => {
        const statements = [
          `INSERT INTO whaleu_community.admin_post_removal_transitions(actor_id,request_id,target_id,before_hash,before_fingerprint,after_hash,after_fingerprint,unchanged_hash,deleted_at)
       VALUES($1,$2,$3,'a','a','a','a','a',clock_timestamp())`,
          `INSERT INTO whaleu_community.admin_post_removal_statements(actor_id,request_id) VALUES($1,$2)`,
          `INSERT INTO whaleu_community.admin_post_removal_epochs(actor_id,request_id,slot,version,before_epoch,after_epoch) VALUES($1,$2,0,1,0,1)`,
          `INSERT INTO whaleu_community.admin_post_removal_events(id,actor_id,request_id,subject_id,target_id,original_region_id,grant_id,selected_authority,recorded_at)
       VALUES(gen_random_uuid(),$1,$2,$1,$3,$4,$5,'{}',date_trunc('milliseconds',clock_timestamp()))`,
          `INSERT INTO whaleu_notifications.admin_post_removal_notices(id,event_id,recipient_account_id,created_at)
       VALUES($2,$2,$1,date_trunc('milliseconds',clock_timestamp()))`,
        ];
        for (const sql of statements) {
          const count = Number(
            [...sql.matchAll(/\$(\d+)/g)]
              .map((m) => m[1])
              .sort((a, b) => Number(b) - Number(a))[0],
          );
          await assert.rejects(
            transaction((tx) =>
              tx.query(
                sql,
                [
                  admin.accountId,
                  randomUUID(),
                  post.id,
                  f.scope.home.regionId,
                  grant,
                ].slice(0, count),
              ),
            ),
            causal,
          );
        }
      },
    );
    await t.test(
      'strict command and receipt shape, timestamp precision and false stale claims fail closed',
      async () => {
        for (const patch of [
          { ban: true },
          { action: 'reset_nickname' },
          { target: { kind: 'comment', id: post.id } },
          { expectedTargetVersion: 'x'.repeat(64) },
        ]) {
          const command = {
            ...(await body()),
            ...patch,
          } as AdminPostRemovalCommand;
          await insertRejects(
            command,
            {
              ...base(command),
              outcome: 'rejected',
              code: 'ADMIN_POST_REMOVAL_CANCELLED',
            },
            null,
            'Strict exact administrative post-removal command required',
          );
        }
        const command = await body();
        for (const recordedAt of [
          '2001-01-01T00:00:00Z',
          '2001-01-01T00:00:00.1Z',
        ])
          await insertRejects(
            command,
            {
              ...base(command),
              outcome: 'applied',
              eventId: randomUUID(),
              recordedAt,
            },
            grant,
            'Exact applied administrative receipt required',
          );
        await insertRejects(
          command,
          {
            ...base(command),
            outcome: 'rejected',
            code: 'ADMIN_POST_REMOVAL_STALE',
          },
          grant,
          'Exact post source CAS required',
        );
        await insertRejects(
          command,
          {
            ...base(command),
            outcome: 'rejected',
            code: 'ADMIN_POST_REMOVAL_CANCELLED',
            subjectId: subject.accountId,
          },
          null,
          'Strict exact administrative post-removal command required',
        );
      },
    );
    await t.test(
      'same-value writes, ABA, extra zero-row source statements and payload changes cannot spend the one epoch allowance',
      async () => {
        for (const sql of [
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          'UPDATE whaleu_community.posts SET text=text WHERE false',
          "UPDATE whaleu_community.posts SET deleted_at=clock_timestamp(),text=text||'x' WHERE id=$1",
          'UPDATE whaleu_community.post_owner_visibility SET owner_hidden=owner_hidden WHERE false',
          'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE false',
        ])
          await fails({
            before: (tx) => tx.query(sql, sql.includes('$1') ? [post.id] : []),
          });
        await fails({
          after: async (tx) => {
            await tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=NULL WHERE id=$1',
              [post.id],
            );
            await tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [post.id],
            );
          },
        });
      },
    );
    await t.test(
      'SET CONSTRAINTS IMMEDIATE cannot let late source or closure edits escape',
      async () => {
        for (const sql of [
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          'UPDATE whaleu_community.posts SET text=text WHERE false',
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
          'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE false',
          'DELETE FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1',
          "UPDATE whaleu_community.outbox SET context='{}' WHERE resource_id=$1 AND event_type='admin_post_removed'",
          'UPDATE whaleu_notifications.admin_post_removal_notices SET read_at=created_at WHERE recipient_account_id=$1',
        ])
          await fails({
            after: async (tx) => {
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              const value = sql.includes('role_grants')
                ? grant
                : sql.includes('notices')
                  ? subject.accountId
                  : post.id;
              await tx.query(sql, sql.includes('$1') ? [value] : []);
            },
          });
      },
    );
    await t.test(
      'initial null-grant and selected-grant facts normalize only the exact explicit request',
      async () => {
        const command = await body();
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN');
          const facts = (
            await tx.query<{ initial: object; selected: object }>(
              `SELECT
        whaleu_community.admin_post_removal_input_facts($1,NULL,$3) initial,
        whaleu_community.admin_post_removal_input_facts($1,$2,$3) selected`,
              [admin.accountId, grant, post.id],
            )
          ).rows[0]!;
          await mutate(tx, command);
          for (const [selected, fact] of [
            [null, facts.initial],
            [grant, facts.selected],
          ] as const) {
            const matched = (
              await tx.query(
                `SELECT
          whaleu_community.admin_post_removal_inputs_match($1,$2,$3,$4,$5) exact,
          whaleu_community.admin_post_removal_inputs_match($1,$2,$3,$4) ordinary,
          whaleu_community.admin_post_removal_inputs_match($1,$2,$3,$4,$6) wrong`,
                [
                  admin.accountId,
                  selected,
                  post.id,
                  fact,
                  command.clientRequestId,
                  randomUUID(),
                ],
              )
            ).rows[0];
            assert.deepEqual(matched, {
              exact: true,
              ordinary: false,
              wrong: false,
            });
          }
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      },
    );
    await t.test(
      'cold cancellation does not open unrelated source or grant relations',
      async () => {
        const command = f.removalCommand(
          { kind: 'post', id: randomUUID() },
          '0'.repeat(64),
        );
        const cold = new Client(f.pool.options),
          locker = await f.pool.connect();
        await cold.connect();
        try {
          await locker.query('BEGIN');
          await locker.query(`LOCK TABLE whaleu_community.posts,whaleu_community.content_approval_bindings,
        whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_profile.profiles,
        whaleu_media.bindings IN ACCESS EXCLUSIVE MODE`);
          await cold.query(
            "BEGIN;SET LOCAL lock_timeout='100ms';SET LOCAL statement_timeout='2s'",
          );
          await insert(
            cold,
            command,
            {
              ...base(command),
              outcome: 'rejected',
              code: 'ADMIN_POST_REMOVAL_CANCELLED',
            },
            null,
          );
          await cold.query('SET CONSTRAINTS ALL IMMEDIATE;COMMIT');
        } finally {
          await cold.query('ROLLBACK');
          await cold.end();
          await locker.query('ROLLBACK');
          locker.release();
        }
        await transaction(async (tx) => {
          const cancelled = f.removalCommand(
            { kind: 'post', id: randomUUID() },
            '0'.repeat(64),
          );
          await insert(
            tx,
            cancelled,
            {
              ...base(cancelled),
              outcome: 'rejected',
              code: 'ADMIN_POST_REMOVAL_CANCELLED',
            },
            null,
          );
        });
      },
    );
    await t.test(
      'one successful cause stays immutable and cannot be attached to the existing tombstone again',
      async () => {
        const command = await body(),
          receipt = await transaction((tx) => mutate(tx, command));
        const count = (
          await f.pool.query(
            `SELECT
      (SELECT count(*)::int FROM whaleu_community.admin_post_removal_transitions WHERE target_id=$1) transitions,
      (SELECT count(*)::int FROM whaleu_community.admin_post_removal_events WHERE target_id=$1) events,
      (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1) jobs,
      (SELECT count(*)::int FROM whaleu_notifications.admin_post_removal_notices WHERE event_id=$2) notices`,
            [post.id, receipt.eventId],
          )
        ).rows[0];
        assert.deepEqual(count, {
          transitions: 1,
          events: 1,
          jobs: 1,
          notices: 1,
        });
        await assert.rejects(
          transaction((tx) =>
            mutate(tx, { ...command, clientRequestId: randomUUID() }),
          ),
          causal,
        );
        await assert.rejects(
          transaction((tx) =>
            tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=NULL WHERE id=$1',
              [post.id],
            ),
          ),
          causal,
        );
        await assert.rejects(
          transaction((tx) =>
            tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [post.id],
            ),
          ),
          causal,
        );
        for (const table of [
          'commands',
          'transitions',
          'events',
          'statements',
          'epochs',
        ])
          await assert.rejects(
            transaction((tx) =>
              tx.query(
                `DELETE FROM whaleu_community.admin_post_removal_${table} WHERE actor_id=$1`,
                [admin.accountId],
              ),
            ),
            causal,
          );
        await assert.rejects(
          transaction((tx) =>
            tx.query(
              'DELETE FROM whaleu_notifications.admin_post_removal_notices WHERE event_id=$1',
              [receipt.eventId],
            ),
          ),
          causal,
        );
        await assert.rejects(
          transaction((tx) =>
            tx.query(
              "UPDATE whaleu_community.outbox SET context='{}' WHERE event_key=$1",
              [`admin-post-removal:${receipt.eventId}`],
            ),
          ),
          causal,
        );
      },
    );
    await t.test(
      'cold HTTP applied replay, recovery and first cancellation need only active identity while every unrelated owner is locked',
      async () => {
        const saved = (
          await f.pool.query<{
            command: AdminPostRemovalCommand;
            receipt: object;
          }>(
            `SELECT command,receipt FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1 AND target_id=$2 AND receipt->>'outcome'='applied'`,
            [admin.accountId, post.id],
          )
        ).rows[0]!;
        assert.ok(saved);
        // The original moderator no longer has phone authority or a live grant.
        // Neither terminal lookup nor the first cancellation may consult them.
        await f.pool.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
          [grant],
        );
        await f.certify(admin.accountId, { phone: 'unverified' });
        const database = f.moderationApp.get(DatabaseService),
          original = database.transaction;
        const locker = await f.pool.connect(),
          pids = new Set<number>();
        const cancelled = f.removalCommand(
          { kind: 'post', id: randomUUID() },
          '0'.repeat(64),
        );
        let cancelledReceipt: object | undefined;
        const coldHttp = async (
          work: () => PromiseLike<{ status: number; body: unknown }>,
        ) => {
          const coldPool = new Pool({
            ...poolOptions(f.moderationApp.get(APP_CONFIG)),
            max: 1,
            application_name: `synthetic-removal-cold-${randomUUID()}`,
          });
          let pid: number | undefined;
          database.transaction = (operation, options) =>
            inTransaction(
              coldPool,
              async (tx) => {
                const observed = (
                  await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
                ).rows[0]!.pid;
                assert.equal(
                  pid,
                  undefined,
                  'Exactly one real service transaction for this HTTP request',
                );
                assert.equal(
                  pids.has(observed),
                  false,
                  'Each terminal request uses a fresh physical PostgreSQL backend',
                );
                pid = observed;
                pids.add(observed);
                await tx.query("SET LOCAL lock_timeout='100ms'");
                return operation(tx);
              },
              options,
            );
          try {
            const result = await work();
            assert.ok(pid);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            return result.body;
          } finally {
            database.transaction = original;
            await coldPool.end();
          }
        };
        try {
          await locker.query('BEGIN');
          await locker.query(`LOCK TABLE whaleu_community.posts,whaleu_community.content_approval_bindings,
            whaleu_community.content_approval_decisions,whaleu_community.content_approval_heads,whaleu_community.content_approval_events,
            whaleu_community.post_owner_visibility,whaleu_authorization.role_grants,
            whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,
            whaleu_profile.profiles,whaleu_profile.avatar_current,whaleu_profile.avatar_definitions,
            whaleu_media.bindings,whaleu_media.assets,whaleu_media.upload_intents,whaleu_media.media_owner_states,
            whaleu_safety.account_heads,whaleu_safety.discovery_count_epochs,whaleu_campus.operating_regions
            IN ACCESS EXCLUSIVE MODE`);
          assert.deepEqual(
            await coldHttp(() => f.removalSend(admin, saved.command)),
            saved.receipt,
          );
          assert.deepEqual(
            await coldHttp(() => f.removalSend(admin, saved.command, true)),
            saved.receipt,
          );
          assert.deepEqual(
            await coldHttp(() =>
              f.removalRecovery(admin, saved.command.clientRequestId),
            ),
            { state: 'recorded', receipt: saved.receipt },
          );
          cancelledReceipt = (await coldHttp(() =>
            f.removalSend(admin, cancelled, true),
          )) as object;
          assert.deepEqual(cancelledReceipt, {
            ...base(cancelled),
            outcome: 'rejected',
            code: 'ADMIN_POST_REMOVAL_CANCELLED',
          });
          assert.deepEqual(
            await coldHttp(() =>
              f.removalRecovery(admin, cancelled.clientRequestId),
            ),
            { state: 'recorded', receipt: cancelledReceipt },
          );
          assert.deepEqual(
            await coldHttp(() => f.removalSend(admin, cancelled)),
            cancelledReceipt,
          );
          assert.equal(pids.size, 6);
        } finally {
          database.transaction = original;
          await locker.query('ROLLBACK');
          locker.release();
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_events WHERE target_id=$1',
              [post.id],
            )
          ).rows[0]!.n,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_notifications.admin_post_removal_notices WHERE recipient_account_id=$1',
              [subject.accountId],
            )
          ).rows[0]!.n,
          1,
        );
      },
    );
    await t.test(
      'live administrative inventory remains equivalent to its original four-owner predicate',
      async (inventory) => {
        const owners = [
          'whaleu_community.advance_discovery_count_epoch()',
          'whaleu_safety.advance_discovery_count_epoch()',
          'whaleu_campus.advance_discovery_count_epoch()',
          'whaleu_media.advance_owner_epoch()',
        ] as const;
        // Frozen original predicate from pre-optimization0131 (migration SHA256
        // d7dfe85d66ce19ef027b5779091f83412ba36a109a11738523a0b26e9ce491d8).
        // Compare live answers rather than duplicating optimized dependency logic.
        const oracle = `
 SELECT NOT EXISTS(SELECT 1 FROM pg_trigger source
  WHERE source.tgfoid IN('whaleu_community.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_safety.advance_discovery_count_epoch()'::regprocedure,'whaleu_campus.advance_discovery_count_epoch()'::regprocedure,
   'whaleu_media.advance_owner_epoch()'::regprocedure)
  AND NOT source.tgisinternal AND source.tgenabled<>'D'
  AND NOT EXISTS(SELECT 1 FROM pg_trigger guard WHERE guard.tgrelid=source.tgrelid
   AND guard.tgfoid='whaleu_community.admin_post_removal_source_statement_guard()'::regprocedure
   AND guard.tgenabled='O' AND guard.tgtype=62))
`;
        const functions = owners
          .map((owner) => `'${owner}'::regprocedure`)
          .join(',');
        const sourceRows = `SELECT source.oid,source.tgrelid,source.tgfoid,source.tgtype,source.tgenabled,source.tgisinternal,source.tgparentid
        FROM pg_catalog.pg_trigger source WHERE source.tgfoid IN(${functions}) ORDER BY source.oid`;
        const indexedRows = `SELECT DISTINCT source.oid,source.tgrelid,source.tgfoid,source.tgtype,source.tgenabled,source.tgisinternal,source.tgparentid
        FROM pg_catalog.pg_depend dep JOIN pg_catalog.pg_trigger source ON source.oid=dep.objid
        WHERE dep.classid='pg_catalog.pg_trigger'::regclass AND dep.refclassid='pg_catalog.pg_proc'::regclass
        AND dep.refobjid IN(${functions}) AND source.tgfoid IN(${functions}) ORDER BY source.oid`;
        const check = async (tx: PoolClient, expected: boolean) => {
          const result = (
            await tx.query<{
              original: boolean;
              optimized: boolean;
            }>(`SELECT (${oracle}) original,
          whaleu_community.admin_post_removal_inventory_current() optimized`)
          ).rows[0]!;
          assert.equal(result.original, expected);
          assert.equal(
            result.optimized,
            result.original,
            'Indexed candidate lookup must retain the exact original live predicate',
          );
          assert.deepEqual(
            (await tx.query(indexedRows)).rows,
            (await tx.query(sourceRows)).rows,
            'Dependencies must discover every actual four-owner source, including partition clones',
          );
        };
        const probe = async (work: (tx: PoolClient) => Promise<void>) => {
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(`CREATE SCHEMA admin_removal_inventory_spec;
            CREATE TABLE admin_removal_inventory_spec.target(id integer PRIMARY KEY);
            CREATE FUNCTION admin_removal_inventory_spec.noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$`);
            await check(tx, true);
            await work(tx);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
          assert.equal(
            (
              await f.pool.query(
                "SELECT to_regnamespace('admin_removal_inventory_spec') value",
              )
            ).rows[0]!.value,
            null,
            'Every live-DDL probe is rolled back',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.admin_post_removal_inventory_current() valid',
              )
            ).rows[0]!.valid,
            true,
            'Rollback restores the original live inventory without cache invalidation code',
          );
        };
        const source = (owner: string) =>
          `CREATE TRIGGER source BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION ${owner}`;
        const guard = `CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()`;
        await inventory.test(
          'new real sources in every owner are found, and enabled modes preserve the original predicate',
          async () => {
            for (const owner of owners)
              await probe(async (tx) => {
                await tx.query(source(owner));
                for (const mode of [
                  'ENABLE',
                  'ENABLE REPLICA',
                  'ENABLE ALWAYS',
                ]) {
                  await tx.query(
                    `ALTER TABLE admin_removal_inventory_spec.target ${mode} TRIGGER source`,
                  );
                  await check(tx, false);
                }
                await tx.query(
                  'ALTER TABLE admin_removal_inventory_spec.target DISABLE TRIGGER source',
                );
                await check(tx, true);
                await tx.query(
                  'ALTER TABLE admin_removal_inventory_spec.target ENABLE TRIGGER source',
                );
                await tx.query(guard);
                await check(tx, true);
                // Administrative inventory originally requires O, unlike avatar's O/A.
                for (const mode of [
                  'DISABLE',
                  'ENABLE REPLICA',
                  'ENABLE ALWAYS',
                ]) {
                  await tx.query(
                    `ALTER TABLE admin_removal_inventory_spec.target ${mode} TRIGGER guard`,
                  );
                  await check(tx, false);
                }
                await tx.query(
                  'ALTER TABLE admin_removal_inventory_spec.target ENABLE TRIGGER guard',
                );
                await check(tx, true);
                await tx.query(
                  'DROP TRIGGER guard ON admin_removal_inventory_spec.target',
                );
                await check(tx, false);
                await tx.query(
                  'DROP TRIGGER source ON admin_removal_inventory_spec.target',
                );
                await check(tx, true);
              });
          },
        );
        await inventory.test(
          'source and guard rebinding update actual function dependencies immediately',
          () =>
            probe(async (tx) => {
              await tx.query(
                'CREATE TRIGGER source BEFORE INSERT ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION admin_removal_inventory_spec.noop()',
              );
              await check(tx, true);
              for (const owner of owners) {
                await tx.query(
                  `CREATE OR REPLACE TRIGGER source BEFORE INSERT ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION ${owner}`,
                );
                await check(tx, false);
                await tx.query(guard);
                await check(tx, true);
                await tx.query(
                  'CREATE OR REPLACE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION admin_removal_inventory_spec.noop()',
                );
                await check(tx, false);
                await tx.query(
                  guard.replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER'),
                );
                await check(tx, true);
                await tx.query(
                  'DROP TRIGGER guard ON admin_removal_inventory_spec.target',
                );
                await tx.query(
                  'CREATE OR REPLACE TRIGGER source BEFORE INSERT ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION admin_removal_inventory_spec.noop()',
                );
                await check(tx, true);
              }
            }),
        );
        await inventory.test(
          'WHEN-only dependencies cannot impersonate either a source or its guard',
          async () => {
            for (const owner of owners)
              await probe(async (tx) => {
                await tx.query(
                  `CREATE TRIGGER when_source BEFORE INSERT ON admin_removal_inventory_spec.target FOR EACH STATEMENT WHEN (${owner} IS NULL) EXECUTE FUNCTION admin_removal_inventory_spec.noop()`,
                );
                assert.equal(
                  (
                    await tx.query(
                      `SELECT count(*)::int n FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_trigger g ON g.oid=d.objid
            WHERE d.classid='pg_catalog.pg_trigger'::regclass AND d.refclassid='pg_catalog.pg_proc'::regclass AND d.refobjid=$1::regprocedure
            AND g.tgname='when_source' AND g.tgfoid<>$1::regprocedure`,
                      [owner],
                    )
                  ).rows[0]!.n,
                  1,
                );
                await check(tx, true);
                await tx.query(source(owner));
                await check(tx, false);
                await tx.query(`CREATE TRIGGER when_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON admin_removal_inventory_spec.target FOR EACH STATEMENT
            WHEN (whaleu_community.admin_post_removal_source_statement_guard() IS NULL) EXECUTE FUNCTION admin_removal_inventory_spec.noop()`);
                await check(tx, false);
                await tx.query(guard);
                await check(tx, true);
              });
          },
        );
        await inventory.test(
          'the exact original source-type and guard-type predicates are not widened or silently tightened',
          () =>
            probe(async (tx) => {
              await tx.query(source(owners[0]));
              await tx.query(
                'CREATE TRIGGER guard BEFORE INSERT ON admin_removal_inventory_spec.target FOR EACH STATEMENT EXECUTE FUNCTION whaleu_community.admin_post_removal_source_statement_guard()',
              );
              await check(tx, false);
              await tx.query(
                'DROP TRIGGER guard ON admin_removal_inventory_spec.target',
              );
              await tx.query(guard);
              await check(tx, true);
              for (const mode of [
                'BEFORE INSERT FOR EACH ROW',
                'AFTER INSERT FOR EACH STATEMENT',
              ]) {
                const [timing, rest] = mode.split(' INSERT ');
                await tx.query(
                  `CREATE OR REPLACE TRIGGER source ${timing} INSERT ON admin_removal_inventory_spec.target ${rest} EXECUTE FUNCTION ${owners[0]}`,
                );
                await check(tx, true); // Original administrative source predicate has no tgtype filter.
              }
            }),
        );
        await inventory.test(
          'partition clones and internal foreign-key triggers retain their original meaning',
          () =>
            probe(async (tx) => {
              await tx.query(`CREATE TABLE admin_removal_inventory_spec.foreign_child(id integer REFERENCES admin_removal_inventory_spec.target(id));
          CREATE TABLE admin_removal_inventory_spec.parent(id integer) PARTITION BY RANGE(id);
          CREATE TABLE admin_removal_inventory_spec.child PARTITION OF admin_removal_inventory_spec.parent FOR VALUES FROM(0) TO(10);
          CREATE TRIGGER source BEFORE INSERT ON admin_removal_inventory_spec.parent FOR EACH ROW EXECUTE FUNCTION whaleu_media.advance_owner_epoch()`);
              assert.ok(
                (
                  await tx.query(
                    "SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='admin_removal_inventory_spec.foreign_child'::regclass AND tgisinternal",
                  )
                ).rowCount,
              );
              assert.equal(
                (
                  await tx.query(
                    "SELECT count(*)::int n FROM pg_catalog.pg_trigger WHERE tgrelid='admin_removal_inventory_spec.child'::regclass AND tgparentid<>0 AND tgfoid='whaleu_media.advance_owner_epoch()'::regprocedure",
                  )
                ).rows[0]!.n,
                1,
              );
              await check(tx, false);
              await tx.query(
                guard.replace(
                  'admin_removal_inventory_spec.target',
                  'admin_removal_inventory_spec.parent',
                ),
              );
              await check(tx, false);
              await tx.query(
                guard.replace(
                  'admin_removal_inventory_spec.target',
                  'admin_removal_inventory_spec.child',
                ),
              );
              await check(tx, true);
              await tx.query(
                'DROP TRIGGER source ON admin_removal_inventory_spec.parent',
              );
              await check(tx, true);
            }),
        );
        await inventory.test(
          'statement-local materialized candidates use reference dependency and trigger OID indexes',
          () =>
            probe(async (tx) => {
              const body = (
                await tx.query<{ prosrc: string }>(
                  "SELECT prosrc FROM pg_catalog.pg_proc WHERE oid='whaleu_community.admin_post_removal_inventory_current()'::regprocedure",
                )
              ).rows[0]!.prosrc;
              assert.equal((body.match(/AS MATERIALIZED/g) ?? []).length, 2);
              for (const owner of owners) assert.ok(body.includes(owner));
              await tx.query(
                "SET LOCAL statement_timeout='100ms';SET LOCAL lock_timeout='1ms'",
              );
              const explain = (
                await tx.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + body)
              ).rows[0]!['QUERY PLAN'] as Array<Record<string, unknown>>;
              const nodes: Array<Record<string, unknown>> = [];
              const collect = (node: Record<string, unknown>) => {
                nodes.push(node);
                for (const child of (node['Plans'] ?? []) as Array<
                  Record<string, unknown>
                >)
                  collect(child);
              };
              collect(explain[0]!['Plan'] as Record<string, unknown>);
              assert.ok(
                nodes.some(
                  (node) => node['Index Name'] === 'pg_depend_reference_index',
                ),
              );
              assert.equal(
                nodes.some(
                  (node) =>
                    node['Relation Name'] === 'pg_trigger' &&
                    node['Node Type'] === 'Seq Scan',
                ),
                false,
              );
              inventory.diagnostic(
                JSON.stringify({
                  adminRemovalInventoryPlan: {
                    statementBudgetMs: 100,
                    planningMs: explain[0]!['Planning Time'],
                    executionMs: explain[0]!['Execution Time'],
                    nodes: nodes.map((node) => ({
                      type: node['Node Type'],
                      relation: node['Relation Name'],
                      index: node['Index Name'],
                      rows: node['Actual Rows'],
                    })),
                  },
                }),
              );
            }),
        );
      },
    );
  },
);
