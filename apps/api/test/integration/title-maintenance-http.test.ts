import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inTransaction } from '../../src/database/database.js';
import { levelFor, thresholds, titles } from '../../src/experience/catalog.js';
import {
  grantSyntheticTitle,
  recordSyntheticHistory,
} from '../support/experience-fixtures.js';
import { maintenanceFixture } from '../support/title-maintenance-fixture.js';

test(
  'real AppModule title maintenance: bounded authorized repairs and immutable recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await maintenanceFixture();
    try {
      const developer = await f.actor(),
        superAdmin = await f.actor(),
        member = await f.actor(),
        school = await f.actor();
      const developerGrant = await f.grant(developer.accountId, 'developer');
      await f.grant(superAdmin.accountId, 'super_admin');
      const region = randomUUID();
      await f.pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic maintenance region',true)",
        [region],
      );
      await f.grant(school.accountId, 'school_admin', { regionId: region });
      const start = () => ({
        requestId: randomUUID(),
        operation: 'repair_level_titles',
      });
      await t.test(
        'guest, malformed token, member and school administrator fail closed',
        async () => {
          await f.batch(undefined, start()).expect(401);
          await f.batch('not-a-session', start()).expect(401);
          for (const who of [member, school]) {
            const input = start();
            await f.batch(who.accessToken, input).expect(403);
            await f.rollbackRows(input.requestId);
          }
          await f
            .batch(developer.accessToken, {
              ...start(),
              targetOwnerId: member.accountId,
            })
            .expect(400);
          await f
            .batch(developer.accessToken, { ...start(), titleKey: 'level_29' })
            .expect(400);
          await f
            .batch(developer.accessToken, {
              ...start(),
              cursor: member.accountId,
            })
            .expect(400);
          await f
            .batch(developer.accessToken, {
              ...start(),
              previousRequestId: randomUUID(),
            })
            .expect(400);
        },
      );
      const balances = [...thresholds.map(BigInt), 9223372036854775807n];
      const known: { id: string; subject: string; balance: bigint }[] = [];
      for (const balance of balances)
        known.push({ ...(await f.account({ balance })), balance });
      const unknown = await f.account(),
        withoutProvider = await f.account({ provider: false }),
        blocked = await f.account({ blocked: true });
      const preserved = known[0]!;
      await inTransaction(f.pool, async (tx) => {
        await grantSyntheticTitle(tx, preserved.id, 'level_29');
        await grantSyntheticTitle(tx, preserved.id, 'redeem_liangchenmeijing');
        await recordSyntheticHistory(tx, preserved.id, { action: 'publish' });
      });
      const original = (
        await f.pool.query(
          'SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1 ORDER BY title_key',
          [preserved.id],
        )
      ).rows;
      const before = (
        await f.pool.query(`SELECT
      (SELECT jsonb_agg(x ORDER BY owner_id) FROM whaleu_experience.account_states x) states,
      (SELECT jsonb_agg(x ORDER BY owner_id) FROM whaleu_experience.baselines x) baselines,
      (SELECT jsonb_agg(x ORDER BY id) FROM whaleu_experience.records x) records,
      (SELECT count(*) FROM whaleu_experience.appearance) appearance,
      (SELECT count(*) FROM whaleu_experience.unlock_notices) notices,
      (SELECT count(*) FROM whaleu_experience.settlements) settlements`)
      ).rows[0];
      await t.test(
        'known zero, every threshold and large bigint receive all eligible lower titles; unknowns remain unknown',
        async () => {
          const receipts = await f.sweep(
            developer.accessToken,
            'repair_level_titles',
          );
          assert.ok(receipts.length > 1);
          for (const [index, r] of receipts.entries()) {
            assert.deepEqual(
              Object.keys(r).sort(),
              [
                'requestId',
                'operation',
                'runId',
                'previousRequestId',
                'visited',
                'updatedOwners',
                'grantedTitles',
                'skippedUnknownLevel',
                'skippedIneligible',
                'done',
              ].sort(),
            );
            assert.ok(r.visited === 0 || r.visited === 1);
            assert.equal(r.runId, receipts[0]!.requestId);
            assert.equal(
              r.previousRequestId,
              index === 0 ? null : receipts[index - 1]!.requestId,
            );
            assert.equal(
              JSON.stringify(r).includes('synthetic-maintenance-only'),
              false,
            );
          }
          assert.equal(
            receipts.reduce((n, r) => n + r.visited, 0),
            known.length + 7,
          );
          assert.equal(
            receipts.reduce((n, r) => n + r.skippedUnknownLevel, 0),
            3,
          );
          for (const who of known) {
            const expected = titles
              .filter(
                (x) =>
                  x.kind === 'level' && x.unlockLevel! <= levelFor(who.balance),
              )
              .map((x) => x.key);
            const rows = (
              await f.pool.query<{ title_key: string }>(
                'SELECT title_key FROM whaleu_experience.entitlements WHERE owner_id=$1',
                [who.id],
              )
            ).rows.map((x) => x.title_key);
            for (const key of expected)
              assert.ok(rows.includes(key), `${who.balance}: missing ${key}`);
            assert.equal(
              rows.length,
              expected.length + (who.id === preserved.id ? 2 : 0),
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_experience.baselines WHERE owner_id=ANY($1::uuid[])',
                [[unknown.id, withoutProvider.id, blocked.id]],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_experience.account_states WHERE owner_id=ANY($1::uuid[])',
                [[unknown.id, withoutProvider.id, blocked.id]],
              )
            ).rowCount,
            0,
          );
          const after = (
            await f.pool.query(`SELECT
        (SELECT jsonb_agg(x ORDER BY owner_id) FROM whaleu_experience.account_states x) states,
        (SELECT jsonb_agg(x ORDER BY owner_id) FROM whaleu_experience.baselines x) baselines,
        (SELECT jsonb_agg(x ORDER BY id) FROM whaleu_experience.records x) records,
        (SELECT count(*) FROM whaleu_experience.appearance) appearance,
        (SELECT count(*) FROM whaleu_experience.unlock_notices) notices,
        (SELECT count(*) FROM whaleu_experience.settlements) settlements`)
          ).rows[0];
          assert.deepEqual(
            after,
            before,
            'Repair must not rewrite state/history/coverage or create appearance/notices',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                "SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key IN ('level_29','redeem_liangchenmeijing') ORDER BY title_key",
                [preserved.id],
              )
            ).rows,
            original,
          );
          const maintenance = (
            await f.pool.query(
              "SELECT earned_at,recorded_at,origin FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='level_1'",
              [preserved.id],
            )
          ).rows[0]!;
          assert.equal(maintenance.origin, 'maintenance');
          assert.ok(maintenance.earned_at instanceof Date);
          assert.ok(
            Math.abs(
              maintenance.recorded_at.getTime() -
                maintenance.earned_at.getTime(),
            ) < 5000,
          );
        },
      );
      await t.test(
        'global superadministrator repairs default independently of balance and blocked target login status',
        async () => {
          const receipts = await f.sweep(
            superAdmin.accessToken,
            'repair_default_title',
          );
          assert.equal(
            receipts.reduce((n, r) => n + r.skippedIneligible, 0),
            1,
          );
          for (const owner of [unknown.id, blocked.id]) {
            assert.equal(
              (
                await f.pool.query(
                  "SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='default_jingxiaoyu' AND origin='maintenance'",
                  [owner],
                )
              ).rowCount,
              1,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT * FROM whaleu_experience.baselines WHERE owner_id=$1',
                  [owner],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT * FROM whaleu_experience.appearance WHERE owner_id=$1',
                  [owner],
                )
              ).rowCount,
              0,
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1',
                [withoutProvider.id],
              )
            ).rowCount,
            0,
          );
          const again = await f.sweep(
            superAdmin.accessToken,
            'repair_default_title',
          );
          assert.equal(
            again.reduce((n, r) => n + r.grantedTitles, 0),
            0,
          );
        },
      );
      await t.test(
        'run boundary excludes a late account behind the cursor; a later sweep picks it up',
        async () => {
          const first = (
            await f
              .batch(superAdmin.accessToken, {
                requestId: randomUUID(),
                operation: 'repair_default_title',
              })
              .expect(200)
          ).body;
          const late = await f.account({
            id: '00000000-0000-4000-8000-000000000000',
          });
          let previous = first;
          for (let pages = 0; !previous.done && pages < 100; pages++)
            previous = (
              await f
                .batch(superAdmin.accessToken, {
                  requestId: randomUUID(),
                  previousRequestId: previous.requestId,
                })
                .expect(200)
            ).body;
          assert.equal(previous.done, true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1',
                [late.id],
              )
            ).rowCount,
            0,
          );
          const repaired = await f
            .batch(superAdmin.accessToken, {
              requestId: randomUUID(),
              operation: 'repair_default_title',
            })
            .expect(200);
          assert.equal(repaired.body.grantedTitles, 1);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='default_jingxiaoyu'",
                [late.id],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'same request replay, recovery, changed intent, actor isolation and one immutable successor',
        async () => {
          const input = start();
          const first = (
            await f.batch(developer.accessToken, input).expect(200)
          ).body;
          assert.deepEqual(
            (await f.batch(developer.accessToken, input).expect(200)).body,
            first,
          );
          assert.deepEqual(
            (
              await f
                .receipt(developer.accessToken, input.requestId)
                .expect(200)
            ).body,
            first,
          );
          await f
            .batch(developer.accessToken, {
              ...input,
              operation: 'repair_default_title',
            })
            .expect(409);
          await f.receipt(superAdmin.accessToken, input.requestId).expect(404);
          await f
            .batch(superAdmin.accessToken, {
              requestId: randomUUID(),
              previousRequestId: input.requestId,
            })
            .expect(404);
          await f.batch(superAdmin.accessToken, input).expect(200);
          const next = {
            requestId: randomUUID(),
            previousRequestId: input.requestId,
          };
          const second = (
            await f.batch(developer.accessToken, next).expect(200)
          ).body;
          assert.deepEqual(
            (await f.batch(developer.accessToken, next).expect(200)).body,
            second,
          );
          await f
            .batch(developer.accessToken, {
              requestId: randomUUID(),
              previousRequestId: input.requestId,
            })
            .expect(409);
          for (const sql of [
            'UPDATE whaleu_experience.maintenance_requests SET cursor_after=upper_account_id WHERE actor_id=$1 AND request_id=$2',
            "UPDATE whaleu_experience.maintenance_requests SET receipt=jsonb_set(receipt,'{grantedTitles}','999') WHERE actor_id=$1 AND request_id=$2",
            'DELETE FROM whaleu_experience.maintenance_requests WHERE actor_id=$1 AND request_id=$2',
          ])
            await assert.rejects(
              f.pool.query(sql, [developer.accountId, input.requestId]),
            );
          assert.deepEqual(
            (
              await f
                .receipt(developer.accessToken, input.requestId)
                .expect(200)
            ).body,
            first,
          );
          await f.pool.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [developerGrant, developer.accountId],
          );
          await f.receipt(developer.accessToken, input.requestId).expect(403);
          await f.batch(developer.accessToken, input).expect(403);
          await f
            .batch(developer.accessToken, {
              requestId: randomUUID(),
              previousRequestId: second.requestId,
            })
            .expect(403);
        },
      );
      await t.test(
        'fresh expired authority, revoked session and blocked actor cannot use maintenance',
        async () => {
          const expired = await f.actor();
          await f.grant(expired.accountId, 'developer', {
            expiresAt: new Date(Date.now() - 1000),
          });
          await f.batch(expired.accessToken, start()).expect(403);
          await f.pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [superAdmin.sessionId],
          );
          await f.batch(superAdmin.accessToken, start()).expect(401);
          await f.pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [developer.accountId],
          );
          await f.batch(developer.accessToken, start()).expect(403);
        },
      );
    } finally {
      await f.close();
    }
  },
);
