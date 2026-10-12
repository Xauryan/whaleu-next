import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { MediaRequiredProof } from '../../src/media/required-proof.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'avatar clear retains original target Media facts and outer epochs without consuming queued revocations',
  { timeout: 240000 },
  async (t) => {
    const f = await profileAvatarModerationFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor();
    const grant = await f.grant(admin);
    const target = await f.publish(subject, {}, true),
      selected = await f.custom(subject);
    const assetId = target.input.imageAssetIds[0]!;
    const database = f.moderationApp.get(DatabaseService);
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object('profile',(SELECT to_jsonb(p) FROM whaleu_profile.profiles p WHERE account_id=$1),'avatar',whaleu_profile.moderation_avatar_facts($1),'media',whaleu_profile.avatar_moderation_media_facts('post',$2),'commands',(SELECT count(*) FROM whaleu_profile.avatar_moderation_commands),'events',(SELECT count(*) FROM whaleu_profile.avatar_moderation_events),'notices',(SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices)) value`,
          [subject.accountId, target.id],
        )
      ).rows[0]!.value;
    const original = await snapshot();
    const body = () =>
      f.command(target, selected.current.revision, selected.appearanceId);
    const injected = async (
      hook: (
        sql: string,
        values: unknown[] | undefined,
        tx: PoolClient,
        query: (sql: string, values?: unknown[]) => Promise<QueryResult>,
      ) => Promise<void>,
      before?: (tx: PoolClient) => Promise<void>,
    ) => {
      const transaction = database.transaction,
        run = transaction.bind(database);
      let result;
      database.transaction = (work, options) =>
        run(async (tx) => {
          if (before) await before(tx);
          const raw = tx.query,
            query = raw.bind(tx) as (
              sql: string,
              values?: unknown[],
            ) => Promise<QueryResult>;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            await hook(sql, values, tx, query);
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        result = await f.send(admin, body());
      } finally {
        database.transaction = transaction;
      }
      assert.notEqual(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(await snapshot(), original);
      return result;
    };
    await t.test(
      'ordinary Media fact enrolled outside mutation scope is not replaced',
      async () => {
        await injected(
          async () => {},
          async (tx) => {
            await new MediaRequiredProof().capture(tx);
          },
        );
      },
    );
    await t.test(
      'initial mutable target tuple, attempted detach/reattach ABA and zero-row Media writers are retained',
      async () => {
        for (const kind of [
          'same-value',
          'detach-reattach',
          'zero-row',
        ] as const) {
          let changed = false;
          await injected(async (sql, _values, _tx, query) => {
            if (!changed && sql.includes('avatar_moderation_media_facts')) {
              changed = true;
              if (kind === 'same-value') {
                const changed = await query(
                  'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE asset_id=$1',
                  [assetId],
                );
                assert.equal(
                  changed.rowCount,
                  1,
                  'Mutable target tuple update actually executes',
                );
              } else if (kind === 'detach-reattach') {
                await query(
                  "UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='synthetic-aba' WHERE asset_id=$1",
                  [assetId],
                );
                await query(
                  'UPDATE whaleu_media.bindings SET detached_at=NULL,detach_reason=NULL WHERE asset_id=$1',
                  [assetId],
                );
              } else
                await query(
                  'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE false',
                );
            }
          });
          assert.equal(changed, true);
        }
      },
    );
    await t.test(
      'pre-admission pointer tuple is not silently rebased after a same-value update and deferred flush',
      async () => {
        let changed = false;
        await injected(async (sql, values, _tx, query) => {
          if (
            !changed &&
            sql.startsWith('SELECT revision,coalesce(nickname,') &&
            values?.[0] === subject.accountId
          ) {
            changed = true;
            assert.equal(
              (
                await query(
                  'UPDATE whaleu_profile.avatar_current SET appearance_id=appearance_id WHERE actor_id=$1',
                  [subject.accountId],
                )
              ).rowCount,
              1,
            );
            await query('SET CONSTRAINTS ALL IMMEDIATE');
            await query('SET CONSTRAINTS ALL DEFERRED');
          }
        });
        assert.equal(changed, true);
      },
    );
    await t.test(
      'late target/zero-row writes after the declared retirement cannot hide in final epoch',
      async () => {
        for (const sql of [
          'UPDATE whaleu_media.assets SET manifest_digest=manifest_digest WHERE id=$1',
          'UPDATE whaleu_media.assets SET manifest_digest=manifest_digest WHERE false',
        ]) {
          let changed = false;
          await injected(async (statement, _values, _tx, query) => {
            if (
              !changed &&
              statement.startsWith(
                'INSERT INTO whaleu_notifications.profile_avatar_moderation_notices',
              )
            ) {
              changed = true;
              await query(sql, sql.includes('$1') ? [assetId] : []);
            }
          });
          assert.equal(changed, true);
        }
      },
    );
    await t.test(
      'queued exact grant revocation is rejected without waiting for a new authority writer',
      async () => {
        const writer = await f.pool.connect();
        let update: Promise<QueryResult> | undefined,
          queued = false;
        try {
          await writer.query('BEGIN');
          const pid = (
            await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await injected(async (sql, _values, _tx) => {
            if (
              !queued &&
              sql.startsWith(
                'INSERT INTO whaleu_notifications.profile_avatar_moderation_notices',
              )
            ) {
              queued = true;
              update = writer.query(
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                [grant],
              );
              for (let i = 0; i < 100; i++) {
                if (
                  (
                    await f.pool.query<{ waiting: boolean }>(
                      "SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",
                      [pid],
                    )
                  ).rows[0]?.waiting
                )
                  return;
                await sleep(10);
              }
              throw new Error('Expected exact grant writer to queue');
            }
          });
        } finally {
          if (update) await update;
          await writer.query('ROLLBACK');
          writer.release();
        }
        assert.equal(queued, true);
      },
    );
    await t.test(
      'same Profile CAS selects only one effect between clear and two administrators',
      async () => {
        const second = await f.actor();
        await f.grant(second);
        const outcomes = await Promise.all([
          f.send(admin, body()),
          f.send(second, body()),
        ]);
        assert.equal(
          outcomes.filter(
            (r) => r.status === 200 && r.body.outcome === 'applied',
          ).length,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_profile.avatar_moderation_events',
            )
          ).rows[0]!.count,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_notifications.profile_avatar_moderation_notices',
            )
          ).rows[0]!.count,
          1,
        );
      },
    );
    await t.test(
      'a later owner bio write wins the old revision without another clear effect',
      async () => {
        const chosen = await f.custom(subject),
          command = f.command(
            target,
            chosen.current.revision,
            chosen.appearanceId,
          );
        const update = await request(f.http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${subject.accessToken}`)
          .send({
            expectedRevision: chosen.current.revision,
            bio: 'Newer owner draft',
          });
        profileOk(update);
        const result = await f.send(admin, command);
        profileOk(result);
        assert.equal(result.body.code, 'PROFILE_AVATAR_MODERATION_STALE');
        assert.equal(
          (
            await f.pool.query(
              'SELECT appearance_id FROM whaleu_profile.avatar_current WHERE actor_id=$1',
              [subject.accountId],
            )
          ).rows[0]!.appearance_id,
          chosen.appearanceId,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_profile.avatar_moderation_events',
            )
          ).rows[0]!.count,
          1,
        );
      },
    );
    await t.test(
      'recovery and fresh cancellation need only original actor session while grant/Profile/Media are locked',
      async () => {
        const lock = await f.pool.connect();
        try {
          await lock.query('BEGIN');
          await lock.query(
            'LOCK TABLE whaleu_authorization.role_grants,whaleu_verification.account_heads,whaleu_profile.profiles,whaleu_media.assets IN ACCESS EXCLUSIVE MODE',
          );
          await lock.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
          );
          const absent = await request(f.http)
            .get(
              `/v1/community/profile-avatar-moderation/requests/${randomUUID()}`,
            )
            .set('Authorization', `Bearer ${admin.accessToken}`);
          profileOk(absent);
          assert.deepEqual(absent.body, { state: 'not_recorded' });
          const cancel = await f.send(
            admin,
            f.command({ kind: 'post', id: randomUUID() }, 0, randomUUID()),
            true,
          );
          profileOk(cancel);
          assert.equal(cancel.body.code, 'PROFILE_AVATAR_MODERATION_CANCELLED');
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
      },
    );
  },
);
