import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  hold,
  maintenanceFixture,
  release,
} from '../support/title-maintenance-fixture.js';

test(
  'real PostgreSQL maintenance locks, transaction deadlines and concurrent one-owner repairs',
  { timeout: 120000 },
  async (t) => {
    const f = await maintenanceFixture();
    try {
      const target = await f.account({ balance: 39n });
      const actor = await f.actor();
      await f.grant(actor.accountId, 'developer');
      const start = () => ({
        requestId: randomUUID(),
        operation: 'repair_level_titles',
      });
      await t.test(
        'independent sweeps serialize on one owner without duplicate grants',
        async () => {
          let held = await hold(
            f.pool,
            'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
            [target.id],
          );
          const a = start(),
            b = start();
          const first = f.batch(actor.accessToken, a).then((r) => r),
            second = f.batch(actor.accessToken, b).then((r) => r);
          try {
            await f.waitForLock('whaleu_experience.owners');
            await release(held);
            held = undefined!;
            const results = await Promise.all([first, second]);
            assert.deepEqual(
              results.map((r) => r.status),
              [200, 200],
            );
            assert.equal(
              results.reduce((n, r) => n + r.body.grantedTitles, 0),
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='level_1'",
                  [target.id],
                )
              ).rowCount,
              1,
            );
          } finally {
            await release(held);
            await Promise.all([first, second]);
          }
        },
      );
      await t.test(
        'same request concurrent replay returns one receipt; competing successors consume predecessor once',
        async () => {
          const input = start();
          const results = await Promise.all([
            f.batch(actor.accessToken, input),
            f.batch(actor.accessToken, input),
          ]);
          assert.deepEqual(
            results.map((r) => r.status),
            [200, 200],
          );
          assert.deepEqual(results[0]!.body, results[1]!.body);
          const next = [
            { requestId: randomUUID(), previousRequestId: input.requestId },
            { requestId: randomUUID(), previousRequestId: input.requestId },
          ];
          const branches = await Promise.all(
            next.map((body) => f.batch(actor.accessToken, body)),
          );
          assert.deepEqual(branches.map((r) => r.status).sort(), [200, 409]);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_experience.maintenance_requests WHERE actor_id=$1 AND previous_request_id=$2',
                [actor.accountId, input.requestId],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'settlement and maintenance share the terminal owner lock and do not duplicate threshold grants',
        async () => {
          const token = mintToken('access');
          await f.identity.createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-maintenance-only',
              subject: target.subject,
            },
            {
              access: hashToken(token),
              refresh: hashToken(mintToken('refresh')),
            },
          );
          let held = await hold(
            f.pool,
            'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
            [target.id],
          );
          const repair = f.batch(actor.accessToken, start()).then((r) => r);
          const signin = request(f.app.getHttpServer())
            .post('/v1/me/experience/sign-in')
            .set('Authorization', `Bearer ${token}`)
            .send({ requestId: randomUUID() })
            .then((r) => r);
          try {
            await f.waitForLock('whaleu_experience.owners');
            await release(held);
            held = undefined!;
            const results = await Promise.all([repair, signin]);
            assert.deepEqual(
              results.map((r) => r.status),
              [200, 200],
            );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='level_3'",
                  [target.id],
                )
              ).rowCount,
              1,
            );
          } finally {
            await release(held);
            await Promise.all([repair, signin]);
          }
        },
      );
      await t.test(
        'two administrators targeting one another keep account locks compatible',
        async () => {
          const other = await f.actor();
          await f.grant(other.accountId, 'super_admin');
          const ids = (
            await f.pool.query<{ id: string }>(
              'SELECT id FROM whaleu_identity.accounts ORDER BY id',
            )
          ).rows.map((row) => row.id);
          async function stopBefore(token: string, targetId: string) {
            const before = ids[ids.indexOf(targetId) - 1];
            assert.ok(before);
            let input: object = start();
            for (let guard = 0; guard < ids.length; guard++) {
              const receipt = (await f.batch(token, input).expect(200)).body;
              const row = (
                await f.pool.query(
                  'SELECT cursor_after FROM whaleu_experience.maintenance_requests WHERE request_id=$1',
                  [receipt.requestId],
                )
              ).rows[0]!;
              if (row.cursor_after === before)
                return {
                  requestId: randomUUID(),
                  previousRequestId: receipt.requestId,
                };
              input = {
                requestId: randomUUID(),
                previousRequestId: receipt.requestId,
              };
            }
            assert.fail('Missing predecessor for cross-target fixture');
          }
          const firstInput = await stopBefore(
              actor.accessToken,
              other.accountId,
            ),
            secondInput = await stopBefore(other.accessToken, actor.accountId);
          let held = await hold(
            f.pool,
            'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=ANY($1::uuid[]) ORDER BY owner_id FOR UPDATE',
            [[actor.accountId, other.accountId]],
          );
          const first = f.batch(actor.accessToken, firstInput).then((r) => r),
            second = f.batch(other.accessToken, secondInput).then((r) => r);
          try {
            await f.waitForLock('whaleu_experience.owners');
            await release(held);
            held = undefined!;
            assert.deepEqual(
              (await Promise.all([first, second])).map((r) => r.status),
              [200, 200],
            );
          } finally {
            await release(held);
            await Promise.all([first, second]);
          }
        },
      );
      await t.test(
        'a locked candidate times out without permanent cursor progress and is repaired on retry',
        async () => {
          let held = await hold(
            f.pool,
            'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
            [target.id],
          );
          const input = start(),
            pending = f.batch(actor.accessToken, input).then((r) => r);
          try {
            await f.waitForLock('whaleu_experience.owners');
            const failed = await pending;
            assert.equal(failed.status, 503);
            await f.rollbackRows(input.requestId);
            await release(held);
            held = undefined!;
            const retried = await f.batch(actor.accessToken, input).expect(200);
            assert.equal(retried.body.visited, 1);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT owner_id FROM whaleu_experience.maintenance_items WHERE request_id=$1',
                  [input.requestId],
                )
              ).rows[0]!.owner_id,
              target.id,
            );
          } finally {
            await release(held);
            await pending;
          }
        },
      );
      for (const stage of ['grant', 'request', 'owner', 'deferred'] as const)
        await t.test(
          `authority expiry during observed ${stage} lock wait rolls back the whole batch`,
          async () => {
            const who = await f.actor(),
              expiresAt = new Date(Date.now() + 1500);
            const grant = await f.grant(who.accountId, 'developer', {
              expiresAt,
            });
            const input = {
              requestId: randomUUID(),
              operation: 'repair_default_title',
            };
            let held;
            if (stage === 'grant')
              held = await hold(
                f.pool,
                'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR UPDATE',
                [grant],
              );
            if (stage === 'request')
              held = await hold(
                f.pool,
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [
                  JSON.stringify([
                    'experience-title-maintenance',
                    who.accountId,
                    input.requestId,
                  ]),
                ],
              );
            if (stage === 'owner')
              held = await hold(
                f.pool,
                'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
                [target.id],
              );
            if (stage === 'deferred') {
              await f.pool.query(
                `CREATE OR REPLACE FUNCTION whaleu_maintenance_test.pause_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(72525,41); RETURN NEW; END $$`,
              );
              await f.pool.query(
                'CREATE CONSTRAINT TRIGGER test_maintenance_pause AFTER INSERT ON whaleu_experience.maintenance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.pause_proof()',
              );
              held = await hold(
                f.pool,
                'SELECT pg_advisory_xact_lock(72525,41)',
              );
            }
            const pending = f.batch(who.accessToken, input).then((r) => r);
            try {
              await f.waitForLock(
                stage === 'grant'
                  ? 'FROM whaleu_authorization.role_grants'
                  : stage === 'request'
                    ? 'hashtextextended'
                    : stage === 'owner'
                      ? 'whaleu_experience.owners'
                      : 'SET CONSTRAINTS',
              );
              await held!.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.03)',
                [expiresAt],
              );
              await release(held);
              held = undefined;
              const result = await pending;
              assert.ok(
                [403, 503].includes(result.status),
                `${stage}: ${result.status} ${JSON.stringify(result.body)}`,
              );
              await f.rollbackRows(input.requestId);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_experience.entitlements WHERE maintenance_request_id=$1',
                    [input.requestId],
                  )
                ).rowCount,
                0,
              );
            } finally {
              await release(held);
              await pending;
              if (stage === 'deferred')
                await f.pool.query(
                  'DROP TRIGGER test_maintenance_pause ON whaleu_experience.maintenance_requests',
                );
            }
          },
        );
      await t.test(
        'session expiry during deferred proof wait is checked after constraints, not only at entry',
        async () => {
          const who = await f.actor();
          await f.grant(who.accountId, 'super_admin');
          const expiresAt = new Date(Date.now() + 1500);
          await f.pool.query(
            'UPDATE whaleu_identity.sessions SET access_expires_at=$2 WHERE id=$1',
            [who.sessionId, expiresAt],
          );
          await f.pool.query(
            'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
            [who.sessionId, expiresAt],
          );
          await f.pool.query(
            'CREATE CONSTRAINT TRIGGER test_maintenance_pause AFTER INSERT ON whaleu_experience.maintenance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.pause_proof()',
          );
          let held = await hold(
            f.pool,
            'SELECT pg_advisory_xact_lock(72525,41)',
          );
          const input = {
              requestId: randomUUID(),
              operation: 'repair_default_title',
            },
            pending = f.batch(who.accessToken, input).then((r) => r);
          try {
            await f.waitForLock('SET CONSTRAINTS');
            await held.query(
              'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.03)',
              [expiresAt],
            );
            await release(held);
            held = undefined!;
            const result = await pending;
            assert.equal(result.status, 401);
            await f.rollbackRows(input.requestId);
          } finally {
            await release(held);
            await pending;
            await f.pool.query(
              'DROP TRIGGER test_maintenance_pause ON whaleu_experience.maintenance_requests',
            );
          }
        },
      );
      for (const stage of ['request', 'owner'] as const)
        await t.test(
          `session expiry during observed ${stage} wait rolls back without a receipt`,
          async () => {
            const who = await f.actor();
            await f.grant(who.accountId, 'developer');
            const expiresAt = new Date(Date.now() + 1500);
            await f.pool.query(
              'UPDATE whaleu_identity.sessions SET access_expires_at=$2 WHERE id=$1',
              [who.sessionId, expiresAt],
            );
            await f.pool.query(
              'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
              [who.sessionId, expiresAt],
            );
            const input = {
              requestId: randomUUID(),
              operation: 'repair_default_title',
            };
            let held =
              stage === 'request'
                ? await hold(
                    f.pool,
                    'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                    [
                      JSON.stringify([
                        'experience-title-maintenance',
                        who.accountId,
                        input.requestId,
                      ]),
                    ],
                  )
                : await hold(
                    f.pool,
                    'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
                    [target.id],
                  );
            const pending = f.batch(who.accessToken, input).then((r) => r);
            try {
              await f.waitForLock(
                stage === 'request'
                  ? 'hashtextextended'
                  : 'whaleu_experience.owners',
              );
              await held.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.03)',
                [expiresAt],
              );
              await release(held);
              held = undefined!;
              assert.equal((await pending).status, 401);
              await f.rollbackRows(input.requestId);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_experience.entitlements WHERE maintenance_request_id=$1',
                    [input.requestId],
                  )
                ).rowCount,
                0,
              );
            } finally {
              await release(held);
              await pending;
            }
          },
        );
      await t.test(
        'session revocation owning its lock first defeats a waiting request',
        async () => {
          const who = await f.actor();
          await f.grant(who.accountId, 'developer');
          let held = await hold(
            f.pool,
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [who.sessionId],
          );
          const input = start(),
            pending = f.batch(who.accessToken, input).then((r) => r);
          try {
            await f.waitForLock('whaleu_identity.sessions');
            await held.query('COMMIT');
            await release(held);
            held = undefined!;
            assert.equal((await pending).status, 401);
            await f.rollbackRows(input.requestId);
          } finally {
            await release(held);
            await pending;
          }
        },
      );
      for (const authority of ['grant', 'session'] as const)
        await t.test(
          `${authority} expiry while waiting for an already consumed predecessor hides successor metadata`,
          async () => {
            const who = await f.actor();
            const expiresAt = new Date(Date.now() + 1700);
            await f.grant(
              who.accountId,
              'developer',
              authority === 'grant' ? { expiresAt } : {},
            );
            const initial = start();
            await f.batch(who.accessToken, initial).expect(200);
            await f
              .batch(who.accessToken, {
                requestId: randomUUID(),
                previousRequestId: initial.requestId,
              })
              .expect(200);
            if (authority === 'session') {
              await f.pool.query(
                'UPDATE whaleu_identity.sessions SET access_expires_at=$2 WHERE id=$1',
                [who.sessionId, expiresAt],
              );
              await f.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
                [who.sessionId, expiresAt],
              );
            }
            let held = await hold(
              f.pool,
              'SELECT request_id FROM whaleu_experience.maintenance_requests WHERE actor_id=$1 AND request_id=$2 FOR UPDATE',
              [who.accountId, initial.requestId],
            );
            const input = {
              requestId: randomUUID(),
              previousRequestId: initial.requestId,
            };
            const pending = f.batch(who.accessToken, input).then((r) => r);
            try {
              await f.waitForLock(
                'FROM whaleu_experience.maintenance_requests',
              );
              await held.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.03)',
                [expiresAt],
              );
              await release(held);
              held = undefined!;
              const result = await pending;
              assert.equal(result.status, authority === 'session' ? 401 : 503);
              assert.equal(
                JSON.stringify(result.body).includes('successorRequestId'),
                false,
              );
              assert.equal(
                JSON.stringify(result.body).includes('CONTINUATION_CONFLICT'),
                false,
              );
              await f.rollbackRows(input.requestId);
            } finally {
              await release(held);
              await pending;
            }
          },
        );
      await t.test(
        'revocation owning the grant lock first defeats a waiting request',
        async () => {
          const who = await f.actor(),
            grant = await f.grant(who.accountId, 'developer');
          let held = await hold(
            f.pool,
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [grant, who.accountId],
          );
          const input = start(),
            pending = f.batch(who.accessToken, input).then((r) => r);
          try {
            await f.waitForLock('FROM whaleu_authorization.role_grants');
            await held.query('COMMIT');
            await release(held);
            held = undefined!;
            assert.equal((await pending).status, 403);
            await f.rollbackRows(input.requestId);
          } finally {
            await release(held);
            await pending;
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
