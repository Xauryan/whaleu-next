/** Raw SQL and managed final-proof adversaries against disposable synthetic facts. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { moderationIntentHash } from '../../src/profile/moderation/evidence.js';
import { moderationReceiptSchema } from '../../src/profile/moderation/contracts.js';
import type { ModerationCommand } from '../../src/profile/moderation/contracts.js';
import { profileModerationFixture } from '../support/profile-moderation-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));
const causal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '23505', '22P02', '55P03'].includes(String(error.code));

test(
  'nickname moderation raw cause closure, registry identity, final authority writers and exact rollback',
  { timeout: 240000 },
  async (t) => {
    const f = await profileModerationFixture();
    t.after(() => f.close());
    const http = f.app.getHttpServer(),
      database = f.app.get(DatabaseService);
    const admin = await f.actor(),
      subject = await f.actor(),
      unrelated = await f.actor();
    const grant = await f.grant(
      admin.accountId,
      'school_admin',
      f.scope.home.regionId,
    );
    const post = await f.publish(subject);
    await f.publish(unrelated);
    const target = { kind: 'post' as const, id: post.id };
    const body = async (): Promise<ModerationCommand> => ({
      clientRequestId: randomUUID(),
      target,
      action: 'reset_nickname',
      expectedProfileRevision: (await profile()).revision,
    });
    const profile = async () =>
      (
        await f.pool.query<{
          revision: number;
          nickname: string | null;
          bytes: object;
        }>(
          'SELECT revision,nickname,to_jsonb(p) bytes FROM whaleu_profile.profiles p WHERE account_id=$1',
          [subject.accountId],
        )
      ).rows[0]!;
    const totals = async () =>
      (
        await f.pool.query(`SELECT
    (SELECT count(*)::integer FROM whaleu_profile.moderation_commands) commands,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_events) events,
    (SELECT count(*)::integer FROM whaleu_profile.moderation_transitions) transitions,
    (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) notices,
    (SELECT count(*)::integer FROM whaleu_notifications.system_notice_ids) registry`)
      ).rows[0];
    const send = (command: ModerationCommand, actor = admin, cancel = false) =>
      request(http)
        .post(
          `/v1/community/profile-moderation/commands${cancel ? '/cancel' : ''}`,
        )
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(command);
    const recovery = (id: string, actor = admin) =>
      request(http)
        .get(`/v1/community/profile-moderation/requests/${id}`)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const empty = async (command: ModerationCommand, actor = admin) => {
      const response = await recovery(command.clientRequestId, actor);
      ok(response);
      assert.deepEqual(response.body, { state: 'not_recorded' });
    };
    const insertCommand = (
      tx: PoolClient,
      command: ModerationCommand,
      receipt: object,
      actor = admin,
      selectedGrant: string | null = grant,
      hash = moderationIntentHash(actor.accountId, command),
    ) =>
      tx.query(
        `INSERT INTO whaleu_profile.moderation_commands
      (actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          actor.accountId,
          command.clientRequestId,
          actor.sessionId,
          hashToken(actor.accessToken),
          command.target.kind,
          command.target.id,
          hash,
          command,
          receipt,
          selectedGrant,
        ],
      );
    const resultBase = (command: ModerationCommand) => ({
      requestId: command.clientRequestId,
      target: command.target,
      expectedProfileRevision: command.expectedProfileRevision,
      action: command.action,
    });
    const nextReceipt = (command: ModerationCommand) => ({
      ...resultBase(command),
      outcome: 'applied' as const,
      revision: command.expectedProfileRevision + 1,
      eventId: randomUUID(),
      recordedAt: new Date().toISOString(),
    });
    const mutate = async (
      tx: PoolClient,
      command: ModerationCommand,
      options: {
        omit?: 'profile' | 'event' | 'notice';
        zeroCas?: boolean;
        eventTarget?: string;
        eventSubject?: string;
        eventAuthority?: object;
        eventRevision?: number;
        noticeSubject?: string;
        noticeNickname?: string;
      } = {},
    ) => {
      const receipt = nextReceipt(command);
      await insertCommand(tx, command, receipt);
      if (options.omit !== 'profile') {
        const changed = await tx.query(
          `UPDATE whaleu_profile.profiles SET nickname='违规昵称Abc123',revision=revision+1,updated_at=clock_timestamp()
         WHERE account_id=$1 AND revision=$2 AND NOT $3::boolean`,
          [
            subject.accountId,
            command.expectedProfileRevision,
            options.zeroCas ?? false,
          ],
        );
        assert.equal(changed.rowCount, options.zeroCas ? 0 : 1);
      }
      if (options.omit !== 'event')
        await tx.query(
          `INSERT INTO whaleu_profile.moderation_events
        (id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,
         selected_authority,before_revision,revision,old_nickname,nickname,recorded_at)
       SELECT $3,q.actor_id,q.request_id,coalesce($4::uuid,q.subject_id),q.target_kind,coalesce($5::uuid,q.target_id),
         q.post_id,q.root_id,q.original_region_id,q.grant_id,$6,q.before_revision,$7,q.before_nickname,'违规昵称Abc123',$8
       FROM whaleu_profile.moderation_commands q WHERE actor_id=$1 AND request_id=$2`,
          [
            admin.accountId,
            command.clientRequestId,
            receipt.eventId,
            options.eventSubject ?? null,
            options.eventTarget ?? null,
            options.eventAuthority ?? null,
            options.eventRevision ?? receipt.revision,
            receipt.recordedAt,
          ],
        );
      if (options.omit !== 'notice')
        await tx.query(
          `INSERT INTO whaleu_notifications.profile_moderation_notices
         (id,event_id,recipient_account_id,nickname,created_at) VALUES($1,$2,$3,$4,$5)`,
          [
            randomUUID(),
            receipt.eventId,
            options.noticeSubject ?? subject.accountId,
            options.noticeNickname ?? '违规昵称Abc123',
            receipt.recordedAt,
          ],
        );
      return receipt;
    };

    await t.test(
      'missing cause, zero-row CAS, wrong subject/target/revision/authority/notice roll back every write',
      async () => {
        for (const options of [
          { omit: 'profile' as const },
          { omit: 'event' as const },
          { omit: 'notice' as const },
          { zeroCas: true },
          { eventTarget: randomUUID() },
          { eventSubject: unrelated.accountId },
          { eventRevision: 17 },
          { eventAuthority: { role: 'super_admin' } },
          { noticeSubject: unrelated.accountId },
          { noticeNickname: '违规昵称Wrong1' },
        ]) {
          const command = await body(),
            before = await totals(),
            own = await profile();
          await assert.rejects(
            inTransaction(f.pool, (tx) => mutate(tx, command, options)),
            causal,
          );
          assert.deepEqual(await totals(), before);
          assert.deepEqual(await profile(), own);
          await empty(command);
        }
        const command = await body();
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            insertCommand(tx, command, nextReceipt(command)),
          ),
          causal,
        );
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            insertCommand(
              tx,
              command,
              {
                ...resultBase(command),
                outcome: 'rejected',
                code: 'PROFILE_MODERATION_CANCELLED',
              },
              admin,
              null,
              '0'.repeat(64),
            ),
          ),
          causal,
        );
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            insertCommand(tx, command, {
              ...resultBase(command),
              outcome: 'rejected',
              code: 'PROFILE_MODERATION_STALE',
            }),
          ),
          causal,
          'Matching current revision cannot be forged into a durable stale result',
        );
        const extra = { ...command, accountId: subject.accountId };
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            insertCommand(
              tx,
              extra,
              {
                ...resultBase(extra),
                outcome: 'rejected',
                code: 'PROFILE_MODERATION_CANCELLED',
              },
              admin,
              null,
            ),
          ),
          causal,
        );
      },
    );

    await t.test(
      'raw legitimate stale receipts retain the original Profile tuple through no-op and ABA writes',
      async () => {
        const previous = await profile();
        const edited = await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send({
            expectedRevision: previous.revision,
            bio: 'Owner edit establishes a real stale request',
          });
        ok(edited);
        const own = await profile();
        assert.equal(own.revision, previous.revision + 1);
        for (const alteration of ['noop', 'aba'] as const) {
          const command: ModerationCommand = {
            ...(await body()),
            expectedProfileRevision: previous.revision,
          };
          const receipt = {
            ...resultBase(command),
            outcome: 'rejected',
            code: 'PROFILE_MODERATION_STALE',
          };
          const before = await totals();
          let inserted = false;
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              await insertCommand(tx, command, receipt);
              inserted = true;
              if (alteration === 'noop') {
                const updated = await tx.query(
                  'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
                  [subject.accountId],
                );
                assert.equal(updated.rowCount, 1);
              } else {
                await tx.query(
                  "UPDATE whaleu_profile.profiles SET nickname='TemporaryStaleName' WHERE account_id=$1",
                  [subject.accountId],
                );
                await tx.query(
                  'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
                  [subject.accountId, own.nickname],
                );
              }
              const restored = (
                await tx.query<{ bytes: object }>(
                  'SELECT to_jsonb(p) bytes FROM whaleu_profile.profiles p WHERE account_id=$1',
                  [subject.accountId],
                )
              ).rows[0]!;
              assert.deepEqual(
                restored.bytes,
                own.bytes,
                'A JSON-only stale guard would incorrectly accept this tuple replacement',
              );
            }),
            causal,
          );
          assert.equal(
            inserted,
            true,
            'The stale receipt was legitimate before the raw tuple change',
          );
          assert.deepEqual(await profile(), own);
          assert.deepEqual(await totals(), before);
          await empty(command);
        }
      },
    );

    await t.test(
      'standalone event/transition/notice/registry and cross-kind UUID collision are rejected',
      async () => {
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_profile.moderation_transitions
        (actor_id,request_id,subject_id,before_revision,after_revision,before_nickname,after_nickname,before_hash,after_hash,unchanged_hash)
       VALUES($1,$2,$3,0,1,NULL,'违规昵称Abc123','forged','forged','forged')`,
            [admin.accountId, randomUUID(), subject.accountId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_profile.moderation_events
        (id,actor_id,request_id,subject_id,target_kind,target_id,post_id,original_region_id,grant_id,before_revision,revision,nickname,recorded_at)
       VALUES($1,$2,$3,$4,'post',$5,$5,$6,$7,0,1,'违规昵称Abc123',date_trunc('milliseconds',clock_timestamp()))`,
            [
              randomUUID(),
              admin.accountId,
              randomUUID(),
              subject.accountId,
              post.id,
              f.scope.home.regionId,
              grant,
            ],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_notifications.profile_moderation_notices
        (id,event_id,recipient_account_id,nickname,created_at) VALUES($1,$2,$3,'违规昵称Abc123',date_trunc('milliseconds',clock_timestamp()))`,
            [randomUUID(), randomUUID(), subject.accountId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) VALUES($1,'profile_nickname_reset',$2)",
            [randomUUID(), subject.accountId],
          ),
          causal,
        );
        const command = await body(),
          response = await send(command);
        ok(response);
        assert.equal(response.body.outcome, 'applied');
        const notice = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_notifications.profile_moderation_notices WHERE event_id=$1',
            [response.body.eventId],
          )
        ).rows[0]!;
        for (const table of [
          'moderation_commands',
          'moderation_events',
          'moderation_transitions',
        ])
          await assert.rejects(
            f.pool.query(
              `DELETE FROM whaleu_profile.${table} WHERE actor_id=$1 AND request_id=$2`,
              [admin.accountId, command.clientRequestId],
            ),
            causal,
          );
        await assert.rejects(
          f.pool.query(
            "UPDATE whaleu_notifications.profile_moderation_notices SET nickname='违规昵称Wrong1' WHERE id=$1",
            [notice.id],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) VALUES($1,'post_jury_removed',$2)",
            [notice.id, subject.accountId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_notifications.system_notice_ids WHERE id=$1',
            [notice.id],
          ),
          causal,
        );
        assert.deepEqual((await recovery(command.clientRequestId)).body, {
          state: 'recorded',
          receipt: response.body,
        });
      },
    );

    await t.test(
      'deferred late changes and ABA cannot erase the original owner facts',
      async () => {
        const changes = [
          'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=NEW.token_hash',
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=NEW.actor_id WHERE id=NEW.grant_id',
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
          "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=NEW.post_id",
          "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=NEW.post_id;UPDATE whaleu_community.posts SET visibility='approved' WHERE id=NEW.post_id",
          "UPDATE whaleu_profile.profiles SET nickname='违规昵称Late12' WHERE account_id=NEW.subject_id",
          "WITH changed AS (INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) SELECT gen_random_uuid(),decision_id,'revoked','complete','accepted','synthetic-profile-review','synthetic-deferred-only',clock_timestamp() FROM whaleu_community.content_approval_bindings WHERE content_kind=NEW.target_kind AND content_id=NEW.target_id RETURNING id,decision_id) UPDATE whaleu_community.content_approval_heads h SET event_id=changed.id FROM changed WHERE h.decision_id=changed.decision_id",
        ];
        for (const change of changes) {
          const command = await body(),
            before = await totals(),
            own = await profile();
          await f.pool
            .query(`CREATE FUNCTION whaleu_profile.moderation_test_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${change};RETURN NULL;END$$;
        CREATE CONSTRAINT TRIGGER zz_moderation_test_change AFTER INSERT ON whaleu_profile.moderation_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.moderation_test_change()`);
          try {
            const result = await send(command);
            assert.ok(
              result.status >= 400,
              `${change}: ${JSON.stringify(result.body)}`,
            );
            assert.deepEqual(await totals(), before);
            assert.deepEqual(await profile(), own);
            await empty(command);
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_moderation_test_change ON whaleu_profile.moderation_commands;DROP FUNCTION whaleu_profile.moderation_test_change()',
            );
          }
        }
      },
    );

    await t.test(
      'real selected-grant and identity writers queued behind retained SHARE abort the tentative command',
      async () => {
        for (const source of ['grant', 'session', 'token'] as const) {
          const actor = await f.actor(),
            selected = await f.grant(
              actor.accountId,
              'school_admin',
              f.scope.home.regionId,
            );
          const command = await body(),
            before = await totals(),
            own = await profile();
          const writer = await f.pool.connect(),
            original = database.transaction;
          const execute = original.bind(database);
          const pending: {
            value: Promise<
              { ok: true; count: number | null } | { ok: false; error: unknown }
            > | null;
          } = { value: null };
          let observed = false,
            open = false;
          try {
            await writer.query('BEGIN');
            open = true;
            await writer.query("SET LOCAL statement_timeout='8s'");
            const writerPid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            database.transaction = function <T>(
              operation: (tx: PoolClient) => Promise<T>,
              options: TransactionOptions = {},
            ): Promise<T> {
              return execute(async (tx) => {
                const result = await operation(tx),
                  receipt = moderationReceiptSchema.safeParse(result);
                if (
                  receipt.success &&
                  receipt.data.requestId === command.clientRequestId &&
                  receipt.data.outcome === 'applied'
                ) {
                  const commandPid = (
                    await tx.query<{ pid: number }>(
                      'SELECT pg_backend_pid() pid',
                    )
                  ).rows[0]!.pid;
                  const query =
                    source === 'grant'
                      ? writer.query(
                          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                          [selected, actor.accountId],
                        )
                      : source === 'session'
                        ? writer.query(
                            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                            [actor.sessionId],
                          )
                        : writer.query(
                            'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                            [hashToken(actor.accessToken)],
                          );
                  pending.value = query.then(
                    (value) => ({ ok: true as const, count: value.rowCount }),
                    (error) => ({ ok: false as const, error }),
                  );
                  const deadline = Date.now() + 5000;
                  while (Date.now() < deadline) {
                    const value = (
                      await f.pool.query<{ waiting: boolean }>(
                        "SELECT wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(pid)) waiting FROM pg_stat_activity WHERE pid=$1",
                        [writerPid, commandPid],
                      )
                    ).rows[0];
                    if (value?.waiting) {
                      observed = true;
                      break;
                    }
                    await sleep(10);
                  }
                  assert.equal(
                    observed,
                    true,
                    `${source} writer must actually queue behind this command's lock`,
                  );
                }
                return result;
              }, options);
            };
            const response = await send(command, actor).timeout({
              response: 10000,
              deadline: 12000,
            });
            assert.equal(observed, true);
            assert.ok(response.status >= 400, JSON.stringify(response.body));
            const changed = await pending.value;
            assert.ok(changed?.ok);
            assert.equal(changed.count, 1);
            // Roll the independent synthetic invalidator back so the actor can read
            // its original-key non-result. The command has already rolled back.
            await writer.query('ROLLBACK');
            open = false;
            assert.deepEqual(await totals(), before);
            assert.deepEqual(await profile(), own);
            await empty(command, actor);
          } finally {
            database.transaction = original;
            if (pending.value) await pending.value;
            try {
              if (open) await writer.query('ROLLBACK');
            } finally {
              writer.release();
            }
          }
        }
      },
    );

    await t.test(
      'grant/token deadlines expiring after tentative work reject the entire mutation',
      async () => {
        for (const source of ['grant', 'token'] as const) {
          const actor = await f.actor();
          await f.grant(
            actor.accountId,
            'school_admin',
            f.scope.home.regionId,
            source === 'grant' ? new Date(Date.now() + 1000) : null,
          );
          const command = await body(),
            before = await totals(),
            own = await profile();
          // A short deadline is set before authentication; a real pg_sleep after
          // work crosses it. No application timeout or proof budget is increased.
          if (source === 'token')
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",
                [hashToken(actor.accessToken)],
              ),
            );
          const original = database.transaction,
            execute = original.bind(database);
          let reached = false;
          database.transaction = (operation, options) =>
            execute(async (tx) => {
              const result = await operation(tx),
                receipt = moderationReceiptSchema.safeParse(result);
              if (
                receipt.success &&
                receipt.data.requestId === command.clientRequestId &&
                receipt.data.outcome === 'applied'
              ) {
                reached = true;
                await tx.query('SELECT pg_sleep(1.1)');
              }
              return result;
            }, options);
          let response;
          try {
            response = await send(command, actor);
          } finally {
            database.transaction = original;
          }
          assert.equal(
            reached,
            true,
            `${source}: command must reach tentative success while deadline is current`,
          );
          assert.ok(response.status >= 400, JSON.stringify(response.body));
          assert.deepEqual(await totals(), before);
          assert.deepEqual(await profile(), own);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.moderation_commands WHERE actor_id=$1 AND request_id=$2',
                [actor.accountId, command.clientRequestId],
              )
            ).rowCount,
            0,
          );
        }
      },
    );

    await t.test(
      'cancellation and actor-owned recovery have no current grant or content table dependency',
      async () => {
        const actor = await f.actor(),
          command = await body();
        command.target = { kind: 'reply', id: randomUUID() };
        const locker = await f.pool.connect();
        try {
          await locker.query('BEGIN');
          await locker.query(
            'LOCK TABLE whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_authorization.role_grants,whaleu_profile.profiles IN ACCESS EXCLUSIVE MODE',
          );
          const response = await send(command, actor, true).timeout({
            response: 2000,
            deadline: 3000,
          });
          ok(response);
          assert.equal(response.body.code, 'PROFILE_MODERATION_CANCELLED');
          const recovered = await recovery(
            command.clientRequestId,
            actor,
          ).timeout({ response: 2000, deadline: 3000 });
          ok(recovered);
          assert.deepEqual(recovered.body, {
            state: 'recorded',
            receipt: response.body,
          });
        } finally {
          await locker.query('ROLLBACK');
          locker.release();
        }
      },
    );

    await t.test(
      'independent current phone and Safety action facts cannot be replaced by the scoped role',
      async () => {
        for (const phone of ['unverified', 'unavailable'] as const) {
          const actor = await f.actor({ phone });
          await f.grant(actor.accountId, 'school_admin', f.scope.home.regionId);
          const command = await body(),
            before = await totals(),
            own = await profile();
          const result = await send(command, actor);
          assert.ok(result.status >= 400, JSON.stringify(result.body));
          assert.deepEqual(await totals(), before);
          assert.deepEqual(await profile(), own);
          await empty(command, actor);
          const cancelled = await send(command, actor, true);
          ok(cancelled);
          assert.equal(cancelled.body.code, 'PROFILE_MODERATION_CANCELLED');
        }
        const actor = await f.actor();
        await f.grant(actor.accountId, 'school_admin', f.scope.home.regionId);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
            [actor.accountId],
          ),
        );
        const command = await body(),
          before = await totals(),
          own = await profile();
        assert.ok((await send(command, actor)).status >= 400);
        assert.deepEqual(await totals(), before);
        assert.deepEqual(await profile(), own);
        await empty(command, actor);
      },
    );
  },
);
