import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { initializeNativeVerificationAccount } from '../../src/verification/lifecycle.js';
import { VerificationRepository } from '../../src/verification/verification.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { maintenanceFixture } from '../support/title-maintenance-fixture.js';

const appId = 'synthetic-native-enrollment-only';
async function fresh(tx: PoolClient) {
  const id = randomUUID();
  await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [id]);
  await tx.query(
    "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat',$1,$2,$3)",
    [appId, randomUUID(), id],
  );
  return id;
}

test(
  'native verification cause: current creation, no history, no legacy, atomic covered absence',
  { timeout: 120000 },
  async (t) => {
    const f = await maintenanceFixture({ nativeVerificationEnrollment: true });
    const records = new VerificationRepository();
    try {
      await t.test(
        'real identity creation and repeated login issue only one absence event',
        async () => {
          const identity = {
            provider: 'wechat' as const,
            appId,
            subject: randomUUID(),
          };
          const login = () =>
            f.identity.createSession(identity, {
              access: hashToken(mintToken('access')),
              refresh: hashToken(mintToken('refresh')),
            });
          const owner = await login();
          const repeated = await login();
          assert.equal(owner.accountId, repeated.accountId);
          const summary = await inTransaction(
            f.pool,
            async (tx) => (await records.read(owner.accountId, tx)).summary,
          );
          assert.deepEqual(summary, {
            affiliation: { status: 'unverified' },
            studentNumber: { status: 'unverified' },
            phone: { status: 'unverified' },
            application: { status: 'none' },
          });
          const events = await f.pool.query(
            'SELECT kind FROM whaleu_verification.events WHERE account_id=$1',
            [owner.accountId],
          );
          assert.deepEqual(events.rows, [{ kind: 'native_enrollment' }]);
          const values = await f.pool.query(
            'SELECT student_number,phone_binding_reference,verified_at FROM whaleu_verification.assertions WHERE account_id=$1',
            [owner.accountId],
          );
          assert.equal(values.rowCount, 3);
          assert.ok(
            values.rows.every(
              (r) =>
                r.student_number === null &&
                r.phone_binding_reference === null &&
                r.verified_at === null,
            ),
          );
        },
      );
      await t.test(
        'old account with provider and missing records remains unknown',
        async () => {
          const owner = await inTransaction(f.pool, fresh);
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              initializeNativeVerificationAccount(owner, appId, tx),
            ),
            /fresh identity creation/,
          );
          const summary = await inTransaction(
            f.pool,
            async (tx) => (await records.read(owner, tx)).summary,
          );
          assert.equal(summary.phone.status, 'unavailable');
          assert.equal(summary.affiliation.status, 'unavailable');
          const subject = (
            await f.pool.query<{ subject: string }>(
              'SELECT subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [owner],
            )
          ).rows[0]!.subject;
          const login = await f.identity.createSession(
            { provider: 'wechat', appId, subject },
            {
              access: hashToken(mintToken('access')),
              refresh: hashToken(mintToken('refresh')),
            },
          );
          assert.equal(login.accountId, owner);
          assert.equal(
            (
              await f.pool.query(
                'SELECT account_id FROM whaleu_verification.native_enrollments WHERE account_id=$1',
                [owner],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_identity.accounts SET local_creation_transaction=pg_current_xact_id() WHERE id=$1',
              [owner],
            ),
            /provenance is immutable/,
          );
        },
      );
      await t.test(
        'a partial marker alone cannot commit covered absence',
        async () => {
          let owner = '';
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              owner = await fresh(tx);
              await tx.query(
                `INSERT INTO whaleu_verification.native_enrollments
          (account_id,app_id,operation_id,affiliation_id,student_number_id,phone_id,snapshot_id,event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                  owner,
                  appId,
                  randomUUID(),
                  randomUUID(),
                  randomUUID(),
                  randomUUID(),
                  randomUUID(),
                  randomUUID(),
                ],
              );
            }),
            /incomplete/,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_identity.accounts WHERE id=$1',
                [owner],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'fresh account with existing history cannot enroll',
        async () => {
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              const owner = await fresh(tx);
              await tx.query(
                'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
                [owner],
              );
              await initializeNativeVerificationAccount(owner, appId, tx);
            }),
            /fresh identity creation/,
          );
        },
      );
      await t.test(
        'legacy mapping before or after enrollment rejects and rolls back',
        async () => {
          for (const before of [true, false]) {
            let owner = '';
            await assert.rejects(
              inTransaction(f.pool, async (tx) => {
                owner = await fresh(tx);
                const map = () =>
                  tx.query(
                    "INSERT INTO whaleu_identity.legacy_account_mappings(source_system,legacy_id,account_id) VALUES('synthetic',$1,$2)",
                    [randomUUID(), owner],
                  );
                if (before) await map();
                await initializeNativeVerificationAccount(owner, appId, tx);
                if (!before) await map();
              }),
              /fresh identity creation|conflicting history/,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT id FROM whaleu_identity.accounts WHERE id=$1',
                  [owner],
                )
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test('missing or removed provider cause rejects', async () => {
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            const owner = randomUUID();
            await tx.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [owner],
            );
            await initializeNativeVerificationAccount(owner, appId, tx);
          }),
          /fresh identity creation/,
        );
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            const owner = await fresh(tx);
            await initializeNativeVerificationAccount(owner, appId, tx);
            await tx.query(
              'DELETE FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [owner],
            );
          }),
          /conflicting history/,
        );
      });
      await t.test(
        'native source cannot later manufacture verified or another absence',
        async () => {
          const owner = await inTransaction(f.pool, async (tx) => {
            const id = await fresh(tx);
            await initializeNativeVerificationAccount(id, appId, tx);
            return id;
          });
          for (const state of ['verified', 'unverified'])
            await assert.rejects(
              f.pool.query(
                `INSERT INTO whaleu_verification.assertions
          (id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,expiry_kind)
          VALUES($1,$2,'phone',$3,'complete','accepted','native_enrollment',$4,'native-account-absence/v1',$2,'policy_exempt')`,
                [randomUUID(), owner, state, `native_enrollment:${owner}`],
              ),
              /covered absence/,
            );
        },
      );
    } finally {
      await f.close();
    }
  },
);
