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
            `SELECT confrelid::regclass::text target FROM pg_constraint WHERE contype='f' AND conrelid='whaleu_profile.self_edit_causes'::regclass`,
          )
        ).rows;
        assert.deepEqual(constraints, []);
      },
    );
  },
);
