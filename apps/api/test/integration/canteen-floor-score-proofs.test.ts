import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  floorRatingFixture,
  floorHistory,
} from '../support/canteen-floor-score-fixture.js';
import { FloorRepository } from '../../src/ratings/canteen-floors/repository.js';
import { floorIntentHash } from '../../src/ratings/canteen-floors/service.js';
import { inTransaction } from '../../src/database/database.js';
const base = '/v1/ratings/canteen-floors';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'floor scores retain exact final owner proofs, raw causality and expiry after real deferred waits',
  { timeout: 240000 },
  async (t) => {
    const f = await floorRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      floor = f.add();
    let catalog = await f.accept([floor]);
    const get = () =>
      request(f.app.getHttpServer())
        .get(base + '/' + floor.floorId)
        .set('Authorization', 'Bearer ' + actor.accessToken);
    const post = (q: object, a = actor) =>
      request(f.app.getHttpServer())
        .post(base + '/' + floor.floorId + '/first-score')
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(q);
    await t.test(
      'external queued topology/history writers after real detail reads fail bounded NOWAIT proof',
      async () => {
        const unrelated = await f.actor();
        for (const sql of [
          `UPDATE whaleu_identity.sessions SET access_expires_at=access_expires_at WHERE id='${unrelated.sessionId}'`,
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
          'UPDATE whaleu_ratings.floor_history_heads SET assertion_id=assertion_id',
        ]) {
          const owner = f.app.get(FloorRepository),
            original = owner.detail.bind(owner),
            writer = await f.pool.connect();
          let entered!: () => void, release!: () => void;
          const ready = new Promise<void>((r) => (entered = r)),
            hold = new Promise<void>((r) => (release = r));
          owner.detail = async (...args) => {
            const result = await original(...args);
            entered();
            await hold;
            return result;
          };
          try {
            const reading = get().then((r) => r);
            await ready;
            await writer.query('BEGIN');
            await writer.query(sql);
            release();
            ok(await reading, 503);
          } finally {
            release();
            await writer.query('ROLLBACK');
            writer.release();
            owner.detail = original;
          }
        }
      },
    );
    await t.test(
      'floor history exact microsecond boundaries, source+deadline one instant, future activation never fabricates known absence',
      async () => {
        const row = (
          await f.pool.query(
            `SELECT whaleu_ratings.floor_history($1,a.accepted_at-interval '1 microsecond') IS NULL before,whaleu_ratings.floor_history($1,a.accepted_at)=a.id accepted,whaleu_ratings.floor_history($1,a.valid_until) IS NULL expired FROM whaleu_ratings.floor_history_heads h JOIN whaleu_ratings.floor_history_assertions a ON a.id=h.assertion_id WHERE h.floor_id=$1`,
            [floor.floorId],
          )
        ).rows[0];
        assert.deepEqual(row, { before: true, accepted: true, expired: true });
        await f.pool.query(
          `ALTER FUNCTION whaleu_ratings.floor_source(uuid,timestamptz) RENAME TO f4_original_source;CREATE FUNCTION whaleu_ratings.floor_source(fid uuid,instant timestamptz) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$DECLARE value jsonb;BEGIN value:=whaleu_ratings.f4_original_source(fid,instant);PERFORM pg_sleep(0.6);RETURN value;END$$`,
        );
        try {
          await floorHistory(
            f.pool,
            floor.floorId,
            'accepted_empty',
            new Date(Date.now() + 300),
          );
          ok(await get(), 503);
          await floorHistory(
            f.pool,
            floor.floorId,
            'accepted_empty',
            new Date(Date.now() + 3600000),
            new Date(Date.now() + 300),
          );
          ok(await get(), 503);
        } finally {
          await f.pool.query(
            'DROP FUNCTION whaleu_ratings.floor_source(uuid,timestamptz);ALTER FUNCTION whaleu_ratings.f4_original_source(uuid,timestamptz) RENAME TO floor_source',
          );
          await floorHistory(f.pool, floor.floorId, 'accepted_empty');
        }
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            client.query('SELECT whaleu_ratings.floor_fence()'),
          );
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );
    await t.test(
      'deferred source/parent/floor/remap/session/phone/Safety changes roll back publication, receipt and active head',
      async () => {
        const inactiveParent = await f.accept([
            { ...floor, parentActive: false },
          ]),
          inactiveFloor = await f.accept([{ ...floor, floorActive: false }]);
        await f.pool.query(
          'UPDATE whaleu_ratings.window_catalog_head SET catalog_id=$1',
          [catalog],
        );
        const cases = [
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
          `UPDATE whaleu_ratings.window_catalog_head SET catalog_id='${inactiveParent}'`,
          `UPDATE whaleu_ratings.window_catalog_head SET catalog_id='${inactiveFloor}'`,
          `UPDATE whaleu_campus.campuses SET is_active=false WHERE id='${floor.campusId}'`,
          `UPDATE whaleu_campus.campus_region_assignments SET operating_region_id='${f.scope.related.regionId}' WHERE campus_id='${floor.campusId}'`,
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
          'phone',
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
        ];
        for (let sql of cases) {
          const a = await f.actor({
              affiliation: 'unverified',
              identity: false,
            }),
            q = f.command(catalog, floor, { score: 1.25 });
          if (sql === 'phone') {
            const snapshot = randomUUID();
            sql = `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) SELECT '${snapshot}',h.account_id,h.revision+1,s.affiliation_assertion_id,s.student_number_assertion_id,NULL,s.application_state,s.application_coverage FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=NEW.actor_id;INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) SELECT '${randomUUID()}',account_id,'${randomUUID()}','reconciled_snapshot',account_id,revision,'${snapshot}',revision+1,'synthetic_fixture' FROM whaleu_verification.account_heads WHERE account_id=NEW.actor_id;UPDATE whaleu_verification.account_heads SET revision=revision+1,snapshot_id='${snapshot}' WHERE account_id=NEW.actor_id`;
          }
          await f.pool.query(
            'CREATE FUNCTION whaleu_ratings.f4_test_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              sql +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_f4_test_change AFTER INSERT ON whaleu_ratings.floor_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.f4_test_change()',
          );
          try {
            const r = await post(q, a);
            assert.ok(
              [401, 403, 409, 503].includes(r.status),
              JSON.stringify(r.body),
            );
            for (const table of ['floor_commands', 'floor_score_events'])
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT 1 FROM whaleu_ratings.${table} WHERE request_id=$1`,
                    [q.clientRequestId],
                  )
                ).rowCount,
                0,
              );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.floor_score_heads WHERE actor_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_f4_test_change ON whaleu_ratings.floor_commands;DROP FUNCTION whaleu_ratings.f4_test_change()',
            );
          }
        }
      },
    );
    await t.test(
      'all final session/phone/Safety/source/history deadlines survive actual deferred wait and rollback atomically',
      async () => {
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.f4_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_f4_test_wait AFTER INSERT ON whaleu_ratings.floor_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.f4_test_wait()',
        );
        try {
          for (const kind of [
            'phone',
            'history',
            'catalog',
            'session',
            'safety',
          ]) {
            const a = await f.actor({
                affiliation: 'unverified',
                identity: false,
              }),
              q = f.command(catalog, floor);
            if (kind === 'session')
              await f.pool.query(
                "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
                [a.sessionId],
              );
            if (kind === 'safety')
              await f.pool.query(
                "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '400 milliseconds' WHERE account_id=$1",
                [a.accountId],
              );
            if (kind === 'phone')
              await f.certify(a.accountId, {
                phone: 'verified',
                affiliation: 'unverified',
                identity: false,
                expiresAt: new Date(Date.now() + 400),
              });
            if (kind === 'history')
              await floorHistory(
                f.pool,
                floor.floorId,
                'accepted_empty',
                new Date(Date.now() + 400),
              );
            if (kind === 'catalog') {
              catalog = await f.accept([floor], {
                validUntil: new Date(Date.now() + 400),
              });
              q.expectedCatalogRevision = catalog;
            }
            const denied = await post(q, a);
            assert.ok(
              [401, 503].includes(denied.status),
              JSON.stringify(denied.body),
            );
            for (const table of ['floor_commands', 'floor_score_events'])
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT 1 FROM whaleu_ratings.${table} WHERE request_id=$1`,
                    [q.clientRequestId],
                  )
                ).rowCount,
                0,
              );
            if (kind === 'history')
              await floorHistory(f.pool, floor.floorId, 'accepted_empty');
            if (kind === 'catalog') catalog = await f.accept([floor]);
          }
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_f4_test_wait ON whaleu_ratings.floor_commands;DROP FUNCTION whaleu_ratings.f4_test_wait()',
          );
        }
      },
    );
    await t.test(
      'fresh cancellation retains current session after every deferred wait while source/phone/Safety stay irrelevant',
      async () => {
        for (const sql of [
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
          'DELETE FROM whaleu_identity.access_tokens WHERE session_id=NEW.session_id',
          "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '1 minute' WHERE id=NEW.session_id",
        ]) {
          const a = await f.actor(),
            q = f.command(catalog, floor);
          await f.pool.query(
            'CREATE FUNCTION whaleu_ratings.f4_cancel_revoke() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              sql +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_f4_cancel_revoke AFTER INSERT ON whaleu_ratings.floor_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.f4_cancel_revoke()',
          );
          try {
            const r = await request(f.app.getHttpServer())
              .post(base + '/requests/' + q.clientRequestId + '/cancel')
              .set('Authorization', 'Bearer ' + a.accessToken)
              .send({ floorId: floor.floorId, command: q });
            assert.ok([401, 503].includes(r.status), JSON.stringify(r.body));
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.floor_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_f4_cancel_revoke ON whaleu_ratings.floor_commands;DROP FUNCTION whaleu_ratings.f4_cancel_revoke()',
            );
          }
        }
      },
    );
    await t.test(
      'cancel exact session access expiry after deferred sleep rolls back even while presented token remains valid',
      async () => {
        const a = await f.actor(),
          q = f.command(catalog, floor);
        await f.pool.query(
          "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
          [a.sessionId],
        );
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.f4_cancel_sleep() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.8);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_f4_cancel_sleep AFTER INSERT ON whaleu_ratings.floor_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.f4_cancel_sleep()',
        );
        try {
          const r = await request(f.app.getHttpServer())
            .post(base + '/requests/' + q.clientRequestId + '/cancel')
            .set('Authorization', 'Bearer ' + a.accessToken)
            .send({ floorId: floor.floorId, command: q });
          assert.ok([401, 503].includes(r.status), JSON.stringify(r.body));
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.floor_commands WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rowCount,
            0,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_f4_cancel_sleep ON whaleu_ratings.floor_commands;DROP FUNCTION whaleu_ratings.f4_cancel_sleep()',
          );
        }
      },
    );
    await t.test(
      'raw event/head/receipt must form exact publication and timestamp; wrong source, same-tx fake already-rated and absent event reject',
      async () => {
        for (const mode of [
          'valid',
          'no-head',
          'wrong-score',
          'wrong-time',
          'wrong-source',
          'no-event',
          'fake-already',
        ]) {
          const a = await f.actor(),
            q = f.command(catalog, floor, { score: 1.25 }),
            revision = randomUUID();
          const operation = () =>
            inTransaction(f.pool, async (tx) => {
              const source = (
                await tx.query<{ source: { history: string } }>(
                  'SELECT whaleu_ratings.floor_source($1,clock_timestamp()) source',
                  [floor.floorId],
                )
              ).rows[0]!.source;
              let time = new Date().toISOString();
              if (mode !== 'no-event') {
                const e = (
                  await tx.query<{ recorded_at: Date }>(
                    'INSERT INTO whaleu_ratings.floor_score_events(id,floor_id,actor_id,request_id,catalog_id,canteen_revision,history_assertion_id,score) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING recorded_at',
                    [
                      revision,
                      floor.floorId,
                      a.accountId,
                      q.clientRequestId,
                      catalog,
                      mode === 'wrong-source'
                        ? randomUUID()
                        : floor.canteenRevision,
                      source.history,
                      mode === 'wrong-score' ? 4.75 : 1.25,
                    ],
                  )
                ).rows[0]!;
                time = e.recorded_at.toISOString();
                if (mode !== 'no-head')
                  await tx.query(
                    'INSERT INTO whaleu_ratings.floor_score_heads(floor_id,actor_id,revision) VALUES($1,$2,$3)',
                    [floor.floorId, a.accountId, revision],
                  );
              }
              const receipt =
                mode === 'fake-already'
                  ? {
                      requestId: q.clientRequestId,
                      operation: 'floor.score.first.v1',
                      floorId: floor.floorId,
                      outcome: 'rejected',
                      code: 'FLOOR_ALREADY_RATED',
                    }
                  : {
                      requestId: q.clientRequestId,
                      operation: 'floor.score.first.v1',
                      floorId: floor.floorId,
                      outcome: 'applied',
                      score: 1.25,
                      scoreRevision: revision,
                      recordedAt:
                        mode === 'wrong-time'
                          ? time.replace('Z', '+00:00')
                          : time,
                    };
              await tx.query(
                'INSERT INTO whaleu_ratings.floor_commands(actor_id,request_id,session_id,floor_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                  a.accountId,
                  q.clientRequestId,
                  a.sessionId,
                  floor.floorId,
                  q,
                  floorIntentHash(a.accountId, floor.floorId, q),
                  receipt,
                ],
              );
            });
          if (mode === 'valid') await operation();
          else await assert.rejects(operation());
        }
      },
    );
  },
);
