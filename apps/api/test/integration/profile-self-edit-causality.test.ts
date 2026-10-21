import { DatabaseService } from '../../src/database/database.js';
import { captureProfileSelfEditIdentity } from '../../src/profile/self-edit-proof.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { hashToken } from '../../src/identity/tokens.js';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'own Profile cause binds real session, exact CAS and late source writes while preserving administrator subjects',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    await t.test(
      'six independent authenticated self edits remain concurrent and all commit',
      async () => {
        const actors: Awaited<ReturnType<typeof f.actor>>[] = [];
        for (let i = 0; i < 6; i++) actors.push(await f.actor());
        const responses = await Promise.all(
          actors.map((actor, index) =>
            request(f.http)
              .patch('/v1/me/profile')
              .set('Authorization', `Bearer ${actor.accessToken}`)
              .send({ expectedRevision: 0, bio: `Parallel owner ${index}` }),
          ),
        );
        for (const response of responses) {
          profileOk(response);
          assert.equal(response.body.revision, 1);
        }
        const proofs = (
          await f.pool.query<{ count: number }>(
            `SELECT count(*)::integer count FROM whaleu_profile.self_edit_causes q
         JOIN whaleu_profile.self_edit_statements s ON s.cause_id=q.id
         JOIN whaleu_profile.self_edit_transitions t ON t.cause_id=q.id
         WHERE q.actor_id=ANY($1::uuid[])`,
            [actors.map((actor) => actor.accountId)],
          )
        ).rows[0]!;
        assert.equal(proofs.count, 6);
        const retained = async () =>
          (
            await f.pool.query(
              `SELECT to_jsonb(q) cause,to_jsonb(s) statement,to_jsonb(t) transition
           FROM whaleu_profile.self_edit_causes q
           JOIN whaleu_profile.self_edit_statements s ON s.cause_id=q.id
           JOIN whaleu_profile.self_edit_transitions t ON t.cause_id=q.id
           WHERE q.actor_id=$1`,
              [actors[0]!.accountId],
            )
          ).rows;
        const history = await retained();
        assert.equal(history.length, 1);
        const cleanup = await f.pool.query(
          'DELETE FROM whaleu_identity.sessions WHERE id=$1',
          [actors[0]!.sessionId],
        );
        assert.equal(cleanup.rowCount, 1);
        assert.deepEqual(
          await retained(),
          history,
          'Credential cleanup cannot delete or block retained causal evidence',
        );
      },
    );
    for (const source of ['session', 'token'] as const)
      await t.test(
        `concurrent ${source} revocation denies pre-admission and waits behind an admitted exact row fence`,
        async () => {
          const revokeSql =
            source === 'session'
              ? "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1"
              : 'DELETE FROM whaleu_identity.access_tokens WHERE token_hash=$1';
          const fresh = async () => {
            const actor = await f.actor();
            await f.pool.query(
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1)',
              [actor.accountId],
            );
            return actor;
          };
          const insertCause = async (
            tx: PoolClient,
            actor: Awaited<ReturnType<typeof fresh>>,
            id: string,
            identityHash: string,
          ) =>
            tx.query(
              `INSERT INTO whaleu_profile.self_edit_causes(id,actor_id,session_id,token_hash,expected_revision,patch,identity_hash)
         VALUES($1,$2,$3,$4,0,'{"bio":"Boundary change"}'::jsonb,$5)`,
              [
                id,
                actor.accountId,
                actor.sessionId,
                hashToken(actor.accessToken),
                identityHash,
              ],
            );
          const early = await fresh();
          let attempted = false,
            admitted = false;
          let admissionError: unknown;
          await assert.rejects(
            f.app.get(DatabaseService).transaction(
              async (tx) => {
                const id = randomUUID();
                const fingerprint = await captureProfileSelfEditIdentity(
                  id,
                  early.accountId,
                  {
                    sessionId: early.sessionId,
                    tokenHash: hashToken(early.accessToken),
                  },
                  tx,
                );
                await f.pool.query(revokeSql, [
                  source === 'session'
                    ? early.sessionId
                    : hashToken(early.accessToken),
                ]);
                attempted = true;
                try {
                  await insertCause(tx, early, id, fingerprint);
                  admitted = true;
                } catch (error) {
                  admissionError = error;
                  throw error;
                }
              },
              { isolationLevel: 'read committed' },
            ),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'constraint' in error &&
              error.constraint === 'profile_self_edit_causal',
          );
          assert.equal(attempted, true);
          assert.equal(
            admitted,
            false,
            'Revoked credentials must fail at cause INSERT, not deferred missing-effect closure',
          );
          assert.ok(
            admissionError &&
              typeof admissionError === 'object' &&
              'constraint' in admissionError &&
              admissionError.constraint === 'profile_self_edit_causal',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer count FROM whaleu_profile.self_edit_causes WHERE actor_id=$1',
                [early.accountId],
              )
            ).rows[0].count,
            0,
          );
          const held = await fresh();
          const writer = await f.pool.connect();
          let rowFenceReached = false;
          try {
            await f.app.get(DatabaseService).transaction(
              async (tx) => {
                const id = randomUUID();
                const fingerprint = await captureProfileSelfEditIdentity(
                  id,
                  held.accountId,
                  {
                    sessionId: held.sessionId,
                    tokenHash: hashToken(held.accessToken),
                  },
                  tx,
                );
                await insertCause(tx, held, id, fingerprint);
                await tx.query(
                  "UPDATE whaleu_profile.profiles SET bio='Boundary change',revision=revision+1,updated_at=clock_timestamp() WHERE account_id=$1",
                  [held.accountId],
                );
                await writer.query('BEGIN');
                await writer.query("SET LOCAL lock_timeout='100ms'");
                await assert.rejects(
                  writer.query(revokeSql, [
                    source === 'session'
                      ? held.sessionId
                      : hashToken(held.accessToken),
                  ]),
                  (error: unknown) =>
                    !!error &&
                    typeof error === 'object' &&
                    'code' in error &&
                    error.code === '55P03',
                );
                rowFenceReached = true;
                await writer.query('ROLLBACK');
              },
              { isolationLevel: 'read committed' },
            );
            assert.equal(rowFenceReached, true);
            const changed = await writer.query(revokeSql, [
              source === 'session'
                ? held.sessionId
                : hashToken(held.accessToken),
            ]);
            assert.equal(changed.rowCount, 1);
            const denied = await request(f.http)
              .patch('/v1/me/profile')
              .set('Authorization', `Bearer ${held.accessToken}`)
              .send({ expectedRevision: 1, bio: 'Must not apply' });
            assert.equal(denied.status, 401);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT bio FROM whaleu_profile.profiles WHERE account_id=$1',
                  [held.accountId],
                )
              ).rows[0].bio,
              'Boundary change',
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const mutePost = await f.publish(owner),
      suspensionPost = await f.publish(owner),
      target = await f.publish(owner);
    const own = async () =>
      (
        await f.pool.query<{ revision: number }>(
          'SELECT revision FROM whaleu_profile.profiles WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0]!;
    const edit = (revision: number) =>
      request(f.http)
        .patch('/v1/me/profile')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ expectedRevision: revision, bio: 'Own private self-service' });
    await f.issue(admin, owner, mutePost, 'interaction_mute');
    const before = await own();
    profileOk(await edit(before.revision));
    const history = (
      await f.pool.query(
        'SELECT q.*,t.after_fingerprint FROM whaleu_profile.self_edit_causes q JOIN whaleu_profile.self_edit_transitions t ON t.cause_id=q.id WHERE actor_id=$1',
        [owner.accountId],
      )
    ).rows;
    assert.ok(history.length > 0);
    assert.equal(history.at(-1).actor_id, owner.accountId);
    assert.equal(history.at(-1).patch.bio, 'Own private self-service');
    assert.ok(history.at(-1).after_fingerprint);
    const stale = await edit(before.revision);
    assert.equal(stale.body.error.code, 'PROFILE_REVISION_CONFLICT');

    const rollback = async (
      run: (tx: PoolClient) => Promise<void>,
      rejects = true,
    ) => {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        if (rejects)
          await assert.rejects(async () => {
            await run(tx);
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          });
        else {
          await run(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        }
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    };
    const prepare = async (
      tx: PoolClient,
      tokenHash = hashToken(owner.accessToken),
      actorId = owner.accountId,
      causeId = randomUUID(),
    ) => {
      const session = (
        await tx.query<{ session_id: string }>(
          'SELECT session_id FROM whaleu_identity.access_tokens WHERE token_hash=$1',
          [hashToken(owner.accessToken)],
        )
      ).rows[0]!;
      const revision = (await own()).revision;
      await tx.query(
        `INSERT INTO whaleu_profile.self_edit_causes(id,actor_id,session_id,token_hash,expected_revision,patch,identity_hash) VALUES($1,$2,$3,$4,$5,$6,whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($2,$3,$4)))`,
        [
          causeId,
          actorId,
          session.session_id,
          tokenHash,
          revision,
          { bio: 'Exact change' },
        ],
      );
      return revision;
    };
    const apply = async (tx: PoolClient) =>
      tx.query(
        "UPDATE whaleu_profile.profiles SET bio='Exact change',revision=revision+1,updated_at=clock_timestamp() WHERE account_id=$1",
        [owner.accountId],
      );
    await t.test(
      'real own cause succeeds; forged token, actor, fields and missing effect fail',
      async () => {
        await rollback(async (tx) => {
          await prepare(tx);
          await apply(tx);
        }, false);
        await rollback(async (tx) => {
          await prepare(tx, '0'.repeat(64));
        });
        await rollback(async (tx) => {
          await prepare(tx, hashToken(owner.accessToken), admin.accountId);
        });
        await rollback(async (tx) => {
          await prepare(tx);
        });
        await rollback(async (tx) => {
          await prepare(tx);
          await tx.query(
            "UPDATE whaleu_profile.profiles SET nickname='Unexpected',revision=revision+1 WHERE account_id=$1",
            [owner.accountId],
          );
        });
      },
    );
    await t.test(
      'an exact actor effect cannot authorize additional subject rows',
      async () => {
        // Identity actor creation does not create a Profile. Materialize the
        // second row explicitly so this attack actually targets two subjects.
        await f.pool.query(
          'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT(account_id) DO NOTHING',
          [admin.accountId],
        );
        const subjects = [owner.accountId, admin.accountId];
        const snapshot = async () =>
          (
            await f.pool.query(
              'SELECT to_jsonb(p) profile FROM whaleu_profile.profiles p WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',
              [subjects],
            )
          ).rows;
        const before = await snapshot();
        assert.equal(
          before.length,
          2,
          'The adversarial UPDATE must match both actor and victim',
        );
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          await prepare(tx);
          await assert.rejects(
            tx.query(
              "UPDATE whaleu_profile.profiles SET bio='Exact change',revision=revision+1,updated_at=clock_timestamp() WHERE account_id=ANY($1::uuid[])",
              [subjects],
            ),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'constraint' in error &&
              error.constraint === 'profile_self_edit_causal',
          );
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        assert.deepEqual(
          await snapshot(),
          before,
          'Rejected multirow attack changes neither subject',
        );
      },
    );
    const constraintIs = (constraint: string) => (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'constraint' in error &&
      error.constraint === constraint;
    const exactFailure = async (
      before: (tx: PoolClient) => Promise<unknown>,
      attack: (tx: PoolClient) => Promise<unknown>,
      constraint = 'profile_self_edit_causal',
    ) => {
      const tx = await f.pool.connect();
      try {
        await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await before(tx);
        await assert.rejects(attack(tx), constraintIs(constraint));
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    };
    await t.test(
      'raw and zero-row inserts fail at exact statement evidence admission',
      async () => {
        await exactFailure(
          (tx) => prepare(tx),
          (tx) =>
            tx.query(
              `INSERT INTO whaleu_profile.self_edit_statements(cause_id,before_fingerprint)
        SELECT id,before_fingerprint FROM whaleu_profile.self_edit_causes
        WHERE actor_id=$1 AND mutation_transaction=pg_current_xact_id()`,
              [owner.accountId],
            ),
        );
        await exactFailure(
          (tx) => prepare(tx),
          (tx) =>
            tx.query(`INSERT INTO whaleu_profile.self_edit_statements(cause_id,before_fingerprint)
        SELECT id,before_fingerprint FROM whaleu_profile.self_edit_causes WHERE false`),
        );
      },
    );
    await t.test(
      'statement evidence rejects mutation and retains exact one-statement closure',
      async () => {
        for (const sql of [
          'UPDATE whaleu_profile.self_edit_statements SET before_fingerprint=before_fingerprint',
          'DELETE FROM whaleu_profile.self_edit_statements',
          'TRUNCATE whaleu_profile.self_edit_statements',
        ])
          await exactFailure(
            async (tx) => {
              await prepare(tx);
              await apply(tx);
            },
            (tx) => tx.query(sql),
            'profile_moderation_causal',
          );
        await exactFailure(
          async (tx) => {
            await prepare(tx);
            await tx.query(
              'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
            );
          },
          (tx) => tx.query('SET CONSTRAINTS ALL IMMEDIATE'),
        );
        await exactFailure(
          async (tx) => {
            await prepare(tx);
          },
          (tx) => tx.query('SET CONSTRAINTS ALL IMMEDIATE'),
        );
        await exactFailure(
          async (tx) => {
            await prepare(tx);
            await tx.query(
              'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
            );
          },
          (tx) => apply(tx),
        );
        await exactFailure(
          async (tx) => {
            await prepare(tx);
            await apply(tx);
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          },
          (tx) =>
            tx.query(
              'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
            ),
        );
      },
    );
    await t.test(
      'zero-row, ABA and identity writer after original cause or forced final proof fail',
      async () => {
        await rollback(async (tx) => {
          await prepare(tx);
          await tx.query(
            'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
          );
          await apply(tx);
        });
        await rollback(async (tx) => {
          await prepare(tx);
          await apply(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.query(
            'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
          );
        });
        await rollback(async (tx) => {
          const revision = await prepare(tx);
          await apply(tx);
          await tx.query(
            'UPDATE whaleu_profile.profiles SET revision=$2 WHERE account_id=$1',
            [owner.accountId, revision],
          );
        });
        await rollback(async (tx) => {
          await prepare(tx);
          await apply(tx);
          await tx.query(
            'UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp() WHERE account_id=$1',
            [owner.accountId],
          );
        });
        await rollback(async (tx) => {
          await prepare(tx);
          await apply(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.query(
            'UPDATE whaleu_identity.access_tokens SET expires_at=expires_at WHERE false',
          );
        });
      },
    );
    await t.test(
      'actorless raw source fixtures are preserved without inventing an authenticated cause',
      async () => {
        await rollback(async (tx) => {
          await tx.query(
            "UPDATE whaleu_profile.profiles SET bio='Synthetic source fixture' WHERE account_id=$1",
            [owner.accountId],
          );
        }, false);
      },
    );
    await t.test(
      'session access expiry after forced SQL closure still rolls back at final owner deadline',
      async () => {
        let reachedLateWait = false;
        await assert.rejects(
          f.app.get(DatabaseService).transaction(
            async (tx) => {
              const session = (
                await tx.query<{ session_id: string }>(
                  'SELECT session_id FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                  [hashToken(owner.accessToken)],
                )
              ).rows[0]!;
              await tx.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",
                [session.session_id],
              );
              const causeId = randomUUID();
              await captureProfileSelfEditIdentity(
                causeId,
                owner.accountId,
                {
                  sessionId: session.session_id,
                  tokenHash: hashToken(owner.accessToken),
                },
                tx,
              );
              await prepare(
                tx,
                hashToken(owner.accessToken),
                owner.accountId,
                causeId,
              );
              await apply(tx);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              reachedLateWait = true;
              await tx.query('SELECT pg_sleep(0.6)');
            },
            { isolationLevel: 'read committed' },
          ),
        );
        assert.equal(reachedLateWait, true);
      },
    );
    await f.issue(admin, owner, suspensionPost, 'access_suspension');
    const suspended = await edit((await own()).revision);
    assert.equal(suspended.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
    await rollback(async (tx) => {
      await prepare(tx);
      await apply(tx);
    });
    await t.test(
      'current administrator may reset nickname of suspended subject',
      async () => {
        const view = await request(f.http)
          .get('/v1/community/profile-moderation/management')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .query({ kind: target.kind, id: target.id });
        profileOk(view);
        const result = await request(f.http)
          .post('/v1/community/profile-moderation/commands')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({
            clientRequestId: randomUUID(),
            target: { kind: target.kind, id: target.id },
            expectedProfileRevision: (await own()).revision,
            action: 'reset_nickname',
          });
        profileOk(result);
        assert.equal(result.body.outcome, 'applied');
      },
    );
    await t.test(
      'retained self history adds no foreign keys to live Identity or Profile state',
      async () => {
        const constraints = (
          await f.pool.query(
            `SELECT c.conname::text constraint_name,
               ARRAY(SELECT a.attname::text
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
                 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
                 ORDER BY k.ord) source_columns,
               n.nspname::text target_schema, r.relname::text target_table,
               ARRAY(SELECT a.attname::text
                 FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
                 JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum
                 ORDER BY k.ord) target_columns,
               c.confupdtype::text on_update, c.confdeltype::text on_delete,
               c.confmatchtype::text match_type, c.condeferrable is_deferrable,
               c.condeferred initially_deferred, c.convalidated validated
             FROM pg_constraint c
             JOIN pg_class r ON r.oid=c.confrelid
             JOIN pg_namespace n ON n.oid=r.relnamespace
             WHERE c.contype='f' AND c.conrelid='whaleu_profile.self_edit_causes'::regclass
             ORDER BY c.conname`,
          )
        ).rows;
        // Only the explicit erasure cause may refer to a retained deletion
        // request. Actor/session and live Profile retention FKs remain forbidden.
        assert.deepEqual(constraints, [
          {
            constraint_name: 'self_edit_causes_erased_by_request_id_fkey',
            source_columns: ['erased_by_request_id'],
            target_schema: 'whaleu_account_deletion',
            target_table: 'requests',
            target_columns: ['id'],
            on_update: 'a',
            on_delete: 'a',
            match_type: 's',
            is_deferrable: false,
            initially_deferred: false,
            validated: true,
          },
        ]);
        const erasureColumn = (
          await f.pool.query(
            `SELECT attname::text column_name, format_type(atttypid,atttypmod) data_type,
               attnotnull not_null, atthasdef has_default
             FROM pg_attribute
             WHERE attrelid='whaleu_profile.self_edit_causes'::regclass
               AND attname='erased_by_request_id' AND NOT attisdropped`,
          )
        ).rows;
        assert.deepEqual(erasureColumn, [
          {
            column_name: 'erased_by_request_id',
            data_type: 'uuid',
            not_null: false,
            has_default: false,
          },
        ]);
        const statementTargets = (
          await f.pool.query(
            `SELECT confrelid::regclass::text target FROM pg_constraint WHERE contype='f' AND conrelid='whaleu_profile.self_edit_statements'::regclass`,
          )
        ).rows;
        assert.deepEqual(statementTargets, [
          { target: 'whaleu_profile.self_edit_causes' },
        ]);
      },
    );
  },
);
