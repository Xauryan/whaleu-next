import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  syntheticAssertion,
  setSyntheticSnapshot,
} from '../support/verification-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { DmVerificationFacade } from '../../src/verification/dm-eligibility.facade.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { PublicProfileFacade } from '../../src/profile/public-profile.facade.js';
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

test('DM owner final proofs retain canonical expiry and negative lifecycle facts through genuine deferred PostgreSQL waits', async (t) => {
  const f = await directoryRuntimeFixture();
  t.after(() => f.close());
  const gate = [1537023, 7];
  await f.pool
    .query(`CREATE TABLE whaleu_messaging.synthetic_dm_owner_probe(id uuid PRIMARY KEY);
 CREATE FUNCTION whaleu_messaging.synthetic_dm_owner_wait() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM pg_advisory_xact_lock(1537023,7);RETURN NULL;END $$;
 CREATE CONSTRAINT TRIGGER synthetic_dm_owner_wait AFTER INSERT ON whaleu_messaging.synthetic_dm_owner_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_messaging.synthetic_dm_owner_wait();`);
  async function delayed(
    read: (tx: PoolClient) => Promise<void>,
    duringWait: () => Promise<void>,
    code: string,
  ) {
    const blocker = await f.pool.connect(),
      probe = randomUUID();
    let pending: Promise<void> | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock($1,$2)', gate);
      pending = inTransaction(
        f.pool,
        async (tx) => {
          await tx.query('SAVEPOINT dm_owner_read');
          await read(tx);
          // Roll back only the read's ordinary locks. Required owner evidence remains
          // in the transaction registry exactly as a terminal DM rejection retains it.
          await tx.query('ROLLBACK TO SAVEPOINT dm_owner_read');
          await tx.query('RELEASE SAVEPOINT dm_owner_read');
          await tx.query(
            'INSERT INTO whaleu_messaging.synthetic_dm_owner_probe(id) VALUES($1)',
            [probe],
          );
        },
        { isolationLevel: 'read committed' },
      );
      void pending.catch(() => undefined);
      await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
      await duringWait();
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1,$2)', gate);
      blocker.release();
    }
    assert.ok(pending);
    await assert.rejects(pending, errorIs(code));
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_messaging.synthetic_dm_owner_probe WHERE id=$1',
          [probe],
        )
      ).rowCount,
      0,
      'Expired/changed authority rolls back the tentative receipt-equivalent write',
    );
  }
  await t.test(
    'canonical phone expires after the last source read during the actual deferred constraint gate',
    async () => {
      const actor = await f.actor({ identity: false });
      const now = (
        await f.pool.query<{ now: Date }>('SELECT clock_timestamp() now')
      ).rows[0]!.now;
      const expiry = new Date(now.getTime() + 2500);
      await setSyntheticSnapshot(f.pool, actor.accountId, [
        syntheticAssertion(
          actor.accountId,
          f.scope.institutionId,
          'affiliation',
          {
            origin_region_id: f.scope.home.regionId,
            expires_at: new Date(now.getTime() + 60000),
          },
        ),
        syntheticAssertion(actor.accountId, f.scope.institutionId, 'phone', {
          expires_at: expiry,
        }),
      ]);
      await delayed(
        (tx) =>
          f.app
            .get(DmVerificationFacade)
            .require(actor.accountId, tx, { phone: true }),
        async () => {
          // Wait until an exact database-time boundary, not an assumed wall-clock delay.
          await f.pool.query(
            'SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.005)',
            [expiry],
          );
          assert.equal(
            (
              await f.pool.query<{ expired: boolean }>(
                'SELECT clock_timestamp()>=$1::timestamptz expired',
                [expiry],
              )
            ).rows[0]!.expired,
            true,
          );
        },
        'VERIFICATION_UNAVAILABLE',
      );
    },
  );
  await t.test(
    'inactive peer activation after command rollback invalidates its retained negative Identity fact',
    async () => {
      const peer = await f.actor({ identity: false });
      await f.pool.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [peer.accountId],
      );
      await delayed(
        async (tx) => {
          assert.equal(
            await f.app
              .get(IdentityService)
              .dmActiveAccount(peer.accountId, tx),
            false,
          );
        },
        async () => {
          await f.pool.query(
            "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
            [peer.accountId],
          );
        },
        'DM_UNAVAILABLE',
      );
    },
  );
  await t.test(
    'a missing public profile appearing after command rollback invalidates source rejection evidence',
    async () => {
      const peer = await f.actor({ identity: false }),
        profileId = randomUUID();
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
            [peer.accountId],
          )
        ).rowCount,
        0,
      );
      await delayed(
        async (tx) => {
          assert.equal(
            await f.app.get(PublicProfileFacade).dmFind(profileId, tx),
            null,
          );
        },
        async () => {
          await f.pool.query(
            'INSERT INTO whaleu_profile.profiles(account_id,public_id) VALUES($1,$2)',
            [peer.accountId, profileId],
          );
        },
        'DM_UNAVAILABLE',
      );
    },
  );
});
