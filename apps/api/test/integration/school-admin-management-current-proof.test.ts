import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken } from '../../src/identity/tokens.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { schoolAdminManagementFixture } from '../support/school-admin-management-fixture.js';

type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;
test(
  'school administration retains initial source, final NOWAIT fences and late-DML closure through actual raw writers',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    const superGrant = await f.grant(admin);
    const database = f.app.get(DatabaseService);
    const snapshot = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
  'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM whaleu_authorization.role_grants g),
  'commands',(SELECT jsonb_agg(to_jsonb(c) ORDER BY actor_id,request_id) FROM whaleu_authorization.school_admin_management_commands c),
  'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM whaleu_authorization.school_admin_assignment_events e),
  'entitlements',(SELECT jsonb_agg(to_jsonb(e) ORDER BY owner_id,title_key) FROM whaleu_experience.entitlements e)) value`)
      ).rows[0]!.value;
    const injected = async (
      hook: (
        sql: string,
        values: unknown[] | undefined,
        query: Query,
      ) => Promise<void>,
    ) => {
      const view = await f.management(admin, target.profileId),
        before = await snapshot();
      const original = database.transaction,
        run = original.bind(database);
      database.transaction = (work, options) =>
        run(async (tx) => {
          const raw = tx.query,
            query = raw.bind(tx) as Query;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            await hook(sql, values, query);
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        const response = await f.send(
          admin,
          f.command(view, 'appoint', f.scope.home.regionId),
        );
        assert.notEqual(response.status, 200, JSON.stringify(response.body));
      } finally {
        database.transaction = original;
      }
      assert.deepEqual(await snapshot(), before);
    };
    for (const [name, mutation, values] of [
      [
        'profile tuple ABA',
        'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE public_id=$1',
        [target.profileId],
      ],
      [
        'physical catalog tuple ABA',
        'UPDATE whaleu_campus.campuses SET full_name=full_name WHERE id=$1',
        [f.scope.home.campusId],
      ],
      [
        'target account tuple ABA',
        'UPDATE whaleu_identity.accounts SET status=status WHERE id=$1',
        [target.accountId],
      ],
    ] as const)
      await t.test(name, async () => {
        let hit = false;
        await injected(async (sql, _values, query) => {
          if (
            !hit &&
            sql.startsWith(
              'SELECT whaleu_authorization.school_admin_management_input_facts',
            )
          ) {
            hit = true;
            await query(mutation, [...values]);
          }
        });
        assert.ok(hit);
      });
    for (const [name, mutation, values] of [
      [
        'zero-row role writer',
        'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at WHERE false',
        [],
      ],
      [
        'same-value role writer',
        'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at WHERE id=$1',
        [superGrant],
      ],
      [
        'late target deactivation',
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [target.accountId],
      ],
      [
        'late catalog deactivation',
        'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
        [f.scope.home.regionId],
      ],
      [
        'late verification same-value update',
        'UPDATE whaleu_verification.account_heads SET revision=revision WHERE account_id=$1',
        [target.accountId],
      ],
      [
        'zero-row profile writer',
        'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
        [],
      ],
    ] as const)
      await t.test(`${name} after SET CONSTRAINTS ALL IMMEDIATE`, async () => {
        let hit = false;
        await injected(async (sql, _values, query) => {
          if (
            !hit &&
            sql.startsWith('INSERT INTO whaleu_experience.entitlements')
          ) {
            hit = true;
            await query('SET CONSTRAINTS ALL IMMEDIATE');
            await query(mutation, [...values]);
          }
        });
        assert.ok(hit);
      });
    for (const kind of [
      'actor-revoke',
      'target-super-phantom',
      'zero-row-role',
      'zero-row-verification',
    ] as const)
      await t.test(
        `uncooperative concurrent ${kind} holds a real writer lock`,
        async () => {
          const writer = await f.pool.connect();
          let pending: Promise<unknown> | undefined,
            hit = false;
          try {
            await writer.query('BEGIN');
            const pid = (await writer.query('SELECT pg_backend_pid() pid'))
              .rows[0]!.pid;
            await injected(async (sql) => {
              if (
                hit ||
                !sql.startsWith('INSERT INTO whaleu_experience.entitlements')
              )
                return;
              hit = true;
              const operation =
                kind === 'actor-revoke'
                  ? writer.query(
                      'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                      [superGrant],
                    )
                  : kind === 'target-super-phantom'
                    ? writer.query(
                        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',$2,'synthetic:raw-phantom')",
                        [randomUUID(), target.accountId],
                      )
                    : kind === 'zero-row-role'
                      ? writer.query(
                          'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at WHERE false',
                        )
                      : writer.query(
                          'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false',
                        );
              let settled = false;
              pending = operation.then(
                () => {
                  settled = true;
                },
                (error) => {
                  settled = true;
                  throw error;
                },
              );
              void pending.catch(() => {});
              const until = performance.now() + 2000;
              while (performance.now() < until) {
                if (settled) return;
                const waiting = (
                  await f.pool.query(
                    "SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",
                    [pid],
                  )
                ).rows[0]?.waiting;
                if (waiting) return;
                await sleep(5);
              }
              assert.fail('Expected actual writer to run or queue');
            });
          } finally {
            if (pending) await pending;
            await writer.query('ROLLBACK');
            writer.release();
          }
          assert.ok(hit);
        },
      );
    const success = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    assert.equal(success.receipt.outcome, 'applied');
  },
);

test(
  'raw writer that already owns target rows cannot be repaired by an advisory gate, and the original source must win over post-wait rereads',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const view = await f.management(admin, target.profileId);
    const writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
        [target.accountId],
      );
      const operation = f
        .send(admin, f.command(view, 'appoint', f.scope.home.regionId))
        .then((r) => r);
      void operation.catch(() => {});
      await f.waitForLock('whaleu_identity.accounts');
      await writer.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',$2,'synthetic:prelocked-super')",
        [randomUUID(), target.accountId],
      );
      await writer.query('COMMIT');
      const result = await operation;
      assert.ok(
        result.status >= 400 || result.body.outcome === 'rejected',
        JSON.stringify(result.body),
      );
      assert.equal((await f.grants(target)).length, 0);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  },
);

test(
  'two managers racing the same target serialize without duplicate live grants and multi-owner terminal locks stay ordered',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      b = await f.actor(),
      target = await f.actor();
    await f.grant(a);
    await f.grant(b);
    const av = await f.management(a, target.profileId),
      bv = await f.management(b, target.profileId);
    const results = await Promise.all([
      f.send(a, f.command(av, 'appoint', f.scope.home.regionId)),
      f.send(b, f.command(bv, 'appoint', f.scope.related.regionId)),
    ]);
    assert.ok(
      results.every((r) => r.status !== 500),
      results.map((r) => JSON.stringify(r.body)).join('\n'),
    );
    assert.equal(results.filter((r) => r.body.outcome === 'applied').length, 1);
    assert.equal(
      (await f.grants(target)).filter((g) => g.revoked_at === null).length,
      1,
    );
    const current = await f.management(a, target.profileId),
      next =
        current.currentAssignment!.regionId === f.scope.home.regionId
          ? f.scope.related.regionId
          : f.scope.home.regionId;
    const raced = await Promise.all([
      f.send(a, f.command(current, 'reassign', next)),
      f.send(b, f.command(current, 'revoke')),
    ]);
    assert.ok(raced.every((r) => r.status !== 500));
    assert.equal(raced.filter((r) => r.body.outcome === 'applied').length, 1);
    assert.ok(
      (await f.grants(target)).filter((g) => g.revoked_at === null).length <= 1,
    );
    const managers = await Promise.all([
      f.management(a, b.profileId),
      f.management(b, a.profileId),
    ]);
    assert.ok(managers.every((v) => v.eligibility.status === 'protected'));
  },
);

test(
  'authority and affiliation expiry during terminal owner work roll back grant, title, event and receipt together',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const database = f.app.get(DatabaseService);
    for (const kind of [
      'actor-grant',
      'target-affiliation',
      'access-token',
      'session-access',
      'session-absolute',
    ] as const)
      await t.test(kind, async () => {
        const expiry = new Date(Date.now() + 2000),
          admin = await f.actor(),
          target = await f.actor(
            kind === 'target-affiliation' ? { expiresAt: expiry } : {},
          );
        await f.grant(
          admin,
          'super_admin',
          null,
          kind === 'actor-grant' ? { until: expiry } : {},
        );
        const view = await f.management(admin, target.profileId),
          body = f.command(view, 'appoint', f.scope.home.regionId),
          original = database.transaction,
          run = original.bind(database);
        if (
          kind === 'access-token' ||
          kind === 'session-access' ||
          kind === 'session-absolute'
        ) {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            if (kind === 'access-token')
              await tx.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(admin.accessToken), expiry],
              );
            else if (kind === 'session-access')
              await tx.query(
                'UPDATE whaleu_identity.sessions SET access_expires_at=$2 WHERE id=$1',
                [admin.sessionId, expiry],
              );
            else
              await tx.query(
                'UPDATE whaleu_identity.sessions SET absolute_expires_at=$2,refresh_expires_at=$2,access_expires_at=$2 WHERE id=$1',
                [admin.sessionId, expiry],
              );
          });
        }
        let waited = false;
        database.transaction = (work, options) =>
          run(async (tx) => {
            const raw = tx.query,
              query = raw.bind(tx) as Query;
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              if (
                !waited &&
                sql.startsWith('INSERT INTO whaleu_experience.entitlements')
              ) {
                waited = true;
                await sleep(Math.max(1, expiry.getTime() - Date.now() + 30));
              }
              return result;
            }) as PoolClient['query'];
            try {
              return await work(tx);
            } finally {
              tx.query = raw;
            }
          }, options);
        try {
          const response = await f.send(admin, body);
          assert.ok(response.status >= 400, JSON.stringify(response.body));
        } finally {
          database.transaction = original;
        }
        assert.ok(waited);
        assert.equal((await f.grants(target)).length, 0);
        if (
          kind === 'access-token' ||
          kind === 'session-access' ||
          kind === 'session-absolute'
        ) {
          assert.ok(
            (await f.recovery(admin, body.clientRequestId)).status >= 400,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_authorization.school_admin_management_commands WHERE actor_id=$1 AND request_id=$2',
                [admin.accountId, body.clientRequestId],
              )
            ).rowCount,
            0,
          );
        } else
          assert.deepEqual(
            (await f.recovery(admin, body.clientRequestId)).body,
            {
              state: 'not_recorded',
            },
          );
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
              [target.accountId],
            )
          ).rows[0]!.n,
          0,
        );
      });
  },
);

test(
  'elapsed active assignment changes state version and cannot turn an unchanged confirmation into silent renewal',
  { timeout: 120000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const expiry = new Date(Date.now() + 750);
    await f.grant(target, 'school_admin', f.scope.home.regionId, {
      until: expiry,
    });
    const view = await f.management(admin, target.profileId);
    assert.equal(view.currentAssignment?.status, 'active');
    await sleep(Math.max(1, expiry.getTime() - Date.now() + 30));
    const stale = await f.send(
      admin,
      f.command(view, 'reassign', f.scope.home.regionId),
    );
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'SCHOOL_ADMIN_MANAGEMENT_STALE');
    assert.equal((await f.grants(target)).length, 1);
    assert.equal((await f.grants(target))[0]!.revoked_at, null);
    const fresh = await f.management(admin, target.profileId);
    assert.equal(fresh.currentAssignment?.status, 'expired');
    assert.notEqual(fresh.stateVersion, view.stateVersion);
    const renewed = await f.send(
      admin,
      f.command(fresh, 'reassign', f.scope.home.regionId),
    );
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.outcome, 'applied');
    assert.equal((await f.grants(target)).length, 2);
  },
);

test(
  'a genuinely committed verification-head replacement after initial observation invalidates the blocked original command',
  { timeout: 120000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const view = await f.management(admin, target.profileId),
      body = f.command(view, 'appoint', f.scope.home.regionId),
      holder = await f.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT account_id FROM whaleu_profile.profiles WHERE public_id=$1 FOR UPDATE',
        [target.profileId],
      );
      const operation = f.send(admin, body).then((r) => r);
      void operation.catch(() => {});
      await f.waitForLock('FROM whaleu_profile.profiles WHERE public_id');
      const changed = await setSyntheticSnapshot(f.pool, target.accountId, [
        syntheticAssertion(
          target.accountId,
          f.scope.institutionId,
          'affiliation',
          { origin_region_id: f.scope.home.regionId },
        ),
      ]);
      assert.notEqual(changed.snapshotId, target.facts.snapshotId);
      await holder.query('COMMIT');
      const result = await operation;
      assert.ok(
        result.status >= 400 || result.body.outcome === 'rejected',
        JSON.stringify(result.body),
      );
      assert.equal((await f.grants(target)).length, 0);
      assert.deepEqual((await f.recovery(admin, body.clientRequestId)).body, {
        state: 'not_recorded',
      });
      const head = (
        await f.pool.query(
          'SELECT snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1',
          [target.accountId],
        )
      ).rows[0]!;
      assert.equal(head.snapshot_id, changed.snapshotId);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  },
);

test(
  'committed topology and physical-region writers serialize through the existing outer gate and make displayed intent stale',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor();
    await f.grant(admin);
    for (const kind of ['topology', 'region'] as const)
      await t.test(kind, async () => {
        const target = await f.actor({ identity: false }),
          view = await f.management(admin, target.profileId),
          body = f.command(view, 'appoint', f.scope.home.regionId),
          writer = await f.pool.connect();
        try {
          await writer.query('BEGIN');
          await lockSafetyPolicy(writer, true);
          const operation = f.send(admin, body).then((r) => r);
          void operation.catch(() => {});
          await f.waitForLock('whaleu:named-block-policy:v1');
          if (kind === 'region')
            await writer.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [f.scope.home.regionId],
            );
          else {
            const old = (
                await writer.query(
                  "SELECT revision FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR UPDATE",
                )
              ).rows[0]!,
              id = randomUUID();
            const topology = structuredClone(f.scope.topology);
            topology.regions.find(
              (r) => r.regionId === f.scope.related.regionId,
            )!.groupId = topology.regions.find(
              (r) => r.regionId === f.scope.foreign.regionId,
            )!.groupId;
            await writer.query(
              `INSERT INTO whaleu_campus.community_topology_snapshots(id,revision,topology,coverage_state,provenance_state,effective_at,expiry_kind,valid_until,source_reference,policy_reference) VALUES($1,$2,$3,'complete','accepted',clock_timestamp()-interval '1 minute','policy_exempt',NULL,'synthetic-committed-management-race','synthetic-explicit-topology')`,
              [id, old.revision + 1, topology],
            );
            await writer.query(
              "UPDATE whaleu_campus.community_topology_heads SET revision=$1,snapshot_id=$2 WHERE scope_key='community'",
              [old.revision + 1, id],
            );
          }
          await writer.query('COMMIT');
          const result = await operation;
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.code, 'SCHOOL_ADMIN_MANAGEMENT_STALE');
          assert.equal((await f.grants(target)).length, 0);
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      });
  },
);
