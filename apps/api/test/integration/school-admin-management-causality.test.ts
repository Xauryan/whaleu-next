import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { schoolAdminManagementFixture } from '../support/school-admin-management-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { lockExperienceOwner } from '../../src/experience/ingress.js';

test(
  'causal closure rejects receipt-only, missing real transitions, missing title reciprocity and forged standalone product grants',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const database = f.app.get(DatabaseService);
    const count = async () =>
      (
        await f.pool.query(
          `SELECT
  (SELECT count(*)::int FROM whaleu_authorization.school_admin_management_commands) commands,
  (SELECT count(*)::int FROM whaleu_authorization.school_admin_assignment_events) events,
  (SELECT count(*)::int FROM whaleu_authorization.school_admin_management_transitions) transitions,
  (SELECT count(*)::int FROM whaleu_experience.school_admin_title_grants) titles,
  (SELECT count(*)::int FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin') entitlements,
  (SELECT count(*)::int FROM whaleu_authorization.role_grants WHERE account_id=$1 AND role='school_admin') grants`,
          [target.accountId],
        )
      ).rows[0];
    const before = await count();
    for (const skipped of [
      'INSERT INTO whaleu_authorization.role_grants',
      'INSERT INTO whaleu_experience.school_admin_title_grants',
      'INSERT INTO whaleu_experience.entitlements',
    ])
      await t.test(`missing ${skipped}`, async () => {
        const view = await f.management(admin, target.profileId),
          body = f.command(view, 'appoint', f.scope.home.regionId),
          original = database.transaction,
          run = original.bind(database);
        let hit = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const raw = tx.query,
              query = raw.bind(tx);
            tx.query = (async (sql: string, values?: unknown[]) => {
              if (sql.startsWith(skipped)) {
                hit = true;
                return {
                  command: 'INSERT',
                  rowCount: 1,
                  oid: 0,
                  rows: [],
                  fields: [],
                };
              }
              return query(sql, values);
            }) as PoolClient['query'];
            try {
              return await work(tx);
            } finally {
              tx.query = raw;
            }
          }, options);
        try {
          const result = await f.send(admin, body);
          assert.ok(result.status >= 400, JSON.stringify(result.body));
        } finally {
          database.transaction = original;
        }
        assert.ok(hit);
        assert.deepEqual(await count(), before);
        assert.deepEqual((await f.recovery(admin, body.clientRequestId)).body, {
          state: 'not_recorded',
        });
      });
    await assert.rejects(() =>
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$4,$5)`,
          [
            randomUUID(),
            target.accountId,
            f.scope.home.regionId,
            admin.accountId,
            `school-admin-management:${admin.accountId}:${randomUUID()}`,
          ],
        ),
      ),
    );
    await assert.rejects(() =>
      inTransaction(f.pool, async (tx) => {
        await lockExperienceOwner(tx, target.accountId, true);
        await tx.query(
          `INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,earned_at,school_admin_actor_id,school_admin_request_id) VALUES($1,'role_admin','school_admin_appointment',clock_timestamp(),$2,$3)`,
          [target.accountId, admin.accountId, randomUUID()],
        );
      }),
    );
    assert.deepEqual(await count(), before);
    const applied = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    assert.equal(applied.receipt.outcome, 'applied');
    const committed = await count();
    assert.deepEqual(committed, {
      commands: 1,
      events: 1,
      transitions: 1,
      titles: 1,
      entitlements: 1,
      grants: 1,
    });
    for (const relation of [
      'whaleu_authorization.school_admin_management_commands',
      'whaleu_authorization.school_admin_assignment_events',
      'whaleu_authorization.school_admin_management_transitions',
      'whaleu_authorization.school_admin_management_statements',
      'whaleu_authorization.school_admin_management_epochs',
      'whaleu_experience.school_admin_title_grants',
    ]) {
      await assert.rejects(() => f.pool.query(`DELETE FROM ${relation}`));
      assert.deepEqual(await count(), committed);
    }
  },
);
