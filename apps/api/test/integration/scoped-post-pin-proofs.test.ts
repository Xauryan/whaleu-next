import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { postPinFixture } from '../support/post-pin-fixture.js';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'pin selected-owner final fences, immutable row binding and PostgreSQL deadlines after deferred waits',
  { timeout: 240000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor();
    await f.grant(admin.accountId, 'super_admin');
    const scope = await f.bind(
      f.scope.home.spaceId,
      'regional',
      f.scope.home.regionId,
    );
    await f.bind(f.scope.global.spaceId, 'university_city', null);
    const post = await f.publish(author),
      other = await f.publish(author, f.scope.global.spaceId);
    const send = (q: object, actor = admin) =>
      request(f.app.getHttpServer())
        .post('/v1/community/post-pin-commands')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(q);
    const command = (postId = post.id) => ({
      operation: 'pin',
      postId,
      clientRequestId: randomUUID(),
      durationHours: 24,
      level: 2,
    });
    await t.test(
      'old migration rows and current pin/command/marker evidence cannot be silently rewritten',
      async () => {
        const q = command(),
          r = await send(q);
        ok(r);
        const read = await send(
          {
            operation: 'read',
            postId: post.id,
            pinId: r.body.pinId,
            clientRequestId: randomUUID(),
          },
          author,
        );
        ok(read);
        for (const sql of [
          'UPDATE whaleu_community.post_pins SET level=1',
          'UPDATE whaleu_community.post_pin_reads SET read_at=clock_timestamp()',
          'DELETE FROM whaleu_community.post_pin_commands',
          'UPDATE whaleu_community.post_pin_scopes SET source_reference=source_reference',
          "UPDATE whaleu_community.post_pin_history SET coverage='unavailable'",
          'UPDATE whaleu_community.post_pin_heads SET pin_id=pin_id',
          'TRUNCATE whaleu_community.post_pin_closures',
        ])
          await assert.rejects(f.pool.query(sql));
        // Historical FK alone cannot authorize a new unrelated marker or closure.
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_community.post_pin_reads(actor_id,pin_id,request_id) VALUES($1,$2,$3)',
            [admin.accountId, r.body.pinId, q.clientRequestId],
          ),
        );
        const foreign = await send(command(other.id));
        ok(foreign);
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_community.post_pin_closures(pin_id,reason,actor_id,request_id) VALUES($1,'unpin',$2,$3)",
            [foreign.body.pinId, admin.accountId, q.clientRequestId],
          ),
        );
        ok(
          await send({
            operation: 'unpin',
            postId: post.id,
            pinId: r.body.pinId,
            clientRequestId: randomUUID(),
          }),
        );
      },
    );
    await t.test(
      'deferred source/safety/scope/grant/session changes after tentative insert roll back pin, head and receipt',
      async () => {
        const changes = [
          'DELETE FROM whaleu_identity.access_tokens WHERE session_id=NEW.session_id',
          "PERFORM pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0));WITH changed AS (INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) SELECT gen_random_uuid(),decision_id,'revoked','complete','accepted','synthetic-pin-review','synthetic-deferred-only',clock_timestamp() FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=(NEW.command->>'postId')::uuid RETURNING id,decision_id) UPDATE whaleu_community.content_approval_heads h SET event_id=changed.id FROM changed WHERE h.decision_id=changed.decision_id",

          "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=(NEW.command->>'postId')::uuid",
          'UPDATE whaleu_community.spaces SET is_active=false WHERE id=(SELECT space_id FROM whaleu_community.post_pin_scopes WHERE id=NEW.scope_id)',
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=NEW.actor_id WHERE id=NEW.grant_id',
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
        ];
        for (const change of changes) {
          const q = command();
          await f.pool.query(
            'CREATE FUNCTION whaleu_community.pin_test_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              change +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_pin_test_change AFTER INSERT ON whaleu_community.post_pin_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.pin_test_change()',
          );
          try {
            const r = await send(q);
            assert.ok(
              [401, 403, 503].includes(r.status),
              JSON.stringify(r.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.post_pin_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_community.post_pins WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_pin_test_change ON whaleu_community.post_pin_commands;DROP FUNCTION whaleu_community.pin_test_change()',
            );
          }
        }
      },
    );
    await t.test(
      'real deferred wait crosses exact grant/session/phone/Safety and pin expiry without committing stale authority',
      async () => {
        await f.pool.query(
          'CREATE FUNCTION whaleu_community.pin_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_pin_test_wait AFTER INSERT ON whaleu_community.post_pin_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.pin_test_wait()',
        );
        try {
          for (const kind of [
            'grant',
            'session',
            'token',
            'phone',
            'safety',
            'pin',
            'review',
          ]) {
            const actor = await f.actor();
            await f.grant(
              actor.accountId,
              'super_admin',
              null,
              kind === 'grant' ? new Date(Date.now() + 400) : null,
            );
            const q = command(
              kind === 'review'
                ? (
                    await f.publish(
                      author,
                      f.scope.home.spaceId,
                      'discussion',
                      { visibilityUntil: new Date(Date.now() + 600) },
                    )
                  ).id
                : post.id,
            );
            if (kind === 'session')
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '400 milliseconds',refresh_expires_at=clock_timestamp()+interval '400 milliseconds',absolute_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
                [actor.sessionId],
              );
            if (kind === 'token')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE session_id=$1",
                [actor.sessionId],
              );
            if (kind === 'phone')
              await f.certify(actor.accountId, {
                expiresAt: new Date(Date.now() + 400),
              });
            if (kind === 'safety')
              await f.pool.query(
                "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '400 milliseconds' WHERE account_id=$1",
                [actor.accountId],
              );
            if (kind === 'pin')
              await f.pool.query(
                "CREATE FUNCTION whaleu_community.pin_test_short() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.pinned_until:=clock_timestamp()+interval '400 milliseconds';NEW.pinned_at:=NEW.pinned_until-NEW.duration_hours*interval '1 hour';RETURN NEW;END$$;CREATE TRIGGER a_pin_test_short BEFORE INSERT ON whaleu_community.post_pins FOR EACH ROW EXECUTE FUNCTION whaleu_community.pin_test_short()",
              );
            try {
              const r = await send(q, actor);
              assert.ok(
                [401, 403, 409, 503].includes(r.status),
                JSON.stringify({ kind, ...r.body }),
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.post_pin_commands WHERE request_id=$1',
                    [q.clientRequestId],
                  )
                ).rowCount,
                0,
              );
            } finally {
              if (kind === 'pin')
                await f.pool.query(
                  'DROP TRIGGER a_pin_test_short ON whaleu_community.post_pins;DROP FUNCTION whaleu_community.pin_test_short()',
                );
            }
          }
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_pin_test_wait ON whaleu_community.post_pin_commands;DROP FUNCTION whaleu_community.pin_test_wait()',
          );
        }
      },
    );
    await t.test(
      'expired authority after waiting for the actual scope mutex is rechecked, and deletion/renewal/read races terminate',
      async () => {
        const actor = await f.actor();
        await f.grant(
          actor.accountId,
          'super_admin',
          null,
          new Date(Date.now() + 700),
        );
        const lock = await f.pool.connect();
        await lock.query('BEGIN');
        await lock.query('SELECT whaleu_community.post_pin_lock($1)', [scope]);
        const q = command();
        const waiting = send(q, actor).then((r) => r);
        const slotWaiting = request(f.app.getHttpServer())
          .get('/v1/community/post-pin-slot')
          .query({ spaceId: f.scope.home.spaceId })
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .then((r) => r);
        await f.waitForLock('whaleu:post-pin-slot');
        await lock.query('SELECT pg_sleep(0.9)');
        await lock.query('COMMIT');
        lock.release();
        ok(await waiting, 403);
        ok(await slotWaiting, 403);
        const r = await send(command());
        ok(r);
        const outcomes = await Promise.all([
          send(command()),
          send(
            {
              operation: 'read',
              postId: post.id,
              pinId: r.body.pinId,
              clientRequestId: randomUUID(),
            },
            author,
          ),
          request(f.app.getHttpServer())
            .delete('/v1/community/posts/' + post.id)
            .set('Authorization', `Bearer ${author.accessToken}`),
        ]);
        assert.ok(
          outcomes.every((x) => [200, 204, 404, 503].includes(x.status)),
          JSON.stringify(outcomes.map((x) => x.body)),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at IS NOT NULL AS deleted FROM whaleu_community.posts WHERE id=$1',
              [post.id],
            )
          ).rows[0].deleted,
          true,
        );
      },
    );
    await t.test(
      'current accepted history and topic expiry are enforced after final waits',
      async () => {
        const p = await f.publish(author, f.scope.foreign.spaceId);
        await f.bind(
          f.scope.foreign.spaceId,
          'regional',
          f.scope.foreign.regionId,
          'accepted_empty',
          new Date(Date.now() + 500),
        );
        await f.pool.query(
          'CREATE FUNCTION whaleu_community.pin_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_pin_test_wait AFTER INSERT ON whaleu_community.post_pin_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.pin_test_wait()',
        );
        try {
          const q = command(p.id),
            r = await send(q);
          ok(r, 503);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_pin_commands WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rowCount,
            0,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_pin_test_wait ON whaleu_community.post_pin_commands;DROP FUNCTION whaleu_community.pin_test_wait()',
          );
        }
      },
    );
  },
);
